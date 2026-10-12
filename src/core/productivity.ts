/**
 * Productivity features of the knowledge workplace (step 4d): daily note with standup
 * draft, quick note, the inbox "Zu prüfen", the hint simulator, ticket, session and
 * project pages. Everything here reads; writes go through actions.
 */
import { join } from "node:path"
import type { Entry } from "../types"
import { readJson, readText, writeJsonAtomic } from "../util/fs"
import { daysBetween, fold, nowIso, truncate } from "../util/text"
import type { Ctx } from "./context"
import { str } from "./frontmatter"
import { gitIn } from "./git"
import { formatHint, HintEngine } from "./hints"
import { aiAccessOf, isOwnDoc, MEMORY_TYPE_LABEL, spec } from "./kinds"
import { localDay } from "./sqlite"

const DAY = 86_400_000

export function journalName(date: string): string {
  return date
}

/** Prefilled daily note: sessions, progress, solved errors, decisions, commits of the project repo + standup draft. */
export async function journalBody(ctx: Ctx, date: string): Promise<string> {
  const day = (iso?: string | number) => (iso === undefined ? "" : localDay(typeof iso === "number" ? iso : Date.parse(iso)))
  const prev = localDay(Date.parse(`${date}T12:00:00`) - DAY)
  const sessions = (ctx.history?.all() ?? []).filter((r) => day(r.at) === date)
  const yesterday = (ctx.history?.all() ?? []).filter((r) => day(r.at) === prev)
  const states = (ctx.mem?.states() ?? []).filter((s) => day(s.updatedAt) === date)
  const errors = ctx.store.list("error").filter((e) => day(e.meta?.updatedAt) === date && str(e.fields.status) === "solved")
  const decisions = ctx.store.list("memory").filter((e) => day(e.meta?.createdAt) === date && str(e.fields.type) === "entscheidung")
  const tasksDone = ctx.tasks.list({ project: "*" }).filter((t) => ctx.tasks.isDone(t.status, t.project) && day(t.updatedAt) === date)
  const tasksOpen = ctx.tasks.list({ project: "*" }).filter((t) => !ctx.tasks.isDone(t.status, t.project) && t.status !== ctx.tasks.columns(t.project)[0])
  let commits: string[] = []
  try {
    const r = await gitIn(ctx.git.bin, ctx.worktree, ["log", `--since=${date}T00:00:00`, `--until=${date}T23:59:59`, "--format=%h %s", "-n", "30"], 10_000)
    if (r.code === 0) commits = r.stdout.split("\n").filter(Boolean)
  } catch {
    commits = []
  }
  const lines: string[] = [`## Sessions (${sessions.length})`]
  lines.push(...(sessions.length ? sessions.map((r) => `- ${truncate(r.title || r.requests[0] || r.id, 120)}${r.problems.length ? ` · ${r.problems.length} Problem(e)` : ""}`) : ["- (keine)"]))
  if (states.length) {
    lines.push("", "## Fortschritt")
    for (const s of states) lines.push(`- **${s.ticket || s.branch}**: ${truncate(s.summary || s.goal, 160)}${s.done.length ? ` – erledigt: ${s.done.slice(-3).join("; ")}` : ""}`)
  }
  if (errors.length) lines.push("", "## Gelöste Fehler", ...errors.map((e) => `- [[error:${e.name}]] ${e.title}`))
  if (decisions.length) lines.push("", "## Neue Entscheidungen", ...decisions.map((e) => `- [[memory:${e.name}]] ${e.title}`))
  if (tasksDone.length) lines.push("", "## Erledigte Aufgaben", ...tasksDone.map((t) => `- [[task:${t.id}]] ${t.title}`))
  if (commits.length) lines.push("", `## Commits (${ctx.project})`, ...commits.map((c) => `- \`${c.slice(0, 8)}\` ${c.slice(8)}`))
  lines.push("", "## Standup-Entwurf", "", "**Gestern**")
  const y = yesterday.map((r) => `- ${truncate(r.title || r.requests[0] || r.id, 120)}`)
  lines.push(...(y.length ? y : ["- "]))
  lines.push("", "**Heute**")
  const today = [
    ...tasksOpen.slice(0, 6).map((t) => `- [[task:${t.id}]] ${t.title}`),
    ...(ctx.mem?.states() ?? [])
      .filter((s) => s.status === "gueltig")
      .flatMap((s) => s.next.slice(0, 2).map((n) => `- ${n} (${s.ticket || s.branch})`))
      .slice(0, 6),
  ]
  lines.push(...(today.length ? today : ["- "]))
  lines.push("", "**Blocker**")
  const blockers = [
    ...ctx.store
      .list("error")
      .filter((e) => str(e.fields.status) === "open" && e.tier === "active")
      .slice(0, 3)
      .map((e) => `- [[error:${e.name}]] ${e.title}`),
    ...(ctx.mem?.conflicts("needs_user") ?? []).slice(0, 2).map((c) => `- Konflikt ${c.id}: ${truncate(c.suspicion, 100)}`),
  ]
  lines.push(...(blockers.length ? blockers : ["- keine"]), "", "## Notizen", "", "")
  return lines.join("\n")
}

/** Standup text to copy (from the daily note sections). */
export function standupOf(body: string): string {
  const m = /## Standup-Entwurf\s*\n([\s\S]*?)(?=\n## |$)/.exec(body)
  return (m?.[1] ?? "").replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, "$1").replace(/\[\[(?:task:)?([^\]]+)\]\]/g, "$1").trim()
}

// ---------------------------------------------------------------------------
// inbox "Zu prüfen"
// ---------------------------------------------------------------------------

export interface InboxItem {
  id: string
  type: string
  group: string
  title: string
  detail?: string
  target?: string
  at?: string
  severity: "info" | "warn" | "critical"
  /** suggested actions (names from the catalog) */
  actions: Array<{ action: string; label: string; args?: Record<string, unknown>; target?: string; confirm?: boolean }>
  data?: unknown
}

function visitFile(ctx: Ctx): string {
  return join(ctx.store.stateDir, "web-visit.json")
}

export function lastVisit(ctx: Ctx): string | undefined {
  return readJson<{ inbox?: string }>(visitFile(ctx), {}).inbox
}

export function markVisited(ctx: Ctx): void {
  writeJsonAtomic(visitFile(ctx), { ...readJson<Record<string, string>>(visitFile(ctx), {}), inbox: nowIso() })
}

export function inbox(ctx: Ctx, opts: { since?: string } = {}): { since?: string; items: InboxItem[]; counts: Record<string, number> } {
  const items: InboxItem[] = []
  const since = opts.since ?? lastVisit(ctx) ?? new Date(Date.now() - 7 * DAY).toISOString()
  const label = (id: string) => {
    const i = id.indexOf(":")
    const e = i > 0 ? ctx.store.getOwned(id.slice(0, i) as Entry["kind"], id.slice(i + 1)) : undefined
    return e?.title ?? id
  }
  // changes of the agents since the last visit (with diff, feedback)
  for (const ev of ctx.audit?.query({ from: since, category: ["change"], actor: ["reviewer", "curator", "doctor", "agent"], limit: 200 }).events ?? []) {
    const t = ev.targets[0]
    if (!t) continue
    items.push({
      id: `change-${ev.seq}`,
      type: "change",
      group: "Änderungen der KI",
      title: `${ev.smith ?? ev.actor}: ${ev.action} ${label(t)}`,
      detail: ev.reason,
      target: t,
      at: ev.at,
      severity: "info",
      actions: [
        { action: "feedback", label: "👍", args: { seq: ev.seq, good: true } },
        { action: "feedback", label: "👎", args: { seq: ev.seq, good: false } },
        ...(ev.run ? [{ action: "run.undo", label: "Rückgängig", args: { run: ev.run }, confirm: true }] : []),
      ],
      data: { commit: ev.commit, run: ev.run, seq: ev.seq },
    })
  }
  // proposals and staged changes
  for (const s of ctx.ops.staged()) {
    items.push({
      id: `staged-${s.id}`,
      type: s.aiProposal ? "proposal" : "staged",
      group: s.aiProposal ? "Vorschläge für Ihre Dokumente" : "Zur Freigabe vorgemerkt",
      title: `${s.smith}: ${s.action} ${spec(s.target).label} ${label(`${s.target}:${s.name}`)}`,
      detail: s.reason,
      target: `${s.target}:${s.name}`,
      at: s.createdAt,
      severity: s.aiProposal ? "warn" : "info",
      actions: [
        { action: "proposal.accept", label: "Übernehmen", args: { id: s.id } },
        { action: "proposal.reject", label: "Ablehnen", args: { id: s.id } },
      ],
      data: { staged: s.id, session: s.sessionID },
    })
  }
  // doctor
  for (const c of ctx.mem?.conflicts(["needs_user", "open"]) ?? []) {
    items.push({
      id: `conflict-${c.id}`,
      type: "conflict",
      group: "Konflikte",
      title: `${label(c.a)} ↔ ${label(c.b)}`,
      detail: c.note ?? c.suspicion,
      target: c.a,
      at: new Date(c.detectedAt).toISOString(),
      severity: c.status === "needs_user" ? "critical" : "warn",
      actions: [
        { action: "conflict.resolve", label: "A gilt", args: { id: c.id, choice: "a" } },
        { action: "conflict.resolve", label: "B gilt", args: { id: c.id, choice: "b" } },
        { action: "conflict.resolve", label: "beide", args: { id: c.id, choice: "both" } },
        { action: "conflict.resolve", label: "kein Bezug", args: { id: c.id, choice: "unrelated" } },
      ],
      data: { a: c.a, b: c.b, conflict: c.id, status: c.status },
    })
  }
  // memories: unconfirmed decisions, due reviews
  const today = new Date().toISOString().slice(0, 10)
  for (const e of ctx.store.list("memory")) {
    if (e.tier !== "active") continue
    const id = `memory:${e.name}`
    if (str(e.fields.type) === "entscheidung" && str(e.fields.status) === "vorgeschlagen") {
      items.push({ id: `confirm-${e.name}`, type: "decision", group: "Unbestätigte Entscheidungen", title: e.title, detail: e.description, target: id, at: e.meta?.createdAt, severity: "warn", actions: [{ action: "memory.confirm", label: "Bestätigen", target: id }, { action: "entry.archive", label: "Verwerfen", target: id }] })
    }
    const ra = str(e.fields.review_after)
    if (ra && ra <= today) items.push({ id: `review-${e.name}`, type: "review", group: "Fällige Prüfungen", title: e.title, detail: `prüfen seit ${ra}`, target: id, severity: "info", actions: [{ action: "memory.reviewed", label: "Geprüft", target: id }] })
  }
  for (const e of ctx.store.list("knowledge")) {
    if (e.tier !== "active") continue
    const id = `knowledge:${e.name}`
    const ra = str(e.fields.review_after)
    const due = ra ? ra <= today : !isOwnDoc(e) && daysBetween(e.meta?.verifiedAt ?? e.meta?.updatedAt ?? e.meta?.createdAt) >= ctx.options.docsmith.reviewAfterDays
    if (due || e.meta?.doubts?.length) {
      items.push({
        id: `doc-${e.name}`,
        type: "doc-due",
        group: "Fällige Prüfungen",
        title: e.title,
        detail: e.meta?.doubts?.length ? `möglicherweise veraltet: ${e.meta.doubts[e.meta.doubts.length - 1].note}` : ra ? `prüfen seit ${ra}` : "lange nicht bestätigt",
        target: id,
        severity: e.meta?.doubts?.length ? "warn" : "info",
        actions: [{ action: "doc.check", label: "Jetzt prüfen lassen", target: id }, { action: "doc.verified", label: "Ist aktuell", target: id }],
      })
    }
  }
  // error-prone entries, red script tests
  const usage = ctx.usage.all()
  for (const [id, u] of Object.entries(usage)) {
    if (u.reviewedLoads >= ctx.options.needsReviewMinLoads && u.loadsWithIssues / u.reviewedLoads >= ctx.options.needsReviewRate) {
      items.push({ id: `prone-${id}`, type: "error-prone", group: "Fehleranfällig", title: label(id), detail: `Probleme bei ${u.loadsWithIssues} von ${u.reviewedLoads} Einsätzen${u.lastIssue ? ` – zuletzt: ${truncate(u.lastIssue, 160)}` : ""}`, target: id, severity: "warn", actions: [] })
    }
  }
  for (const s of ctx.store.list("script")) {
    if (s.meta?.test?.status === "failed") items.push({ id: `test-${s.name}`, type: "test", group: "Rote Skript-Tests", title: s.name, detail: s.meta.test.summary, target: `script:${s.name}`, severity: "warn", actions: [{ action: "script.retest", label: "Neu testen", target: `script:${s.name}` }] })
  }
  // open abbreviations
  for (const c of ctx.store.candidates("glossary").filter((x) => !x.promotedTo).slice(0, 30)) {
    items.push({ id: `abbr-${c.id}`, type: "abbreviation", group: "Offene Abkürzungen", title: c.keywords[0] ?? c.id, detail: `${c.sessions.length} Session(s) · ${truncate(c.summary.replace(/^[^:]+:\s*/, ""), 120)}`, severity: "info", actions: [{ action: "glossary.ignore", label: "Ignorieren", args: { terms: [c.keywords[0] ?? c.id] } }], data: { term: c.keywords[0] ?? c.id } })
  }
  // broken links
  for (const b of ctx.links.broken().slice(0, 50)) {
    items.push({ id: `link-${b.from}-${b.target}`, type: "broken-link", group: "Defekte Links", title: `${label(b.from)}: ${b.raw}`, detail: `Ziel „${b.target}“ gibt es nicht`, target: b.from, severity: "info", actions: [] })
  }
  // agents
  for (const j of ctx.agentTasks.active()) {
    if (j.phase === "awaiting_approval") items.push({ id: `agent-${j.id}`, type: "agent-proposal", group: "Agenten", title: `Vorschlag von ${j.agent} für ${j.task.toUpperCase()}`, detail: truncate(j.proposals[j.proposals.length - 1]?.approach ?? "", 200), target: `task:${j.task}`, severity: "warn", actions: [], data: { job: j.id } })
    for (const p of j.permissions) items.push({ id: `perm-${p.id}`, type: "permission", group: "Agenten", title: `Rückfrage: ${p.title}`, detail: `${j.agent} · ${j.task.toUpperCase()}`, target: `task:${j.task}`, severity: "critical", actions: ["once", "always", "reject"].map((r) => ({ action: "agent.permission", label: r === "once" ? "einmal" : r === "always" ? "immer" : "ablehnen", args: { job: j.id, permission: p.id, response: r } })), data: { job: j.id } })
    if (j.phase === "in_test") items.push({ id: `agent-done-${j.id}`, type: "agent-done", group: "Agenten", title: `${j.task.toUpperCase()} umgesetzt – bitte prüfen`, detail: truncate(j.summary ?? "", 200), target: `task:${j.task}`, severity: "info", actions: [], data: { job: j.id } })
  }
  for (const r of ctx.agentTasks.rules().filter((x) => x.status === "candidate")) {
    items.push({ id: `rule-${r.id}`, type: "rule", group: "Regeln aus Korrekturen", title: r.text, detail: `${r.kind === "skill" ? "Skill-Änderung" : "Vorgabe"}${r.project ? ` · ${r.project}` : ""}${r.task ? ` · ${r.task.toUpperCase()}` : ""}`, severity: "info", actions: [{ action: "rule.decide", label: "Bestätigen", args: { id: r.id, decision: "confirm" } }, { action: "rule.decide", label: "Verwerfen", args: { id: r.id, decision: "dismiss" } }] })
  }
  for (const t of ctx.tasks.list({ project: "*" }).filter((x) => x.suggested)) {
    items.push({ id: `suggest-${t.name}`, type: "task-suggestion", group: "Aufgaben-Vorschläge", title: `${t.id} ${t.title}`, detail: t.description, target: t.key, severity: "info", actions: [{ action: "task.acceptSuggestion", label: "Einplanen", target: t.key }, { action: "task.dismissSuggestion", label: "Verwerfen", target: t.key }] })
  }
  for (const t of ctx.tasks.list({ project: "*" }).filter((x) => x.pipeline?.status === "failed" && !ctx.tasks.isDone(x.status, x.project))) {
    items.push({ id: `pipe-${t.name}`, type: "pipeline", group: "Pipeline rot", title: `${t.id} ${t.title}`, target: t.key, severity: "warn", actions: [{ action: "pipeline.start", label: "Erneut starten", args: { project: t.project, task: t.name } }] })
  }
  // relevance: unconnected and long unused → archive or link; large and orange → improve first
  try {
    const nodes = ctx.graph.nodes().filter((n) => n.tier === "active" && ["skill", "knowledge", "error", "script"].includes(n.kind))
    const rel = ctx.relevance.compute(nodes, ctx.graph.allEdges())
    for (const n of nodes) {
      const r = rel.get(n.id)
      if (!r) continue
      const created = n.date ? Date.parse(n.date) : Date.now()
      const i = n.id.indexOf(":")
      const entry = ctx.store.getOwned(n.id.slice(0, i) as Entry["kind"], n.id.slice(i + 1))
      const userOwned = !!entry && (isOwnDoc(entry) || aiAccessOf(entry) !== "frei")
      if (!r.raw.edges && !r.raw.uses && Date.now() - created > 60 * DAY && !r.pinned && !userOwned) {
        items.push({ id: `stale-${n.id}`, type: "stale", group: "Aufräumen", title: n.title, detail: "unvernetzt und lange ungenutzt – archivieren oder verknüpfen", target: n.id, severity: "info", actions: [{ action: "entry.archive", label: "Archivieren", target: n.id }] })
      } else if (r.score >= 0.6 && r.ring === "warn") {
        items.push({ id: `improve-${n.id}`, type: "improve", group: "Zuerst verbessern", title: n.title, detail: `viel genutzt, aber ${r.ringReason}`, target: n.id, severity: "warn", actions: [] })
      }
    }
  } catch {
    // relevance is optional
  }
  // outdated project docs
  for (const l of (readText(join(ctx.store.stateDir, "outdated-docs.jsonl")) ?? "").split("\n").filter(Boolean).slice(-10)) {
    try {
      const j = JSON.parse(l) as { at: string; project: string; doc: string }
      if (j.at >= since) items.push({ id: `outdated-${j.at}`, type: "project-doc", group: "Projekt-Doku prüfen", title: j.doc, detail: j.project, at: j.at, severity: "info", actions: [] })
    } catch {
      // ignore
    }
  }
  const counts: Record<string, number> = {}
  for (const i of items) counts[i.group] = (counts[i.group] ?? 0) + 1
  return { since, items, counts }
}

// ---------------------------------------------------------------------------
// hint simulator (idea 3)
// ---------------------------------------------------------------------------

export async function simulateHints(
  ctx: Ctx,
  text: string,
  overrides: { minScore?: number; hintMinSimilarity?: number; max?: number; ownBoost?: number } = {},
): Promise<Record<string, unknown>> {
  const options = {
    ...ctx.options,
    hints: { ...ctx.options.hints, ...(overrides.minScore !== undefined ? { minScore: overrides.minScore } : {}), ...(overrides.max !== undefined ? { max: overrides.max } : {}) },
    embedding: { ...ctx.options.embedding, ...(overrides.hintMinSimilarity !== undefined ? { hintMinSimilarity: overrides.hintMinSimilarity } : {}) },
    docs: { ...ctx.options.docs, ...(overrides.ownBoost !== undefined ? { ownBoost: overrides.ownBoost } : {}) },
  }
  const sim = { ...ctx, options, metrics: undefined } as Ctx
  const engine = new HintEngine(sim)
  const sid = `simulator-${Date.now()}`
  const started = Date.now()
  const set = await engine.select(sid, text)
  ctx.sessions.remove(sid)
  let stand: string | undefined
  try {
    stand = engine.standBlock()
  } catch {
    stand = undefined
  }
  const block = [stand, formatHint({ ...set, project: ctx.project })].filter(Boolean).join("\n")
  const shown = new Set([...set.skills, ...set.knowledge, ...set.errors, ...set.scripts].map((h) => `${h.kind}:${h.name}`))
  // all candidates with their values and why they are (not) shown
  const vec = await ctx.retriever.queryVector(text, "hint", ctx.options.embedding.hintWaitMs).catch(() => undefined)
  const candidates: Array<Record<string, unknown>> = []
  const rel = (() => {
    try {
      return ctx.relevance.compute(ctx.graph.nodes(), ctx.graph.allEdges())
    } catch {
      return undefined
    }
  })()
  for (const kind of ["skill", "knowledge", "error", "script", "memory"] as const) {
    const hits = await ctx.retriever.search(text, { kinds: [kind], tiers: ["active", "dormant"], limit: 8, queryVector: vec, minSimilarity: 0, purpose: "hint", ownBoost: options.docs.ownBoost })
    for (const h of hits) {
      const id = `${h.kind}:${h.name}`
      const strongBm25 = h.confidence >= options.hints.minScore && (h.matched.length >= 2 || (h.matched.length === 1 && h.confidence >= 0.6))
      const strongSem = (h.similarity ?? 0) >= options.embedding.hintMinSimilarity
      const isShown = shown.has(id) || (kind === "memory" && (set.memories ?? []).some((m) => m.id === id))
      const why = isShown
        ? strongSem && !strongBm25
          ? "gezeigt (semantisch ähnlich)"
          : "gezeigt (Stichworte)"
        : !strongBm25 && !strongSem
          ? `zu schwach: Stichwort-Sicherheit ${h.confidence.toFixed(2)} < ${options.hints.minScore}${h.similarity !== undefined ? `, Ähnlichkeit ${h.similarity.toFixed(2)} < ${options.embedding.hintMinSimilarity}` : ""}`
          : kind === "knowledge" || kind === "error" || kind === "script"
            ? "stark genug, aber höchstens 2 je Art"
            : `stark genug, aber höchstens ${options.hints.max}`
      candidates.push({ id, kind, title: h.title, confidence: h.confidence, similarity: h.similarity ?? null, matched: h.matched, shown: isShown, why, relevance: rel?.get(id)?.score ?? null })
    }
  }
  return {
    block,
    ms: Date.now() - started,
    semantic: !!vec,
    thresholds: { minScore: options.hints.minScore, hintMinSimilarity: options.embedding.hintMinSimilarity, max: options.hints.max, ownBoost: options.docs.ownBoost },
    glossary: set.glossary.map((e) => ({ id: `glossary:${e.name}`, title: e.title })),
    memories: set.memories ?? [],
    sessions: (set.sessions ?? []).map((s) => ({ id: s.record.id, title: s.record.title ?? s.record.requests[0], similarity: s.similarity ?? null })),
    seeAlso: set.seeAlso ?? [],
    candidates,
  }
}

// ---------------------------------------------------------------------------
// pages: ticket, session, project
// ---------------------------------------------------------------------------

export function ticketPage(ctx: Ctx, ticket: string): Record<string, unknown> {
  const t = fold(ticket)
  const has = (s: unknown) => fold(String(s ?? "")).includes(t)
  const states = (ctx.mem?.states() ?? []).filter((s) => fold(s.ticket ?? "") === t || has(s.branch))
  const memories = ctx.store.list("memory").filter((e) => fold(str(e.fields.ticket)) === t || has(e.body) || has(str(e.fields.branch)))
  const docs = ctx.store.list("knowledge").filter((e) => has(e.title) || has(e.body))
  const tasks = ctx.tasks.list({ project: "*", includeArchived: true }).filter((x) => fold(x.ticket ?? "") === t || has(x.branch) || has(x.title))
  const sessions = (ctx.history?.all() ?? []).filter((r) => has(r.title) || r.requests.some(has)).slice(0, 30)
  const url = ctx.options.links.ticketUrl ? ctx.options.links.ticketUrl.replace("{ticket}", encodeURIComponent(ticket)) : undefined
  return {
    ticket,
    url,
    states: states.map((s) => ({ id: s.id, branch: s.branch, summary: s.summary || s.goal, open: s.open, done: s.done, next: s.next, updatedAt: new Date(s.updatedAt).toISOString(), status: s.status })),
    memories: memories.map((e) => ({ id: `memory:${e.name}`, title: e.title, type: MEMORY_TYPE_LABEL[str(e.fields.type)] ?? "Erinnerung", status: str(e.fields.status) })),
    docs: docs.slice(0, 30).map((e) => ({ id: `knowledge:${e.name}`, title: e.title })),
    tasks: tasks.map((x) => ({ id: x.key, short: x.id, title: x.title, status: x.status, project: x.project })),
    sessions: sessions.map((r) => ({ id: r.id, title: r.title || r.requests[0], at: r.at, project: r.project })),
  }
}

export function sessionPage(ctx: Ctx, id: string): Record<string, unknown> {
  const r = ctx.history?.get(id)
  const events = ctx.audit?.query({ session: id, limit: 300 }).events ?? []
  const metrics = ctx.metrics?.events({ session: id, limit: 2000 }) ?? []
  const tokens = metrics.filter((m) => m.type === "session.reply").reduce((n, m) => n + (m.value ?? 0), 0)
  const cost = metrics.filter((m) => m.type === "session.reply").reduce((n, m) => n + (m.value2 ?? 0), 0)
  return {
    id,
    record: r ?? null,
    changes: events.map((e) => ({ seq: e.seq, at: e.at, smith: e.smith, category: e.category, action: e.action, targets: e.targets, result: e.result, reason: e.reason, commit: e.commit, run: e.run })),
    usage: metrics.filter((m) => m.type.startsWith("entry.")).map((m) => ({ at: m.at, type: m.type, entry: m.entry })),
    tools: metrics.filter((m) => m.type === "tool.call").length,
    tokens,
    cost,
  }
}

export function projectPage(ctx: Ctx, name: string): Record<string, unknown> {
  const p = ctx.projects.get(name)
  if (!p) return { error: "nicht gefunden" }
  const matches = (proj: string, projName: string) => proj === p.name || projName === p.title || projName === p.name || (p.homePath ? proj.includes(p.homePath.replace(/^~\//, "")) : false)
  const states = (ctx.mem?.states() ?? []).filter((s) => matches(s.project, s.projectName))
  const memories = ctx.store.list("memory").filter((e) => e.tier === "active" && matches(str(e.fields.project), str(e.fields.project_name)))
  return {
    project: p,
    tasks: ctx.tasks.list({ project: p.name }),
    runs: ctx.pipeline.runs(p.name, 20).map((r) => ({ ...r, stages: r.stages.map((s) => ({ name: s.name, status: s.status, ms: s.ms })) })),
    states: states.map((s) => ({ id: s.id, branch: s.branch, ticket: s.ticket, summary: s.summary || s.goal, open: s.open, next: s.next, done: s.done, status: s.status, updatedAt: new Date(s.updatedAt).toISOString() })),
    rules: memories.filter((e) => str(e.fields.type) === "vorgabe").map((e) => ({ id: `memory:${e.name}`, title: e.title })),
    decisions: memories.filter((e) => str(e.fields.type) === "entscheidung").map((e) => ({ id: `memory:${e.name}`, title: e.title, status: str(e.fields.status) })),
    results: (ctx.mem?.results() ?? []).filter((r) => matches(r.project, r.projectName)).slice(0, 20).map((r) => ({ id: r.id, title: r.title })),
    docs: ctx.links.backlinksOf(`project:${p.name}`).map((b) => ({ id: b.from, title: b.from })),
    jobs: ctx.agentTasks.all().filter((j) => j.project === p.name).slice(0, 20).map((j) => ({ id: j.id, task: j.task, agent: j.agent, phase: j.phase, startedAt: j.startedAt })),
  }
}
