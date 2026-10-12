/**
 * Small generic BM25F index for things that are not store entries
 * (project doc sections, session history). Same tokenizer and prefix
 * expansion as the entry search.
 */
import { tokenize } from "../util/text"

const K1 = 1.2
const B = 0.75

export interface MiniDoc {
  id: string
  fields: Array<[number, string]>
}

export interface MiniHit {
  id: string
  score: number
  matched: string[]
  /** share of query terms (max 4) matched */
  coverage: number
}

export class MiniIndex {
  private docs: Array<{ id: string; tf: Map<string, number>; len: number }> = []
  private df = new Map<string, number>()
  private avgLen = 1
  private vocab: string[] = []

  constructor(docs: MiniDoc[]) {
    let total = 0
    for (const d of docs) {
      const tf = new Map<string, number>()
      let len = 0
      for (const [w, text] of d.fields) {
        if (!text) continue
        for (const t of tokenize(text)) {
          tf.set(t, (tf.get(t) ?? 0) + w)
          len += w
        }
      }
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1)
      total += len
      this.docs.push({ id: d.id, tf, len })
    }
    this.avgLen = this.docs.length ? total / this.docs.length : 1
    this.vocab = [...this.df.keys()].sort()
  }

  get size(): number {
    return this.docs.length
  }

  private idf(term: string): number {
    const n = this.docs.length
    const df = this.df.get(term) ?? 0
    return Math.log(1 + (n - df + 0.5) / (df + 0.5))
  }

  search(query: string, limit = 10): MiniHit[] {
    const terms = [...new Set(tokenize(query))].slice(0, 40)
    if (!terms.length || !this.docs.length) return []
    const expanded = terms.map((q) => {
      const list: Array<{ term: string; weight: number }> = []
      if (this.df.has(q)) list.push({ term: q, weight: 1 })
      if (q.length >= 4) {
        let added = 0
        for (const v of this.vocab) {
          if (v === q) continue
          if (v.startsWith(q) || (v.length >= 5 && q.startsWith(v))) {
            list.push({ term: v, weight: 0.5 })
            if (++added >= 6) break
          }
        }
      }
      return [q, list] as const
    })
    const hits: MiniHit[] = []
    for (const d of this.docs) {
      let score = 0
      const matched: string[] = []
      for (const [q, list] of expanded) {
        let best = 0
        for (const { term, weight } of list) {
          const tf = d.tf.get(term)
          if (!tf) continue
          const s = weight * this.idf(term) * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * d.len) / this.avgLen)))
          if (s > best) best = s
        }
        if (best > 0) {
          score += best
          matched.push(q)
        }
      }
      if (score > 0) hits.push({ id: d.id, score, matched, coverage: Math.min(1, matched.length / Math.min(terms.length, 4)) })
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit)
  }
}

/** Reciprocal Rank Fusion of a lexical and a semantic ranking. */
export function rrf<T extends { id: string }>(
  lexical: T[],
  semantic: Array<{ id: string; similarity: number }>,
  minSimilarity: number,
  k = 60,
): Array<{ id: string; score: number; similarity?: number; lexical?: T }> {
  const out = new Map<string, { id: string; score: number; similarity?: number; lexical?: T }>()
  lexical.forEach((h, i) => out.set(h.id, { id: h.id, score: 1 / (k + i + 1), lexical: h }))
  semantic.forEach((h, i) => {
    const cur = out.get(h.id)
    if (cur) {
      cur.score += 1 / (k + i + 1)
      cur.similarity = h.similarity
    } else if (h.similarity >= minSimilarity) {
      out.set(h.id, { id: h.id, score: 1 / (k + i + 1), similarity: h.similarity })
    }
  })
  return [...out.values()].sort((a, b) => b.score - a.score)
}
