/**
 * Productivity features of the knowledge workplace (step 4d): daily note with standup
 * draft, quick note, the hint simulator, ticket, session and project pages (the inbox lives
 * in inbox.ts). Everything here reads; writes go through actions.
 */
import { fold, localDay, truncate } from "../util/text"
import type { Ctx } from "./context"
import { str } from "./frontmatter"
import { gitIn } from "./git"
import { formatHint, HintEngine } from "./hints"
import { MEMORY_TYPE_LABEL } from "./kinds"
import { resolveFlows } from "./workflow"

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
    jobs: ctx.agentTasks.all().filter((j) => j.project === p.name).slice(0, 20).map((j) => ({ id: j.id, task: j.task, agent: j.agent, phase: j.phase, step: j.step, column: j.column, waitingFor: j.waitingFor, loops: j.loops, startedAt: j.startedAt })),
    // workflow: effective per column, and without the project's own settings (the editor saves the difference)
    flows: ctx.agentTasks.flows(p.name),
    flowDefaults: resolveFlows(ctx.tasks.columns(p.name), ctx.options),
  }
}
