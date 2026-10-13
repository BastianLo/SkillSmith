/**
 * Inbox "Zu prüfen": everything that changed or waits for a decision, with the action next to
 * it. Every message type can be switched directly from the inbox (`inbox.types`):
 *
 *   an          listed
 *   gebuendelt  one collapsed row per group (expand to see the items)
 *   aus         not listed (counted under "ausgeblendet")
 *
 * Changes of the AI can also be switched per smith ("change.skillsmith"). Several changes of
 * the same entry form one row. Single messages can be dismissed ("erledigt"); they come back
 * when their content changes (signature). Dismissals are local (state/inbox.json).
 */
import { join } from "node:path"
import type { Entry } from "../types"
import { readJson, readText, withLock, writeJsonAtomic } from "../util/fs"
import { daysBetween, nowIso, sha, truncate } from "../util/text"
import type { Ctx } from "./context"
import { str } from "./frontmatter"
import { aiAccessOf, isOwnDoc, spec } from "./kinds"
import { SMITHS } from "./prompts"

const DAY = 86_400_000

export type InboxMode = "an" | "gebuendelt" | "aus"

export interface InboxTypeDef {
  type: string
  group: string
  label: string
  description: string
}

/** Every message type in display order (groups appear in the order of their first type). */
export const INBOX_TYPES: InboxTypeDef[] = [
  { type: "permission", group: "Agenten", label: "Rückfragen der Agenten", description: "Ein Agent wartet auf Ihre Antwort (einmal, immer, ablehnen)." },
  { type: "agent-proposal", group: "Agenten", label: "Pläne zur Freigabe", description: "Ein Agent hat einen Plan erstellt und wartet auf Freigabe." },
  { type: "agent-halted", group: "Agenten", label: "angehaltene Aufträge", description: "Ein Auftrag hat die höchste Zahl Rücksprünge erreicht und braucht Sie." },
  { type: "agent-done", group: "Agenten", label: "Umsetzung fertig", description: "Ein Auftrag ist umgesetzt und wartet auf die Abnahme." },
  { type: "conflict", group: "Konflikte", label: "Konflikte", description: "Der Doktor hat einen Widerspruch gefunden, den nur Sie entscheiden können." },
  { type: "proposal", group: "Vorschläge für Ihre Dokumente", label: "Vorschläge für Ihre Dokumente", description: "Die KI schlägt eine Änderung an einem Dokument mit KI-Recht „vorschlag“ vor." },
  { type: "pipeline", group: "Pipeline rot", label: "rote Pipeline", description: "Die Prüfbefehle einer offenen Aufgabe sind rot." },
  { type: "task-suggestion", group: "Aufgaben-Vorschläge", label: "Aufgaben-Vorschläge", description: "memorysmith schlägt eine Aufgabe vor („machen wir später“)." },
  { type: "decision", group: "Unbestätigte Entscheidungen", label: "unbestätigte Entscheidungen", description: "Eine Entscheidung ohne Ihr Zitat wartet auf Bestätigung." },
  { type: "rule", group: "Regeln aus Korrekturen", label: "Regeln aus Korrekturen", description: "Aus einer Korrektur könnte eine Vorgabe werden." },
  { type: "staged", group: "Zur Freigabe vorgemerkt", label: "vorgemerkte Änderungen", description: "Änderungen im Schreibmodus „stage“ warten auf Freigabe." },
  { type: "change", group: "Änderungen der KI", label: "Änderungen der KI", description: "Was Reviewer, Curator, Doktor und Agenten seit Ihrem letzten Besuch geändert haben." },
  { type: "job-failed", group: "Jobs", label: "fehlgeschlagene Jobs", description: "Ein wiederkehrender Job ist mit einem Fehler beendet worden." },
  { type: "review", group: "Fällige Prüfungen", label: "Erinnerungen prüfen", description: "Eine Erinnerung hat ihr Prüfdatum erreicht." },
  { type: "doc-due", group: "Fällige Prüfungen", label: "Wissen prüfen", description: "Wissen ist lange nicht bestätigt worden oder als möglicherweise veraltet markiert." },
  { type: "improve", group: "Zuerst verbessern", label: "zuerst verbessern", description: "Viel genutzt, aber mit Problemen – lohnt sich zuerst." },
  { type: "error-prone", group: "Fehleranfällig", label: "fehleranfällige Einträge", description: "Einträge, bei deren Einsatz oft Probleme auftraten." },
  { type: "test", group: "Rote Skript-Tests", label: "rote Skript-Tests", description: "Der Retest eines Skripts ist fehlgeschlagen." },
  { type: "broken-link", group: "Defekte Links", label: "defekte Links", description: "Ein [[Link]] zeigt auf einen Eintrag, den es nicht gibt." },
  { type: "abbreviation", group: "Offene Abkürzungen", label: "offene Abkürzungen", description: "Abkürzungen ohne bekannte Bedeutung." },
  { type: "project-doc", group: "Projekt-Doku prüfen", label: "Projekt-Doku prüfen", description: "docsmith hält eine Projekt-.md für veraltet." },
  { type: "stale", group: "Aufräumen", label: "Aufräumen", description: "Unvernetzt und lange ungenutzt – archivieren oder verknüpfen." },
]

/** Sub-types: changes of the AI per smith. */
export const CHANGE_SUBTYPES = SMITHS.map((s) => ({ type: `change.${s}`, label: `Änderungen von ${s}` }))

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
  /** smith of a change (sub-type "change.<smith>") */
  smith?: string
}

export interface InboxResult {
  since?: string
  items: InboxItem[]
  /** visible rows per group */
  counts: Record<string, number>
  /** groups shown as one collapsed row */
  bundled: string[]
  /** hidden by type ("aus") and dismissed */
  hidden: { byType: Record<string, number>; dismissed: number }
  /** every type with its mode (for the switches in the inbox) */
  types: Array<InboxTypeDef & { mode: InboxMode; count: number }>
  subtypes: Array<{ type: string; label: string; mode: InboxMode; count: number }>
  /** rows that count for the badge: listed items + one per bundled group */
  badge: number
}

interface InboxState {
  dismissed: Record<string, { at: string; sig: string }>
}

const stateFile = (ctx: Ctx) => join(ctx.store.stateDir, "inbox.json")
const visitFile = (ctx: Ctx) => join(ctx.store.stateDir, "web-visit.json")

export function lastVisit(ctx: Ctx): string | undefined {
  return readJson<{ inbox?: string }>(visitFile(ctx), {}).inbox
}

export function markVisited(ctx: Ctx): void {
  writeJsonAtomic(visitFile(ctx), { ...readJson<Record<string, string>>(visitFile(ctx), {}), inbox: nowIso() })
}

const signature = (it: Pick<InboxItem, "title" | "detail">) => sha(`${it.title}\u001f${it.detail ?? ""}`, 10)

/** Mode of a type ("change" with smith → "change.<smith>" first). */
export function modeOf(ctx: Ctx, type: string, smith?: string): InboxMode {
  const t = ctx.options.inbox.types
  return (smith ? t[`${type}.${smith}`] : undefined) ?? t[type] ?? "an"
}

/** Mark messages as done; they return when their content changes. */
export async function dismiss(ctx: Ctx, items: Array<{ id: string; sig?: string }>): Promise<number> {
  return withLock(ctx.store.locksDir, "inbox-state", () => {
    const st = readJson<InboxState>(stateFile(ctx), { dismissed: {} })
    const now = Date.now()
    for (const [id, d] of Object.entries(st.dismissed)) if (now - Date.parse(d.at) > 90 * DAY) delete st.dismissed[id]
    for (const it of items) st.dismissed[it.id] = { at: nowIso(), sig: it.sig ?? "" }
    writeJsonAtomic(stateFile(ctx), st)
    return items.length
  })
}

/** All raw messages (before modes and dismissals). */
export function collect(ctx: Ctx, since: string): InboxItem[] {
  const items: InboxItem[] = []
  const label = (id: string) => {
    const i = id.indexOf(":")
    const e = i > 0 ? ctx.store.getOwned(id.slice(0, i) as Entry["kind"], id.slice(i + 1)) : undefined
    return e?.title ?? id
  }
  // changes of the agents since the last visit (at most changesDays back), one row per entry
  const floor = new Date(Date.now() - ctx.options.inbox.changesDays * DAY).toISOString()
  const from = since > floor ? since : floor
  const byTarget = new Map<string, InboxItem & { data: { commit?: string; run?: string; seq: number; seqs: number[]; count: number } }>()
  for (const ev of ctx.audit?.query({ from, category: ["change"], actor: ["reviewer", "curator", "doctor", "agent"], limit: 2000 }).events ?? []) {
    const t = ev.targets[0]
    if (!t || t.startsWith("settings:")) continue
    const row = byTarget.get(t)
    if (row) {
      row.data.count++
      row.data.seqs.push(ev.seq)
      continue
    }
    byTarget.set(t, {
      id: `change-${t}`,
      type: "change",
      group: "Änderungen der KI",
      smith: ev.smith,
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
      data: { commit: ev.commit, run: ev.run, seq: ev.seq, seqs: [ev.seq], count: 1 },
    })
  }
  for (const row of byTarget.values()) {
    if (row.data.count > 1) row.detail = `${row.data.count} Änderungen · zuletzt: ${truncate(row.detail ?? "", 200)}`
    items.push(row)
  }
  // proposals and staged changes
  for (const s of ctx.ops.staged()) {
    items.push({
      id: `staged-${s.id}`,
      type: s.aiProposal ? "proposal" : "staged",
      group: s.aiProposal ? "Vorschläge für Ihre Dokumente" : "Zur Freigabe vorgemerkt",
      smith: s.smith,
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
  for (const [id, u] of Object.entries(ctx.usage.all())) {
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
  items.push(...ctx.agentTasks.inboxItems())
  for (const r of ctx.agentTasks.rules().filter((x) => x.status === "candidate")) {
    items.push({ id: `rule-${r.id}`, type: "rule", group: "Regeln aus Korrekturen", title: r.text, detail: `${r.kind === "skill" ? "Skill-Änderung" : "Vorgabe"}${r.project ? ` · ${r.project}` : ""}${r.task ? ` · ${r.task.toUpperCase()}` : ""}`, severity: "info", actions: [{ action: "rule.decide", label: "Bestätigen", args: { id: r.id, decision: "confirm" } }, { action: "rule.decide", label: "Verwerfen", args: { id: r.id, decision: "dismiss" } }] })
  }
  for (const t of ctx.tasks.list({ project: "*" }).filter((x) => x.suggested)) {
    items.push({ id: `suggest-${t.name}`, type: "task-suggestion", group: "Aufgaben-Vorschläge", title: `${t.id} ${t.title}`, detail: t.description, target: t.key, severity: "info", actions: [{ action: "task.acceptSuggestion", label: "Einplanen", target: t.key }, { action: "task.dismissSuggestion", label: "Verwerfen", target: t.key }] })
  }
  for (const t of ctx.tasks.list({ project: "*" }).filter((x) => x.pipeline?.status === "failed" && !ctx.tasks.isDone(x.status, x.project))) {
    items.push({ id: `pipe-${t.name}`, type: "pipeline", group: "Pipeline rot", title: `${t.id} ${t.title}`, target: t.key, severity: "warn", actions: [{ action: "pipeline.start", label: "Erneut starten", args: { project: t.project, task: t.name } }] })
  }
  // failed jobs (last run of each job)
  for (const j of ctx.jobs?.list() ?? []) {
    const last = j.last as { id: string; status: string; error?: string; endedAt?: string } | null
    if (last?.status !== "error") continue
    items.push({ id: `job-${last.id}`, type: "job-failed", group: "Jobs", title: `Job „${j.label}“ fehlgeschlagen`, detail: truncate(last.error ?? "", 300), at: last.endedAt, severity: "warn", actions: [{ action: "job.run", label: "Erneut ausführen", args: { id: j.id } }], data: { job: j.id, run: last.id } })
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
  return items
}

/** The inbox with modes and dismissals applied. */
export function inbox(ctx: Ctx, opts: { since?: string } = {}): InboxResult {
  const since = opts.since ?? lastVisit(ctx) ?? new Date(Date.now() - 7 * DAY).toISOString()
  const all = collect(ctx, since)
  const dismissed = readJson<InboxState>(stateFile(ctx), { dismissed: {} }).dismissed
  const byType: Record<string, number> = {}
  const countOf: Record<string, number> = {}
  let dismissedCount = 0
  const items: InboxItem[] = []
  for (const it of all) {
    countOf[it.type] = (countOf[it.type] ?? 0) + 1
    if (it.smith && it.type === "change") countOf[`change.${it.smith}`] = (countOf[`change.${it.smith}`] ?? 0) + 1
    const d = dismissed[it.id]
    if (d && d.sig === signature(it)) {
      dismissedCount++
      continue
    }
    if (modeOf(ctx, it.type, it.type === "change" ? it.smith : undefined) === "aus") {
      byType[it.type] = (byType[it.type] ?? 0) + 1
      continue
    }
    items.push({ ...it, data: { ...((it.data as object) ?? {}), sig: signature(it) } })
  }
  const order = new Map(INBOX_TYPES.map((t, i) => [t.type, i]))
  items.sort((a, b) => (order.get(a.type) ?? 99) - (order.get(b.type) ?? 99) || (b.at ?? "").localeCompare(a.at ?? ""))
  // a group is bundled when all of its visible types are "gebuendelt"
  const groups = new Map<string, InboxItem[]>()
  for (const it of items) (groups.get(it.group) ?? groups.set(it.group, []).get(it.group)!).push(it)
  const bundled = [...groups.entries()].filter(([, list]) => list.every((it) => modeOf(ctx, it.type, it.type === "change" ? it.smith : undefined) === "gebuendelt")).map(([g]) => g)
  const counts: Record<string, number> = {}
  for (const [g, list] of groups) counts[g] = list.length
  const max = ctx.options.inbox.maxPerGroup
  const limited = [...groups.values()].flatMap((list) => list.slice(0, max))
  const badge = [...groups.entries()].reduce((n, [g, list]) => n + (bundled.includes(g) ? 1 : list.length), 0)
  return {
    since,
    items: limited,
    counts,
    bundled,
    hidden: { byType, dismissed: dismissedCount },
    types: INBOX_TYPES.map((t) => ({ ...t, mode: modeOf(ctx, t.type), count: countOf[t.type] ?? 0 })),
    subtypes: CHANGE_SUBTYPES.map((s) => ({ ...s, mode: modeOf(ctx, "change", s.type.slice("change.".length)), count: countOf[s.type] ?? 0 })),
    badge,
  }
}
