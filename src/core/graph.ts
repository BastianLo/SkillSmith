/**
 * Knowledge graph over everything skillsmith keeps:
 *  - nodes: store entries ("skill:deploy-checklist", "memory:billing-entscheidung-…"),
 *    work states ("state:…"), results ("result:…"), sessions ("session:<id>");
 *  - stored edges: relations in the meta of store entries (git) and relations with
 *    a volatile end (state/memory.sqlite) – written by the doctor and the reviewers;
 *  - derived edges (computed, never stored): an entry mentions a script or another
 *    entry by name (uses / solves / related), merges (duplicates), superseded
 *    memories (supersedes), results of a branch (part_of), entries created in a
 *    session (derived_from).
 */
import type { Entry, Kind, Relation, RelationType } from "../types"
import { KINDS, key, SYMMETRIC_RELATIONS } from "../types"
import { sha, truncate } from "../util/text"
import { str } from "./frontmatter"
import { isPrivate, MEMORY_TYPE_LABEL, scriptFiles, spec } from "./kinds"
import type { MemoryDb, ResultMemory, WorkState } from "./memory-db"
import { stateId } from "./memory-db"
import type { HistoryRecord, SessionHistory } from "./session-history"
import type { Store } from "./store"

export type NodeKind = Kind | "arbeitsstand" | "ergebnis" | "session"

export interface GraphNode {
  id: string
  kind: NodeKind
  /** memory type (entscheidung, vorgabe, erfahrung) of durable memories */
  type?: string
  name: string
  title: string
  summary: string
  status?: string
  tier?: string
  project?: string
  projectName?: string
  date?: string
  /** content hash (stale detection of judged pairs) */
  hash: string
  /** full text (detail view, doctor) */
  text: string
}

export interface GraphEdge extends Relation {
  from: string
  /** stored (meta / memory db) or derived from content */
  derived?: boolean
}

export const RELATION_LABEL: Record<RelationType, string> = {
  not_related: "kein Bezug",
  related: "verwandt",
  supplements: "ergänzt",
  duplicates: "Duplikat von",
  contradicts: "widerspricht",
  supersedes: "löst ab",
  depends_on: "setzt voraus",
  part_of: "gehört zu",
  solves: "löst",
  caused_by: "verursacht durch",
  derived_from: "abgeleitet aus",
  uses: "nutzt",
  example_of: "Beispiel für",
  references: "verweist auf",
}

export function nodeLabel(kind: NodeKind, type?: string): string {
  if (kind === "memory") return MEMORY_TYPE_LABEL[type ?? ""] ?? "Erinnerung"
  if (kind === "arbeitsstand" || kind === "ergebnis" || kind === "session") return MEMORY_TYPE_LABEL[kind]
  return spec(kind).label
}

export function isStoreId(id: string): { kind: Kind; name: string } | undefined {
  const i = id.indexOf(":")
  if (i <= 0) return undefined
  const kind = id.slice(0, i) as Kind
  return KINDS.includes(kind) ? { kind, name: id.slice(i + 1) } : undefined
}

export function entryNode(e: Entry): GraphNode {
  const f = e.fields
  const isMemory = e.kind === "memory"
  return {
    id: key(e.kind, e.name),
    kind: e.kind,
    type: isMemory ? str(f.type) : undefined,
    name: e.name,
    title: e.kind === "skill" || e.kind === "script" ? e.name : e.title,
    summary: e.description,
    status: isMemory ? str(f.status) : e.kind === "error" ? str(f.status) : undefined,
    tier: e.tier,
    project: isMemory ? str(f.project) : undefined,
    projectName: isMemory ? str(f.project_name) : undefined,
    date: e.meta?.updatedAt ?? e.meta?.createdAt,
    hash: e.version,
    text: `${e.title}\n${e.description}\n${e.body}`,
  }
}

export function stateNode(s: WorkState): GraphNode {
  const lines = [
    s.goal ? `Ziel: ${s.goal}` : "",
    s.done.length ? `Erledigt:\n${s.done.map((x) => `- ${x}`).join("\n")}` : "",
    s.open.length ? `Offen:\n${s.open.map((x) => `- ${x}`).join("\n")}` : "",
    s.next.length ? `Nächste Schritte:\n${s.next.map((x) => `- ${x}`).join("\n")}` : "",
    s.files.length ? `Dateien: ${s.files.join(", ")}` : "",
  ].filter(Boolean)
  return {
    id: s.id,
    kind: "arbeitsstand",
    name: s.ticket || s.branch,
    title: `Arbeitsstand ${s.ticket || s.branch}`,
    summary: s.summary || s.goal,
    status: s.status,
    project: s.project,
    projectName: s.projectName,
    date: new Date(s.updatedAt).toISOString(),
    hash: sha(`${s.summary}|${s.updatedAt}`, 12),
    text: lines.join("\n\n"),
  }
}

export function resultNode(r: ResultMemory): GraphNode {
  return {
    id: r.id,
    kind: "ergebnis",
    name: r.id.slice(7),
    title: r.title,
    summary: truncate(r.answer.split("\n")[0] ?? "", 200),
    status: r.status,
    project: r.project,
    projectName: r.projectName,
    date: new Date(r.createdAt).toISOString(),
    hash: sha(`${r.title}|${r.answer}`, 12),
    text: [r.question ? `Frage: ${r.question}` : "", r.answer, r.files.length ? `Dateien: ${r.files.join(", ")}` : "", r.sources.length ? `Quellen: ${r.sources.join(", ")}` : ""]
      .filter(Boolean)
      .join("\n\n"),
  }
}

export function sessionNode(r: HistoryRecord): GraphNode {
  return {
    id: `session:${r.id}`,
    kind: "session",
    name: r.id,
    title: truncate(r.title && r.title.length >= 8 ? r.title : (r.requests[0] ?? r.id), 120),
    summary: r.requests[0] ?? "",
    project: r.project,
    projectName: r.project,
    date: r.at,
    hash: sha(r.at, 12),
    text: [
      ...r.requests.map((q) => `Anfrage: ${q}`),
      ...r.problems.map((p) => `Problem (${p.resolved ? "gelöst" : "ungelöst"}): ${p.error}${p.fix ? `\nLösung: ${p.fix}` : ""}`),
      r.outcome ? `Ergebnis: ${r.outcome}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  }
}

export class Graph {
  private derivedCache?: { revision: number; at: number; edges: GraphEdge[] }
  /** [[links]] between entries (derived edges "references") */
  links?: { pairs(): Array<{ from: string; to: string; label?: string }> }

  constructor(
    private store: Store,
    private mem?: MemoryDb,
    private history?: SessionHistory,
  ) {}

  /** Private store entries (KI-Recht privat) do not exist for the AI. */
  hidden(id: string): boolean {
    const s = isStoreId(id)
    if (!s) return false
    const e = this.store.getOwned(s.kind, s.name)
    return !!e && isPrivate(e)
  }

  node(id: string): GraphNode | undefined {
    const s = isStoreId(id)
    if (s) {
      const e = this.store.get(s.kind, s.name)
      return e ? entryNode(e) : undefined
    }
    if (id.startsWith("state:")) {
      const st = this.mem?.getState(id)
      return st ? stateNode(st) : undefined
    }
    if (id.startsWith("result:")) {
      const r = this.mem?.getResult(id)
      return r ? resultNode(r) : undefined
    }
    if (id.startsWith("session:")) {
      const r = this.history?.get(id.slice(8))
      return r ? sessionNode(r) : undefined
    }
    return undefined
  }

  /** All nodes (owned entries, work states, results; sessions only when an edge reaches them). */
  nodes(): GraphNode[] {
    const out: GraphNode[] = []
    for (const kind of KINDS) for (const e of this.store.list(kind)) out.push(entryNode(e))
    for (const s of this.mem?.states() ?? []) out.push(stateNode(s))
    for (const r of this.mem?.results() ?? []) out.push(resultNode(r))
    const sessions = new Set<string>()
    for (const e of this.allEdges()) for (const id of [e.from, e.to]) if (id.startsWith("session:")) sessions.add(id)
    for (const id of sessions) {
      const n = this.node(id)
      if (n) out.push(n)
    }
    return out
  }

  /** Stored edges: meta relations of owned entries + relations with a volatile end. */
  storedEdges(): GraphEdge[] {
    const out: GraphEdge[] = []
    for (const kind of KINDS) {
      for (const e of this.store.list(kind)) {
        for (const r of e.meta?.relations ?? []) out.push({ ...r, from: key(kind, e.name) })
      }
    }
    for (const r of this.mem?.allRelations() ?? []) out.push(r)
    return out
  }

  /** Edges derived from content (cached per store revision for 30 s). */
  derivedEdges(): GraphEdge[] {
    const rev = this.store.revision
    if (this.derivedCache && this.derivedCache.revision === rev && Date.now() - this.derivedCache.at < 30_000) return this.derivedCache.edges
    const edges: GraphEdge[] = []
    const at = new Date().toISOString()
    const add = (from: string, to: string, type: RelationType, strength: number, description: string) => {
      if (from === to) return
      if (edges.some((e) => e.from === from && e.to === to && e.type === type)) return
      edges.push({ from, to, type, strength, description, source: "deterministic", at, derived: true })
    }
    const scripts = this.store.list("script")
    const named = KINDS.filter((k) => k !== "glossary" && k !== "memory").flatMap((k) => this.store.list(k))
    for (const kind of KINDS) {
      for (const e of this.store.list(kind)) {
        const from = key(kind, e.name)
        const body = `${e.body}\n${str(e.fields.usage)}`
        // mentions of scripts: by name or module file
        for (const s of scripts) {
          if (s.name === e.name && kind === "script") continue
          const mod = scriptFiles(s.name).code
          const re = new RegExp(`(?<![A-Za-z0-9_-])(${escapeRe(s.name)}|${escapeRe(mod)})(?![A-Za-z0-9_-])`)
          if (!re.test(body)) continue
          if (kind === "error") add(key("script", s.name), from, "solves", 0.8, `Die Lösung von „${e.title}“ nutzt das Skript.`)
          else add(from, key("script", s.name), "uses", 0.8, `${spec(kind).label} ruft das Skript ${s.name} auf.`)
        }
        // mentions of other entries by name (distinctive names only)
        for (const o of named) {
          if (o.kind === "script" || o.name === e.name || o.name.split("-").length < 3) continue
          if (new RegExp(`(?<![A-Za-z0-9_-])${escapeRe(o.name)}(?![A-Za-z0-9_-])`).test(e.body)) {
            add(from, key(o.kind, o.name), "related", 0.5, `Erwähnt ${spec(o.kind).label} ${o.name}.`)
          }
        }
        if (e.meta?.absorbedInto) add(from, key(kind, e.meta.absorbedInto), "duplicates", 0.8, `Zusammengeführt in ${e.meta.absorbedInto}.`)
        const sup = str(e.fields.superseded_by)
        if (kind === "memory" && sup) add(key("memory", sup), from, "supersedes", 0.9, "Neuere Fassung löst diese Erinnerung ab.")
      }
    }
    for (const p of this.links?.pairs() ?? []) add(p.from, p.to, "references", 0.6, p.label ? `Verlinkt als „${p.label}“.` : "Verlinkt im Text.")
    for (const r of this.mem?.results() ?? []) {
      if (r.branch) {
        const sid = stateId(r.project, r.branch)
        if (this.mem?.getState(sid)) add(r.id, sid, "part_of", 0.6, `Ergebnis zur Arbeit an ${r.branch}.`)
      }
    }
    for (const rec of this.history?.all() ?? []) {
      for (const l of rec.links) {
        if (l.rel !== "new") continue
        if (!this.store.getOwned(l.kind, l.name)) continue
        add(key(l.kind, l.name), `session:${rec.id}`, "derived_from", 0.5, `Entstand in der Session vom ${rec.at.slice(0, 10)}.`)
      }
    }
    this.derivedCache = { revision: rev, at: Date.now(), edges }
    return edges
  }

  allEdges(): GraphEdge[] {
    const stored = this.storedEdges()
    const seen = new Set(stored.map((e) => pairId(e.from, e.to)))
    return [...stored, ...this.derivedEdges().filter((e) => !seen.has(pairId(e.from, e.to)))]
  }

  /** Edges touching a node (both directions), strongest first; not_related left out unless asked. */
  edgesOf(id: string, includeNotRelated = false): GraphEdge[] {
    return this.allEdges()
      .filter((e) => (e.from === id || e.to === id) && (includeNotRelated || e.type !== "not_related"))
      .sort((a, b) => b.strength - a.strength)
  }

  /** Any stored or derived relation between two nodes. */
  between(a: string, b: string): GraphEdge | undefined {
    return this.allEdges().find((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a))
  }

  /** Neighbourhood up to `depth` steps (BFS), edges at least `minStrength`. */
  neighbourhood(center: string, depth = 1, minStrength = 0, types?: RelationType[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const all = this.allEdges().filter((e) => e.type !== "not_related" && e.strength >= minStrength && (!types || types.includes(e.type)))
    const seen = new Set([center])
    let frontier = [center]
    const edges: GraphEdge[] = []
    for (let d = 0; d < depth; d++) {
      const next: string[] = []
      for (const e of all) {
        const f = frontier.includes(e.from)
        const t = frontier.includes(e.to)
        if (!f && !t) continue
        if (!edges.includes(e)) edges.push(e)
        for (const id of [e.from, e.to]) {
          if (!seen.has(id)) {
            seen.add(id)
            next.push(id)
          }
        }
      }
      frontier = next
      if (!frontier.length) break
    }
    const nodes = [...seen].map((id) => this.node(id)).filter((n): n is GraphNode => !!n)
    const ids = new Set(nodes.map((n) => n.id))
    return { nodes, edges: edges.filter((e) => ids.has(e.from) && ids.has(e.to)) }
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function pairId(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

/** Where a relation is stored: symmetric types on the smaller id. */
export function canonicalEdge(from: string, to: string, type: RelationType): { from: string; to: string } {
  if (SYMMETRIC_RELATIONS.has(type) && to < from) return { from: to, to: from }
  return { from, to }
}
