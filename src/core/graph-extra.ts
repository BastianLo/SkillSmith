/**
 * Graph extensions (idea 8) and the semantic map (idea 9):
 *  - shortest path between two nodes (stored and derived edges, not_related ignored),
 *  - time travel: entries and stored relations as they were at a date (from git),
 *  - 2D projection of the embeddings (PCA by power iteration); without embeddings the
 *    TF-IDF vectors of the full-text index are projected (BM25 fallback).
 */
import type { Kind } from "../types"
import { KINDS } from "../types"
import type { Ctx } from "./context"
import { spec } from "./kinds"
import type { GraphEdge } from "./graph"
import { entryOfPath } from "./versions"

export function shortestPath(edges: GraphEdge[], from: string, to: string, maxDepth = 8): GraphEdge[] | undefined {
  if (from === to) return []
  const adj = new Map<string, Array<{ to: string; e: GraphEdge }>>()
  for (const e of edges) {
    if (e.type === "not_related") continue
    ;(adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push({ to: e.to, e })
    ;(adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push({ to: e.from, e })
  }
  const prev = new Map<string, { node: string; e: GraphEdge }>()
  const seen = new Set([from])
  let frontier = [from]
  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next: string[] = []
    for (const n of frontier) {
      for (const { to: m, e } of adj.get(n) ?? []) {
        if (seen.has(m)) continue
        seen.add(m)
        prev.set(m, { node: n, e })
        if (m === to) {
          const path: GraphEdge[] = []
          let cur = to
          while (cur !== from) {
            const p = prev.get(cur)!
            path.unshift(p.e)
            cur = p.node
          }
          return path
        }
        next.push(m)
      }
    }
    frontier = next
  }
  return undefined
}

/** Entries and stored relations at a date (the last commit before the end of that day). */
export async function graphAt(ctx: Ctx, date: string): Promise<{ commit?: string; nodes: Array<{ id: string; kind: Kind; name: string; tier?: string; title: string }>; edges: Array<{ from: string; to: string; type: string; strength: number }> }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Datum als JJJJ-MM-TT")
  if (!(await ctx.git.init())) return { nodes: [], edges: [] }
  const rev = (await ctx.git.git(["rev-list", "-n1", `--before=${date}T23:59:59`, "HEAD"])).stdout.trim()
  if (!rev) return { nodes: [], edges: [] }
  const files = (await ctx.git.git(["ls-tree", "-r", "--name-only", rev])).stdout.split("\n").filter(Boolean)
  const nodes = new Map<string, { id: string; kind: Kind; name: string; tier?: string; title: string }>()
  const metas: string[] = []
  for (const f of files) {
    const e = entryOfPath(f)
    if (!e) continue
    if (e.meta) metas.push(f)
    else if (spec(e.kind).layout === "file" || f.endsWith(`/${spec(e.kind).main}`)) nodes.set(`${e.kind}:${e.name}`, { id: `${e.kind}:${e.name}`, kind: e.kind, name: e.name, tier: e.tier, title: e.name })
  }
  const edges: Array<{ from: string; to: string; type: string; strength: number }> = []
  // relations from the meta files of that revision: one "git grep" prints every line with its path
  if (metas.length) {
    const r2 = await ctx.git.git(["grep", "--null", "--no-color", "-e", "", rev, "--", "meta/"], 120_000).catch(() => undefined)
    const byFile = new Map<string, string[]>()
    for (const line of (r2?.stdout ?? "").split("\n")) {
      const z = line.indexOf("\0")
      if (z < 0) continue
      const path = line.slice(0, z).replace(/^[0-9a-f]+:/, "")
      ;(byFile.get(path) ?? byFile.set(path, []).get(path)!).push(line.slice(z + 1))
    }
    for (const [f, lines] of byFile) {
      const e = entryOfPath(f)
      if (!e?.meta) continue
      try {
        const m = JSON.parse(lines.join("\n"))
        const id = `${e.kind}:${e.name}`
        for (const rel of m.relations ?? []) if (rel.type !== "not_related") edges.push({ from: id, to: rel.to, type: rel.type, strength: Number(rel.strength) || 0.5 })
      } catch {
        // skip broken meta
      }
    }
  }
  return { commit: rev.slice(0, 8), nodes: [...nodes.values()], edges: edges.filter((e) => nodes.has(e.from) && nodes.has(e.to)) }
}

function dense(vectors: Float32Array[]): { project: (v: Float32Array) => [number, number] } {
  const n = vectors.length
  const d = vectors[0]?.length ?? 0
  const mean = new Float64Array(d)
  for (const v of vectors) for (let i = 0; i < d; i++) mean[i] += v[i] / n
  const components: Float64Array[] = []
  for (let c = 0; c < 2; c++) {
    let w: Float64Array = new Float64Array(d).map((_, i) => Math.sin(i * (c + 1) * 12.9898) + 0.01)
    for (let it = 0; it < 40; it++) {
      const next = new Float64Array(d)
      for (const v of vectors) {
        let dot = 0
        for (let i = 0; i < d; i++) dot += (v[i] - mean[i]) * w[i]
        for (let i = 0; i < d; i++) next[i] += dot * (v[i] - mean[i])
      }
      for (const p of components) {
        let dot = 0
        for (let i = 0; i < d; i++) dot += next[i] * p[i]
        for (let i = 0; i < d; i++) next[i] -= dot * p[i]
      }
      const norm = Math.sqrt(next.reduce((s, x) => s + x * x, 0)) || 1
      w = next.map((x) => x / norm)
    }
    components.push(w)
  }
  return {
    project: (v) => components.map((p) => p.reduce((s, x, i) => s + x * (v[i] - mean[i]), 0)) as [number, number],
  }
}

/** 2D map of all entries: topic islands, duplicates as neighbours, gaps. */
export async function semanticMap(ctx: Ctx, kinds: Kind[] = KINDS.filter((k) => k !== "project")): Promise<{ mode: "embeddings" | "bm25"; points: Array<{ id: string; kind: Kind; title: string; x: number; y: number; tier?: string }>; neighbours: Array<{ a: string; b: string; similarity: number }> }> {
  const entries = kinds.flatMap((k) => ctx.store.list(k).map((e) => ({ id: `${k}:${e.name}`, kind: k, title: e.title, tier: e.tier })))
  const sem = ctx.semantic
  let mode: "embeddings" | "bm25" = "bm25"
  let vecs: Array<{ id: string; v: Float32Array }> = []
  if (sem && sem.available()) {
    await sem.ensureCurrent().catch(() => undefined)
    for (const e of entries) {
      const i = e.id.indexOf(":")
      const v = sem.vectorOf(e.kind, e.id.slice(i + 1))
      if (v) vecs.push({ id: e.id, v })
    }
    if (vecs.length >= 3) mode = "embeddings"
  }
  if (mode === "bm25") {
    // TF-IDF over the 400 most informative terms
    const sparse = ctx.index.vectors(kinds)
    const df = new Map<string, number>()
    for (const s of sparse) for (const t of s.v.keys()) df.set(t, (df.get(t) ?? 0) + 1)
    // small stores: every shared term counts; large stores: drop rare and ubiquitous terms
    const minDf = sparse.length > 20 ? 2 : 1
    const maxDf = sparse.length > 10 ? sparse.length * 0.6 : sparse.length
    const vocab = [...df.entries()]
      .filter(([, n]) => n >= minDf && n < maxDf)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 400)
      .map(([t]) => t)
    const index = new Map(vocab.map((t, i) => [t, i]))
    vecs = sparse.map((s) => {
      const v = new Float32Array(vocab.length)
      for (const [t, w] of s.v) {
        const i = index.get(t)
        if (i !== undefined) v[i] = w
      }
      return { id: s.id, v }
    })
  }
  if (vecs.length < 3 || !vecs[0].v.length) return { mode, points: [], neighbours: [] }
  const pca = dense(vecs.map((x) => x.v))
  const byId = new Map(entries.map((e) => [e.id, e]))
  const raw = vecs.map((x) => ({ id: x.id, p: pca.project(x.v) }))
  const xs = raw.map((r) => r.p[0])
  const ys = raw.map((r) => r.p[1])
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const points = raw
    .filter((r) => byId.has(r.id))
    .map((r) => {
      const e = byId.get(r.id)!
      return { id: r.id, kind: e.kind, title: e.title, tier: e.tier, x: Math.round(((r.p[0] - minX) / (maxX - minX || 1)) * 1000) / 1000, y: Math.round(((r.p[1] - minY) / (maxY - minY || 1)) * 1000) / 1000 }
    })
  // nearest neighbours (possible duplicates) by cosine similarity
  const neighbours: Array<{ a: string; b: string; similarity: number }> = []
  const norm = (v: Float32Array) => Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
  const norms = vecs.map((x) => norm(x.v))
  const limit = Math.min(vecs.length, 1500)
  for (let i = 0; i < limit; i++) {
    let best = -1
    let bi = -1
    for (let j = 0; j < limit; j++) {
      if (i === j) continue
      let dot = 0
      const a = vecs[i].v
      const b = vecs[j].v
      for (let k = 0; k < a.length; k++) dot += a[k] * b[k]
      const sim = dot / (norms[i] * norms[j])
      if (sim > best) {
        best = sim
        bi = j
      }
    }
    if (bi >= 0 && best >= (mode === "embeddings" ? ctx.options.embedding.candidateSimilarity : 0.6) && vecs[i].id < vecs[bi].id) neighbours.push({ a: vecs[i].id, b: vecs[bi].id, similarity: Math.round(best * 1000) / 1000 })
  }
  return { mode, points, neighbours: neighbours.sort((a, b) => b.similarity - a.similarity).slice(0, 100) }
}
