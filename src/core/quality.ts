/**
 * Quality score per entry (5c): 0–100 with reasons. Components (weights in quality.weights,
 * a component without data is left out and the others are re-weighted):
 *
 *   belegt    share of statement paragraphs with a valid source (provenance)
 *   frische   age of the newest confirmation (verifiedAt, newest source, update by the user)
 *   hinweise  hit rate of the hints (followed / shown; at least 3 shown)
 *   zweifel   open doubts (docsmith flag) and open doctor conflicts
 *   anker     share of code anchors that still match the code
 *   gym       verdict of the gym (5d): hilft 1, neutral 0.6, ungenutzt 0.4, schadet 0
 *
 * The user's own documents count their paragraphs as their own input (no "unbelegt").
 */
import type { Entry, Kind } from "../types"
import type { Ctx } from "./context"
import { isOwnDoc } from "./kinds"
import { provenanceView, PROVENANCE_KINDS } from "./provenance"

export interface QualityPart {
  id: "belegt" | "frische" | "hinweise" | "zweifel" | "anker" | "gym"
  label: string
  /** 0–1 */
  value: number
  weight: number
  reason: string
}

export interface Quality {
  score: number
  parts: QualityPart[]
  reasons: string[]
}

const DAY = 86_400_000

/** Gym verdicts per entry id (5d registers a provider). */
export type GymVerdicts = (id: string) => { verdict: "hilft" | "neutral" | "schadet" | "ungenutzt"; at: string } | undefined

export class QualityEngine {
  private cache = new Map<string, { rev: number; at: number; q: Quality }>()
  gym?: GymVerdicts

  constructor(private ctx: Ctx) {}

  of(e: Entry): Quality {
    const id = `${e.kind}:${e.name}`
    const rev = this.ctx.store.revision
    const hit = this.cache.get(id)
    if (hit && hit.rev === rev && Date.now() - hit.at < 60_000) return hit.q
    const q = this.compute(e)
    this.cache.set(id, { rev, at: Date.now(), q })
    if (this.cache.size > 5000) this.cache.clear()
    return q
  }

  score(kind: Kind, name: string): number | undefined {
    const e = this.ctx.store.getOwned(kind, name)
    return e ? this.of(e).score : undefined
  }

  private compute(e: Entry): Quality {
    const o = this.ctx.options.quality
    const w = o.weights
    const id = `${e.kind}:${e.name}`
    const parts: QualityPart[] = []
    const own = isOwnDoc(e)
    const anchors = this.ctx.anchors?.statusOf(id) ?? []
    // provenance
    if (PROVENANCE_KINDS.includes(e.kind)) {
      const view = provenanceView(e, { anchors, exists: (x) => exists(this.ctx, x), own })
      if (own) parts.push({ id: "belegt", label: "belegt", value: 1, weight: w.belegt, reason: "eigenes Dokument" })
      else if (view.share !== undefined) {
        const statements = view.counts.belegt + view.counts.unbelegt + view.counts.veraltet
        parts.push({ id: "belegt", label: "belegt", value: view.share, weight: w.belegt, reason: `${view.counts.belegt} von ${statements} Absätzen belegt${view.counts.veraltet ? `, ${view.counts.veraltet} mit veralteter Quelle` : ""}` })
      }
    }
    // freshness
    const newestSource = Object.values(e.meta?.provenance ?? {})
      .flat()
      .map((s) => s.at)
      .sort()
      .pop()
    const confirmed = [e.meta?.verifiedAt, newestSource, own ? e.meta?.updatedAt : undefined].filter(Boolean).sort().pop() ?? e.meta?.createdAt
    if (confirmed) {
      const days = (Date.now() - Date.parse(confirmed)) / DAY
      const value = Math.max(0, Math.min(1, 1 - days / o.freshDays))
      parts.push({ id: "frische", label: "frisch", value, weight: w.frische, reason: `zuletzt bestätigt vor ${Math.max(0, Math.round(days))} Tag(en)` })
    }
    // hint hit rate
    const u = this.ctx.usage.get(e.kind, e.name)
    if (u.hintsShown >= 3) {
      const rate = Math.min(1, u.hintsFollowed / u.hintsShown)
      const issues = u.reviewedLoads ? u.loadsWithIssues / u.reviewedLoads : 0
      parts.push({ id: "hinweise", label: "Hinweise", value: Math.max(0, rate - issues / 2), weight: w.hinweise, reason: `${u.hintsFollowed} von ${u.hintsShown} Hinweisen genutzt${u.loadsWithIssues ? `, ${u.loadsWithIssues} Einsatz/Einsätze mit Problemen` : ""}` })
    }
    // doubts and conflicts
    const doubts = e.meta?.doubts?.length ?? 0
    const conflicts = (this.ctx.mem?.conflicts(["open", "needs_user"]) ?? []).filter((c) => c.a === id || c.b === id).length
    parts.push({ id: "zweifel", label: "ohne Zweifel", value: Math.max(0, 1 - 0.34 * (doubts + conflicts)), weight: w.zweifel, reason: doubts + conflicts ? `${doubts} Zweifel, ${conflicts} offene(r) Konflikt(e)` : "keine offenen Zweifel" })
    // code anchors
    const pinned = e.meta?.anchors?.length ?? 0
    if (pinned) {
      const broken = anchors.filter((a) => a.status === "changed" || a.status === "deleted").length
      parts.push({ id: "anker", label: "Code-Anker", value: (pinned - broken) / pinned, weight: w.anker, reason: broken ? `${broken} von ${pinned} Code-Anker(n) gebrochen` : `${pinned} Code-Anker intakt` })
    }
    // gym
    const g = this.gym?.(id)
    if (g) {
      const value = g.verdict === "hilft" ? 1 : g.verdict === "neutral" ? 0.6 : g.verdict === "ungenutzt" ? 0.4 : 0
      parts.push({ id: "gym", label: "Gym", value, weight: w.gym, reason: `Gym: ${g.verdict} (${g.at.slice(0, 10)})` })
    }
    const counted = parts.filter((p) => p.weight > 0)
    const total = counted.reduce((n, p) => n + p.weight, 0)
    const score = total ? Math.round((100 * counted.reduce((n, p) => n + p.weight * p.value, 0)) / total) : 50
    const reasons = counted.filter((p) => p.value < 0.7).map((p) => p.reason)
    return { score, parts, reasons }
  }

  /** Active entries below the threshold (inbox "Qualität prüfen"). */
  low(limit = 50): Array<{ entry: Entry; quality: Quality }> {
    const out: Array<{ entry: Entry; quality: Quality }> = []
    for (const kind of PROVENANCE_KINDS) {
      for (const e of this.ctx.store.list(kind)) {
        if (e.tier !== "active" || isOwnDoc(e)) continue
        const q = this.of(e)
        if (q.score < this.ctx.options.quality.lowThreshold) out.push({ entry: e, quality: q })
      }
    }
    return out.sort((a, b) => a.quality.score - b.quality.score).slice(0, limit)
  }
}

function exists(ctx: Ctx, id: string): boolean {
  const i = id.indexOf(":")
  return i > 0 && !!ctx.store.getOwned(id.slice(0, i) as Kind, id.slice(i + 1))
}
