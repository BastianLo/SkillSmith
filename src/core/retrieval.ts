/**
 * Hybrid retrieval: BM25F (search.ts) + semantic similarity (embeddings.ts),
 * fused with Reciprocal Rank Fusion. Falls back to BM25 alone whenever the
 * embedding endpoint is unavailable, slow or not configured.
 */
import type { Options } from "../config"
import type { Entry, Kind, SearchHit, Tier } from "../types"
import { KINDS } from "../types"
import { truncate } from "../util/text"
import type { Purpose, SemanticIndex } from "./embeddings"
import { dot } from "./embeddings"
import { entryText } from "./embeddings"
import { normalizeTags, type EntryContent } from "./kinds"
import type { SimilarityProvider } from "./ops"
import type { SearchIndex, SearchOptions } from "./search"
import type { Store } from "./store"

const RRF_K = 60

export interface HybridOptions extends SearchOptions {
  purpose?: Purpose
  /** minimum cosine similarity for hits that BM25 did not find */
  minSimilarity?: number
  /** bound for the embedding call (falls back to BM25 when exceeded) */
  timeoutMs?: number
  /** precomputed query vector (evaluation) */
  queryVector?: Float32Array
}

export interface RetrieverDeps {
  store: Store
  index: SearchIndex
  semantic?: SemanticIndex
  options: Options
}

function firstLine(body: string): string {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !/^#+\s*$/.test(l) && !/^-{3,}$/.test(l))
  return truncate((line ?? "").replace(/^#+\s*/, ""), 200)
}

const PLURAL = ["s", "es"]
const INFLECTION = ["ing", "ings", "ment", "ments", "ation", "ations", "uration", "en", "ung", "ungen", "js", "ed"]

/**
 * Same tag in another form? ("deploy"/"deployment", "db-2"/"db2", "test"/"tests", "query"/"queries").
 * Only known suffixes count – never "java"/"javascript", "port"/"portal", "work"/"worker".
 */
export function tagVariant(a: string, b: string): boolean {
  if (a === b) return false
  const x = a.replace(/-/g, "")
  const y = b.replace(/-/g, "")
  if (x === y) return true
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  if (short.endsWith("y") && short.length >= 4 && long === `${short.slice(0, -1)}ies`) return true
  if (!long.startsWith(short)) return false
  const rest = long.slice(short.length)
  if (PLURAL.includes(rest)) return short.length >= 3
  return INFLECTION.includes(rest) && short.length >= 4
}

export class Retriever {
  constructor(private d: RetrieverDeps) {}

  get semanticAvailable(): boolean {
    return !!this.d.semantic?.available()
  }

  /** BM25 + semantic, fused. Hits carry `similarity` when the semantic side contributed. */
  async search(query: string, opts: HybridOptions = {}): Promise<SearchHit[]> {
    const limit = opts.limit ?? 10
    const kinds = opts.kinds ?? ["skill"]
    const bm25 = this.d.index.search(query, { ...opts, limit: Math.max(30, limit * 3) })
    const sem = this.d.semantic
    if (!sem || !sem.available() || !query.trim()) return bm25.slice(0, limit)
    if (opts.queryVector === undefined && "queryVector" in opts) return bm25.slice(0, limit)
    sem.touch()
    const vec = opts.queryVector ?? (await sem.embedQuery(query, opts.purpose ?? "search", opts.timeoutMs))
    if (!vec) return bm25.slice(0, limit)
    const minSim = opts.minSimilarity ?? this.d.options.embedding.searchMinSimilarity
    const allowed = new Set<Tier | "foreign">(opts.tiers ?? ["active", "dormant", ...(opts.includeArchived ? (["archive"] as const) : []), "foreign"])
    if (opts.includeForeign === false) allowed.delete("foreign")
    const wantTags = normalizeTags(opts.tags ?? [])
    const semHits = sem
      .score(vec, kinds)
      .filter((h) => allowed.has(h.tier))
      .filter((h) => !opts.exclude?.has(`${h.kind}:${h.name}`) && !(h.kind === "skill" && opts.exclude?.has(h.name)))
      .slice(0, 50)
    const simOf = new Map(semHits.map((h) => [`${h.kind}:${h.name}`, h.similarity]))
    const fused = new Map<string, { score: number; hit?: SearchHit }>()
    bm25.forEach((h, i) => fused.set(`${h.kind}:${h.name}`, { score: 1 / (RRF_K + i + 1), hit: h }))
    semHits.forEach((h, i) => {
      const k = `${h.kind}:${h.name}`
      const cur = fused.get(k)
      if (cur) cur.score += 1 / (RRF_K + i + 1)
      else if (h.similarity >= minSim) fused.set(k, { score: 1 / (RRF_K + i + 1) })
    })
    const out: SearchHit[] = []
    for (const [k, f] of fused) {
      const sim = simOf.get(k)
      if (f.hit) {
        out.push({ ...f.hit, similarity: sim, score: Math.round(f.score * 100000) / 100000 })
        continue
      }
      const [kind, ...rest] = k.split(":") as [Kind, ...string[]]
      const name = rest.join(":")
      const rec: Entry | undefined = this.d.store.get(kind, name)
      if (!rec) continue
      if (wantTags.length && !wantTags.every((t) => rec.tags.includes(t))) continue
      out.push({
        kind,
        name: rec.name,
        title: rec.title,
        tier: rec.tier,
        owned: rec.owned,
        description: rec.description,
        tags: rec.tags,
        score: Math.round(f.score * 100000) / 100000,
        confidence: 0,
        similarity: sim,
        matched: [],
        snippet: firstLine(rec.body),
        file: rec.file,
      })
    }
    return out.sort((a, b) => b.score - a.score || (b.similarity ?? 0) - (a.similarity ?? 0)).slice(0, limit)
  }

  /** One query vector for several searches (undefined → BM25 only). */
  async queryVector(text: string, purpose: Purpose, timeoutMs?: number): Promise<Float32Array | undefined> {
    const sem = this.d.semantic
    if (!sem || !sem.available() || !text.trim()) return undefined
    sem.touch()
    return sem.embedQuery(text, purpose, timeoutMs)
  }

  /** Display score for a hit: BM25 confidence or cosine similarity, whichever is higher. */
  static display(h: SearchHit): number {
    return Math.max(h.confidence, h.similarity ?? 0)
  }

  /** SimilarityProvider for Ops (duplicate gate, candidate matching). */
  similarity(): SimilarityProvider {
    return {
      tagPlan: (kind, c) => this.tagPlan(kind, c),
      duplicateOf: async (kind, c) => {
        const sem = this.d.semantic
        if (!sem || !sem.available()) return undefined
        await sem.ensureCurrent()
        const vec = await sem.embedDocument(entryText({ ...c, kind }))
        if (!vec) return undefined
        // memories: only the same project counts (topics repeat across projects)
        const sameScope = (name: string) => {
          if (kind !== "memory") return true
          const e = this.d.store.getOwned("memory", name)
          return !!e && String(e.fields.project ?? "") === String(c.fields.project ?? "")
        }
        const best = sem.score(vec, [kind]).find((h) => h.tier !== "foreign" && h.name !== c.name && sameScope(h.name))
        if (!best || best.similarity < this.d.options.embedding.duplicateSimilarity) return undefined
        return { name: best.name, similarity: best.similarity, tier: best.tier }
      },
      matchCandidate: async (kind, text) => {
        const sem = this.d.semantic
        if (!sem || !sem.available()) return undefined
        await sem.ensureCurrent()
        const vec = await sem.embedDocument(text)
        if (!vec) return undefined
        let best: { id: string; similarity: number } | undefined
        for (const [id, s] of sem.candidateScores(vec, kind)) {
          const c = this.d.store.candidate(kind, id)
          if (!c || c.promotedTo) continue
          if (!best || s > best.similarity) best = { id, similarity: s }
        }
        return best && best.similarity >= this.d.options.embedding.candidateSimilarity ? best : undefined
      },
    }
  }

  /**
   * Entries of the given kinds that are similar to a text (doctor candidates):
   * cosine similarity ≥ `minSimilarity` with embeddings, else BM25 confidence ≥ 0.5
   * with at least three matched terms.
   */
  async similarTo(
    text: string,
    kinds: Kind[],
    opts: { exclude?: Set<string>; limit?: number; minSimilarity?: number; vector?: Float32Array } = {},
  ): Promise<Array<{ kind: Kind; name: string; score: number; semantic: boolean }>> {
    const limit = opts.limit ?? 8
    const sem = this.d.semantic
    if (sem && sem.available()) {
      await sem.ensureCurrent()
      const vec = opts.vector ?? (await sem.embedDocument(truncate(text, 6000)))
      if (vec) {
        const min = opts.minSimilarity ?? this.d.options.embedding.relatedSimilarity
        return sem
          .score(vec, kinds)
          .filter((h) => h.tier !== "foreign" && h.similarity >= min && !opts.exclude?.has(`${h.kind}:${h.name}`))
          .slice(0, limit)
          .map((h) => ({ kind: h.kind, name: h.name, score: h.similarity, semantic: true }))
      }
    }
    return this.d.index
      .search(truncate(text, 2000), { kinds, tiers: ["active", "dormant"], limit: limit + (opts.exclude?.size ?? 0) })
      .filter((h) => h.confidence >= 0.5 && h.matched.length >= 3 && !opts.exclude?.has(`${h.kind}:${h.name}`))
      .slice(0, limit)
      .map((h) => ({ kind: h.kind, name: h.name, score: h.confidence, semantic: false }))
  }

  /** Stored vector of an entry (undefined without embeddings). */
  vectorOf(kind: Kind, name: string): Float32Array | undefined {
    const sem = this.d.semantic
    return sem && sem.available() ? sem.vectorOf(kind, name) : undefined
  }

  /** Related but distinct entries of the same kind (contradiction check after a change). */
  async related(kind: Kind, name: string, limit = 3): Promise<Array<{ entry: Entry; score: number }>> {
    const rec = this.d.store.getOwned(kind, name)
    if (!rec) return []
    const sem = this.d.semantic
    const o = this.d.options.embedding
    if (sem && sem.available()) {
      await sem.ensureCurrent()
      const vec = sem.vectorOf(kind, name) ?? (await sem.embedDocument(entryText(rec)))
      if (vec) {
        return sem
          .score(vec, [kind])
          .filter((h) => h.name !== name && h.tier !== "archive" && h.similarity >= o.relatedSimilarity)
          .slice(0, limit)
          .map((h) => ({ entry: this.d.store.getOwned(kind, h.name)!, score: h.similarity }))
          .filter((x) => !!x.entry)
      }
    }
    return this.d.index
      .search(`${rec.title} ${rec.description} ${rec.tags.join(" ")}`, { kinds: [kind], tiers: ["active", "dormant"], limit: limit + 1 })
      .filter((h) => h.name !== name && h.confidence >= 0.5)
      .slice(0, limit)
      .map((h) => ({ entry: this.d.store.getOwned(kind, h.name)!, score: h.confidence }))
      .filter((x) => !!x.entry)
  }

  /** Tag usage over all owned entries. */
  tagVocabulary(): Map<string, number> {
    const counts = new Map<string, number>()
    for (const kind of KINDS) for (const e of this.d.store.list(kind)) for (const t of e.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
    return counts
  }

  private async tagVectors(vocab: string[]): Promise<boolean> {
    const sem = this.d.semantic
    if (!sem || !sem.available() || !vocab.length) return false
    await sem.syncCustom("tags", vocab.map((t) => ({ key: t, text: `Tag: ${t.replace(/-/g, " ")}` })))
    return true
  }

  /** Map a tag to the existing vocabulary (lexical variant first, then semantic similarity). */
  private async mapTag(t: string, vocab: Map<string, number>, useSemantic: boolean): Promise<string> {
    if (vocab.has(t)) return t
    const lexical = [...vocab.keys()].filter((v) => tagVariant(t, v)).sort((a, b) => (vocab.get(b) ?? 0) - (vocab.get(a) ?? 0))
    if (lexical.length) return lexical[0]
    const sem = this.d.semantic
    if (!useSemantic || !sem) return t
    const vec = await sem.embedDocument(`Tag: ${t.replace(/-/g, " ")}`)
    if (!vec) return t
    const best = sem.scoreCustom(vec, "tags").find((h) => vocab.has(h.id))
    return best && best.similarity >= this.d.options.embedding.tagSimilarity ? best.id : t
  }

  /**
   * Tags for a new/changed entry: variants are mapped onto the existing vocabulary,
   * and when the agent gave fewer than 2 tags, tags of the most similar entries are suggested.
   */
  async tagPlan(kind: Kind, c: EntryContent): Promise<{ tags: string[]; notes: string[] }> {
    const vocab = this.tagVocabulary()
    const notes: string[] = []
    const useSemantic = await this.tagVectors([...vocab.keys()]).catch(() => false)
    const tags: string[] = []
    for (const t of normalizeTags(c.tags)) {
      const m = await this.mapTag(t, vocab, useSemantic)
      if (m !== t) notes.push(`${t}→${m}`)
      if (!tags.includes(m)) tags.push(m)
    }
    if (tags.length < 2) {
      const weights = new Map<string, number>()
      const sem = this.d.semantic
      let neighbours: Array<{ entry: Entry; weight: number }> = []
      const vec = sem && sem.available() ? await sem.embedDocument(entryText({ ...c, kind })) : undefined
      if (vec && sem) {
        neighbours = sem
          .score(vec, KINDS)
          .filter((h) => h.tier !== "foreign" && h.name !== c.name && h.similarity >= 0.5)
          .slice(0, 8)
          .map((h) => ({ entry: this.d.store.getOwned(h.kind, h.name)!, weight: h.similarity }))
          .filter((x) => !!x.entry)
      } else {
        neighbours = this.d.index
          .search(`${c.name.replace(/-/g, " ")} ${c.title} ${c.description}`, { kinds: KINDS, tiers: ["active", "dormant", "archive"], limit: 8, includeForeign: false })
          .filter((h) => h.name !== c.name && h.confidence >= 0.4)
          .map((h) => ({ entry: this.d.store.getOwned(h.kind, h.name)!, weight: h.confidence }))
          .filter((x) => !!x.entry)
      }
      for (const n of neighbours) for (const t of n.entry.tags) weights.set(t, (weights.get(t) ?? 0) + n.weight)
      const suggested = [...weights.entries()]
        .filter(([t, w]) => !tags.includes(t) && w >= 0.9)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3 - tags.length)
        .map(([t]) => t)
      if (suggested.length) notes.push(`+${suggested.join(", +")} (from similar entries)`)
      tags.push(...suggested)
    }
    return { tags: tags.slice(0, 12), notes }
  }

  /** Tag variants in the vocabulary → canonical tag (the more frequent one). */
  async tagMerges(): Promise<Map<string, string>> {
    const vocab = this.tagVocabulary()
    const tags = [...vocab.keys()].sort((a, b) => (vocab.get(b) ?? 0) - (vocab.get(a) ?? 0) || a.length - b.length || a.localeCompare(b))
    const useSemantic = await this.tagVectors(tags).catch(() => false)
    const sem = this.d.semantic
    const target = new Map<string, string>()
    for (let i = 0; i < tags.length; i++) {
      const canonical = tags[i]
      if (target.has(canonical)) continue
      const vec = useSemantic && sem ? this.vectorOfTag(canonical) : undefined
      for (let j = i + 1; j < tags.length; j++) {
        const t = tags[j]
        if (target.has(t)) continue
        let same = tagVariant(canonical, t)
        if (!same && vec && sem) {
          const other = this.vectorOfTag(t)
          same = !!other && dot(vec, other) >= this.d.options.embedding.tagSimilarity
        }
        if (same) target.set(t, canonical)
      }
    }
    return target
  }

  private vectorOfTag(tag: string): Float32Array | undefined {
    const sem = this.d.semantic
    const space = sem?.client.space()
    return space ? sem!.vectors.get(space, "tags", tag)?.vec : undefined
  }

  /** Candidates ranked by semantic similarity to a query (undefined → caller uses token overlap). */
  async candidateRanking(kind: Kind, query: string): Promise<Map<string, number> | undefined> {
    const sem = this.d.semantic
    if (!sem || !sem.available() || !query.trim()) return undefined
    const vec = await sem.embedQuery(query, "context")
    return vec ? sem.candidateScores(vec, kind) : undefined
  }
}

/** For error entries: semantic best match of an error text (live hints). */
export async function semanticErrorMatch(r: RetrieverDeps, errorText: string, timeoutMs: number): Promise<{ name: string; similarity: number } | undefined> {
  const sem = r.semantic
  if (!sem || !sem.available()) return undefined
  const vec = await sem.embedQuery(errorText, "error", timeoutMs)
  if (!vec) return undefined
  const best = sem.score(vec, ["error"]).find((h) => h.tier === "active" || h.tier === "dormant")
  return best && best.similarity >= r.options.embedding.errorSimilarity ? { name: best.name, similarity: best.similarity } : undefined
}
