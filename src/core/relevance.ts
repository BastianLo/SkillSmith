/**
 * Relevance of graph nodes (idea 28): node size = how relevant an entry is today.
 *
 *   usage (50 %)       decayed uses from the metrics event log (loads, followed hints, script runs,
 *                      helpful error hints ×2, shown hints 0.1, opened in the web view 0.3);
 *                      at most 2 per session, background agents never count.
 *                      Without SQLite: usage.json totals (no decay).
 *   network (35 %)     weighted PageRank over stored and derived edges (strength; derived ×0.5;
 *                      contradicts / not_related ignored).
 *   importance (15 %)  pinned, valid decision/convention, evidence, backlinks from the user's
 *                      own documents and tasks.
 *
 * Counts are damped (log1p) and ranked within the node's own kind (or across all kinds),
 * so skills do not dwarf memories. The ring is a second, independent dimension: green
 * (hints followed / error hints help), orange (issues, hints without effect), red (open conflict).
 */
import type { Options } from "../config"
import type { GraphEdge, GraphNode } from "./graph"
import { isStoreId } from "./graph"
import type { MemoryDb } from "./memory-db"
import { M, type Metrics } from "./metrics"
import type { UsageStore } from "./state"

export type Ring = "good" | "warn" | "critical" | undefined

export interface Relevance {
  id: string
  /** 0–1 */
  score: number
  usage: number
  network: number
  importance: number
  /** raw values behind the components (tooltips) */
  raw: { uses: number; sessions: number; hintsFollowed: number; hintsShown: number; edges: number; pagerank: number; networkPercentile: number; backlinks: number }
  ring: Ring
  ringReason?: string
  isNew: boolean
  faded: boolean
  pinned: boolean
  explain: string
}

export interface RelevanceOptions {
  /** "current": decayed, "total": all-time */
  window?: "current" | "total"
  /** rank across all kinds instead of within the kind */
  acrossKinds?: boolean
  now?: number
}

const USE_WEIGHTS: Record<string, number> = {
  [M.load]: 1,
  [M.hintFollowed]: 1,
  [M.scriptRun]: 1,
  [M.hintHelped]: 2,
  [M.hintShown]: 0.1,
  [M.view]: 0.3,
}

/** Weighted PageRank (damping 0.85). Directed edges carry their full weight forward and 30 % back. */
export function pageRank(ids: string[], edges: Array<{ from: string; to: string; weight: number; symmetric?: boolean }>, iterations = 40, damping = 0.85): Map<string, number> {
  const n = ids.length
  const index = new Map(ids.map((id, i) => [id, i]))
  const out: Array<Array<[number, number]>> = ids.map(() => [])
  const add = (a: number, b: number, w: number) => {
    if (w > 0 && a !== b) out[a].push([b, w])
  }
  for (const e of edges) {
    const a = index.get(e.from)
    const b = index.get(e.to)
    if (a === undefined || b === undefined) continue
    add(a, b, e.weight)
    add(b, a, e.symmetric ? e.weight : e.weight * 0.3)
  }
  const outSum = out.map((l) => l.reduce((s, [, w]) => s + w, 0))
  let rank = new Float64Array(n).fill(n ? 1 / n : 0)
  for (let it = 0; it < iterations; it++) {
    const next = new Float64Array(n).fill((1 - damping) / Math.max(1, n))
    let dangling = 0
    for (let i = 0; i < n; i++) {
      if (!outSum[i]) {
        dangling += rank[i]
        continue
      }
      for (const [j, w] of out[i]) next[j] += (damping * rank[i] * w) / outSum[i]
    }
    if (dangling) for (let i = 0; i < n; i++) next[i] += (damping * dangling) / n
    rank = next
  }
  return new Map(ids.map((id, i) => [id, rank[i]]))
}

/** Percentile rank (0–1) of each value within its group; ties share the mean rank; all-zero → 0. */
export function percentileRanks(values: Map<string, number>, groupOf: (id: string) => string): Map<string, number> {
  const groups = new Map<string, Array<[string, number]>>()
  for (const [id, v] of values) {
    const g = groupOf(id)
    const list = groups.get(g) ?? []
    list.push([id, v])
    groups.set(g, list)
  }
  const out = new Map<string, number>()
  for (const list of groups.values()) {
    const sorted = [...list].sort((a, b) => a[1] - b[1])
    const max = sorted[sorted.length - 1]?.[1] ?? 0
    let i = 0
    while (i < sorted.length) {
      let j = i
      while (j + 1 < sorted.length && sorted[j + 1][1] === sorted[i][1]) j++
      const r = sorted.length === 1 ? 1 : ((i + j) / 2) / (sorted.length - 1)
      for (let k = i; k <= j; k++) out.set(sorted[k][0], max <= 0 || sorted[k][1] <= 0 ? 0 : r)
      i = j + 1
    }
  }
  return out
}

export class RelevanceEngine {
  private cache?: { key: string; at: number; map: Map<string, Relevance> }

  constructor(
    private options: Options,
    private usage: UsageStore,
    private metrics: Metrics | undefined,
    private mem: MemoryDb | undefined,
  ) {}

  /** Relevance for every node of a graph snapshot (cached 20 s per window/mode/graph size). */
  compute(nodes: GraphNode[], edges: GraphEdge[], opts: RelevanceOptions = {}, extra: { backlinks?: Map<string, number>; ownDocs?: Set<string>; pinned?: Set<string>; evidence?: Map<string, number> } = {}): Map<string, Relevance> {
    const now = opts.now ?? Date.now()
    const window = opts.window ?? "current"
    const key = `${window}|${opts.acrossKinds ? 1 : 0}|${nodes.length}|${edges.length}`
    if (this.cache && this.cache.key === key && now - this.cache.at < 20_000 && !opts.now) return this.cache.map
    const cfg = this.options.graph.relevance
    const ids = nodes.map((n) => n.id)
    const byId = new Map(nodes.map((n) => [n.id, n]))
    // usage
    const useScore = new Map<string, number>()
    const raw = new Map<string, Relevance["raw"]>()
    const rawOf = (id: string) => {
      let r = raw.get(id)
      if (!r) {
        r = { uses: 0, sessions: 0, hintsFollowed: 0, hintsShown: 0, edges: 0, pagerank: 0, networkPercentile: 0, backlinks: 0 }
        raw.set(id, r)
      }
      return r
    }
    const totals = this.metrics?.available ? this.metrics.totalsByEntry([M.hintFollowed, M.hintShown, M.hintHelped, M.hintFailed, M.feedbackIssue, M.feedbackOk], window === "current" ? 90 : 0, undefined, now) : undefined
    if (this.metrics?.available && window === "current") {
      for (const [id, u] of this.metrics.decayedUse(cfg.halfLifeDays, USE_WEIGHTS, now)) {
        useScore.set(id, u.score)
        const r = rawOf(id)
        r.uses = u.uses
        r.sessions = u.sessions
      }
    } else if (this.metrics?.available) {
      for (const [id, t] of this.metrics.totalsByEntry(Object.keys(USE_WEIGHTS), 0, undefined, now)) {
        let s = 0
        for (const [type, n] of Object.entries(t)) s += (USE_WEIGHTS[type] ?? 0) * n
        useScore.set(id, s)
        rawOf(id).uses = (t[M.load] ?? 0) + (t[M.hintFollowed] ?? 0) + (t[M.scriptRun] ?? 0) + (t[M.hintHelped] ?? 0)
      }
    } else {
      for (const [id, u] of Object.entries(this.usage.all())) {
        const s = u.loads + u.hintsFollowed + 2 * (u.helped ?? 0) + 0.1 * u.hintsShown
        useScore.set(id, s)
        rawOf(id).uses = u.loads + u.hintsFollowed + (u.helped ?? 0)
      }
    }
    const usageFile = this.usage.all()
    for (const id of ids) {
      const r = rawOf(id)
      const t = totals?.get(id)
      const u = usageFile[id]
      r.hintsFollowed = t ? (t[M.hintFollowed] ?? 0) : (u?.hintsFollowed ?? 0)
      r.hintsShown = t ? (t[M.hintShown] ?? 0) : (u?.hintsShown ?? 0)
    }
    // network
    const prEdges: Array<{ from: string; to: string; weight: number; symmetric?: boolean }> = []
    for (const e of edges) {
      if (e.type === "contradicts" || e.type === "not_related") continue
      const w = Math.max(0, Math.min(1, e.strength)) * (e.derived ? 0.5 : 1)
      prEdges.push({ from: e.from, to: e.to, weight: w, symmetric: e.type === "related" || e.type === "duplicates" })
      if (byId.has(e.from)) rawOf(e.from).edges++
      if (byId.has(e.to)) rawOf(e.to).edges++
    }
    const pr = pageRank(ids, prEdges)
    // importance
    const imp = new Map<string, number>()
    for (const n of nodes) {
      let v = 0
      const pinned = extra.pinned?.has(n.id) ?? false
      if (pinned) v += 0.4
      if (n.kind === "memory" && (n.type === "entscheidung" || n.type === "vorgabe") && n.status === "gueltig") v += 0.3
      const ev = extra.evidence?.get(n.id) ?? 0
      v += Math.min(1, ev / 5) * 0.15
      const bl = extra.backlinks?.get(n.id) ?? 0
      rawOf(n.id).backlinks = bl
      v += Math.min(1, bl / 3) * 0.3
      if (extra.ownDocs?.has(n.id)) v += 0.15
      imp.set(n.id, Math.min(1, v))
    }
    // damp + rank
    const groupOf = opts.acrossKinds ? () => "all" : (id: string) => byId.get(id)?.kind ?? "other"
    const damped = new Map(ids.map((id) => [id, Math.log1p(useScore.get(id) ?? 0)]))
    const usageRank = percentileRanks(damped, groupOf)
    const netRank = percentileRanks(new Map(ids.map((id) => [id, (pr.get(id) ?? 0) * ids.length])), groupOf)
    const netAll = percentileRanks(new Map(ids.map((id) => [id, pr.get(id) ?? 0])), () => "all")
    const w = cfg.weights
    const wsum = w.usage + w.network + w.importance || 1
    const conflicts = this.openConflicts()
    const map = new Map<string, Relevance>()
    for (const n of nodes) {
      const r = rawOf(n.id)
      r.pagerank = pr.get(n.id) ?? 0
      r.networkPercentile = netAll.get(n.id) ?? 0
      const usage = usageRank.get(n.id) ?? 0
      // a node without any edge has no network value at all
      const network = r.edges ? (netRank.get(n.id) ?? 0) : 0
      const importance = imp.get(n.id) ?? 0
      let score = (w.usage * usage + w.network * network + w.importance * importance) / wsum
      const pinned = extra.pinned?.has(n.id) ?? false
      const created = n.date ? Date.parse(n.date) : NaN
      const isNew = Number.isFinite(created) && now - created < cfg.newDays * 86_400_000 && !r.uses
      const faded = n.tier === "archive" || n.status === "abgeloest" || n.status === "abgelaufen"
      if (pinned) score = Math.max(score, 0.5)
      if (faded) score = Math.min(score, 0.1)
      const ring = this.ringOf(n, r, totals?.get(n.id), usageFile[n.id], conflicts)
      map.set(n.id, {
        id: n.id,
        score: Math.max(0, Math.min(1, score)),
        usage,
        network,
        importance,
        raw: r,
        ring: ring?.ring,
        ringReason: ring?.reason,
        isNew,
        faded,
        pinned,
        explain: explainOf(r, network),
      })
    }
    if (!opts.now) this.cache = { key, at: now, map }
    return map
  }

  private openConflicts(): Set<string> {
    const out = new Set<string>()
    try {
      for (const c of this.mem?.conflicts(["open", "needs_user"]) ?? []) {
        out.add(c.a)
        out.add(c.b)
      }
    } catch {
      // ignore
    }
    return out
  }

  private ringOf(
    n: GraphNode,
    r: Relevance["raw"],
    t: Record<string, number> | undefined,
    u: { reviewedLoads: number; loadsWithIssues: number; helped?: number; failed?: number } | undefined,
    conflicts: Set<string>,
  ): { ring: Ring; reason: string } | undefined {
    if (conflicts.has(n.id)) return { ring: "critical", reason: "offener Konflikt beim Doktor" }
    const reviewed = t ? (t[M.feedbackOk] ?? 0) + (t[M.feedbackIssue] ?? 0) : (u?.reviewedLoads ?? 0)
    const issues = t ? (t[M.feedbackIssue] ?? 0) : (u?.loadsWithIssues ?? 0)
    if (reviewed >= this.options.needsReviewMinLoads && issues / reviewed >= this.options.needsReviewRate) {
      return { ring: "warn", reason: `Probleme bei ${issues} von ${reviewed} Einsätzen` }
    }
    const helped = t ? (t[M.hintHelped] ?? 0) : (u?.helped ?? 0)
    const failed = t ? (t[M.hintFailed] ?? 0) : (u?.failed ?? 0)
    if (n.kind === "error" && failed >= 2 && failed > helped) return { ring: "warn", reason: `Hinweis half ${helped}×, nicht ${failed}×` }
    if (r.hintsShown >= 8 && r.hintsFollowed === 0 && n.kind !== "glossary") return { ring: "warn", reason: `${r.hintsShown} Hinweise ohne Wirkung` }
    if (helped > 0 && helped >= failed) return { ring: "good", reason: `Hinweis half ${helped}×` }
    if (r.hintsFollowed > 0 && r.hintsFollowed / Math.max(1, r.hintsShown) >= 0.2) return { ring: "good", reason: `${r.hintsFollowed} von ${r.hintsShown} Hinweisen befolgt` }
    return undefined
  }

  /**
   * Decayed usage score of one entry over time (weekly points) – the small relevance curve
   * of the detail view. Uses the raw event log only.
   */
  curve(id: string, weeks = 12, now = Date.now()): Array<{ at: number; value: number }> {
    if (!this.metrics?.available) return []
    const half = this.options.graph.relevance.halfLifeDays * 86_400_000
    const from = now - (weeks * 7 + this.options.graph.relevance.halfLifeDays * 4) * 86_400_000
    const events = this.metrics.events({ entry: id, types: Object.keys(USE_WEIGHTS), from, limit: 50_000 })
    const out: Array<{ at: number; value: number }> = []
    for (let i = weeks; i >= 0; i--) {
      const t = now - i * 7 * 86_400_000
      let v = 0
      for (const e of events) if (e.at <= t && e.origin !== "background") v += (USE_WEIGHTS[e.type] ?? 0) * Math.pow(0.5, (t - e.at) / half)
      out.push({ at: t, value: Math.round(v * 100) / 100 })
    }
    return out
  }
}

function explainOf(r: Relevance["raw"], network: number): string {
  const parts: string[] = []
  if (r.uses) parts.push(`genutzt ${r.uses}×${r.sessions ? ` in ${r.sessions} Session${r.sessions === 1 ? "" : "s"}` : ""}`)
  if (r.hintsFollowed) parts.push(`${r.hintsFollowed} Hinweis${r.hintsFollowed === 1 ? "" : "e"} befolgt`)
  if (r.edges) parts.push(`${r.edges} Verknüpfung${r.edges === 1 ? "" : "en"}`)
  if (r.backlinks) parts.push(`${r.backlinks} Rückverweis${r.backlinks === 1 ? "" : "e"} aus eigenen Dokumenten`)
  if (network > 0 && r.networkPercentile >= 0.9) parts.push("Vernetzung unter den obersten 10 %")
  else if (network > 0 && r.networkPercentile >= 0.75) parts.push("Vernetzung im oberen Viertel")
  return parts.join(", ") || "noch keine Nutzung, keine Verknüpfungen"
}

/** Node radius from relevance (area-proportional). */
export function radiusOf(score: number, min = 6, max = 28): number {
  return min + (max - min) * Math.sqrt(Math.max(0, Math.min(1, score)))
}

/** Evidence counts and pins of store entries (inputs of the importance component). */
export function storeExtras(nodes: GraphNode[], getMeta: (kind: string, name: string) => { pinned?: boolean; evidence?: unknown[] } | undefined): { pinned: Set<string>; evidence: Map<string, number> } {
  const pinned = new Set<string>()
  const evidence = new Map<string, number>()
  for (const n of nodes) {
    const s = isStoreId(n.id)
    if (!s) continue
    const m = getMeta(s.kind, s.name)
    if (m?.pinned) pinned.add(n.id)
    if (m?.evidence?.length) evidence.set(n.id, m.evidence.length)
  }
  return { pinned, evidence }
}
