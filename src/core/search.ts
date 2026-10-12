/**
 * In-memory BM25F full-text search over all store entries (plus foreign
 * skills). Files stay the single source of truth; every kind has its own
 * statistics (df, average length) because the kinds differ a lot in size.
 * The index is rebuilt cheaply whenever the store revision changes or
 * periodically (to see manual/foreign edits).
 */
import type { Entry, Kind, SearchHit, Tier } from "../types"
import { KINDS } from "../types"
import { tokenize, truncate } from "../util/text"
import { isOwnDoc, isPrivate, normalizeTags, spec } from "./kinds"
import type { Store } from "./store"

const K1 = 1.2
const B = 0.75

interface Doc {
  rec: Entry
  tf: Map<string, number>
  len: number
  raw: Map<string, number>
  keyTerms: Set<string>
  tags: Set<string>
}

interface SubIndex {
  docs: Doc[]
  df: Map<string, number>
  avgLen: number
  vocab: string[]
}

export interface SearchOptions {
  kinds?: Kind[]
  tiers?: Array<Tier | "foreign">
  includeArchived?: boolean
  includeForeign?: boolean
  limit?: number
  /** "kind:name" (or plain names for skills) to exclude */
  exclude?: Set<string>
  /** entries must carry all of these tags */
  tags?: string[]
  /** small boost for entries confirmed in this project */
  project?: string
  /** private documents (KI-Recht privat) – only for the user's own search in the web view */
  includePrivate?: boolean
  /** score bonus for the user's own documents (docs.ownBoost) */
  ownBoost?: number
}

function keyTermsOf(rec: Entry): string[] {
  const parts = [rec.name.replace(/-/g, " "), rec.title, rec.description, rec.tags.join(" ")]
  if (rec.kind === "glossary") {
    parts.push(String(rec.fields.term ?? ""), ((rec.fields.aliases as string[]) ?? []).join(" "))
  }
  return tokenize(parts.join(" "))
}

export class SearchIndex {
  private subs = new Map<Kind, SubIndex>()
  private builtRevision = -1
  private builtAt = 0

  constructor(private store: Store, private includeForeign: boolean) {}

  private ensureFresh(): void {
    if (this.builtRevision === this.store.revision && Date.now() - this.builtAt < 15_000) return
    this.rebuild()
  }

  rebuild(): void {
    const subs = new Map<Kind, SubIndex>()
    for (const kind of KINDS) {
      const records = [...this.store.list(kind), ...(kind === "skill" && this.includeForeign ? this.store.listForeign() : [])]
      const docs: Doc[] = []
      const df = new Map<string, number>()
      let total = 0
      for (const rec of records) {
        const tf = new Map<string, number>()
        const raw = new Map<string, number>()
        let len = 0
        for (const [w, text] of spec(kind).searchFields(rec)) {
          if (!text) continue
          for (const t of tokenize(text)) {
            tf.set(t, (tf.get(t) ?? 0) + w)
            raw.set(t, (raw.get(t) ?? 0) + 1)
            len += w
          }
        }
        for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1)
        total += len
        docs.push({ rec, tf, len, raw, keyTerms: new Set(keyTermsOf(rec)), tags: new Set(rec.tags) })
      }
      subs.set(kind, { docs, df, avgLen: docs.length ? total / docs.length : 1, vocab: [...df.keys()].sort() })
    }
    this.subs = subs
    this.builtRevision = this.store.revision
    this.builtAt = Date.now()
  }

  size(kind?: Kind): number {
    this.ensureFresh()
    if (kind) return this.subs.get(kind)?.docs.length ?? 0
    let n = 0
    for (const s of this.subs.values()) n += s.docs.length
    return n
  }

  private idf(sub: SubIndex, term: string): number {
    const n = sub.docs.length
    const df = sub.df.get(term) ?? 0
    return Math.log(1 + (n - df + 0.5) / (df + 0.5))
  }

  private expand(sub: SubIndex, terms: string[]): Map<string, Array<{ term: string; weight: number }>> {
    const out = new Map<string, Array<{ term: string; weight: number }>>()
    for (const q of terms) {
      const list: Array<{ term: string; weight: number }> = []
      if (sub.df.has(q)) list.push({ term: q, weight: 1 })
      if (q.length >= 4) {
        let added = 0
        for (const v of sub.vocab) {
          if (v === q) continue
          if (v.startsWith(q) || (v.length >= 5 && q.startsWith(v))) {
            list.push({ term: v, weight: 0.5 })
            if (++added >= 6) break
          }
        }
      }
      out.set(q, list)
    }
    return out
  }

  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    this.ensureFresh()
    const terms = [...new Set(tokenize(query))].slice(0, 40)
    if (terms.length === 0) return []
    const kinds = opts.kinds ?? ["skill"]
    const allowed = new Set<Tier | "foreign">(
      opts.tiers ?? ["active", "dormant", ...(opts.includeArchived ? (["archive"] as const) : []), "foreign"],
    )
    if (opts.includeForeign === false) allowed.delete("foreign")
    const wantTags = normalizeTags(opts.tags ?? [])
    const hits: SearchHit[] = []
    for (const kind of kinds) {
      const sub = this.subs.get(kind)
      if (!sub || sub.docs.length === 0) continue
      const expanded = this.expand(sub, terms)
      for (const doc of sub.docs) {
        if (!allowed.has(doc.rec.tier)) continue
        if (opts.exclude?.has(`${kind}:${doc.rec.name}`) || (kind === "skill" && opts.exclude?.has(doc.rec.name))) continue
        if (wantTags.length && !wantTags.every((t) => doc.tags.has(t))) continue
        if (!opts.includePrivate && isPrivate(doc.rec)) continue
        let score = 0
        const matched: string[] = []
        for (const [q, list] of expanded) {
          let best = 0
          for (const { term, weight } of list) {
            const tf = doc.tf.get(term)
            if (!tf) continue
            const s = weight * this.idf(sub, term) * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.len) / sub.avgLen)))
            if (s > best) best = s
          }
          if (best > 0) {
            score += best
            matched.push(q)
          }
        }
        if (score <= 0) continue
        if (opts.project && doc.rec.meta?.projects?.includes(opts.project)) score *= 1.15
        const queryCoverage = Math.min(1, matched.length / Math.min(terms.length, 4))
        let covered = 0
        for (const k of doc.keyTerms) {
          if (terms.some((q) => q === k || (q.length >= 4 && k.startsWith(q)) || (k.length >= 5 && q.startsWith(k)))) covered++
        }
        const keyCoverage = doc.keyTerms.size ? covered / doc.keyTerms.size : 0
        let confidence = 0.5 * queryCoverage + 0.5 * keyCoverage
        if (opts.ownBoost && isOwnDoc(doc.rec)) {
          score *= 1 + opts.ownBoost
          confidence = Math.min(1, confidence + opts.ownBoost)
        }
        hits.push({
          kind,
          name: doc.rec.name,
          title: doc.rec.title,
          tier: doc.rec.tier,
          owned: doc.rec.owned,
          description: doc.rec.description,
          tags: doc.rec.tags,
          score: Math.round(score * 1000) / 1000,
          confidence: Math.round(confidence * 1000) / 1000,
          matched,
          snippet: snippet(doc.rec.body, new Set(matched)),
          file: doc.rec.file,
        })
      }
    }
    // across kinds scores are not comparable → rank by confidence first when mixing
    if (kinds.length > 1) hits.sort((a, b) => b.confidence - a.confidence || b.score - a.score || a.name.localeCompare(b.name))
    else hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    return hits.slice(0, opts.limit ?? 10)
  }

  /** All tags with counts (optionally for one kind). */
  tags(kind?: Kind): Array<{ tag: string; count: number }> {
    this.ensureFresh()
    const counts = new Map<string, number>()
    for (const [k, sub] of this.subs) {
      if (kind && k !== kind) continue
      for (const d of sub.docs) {
        if (!d.rec.owned) continue
        for (const t of d.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
      }
    }
    return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
  }

  /** Normalised TF-IDF vectors of all owned entries of some kinds (semantic map without embeddings). */
  vectors(kinds: Kind[], includePrivate = true): Array<{ id: string; v: Map<string, number> }> {
    this.ensureFresh()
    const out: Array<{ id: string; v: Map<string, number> }> = []
    for (const kind of kinds) {
      const sub = this.subs.get(kind)
      if (!sub) continue
      for (const d of sub.docs) {
        if (!d.rec.owned || (!includePrivate && isPrivate(d.rec))) continue
        const v = new Map<string, number>()
        let norm = 0
        for (const [t, c] of d.raw) {
          const w = (1 + Math.log(c)) * this.idf(sub, t)
          v.set(t, w)
          norm += w * w
        }
        norm = Math.sqrt(norm) || 1
        for (const [t, w] of v) v.set(t, w / norm)
        out.push({ id: `${kind}:${d.rec.name}`, v })
      }
    }
    return out
  }

  /** Pairwise TF-IDF cosine similarity among entries of one kind. */
  similarPairs(names: string[], threshold: number, kind: Kind = "skill"): Array<{ a: string; b: string; score: number }> {
    this.ensureFresh()
    const sub = this.subs.get(kind)
    if (!sub) return []
    const wanted = new Set(names)
    const docs = sub.docs.filter((d) => d.rec.owned && wanted.has(d.rec.name))
    const vectors = docs.map((d) => {
      const v = new Map<string, number>()
      let norm = 0
      for (const [t, c] of d.raw) {
        const w = (1 + Math.log(c)) * this.idf(sub, t)
        v.set(t, w)
        norm += w * w
      }
      return { name: d.rec.name, v, norm: Math.sqrt(norm) || 1 }
    })
    const out: Array<{ a: string; b: string; score: number }> = []
    for (let i = 0; i < vectors.length; i++) {
      for (let j = i + 1; j < vectors.length; j++) {
        const [x, y] = vectors[i].v.size < vectors[j].v.size ? [vectors[i], vectors[j]] : [vectors[j], vectors[i]]
        let dot = 0
        for (const [t, w] of x.v) {
          const o = y.v.get(t)
          if (o) dot += w * o
        }
        const score = dot / (vectors[i].norm * vectors[j].norm)
        if (score >= threshold) out.push({ a: vectors[i].name, b: vectors[j].name, score: Math.round(score * 1000) / 1000 })
      }
    }
    return out.sort((p, q) => q.score - p.score)
  }

  clusters(names: string[], threshold: number, kind: Kind = "skill"): string[][] {
    const parent = new Map(names.map((n) => [n, n]))
    const find = (n: string): string => {
      let p = parent.get(n)!
      while (p !== parent.get(p)) p = parent.get(p)!
      parent.set(n, p)
      return p
    }
    for (const { a, b } of this.similarPairs(names, threshold, kind)) {
      const ra = find(a)
      const rb = find(b)
      if (ra !== rb) parent.set(ra, rb)
    }
    const groups = new Map<string, string[]>()
    for (const n of names) {
      const r = find(n)
      groups.set(r, [...(groups.get(r) ?? []), n])
    }
    return [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort())
  }
}

function snippet(body: string, terms: Set<string>): string {
  const lines = body.split("\n").map((l) => l.trim()).filter((l) => l && !/^-{3,}$/.test(l))
  let best = ""
  let bestScore = -1
  for (const line of lines) {
    const toks = new Set(tokenize(line))
    let s = 0
    for (const t of terms) if (toks.has(t)) s++
    if (s > bestScore) {
      best = line
      bestScore = s
    }
  }
  return truncate(best.replace(/^#+\s*/, ""), 200)
}
