/**
 * Offline evaluation of the semantic search with real data: from past
 * sessions, every user message that was followed by loading an entry
 * (skill, skill_read, knowledge_read, script_read, error_lookup by name)
 * becomes a (query → expected entry) pair. BM25 alone and the hybrid search
 * are compared (hit@1, hit@3, MRR) and the similarity distribution suggests
 * a threshold for hints.
 */
import type { Kind } from "../types"
import { truncate } from "../util/text"
import { unwrap } from "./agent-runner"
import type { Ctx } from "./context"
import { AGENT_TITLE_PREFIX } from "./reviewer"
import { isInternalMessage, userText, type Msg } from "./transcript"

export interface EvalPair {
  query: string
  kind: Kind
  name: string
  session: string
}

const READ_KIND: Record<string, Kind> = { skill: "skill", skill_read: "skill", knowledge_read: "knowledge", script_read: "script", error_lookup: "error" }

export async function buildEvalSet(ctx: Ctx, maxSessions = 100): Promise<{ pairs: EvalPair[]; sessions: number }> {
  const sessions = unwrap<any[]>(await ctx.client.session.list())
    .filter((s) => !String(s?.title ?? "").startsWith(AGENT_TITLE_PREFIX))
    .sort((a, b) => (b?.time?.updated ?? 0) - (a?.time?.updated ?? 0))
    .slice(0, maxSessions)
  const pairs: EvalPair[] = []
  const seen = new Set<string>()
  let used = 0
  for (const s of sessions) {
    let msgs: Msg[]
    try {
      msgs = unwrap<Msg[]>(await ctx.client.session.messages({ path: { id: s.id } }))
    } catch {
      continue
    }
    let current = ""
    let found = false
    for (const m of msgs) {
      if (m.info.role === "user") {
        current = isInternalMessage(m) ? "" : userText(m)
        continue
      }
      if (!current || current.length < 8) continue
      for (const p of m.parts) {
        if (p.type !== "tool" || p.state?.status !== "completed") continue
        const kind = READ_KIND[p.tool ?? ""]
        const name = typeof p.state?.input?.name === "string" ? String(p.state.input.name).trim() : ""
        if (!kind || !name || !ctx.store.get(kind, name)) continue
        const query = truncate(ctx.redactor.redact(current), 2000)
        const k = `${kind}:${name}|${query}`
        if (seen.has(k)) continue
        seen.add(k)
        pairs.push({ query, kind, name, session: s.id })
        found = true
      }
    }
    if (found) used++
  }
  return { pairs, sessions: used }
}

function quantile(values: number[], q: number): number {
  if (!values.length) return NaN
  const v = [...values].sort((a, b) => a - b)
  const i = Math.min(v.length - 1, Math.max(0, Math.floor(q * (v.length - 1))))
  return v[i]
}

export interface EvalResult {
  pairs: number
  sessions: number
  bm25: { hit1: number; hit3: number; mrr: number }
  hybrid?: { hit1: number; hit3: number; mrr: number }
  positive?: { median: number; p20: number }
  negative?: { median: number }
  suggestion?: number
}

export async function runEval(ctx: Ctx, pairs: EvalPair[], sessions: number): Promise<EvalResult> {
  const tiers = ["active", "dormant", "archive", "foreign"] as const
  const rank = (names: string[], name: string) => {
    const i = names.indexOf(name)
    return i < 0 ? Infinity : i + 1
  }
  const agg = () => ({ hit1: 0, hit3: 0, mrr: 0 })
  const bm25 = agg()
  const hybrid = agg()
  const add = (a: ReturnType<typeof agg>, r: number) => {
    if (r === 1) a.hit1++
    if (r <= 3) a.hit3++
    if (Number.isFinite(r)) a.mrr += 1 / r
  }
  const sem = ctx.semantic
  let vecs: Array<Float32Array | undefined> = []
  if (sem?.available()) {
    await sem.sync()
    vecs = (await sem.client.embed(
      pairs.map((p) => p.query),
      "query",
      "search",
    )) ?? []
  }
  const pos: number[] = []
  const neg: number[] = []
  for (const [i, p] of pairs.entries()) {
    add(bm25, rank(ctx.index.search(p.query, { kinds: [p.kind], tiers: [...tiers], limit: 20 }).map((h) => h.name), p.name))
    const vec = vecs[i]
    if (vec && sem) {
      add(hybrid, rank((await ctx.retriever.search(p.query, { kinds: [p.kind], tiers: [...tiers], limit: 20, queryVector: vec })).map((h) => h.name), p.name))
      const scored = sem.score(vec, [p.kind])
      const target = scored.find((h) => h.name === p.name)
      const other = scored.find((h) => h.name !== p.name)
      if (target) pos.push(target.similarity)
      if (other) neg.push(other.similarity)
    }
  }
  const n = pairs.length || 1
  const norm = (a: ReturnType<typeof agg>) => ({ hit1: a.hit1 / n, hit3: a.hit3 / n, mrr: a.mrr / n })
  const res: EvalResult = { pairs: pairs.length, sessions, bm25: norm(bm25) }
  if (vecs.length && pos.length) {
    res.hybrid = norm(hybrid)
    res.positive = { median: quantile(pos, 0.5), p20: quantile(pos, 0.2) }
    res.negative = neg.length ? { median: quantile(neg, 0.5) } : undefined
    res.suggestion = Math.round(Math.max(res.positive.p20, (res.negative?.median ?? 0) + 0.02) * 100) / 100
  }
  return res
}

export function formatEval(r: EvalResult, current: number): string {
  const pct = (x: number) => `${Math.round(x * 100)} %`
  if (r.pairs < 5) return `Zu wenige Daten für eine Auswertung (${r.pairs} Paare). Es braucht Sessions, in denen nach einer Nachricht ein Eintrag geladen wurde.`
  const lines = [
    `**Embedding-Auswertung** – ${r.pairs} Paare (Nachricht → danach geladener Eintrag) aus ${r.sessions} Sessions`,
    "",
    "| Suche | Treffer@1 | Treffer@3 | MRR |",
    "|---|---|---|---|",
    `| BM25 | ${pct(r.bm25.hit1)} | ${pct(r.bm25.hit3)} | ${r.bm25.mrr.toFixed(2)} |`,
  ]
  if (r.hybrid) lines.push(`| hybrid | ${pct(r.hybrid.hit1)} | ${pct(r.hybrid.hit3)} | ${r.hybrid.mrr.toFixed(2)} |`)
  else lines.push("| hybrid | – | – | – |", "", "Embeddings nicht verfügbar – nur BM25 ausgewertet (/smith-embed zeigt den Grund).")
  if (r.positive) {
    lines.push(
      "",
      `Ähnlichkeit zum richtigen Eintrag: Median ${r.positive.median.toFixed(2)}, 80 % liegen über ${r.positive.p20.toFixed(2)}` +
        (r.negative ? ` · bester falscher Eintrag: Median ${r.negative.median.toFixed(2)}` : ""),
      `Vorschlag für \`embedding.hintMinSimilarity\`: ${r.suggestion?.toFixed(2)} (aktuell ${current.toFixed(2)})`,
    )
  }
  return lines.join("\n")
}
