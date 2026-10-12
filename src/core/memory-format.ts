/**
 * Text forms of memories for prompts, tools, hints and commands:
 * work states, durable memories (lists and full entries), relations,
 * and the stand block that opens a new session.
 */
import type { Entry } from "../types"
import { key } from "../types"
import { truncate } from "../util/text"
import { str } from "./frontmatter"
import { nodeLabel, RELATION_LABEL, type Graph, type GraphEdge } from "./graph"
import { MEMORY_TYPE_LABEL } from "./kinds"
import type { ResultMemory, WorkState } from "./memory-db"
import type { Scope } from "./scope"

export function ageLabel(ms: number, now = Date.now()): string {
  const d = Math.floor((now - ms) / 86_400_000)
  if (d <= 0) return "heute"
  if (d === 1) return "gestern"
  return `vor ${d} Tagen`
}

export function formatState(s: WorkState, opts: { history?: boolean } = {}): string {
  const lines = [
    `Arbeitsstand ${s.ticket ? `${s.ticket} · ` : ""}Branch ${s.branch} (${s.projectName || s.project}) – ${ageLabel(s.updatedAt)}${s.status !== "gueltig" ? ` [${s.status}]` : ""}`,
    s.goal ? `Ziel: ${s.goal}` : "",
    s.done.length ? `Erledigt:\n${s.done.map((x) => `- ${x}`).join("\n")}` : "",
    s.open.length ? `Offen:\n${s.open.map((x) => `- ${x}`).join("\n")}` : "",
    s.next.length ? `Nächste Schritte:\n${s.next.map((x) => `- ${x}`).join("\n")}` : "",
    s.files.length ? `Dateien: ${s.files.join(", ")}` : "",
  ]
  if (opts.history && s.history.length) {
    lines.push(`Frühere Stände:\n${s.history.slice(0, 5).map((h) => `- ${new Date(h.at).toISOString().slice(0, 10)}: ${truncate(h.summary, 160)}`).join("\n")}`)
  }
  return lines.filter(Boolean).join("\n")
}

export function memoryLine(e: Entry): string {
  const f = e.fields
  const type = str(f.type)
  const status = str(f.status)
  const due = type === "entscheidung" && str(f.review_after) && str(f.review_after) < new Date().toISOString().slice(0, 10)
  const flags = [MEMORY_TYPE_LABEL[type] ?? type, status && status !== "gueltig" ? status : "", e.tier !== "active" ? e.tier : "", str(f.scope) === "global" ? "global" : "", due ? "prüfen?" : ""].filter(Boolean)
  return `memory:${e.name} [${flags.join(", ")}] ${truncate(e.title, 90)} – ${truncate(e.description, 160)}`
}

export function formatMemoryList(entries: Entry[], opts: { withBody?: boolean; bodyChars?: number } = {}): string {
  return entries
    .map((e) => {
      const head = `- ${memoryLine(e)} (topic ${str(e.fields.topic)}${e.meta?.updatedAt ? `, ${e.meta.updatedAt.slice(0, 10)}` : ""})`
      return opts.withBody ? `${head}\n${truncate(e.body.trim(), opts.bodyChars ?? 700).split("\n").map((l) => `    ${l}`).join("\n")}` : head
    })
    .join("\n")
}

export function formatResult(r: ResultMemory, full = false): string {
  const head = `${r.id} [Ergebnis${r.status !== "gueltig" ? `, ${r.status}` : ""}] ${r.title} – ${ageLabel(r.createdAt)}${r.branch ? `, Branch ${r.branch}` : ""}`
  if (!full) return `${head}\n   ${truncate(r.answer.split("\n").find((l) => l.trim()) ?? "", 200)}`
  return [
    head,
    r.question ? `Frage: ${r.question}` : "",
    r.answer,
    r.files.length ? `Dateien: ${r.files.join(", ")}` : "",
    r.sources.length ? `Quellen: ${r.sources.join(", ")}` : "",
    r.tags.length ? `tags: ${r.tags.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

/** "→ löst ab memory:x (0.9) – description" lines for one node. */
export function relationLines(graph: Graph, id: string, max = 20): string[] {
  const edges = graph
    .edgesOf(id)
    .filter((e) => !graph.hidden(e.from) && !graph.hidden(e.to))
    .slice(0, max)
  return edges.map((e) => relationLine(graph, id, e))
}

export function relationLine(graph: Graph, id: string, e: GraphEdge): string {
  const out = e.from === id
  const other = out ? e.to : e.from
  const n = graph.node(other)
  const label = RELATION_LABEL[e.type] ?? e.type
  const title = n ? `${nodeLabel(n.kind, n.type)} „${truncate(n.title, 70)}“` : "(nicht mehr vorhanden)"
  return `${out ? "→" : "←"} ${out ? label : `${label} (eingehend)`} ${other} ${title} · Stärke ${e.strength.toFixed(1)}${e.derived ? " · abgeleitet" : ""}${e.description ? ` – ${truncate(e.description, 160)}` : ""}`
}

/** Full text of a durable memory (memory_read, /memory). */
export function formatMemoryEntry(e: Entry, graph?: Graph): string {
  const f = e.fields
  const type = str(f.type)
  const lines = [
    `<memory id="memory:${e.name}" type="${type}" status="${str(f.status)}" tier="${e.tier}" version="${e.version}">`,
    `# ${e.title}`,
    e.description,
    `Art: ${MEMORY_TYPE_LABEL[type] ?? type} · Gültigkeit: ${str(f.scope) === "global" ? "global" : `Projekt ${str(f.project_name) || str(f.project)}`}${str(f.branch) ? ` · Branch ${str(f.branch)}` : ""}${str(f.ticket) ? ` · Ticket ${str(f.ticket)}` : ""}`,
    `Thema: ${str(f.topic)} · gültig seit ${str(f.valid_from) || "?"}${str(f.review_after) ? ` · prüfen nach ${str(f.review_after)}` : ""}${type === "entscheidung" ? ` · entschieden von ${str(f.decided_by) === "agent" ? "Agent (unbestätigt)" : "Nutzer"}` : ""}`,
    str(f.superseded_by) ? `⚠ abgelöst durch memory:${str(f.superseded_by)} – diese Fassung gilt nicht mehr.` : "",
    e.tags.length ? `tags: ${e.tags.join(", ")}` : "",
    e.meta?.evidence?.length ? `Belege:\n${e.meta.evidence.slice(-3).map((ev) => `  - ${ev.at.slice(0, 10)} (${ev.source}): „${truncate(ev.text, 200)}“`).join("\n")}` : "",
    "",
    e.body,
  ]
  if (graph) {
    const rel = relationLines(graph, key("memory", e.name), 12)
    if (rel.length) lines.push("", "Verknüpfungen:", ...rel.map((l) => `  ${l}`))
  }
  lines.push("</memory>")
  return lines.filter((l, i) => l !== "" || i > 5).join("\n")
}

export interface StandParts {
  state?: WorkState
  conventions: Entry[]
  decisions: Entry[]
}

/** Memories that open a session: work state of the branch, conventions, valid decisions. */
export function standParts(entries: Entry[], scope: Scope, state?: WorkState, crossProject = false): StandParts {
  const inScope = (e: Entry) => {
    const p = str(e.fields.project)
    return !p || p === scope.project || crossProject
  }
  const active = entries.filter((e) => e.tier === "active" && inScope(e) && str(e.fields.status) !== "abgeloest")
  const byDate = (a: Entry, b: Entry) => (b.meta?.updatedAt ?? "").localeCompare(a.meta?.updatedAt ?? "")
  return {
    state,
    conventions: active.filter((e) => str(e.fields.type) === "vorgabe").sort(byDate),
    decisions: active.filter((e) => str(e.fields.type) === "entscheidung" && str(e.fields.status) === "gueltig").sort(byDate),
  }
}

/** `<smith_memory>` block (≤ maxChars) or undefined when there is nothing to say. */
export function formatStand(parts: StandParts, scope: Scope, maxChars: number): string | undefined {
  const sections: string[] = []
  const s = parts.state
  if (s) {
    const lines = [`Arbeitsstand (${ageLabel(s.updatedAt)}, ${s.ticket ? `${s.ticket}, ` : ""}Branch ${s.branch}):`]
    if (s.goal) lines.push(`- Ziel: ${truncate(s.goal, 200)}`)
    for (const x of s.open.slice(0, 5)) lines.push(`- offen: ${truncate(x, 160)}`)
    for (const x of s.next.slice(0, 3)) lines.push(`- als Nächstes: ${truncate(x, 160)}`)
    sections.push(lines.join("\n"))
  }
  if (parts.conventions.length) {
    sections.push(`Vorgaben:\n${parts.conventions.slice(0, 8).map((e) => `- ${truncate(e.title, 110)}${str(e.fields.scope) === "global" ? " (global)" : ""} [memory:${e.name}]`).join("\n")}`)
  }
  if (parts.decisions.length) {
    sections.push(`Entscheidungen:\n${parts.decisions.slice(0, 5).map((e) => `- ${truncate(e.title, 110)} [memory:${e.name}]`).join("\n")}`)
  }
  if (!sections.length) return undefined
  const head = `<smith_memory source="memorysmith" project="${scope.projectName}"${scope.branch ? ` branch="${scope.branch}"` : ""}>\nRemembered for this project – current unless the user says otherwise (details: memory_read):\n`
  const tail = "\n</smith_memory>"
  let body = sections.join("\n")
  const room = Math.max(200, maxChars - head.length - tail.length)
  if (body.length > room) body = `${body.slice(0, room - 2).replace(/\n[^\n]*$/, "")}\n…`
  return head + body + tail
}
