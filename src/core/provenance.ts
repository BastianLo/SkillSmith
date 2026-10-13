/**
 * Provenance per paragraph (5c): every paragraph of an entry carries its sources – a
 * session message with a quote, a commit, a ticket, a Confluence page, a code anchor,
 * the user's own input or another document. The sources live in meta.provenance keyed by
 * a hash of the paragraph text; the text itself stays clean Markdown.
 *
 * On every write (Ops) unchanged paragraphs keep their sources, changed and new ones get
 * the sources of this write; paragraphs that no longer exist drop out. Evidence from the
 * history (meta.evidence before 5c) counts for a paragraph only when its quote is found
 * in that paragraph – nothing is assigned by guessing.
 */
import type { Entry, Evidence, Kind, ProvenanceSource } from "../types"
import { fold, nowIso, sha, truncate } from "../util/text"
import type { AnchorStatus } from "./anchors"
import { parseAnchors } from "./anchors"

/** same normalization as the evidence gate (Ops.normalizeQuote) */
const normalizeQuote = (s: string): string => fold(s).replace(/[^a-z0-9]+/g, " ").trim()

/** Kinds whose paragraphs carry sources (statements of the AI). */
export const PROVENANCE_KINDS: Kind[] = ["knowledge", "memory", "skill", "error"]

export interface Paragraph {
  index: number
  key: string
  text: string
  /** headings, rules, code blocks, link lists: no statement of their own */
  neutral: boolean
  /** first line number (1-based) in the body */
  line: number
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim()

export function paragraphKey(text: string): string {
  return sha(norm(text), 10)
}

/** Blocks of a Markdown body: separated by blank lines, fenced code is one block, headings are their own block. */
export function paragraphs(body: string): Paragraph[] {
  const out: Paragraph[] = []
  const lines = body.split("\n")
  let buf: string[] = []
  let start = 0
  let fence = false
  const flush = () => {
    const text = buf.join("\n").trim()
    if (text) {
      const neutral = isNeutral(text)
      out.push({ index: out.length, key: paragraphKey(text), text, neutral, line: start + 1 })
    }
    buf = []
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (/^\s*(```|~~~)/.test(l)) {
      if (!fence) {
        flush()
        start = i
      }
      buf.push(l)
      fence = !fence
      if (!fence) flush()
      continue
    }
    if (fence) {
      buf.push(l)
      continue
    }
    if (/^\s{0,3}#{1,6}\s/.test(l)) {
      flush()
      start = i
      buf.push(l)
      flush()
      continue
    }
    if (!l.trim()) {
      flush()
      continue
    }
    if (!buf.length) start = i
    buf.push(l)
  }
  flush()
  return out
}

function isNeutral(text: string): boolean {
  if (/^\s{0,3}#{1,6}\s/.test(text)) return true
  if (/^(```|~~~)/.test(text)) return true
  if (/^([-*_]\s*){3,}$/.test(text)) return true
  // only links / anchors (lists of references)
  const stripped = text.replace(/\[\[[^\]]+\]\]/g, "").replace(/\[[^\]]*\]\([^)]*\)/g, "").replace(/^[\s>*-]*/gm, "").replace(/[\s,;·|]/g, "")
  return stripped.length < 3
}

/** Source of an evidence quote (session message or doc passage). */
export function evidenceSource(ev: Evidence, runId?: string, scope: ProvenanceSource["scope"] = "change"): ProvenanceSource {
  const type = ev.source === "doc" ? "doc" : ev.source === "command" ? "user" : "session"
  return { type, ...(ev.sessionID ? { ref: ev.sessionID } : {}), quote: truncate(ev.text, 300), at: ev.at, ...(runId ? { runId } : {}), scope }
}

/** The paragraph a source names: by its start (≥ 12 chars, normalized) or contained text. */
export function findParagraph(list: Paragraph[], start: string): Paragraph | undefined {
  const q = normalizeQuote(start)
  if (q.length < 12) return undefined
  return list.find((p) => normalizeQuote(p.text).startsWith(q)) ?? list.find((p) => normalizeQuote(p.text).includes(q))
}

/**
 * Sources after a write: unchanged paragraphs keep theirs, changed / new paragraphs get the
 * explicit per-paragraph sources or the general sources of the change.
 */
export function nextProvenance(
  newBody: string,
  previous: Record<string, ProvenanceSource[]> | undefined,
  general: ProvenanceSource[],
  perParagraph: Map<string, ProvenanceSource[]> = new Map(),
): { provenance: Record<string, ProvenanceSource[]>; changed: Paragraph[]; withoutOwn: Paragraph[] } {
  const prev = previous ?? {}
  const out: Record<string, ProvenanceSource[]> = {}
  const changed: Paragraph[] = []
  const withoutOwn: Paragraph[] = []
  for (const p of paragraphs(newBody)) {
    if (p.neutral) continue
    const own = perParagraph.get(p.key)
    if (prev[p.key] && !own) {
      out[p.key] = prev[p.key]
      continue
    }
    changed.push(p)
    if (!own?.length) withoutOwn.push(p)
    const list = [...(own ?? []), ...(own?.length ? [] : general)]
    if (list.length) out[p.key] = dedupe([...list, ...(prev[p.key] ?? [])]).slice(0, 6)
  }
  return { provenance: out, changed, withoutOwn }
}

function dedupe(list: ProvenanceSource[]): ProvenanceSource[] {
  const seen = new Set<string>()
  return list.filter((s) => {
    const k = `${s.type}|${s.ref ?? ""}|${s.quote ?? ""}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

export type ParagraphStatus = "belegt" | "unbelegt" | "veraltet" | "neutral"

export interface ParagraphView extends Paragraph {
  status: ParagraphStatus
  sources: ProvenanceSource[]
  /** sources taken over from meta.evidence (quote found in the paragraph) */
  fromHistory?: boolean
  reason?: string
}

export interface ProvenanceView {
  paragraphs: ParagraphView[]
  counts: Record<ParagraphStatus, number>
  /** share of statement paragraphs with a valid source (0–1); undefined without statements */
  share?: number
  own: boolean
}

/**
 * Status per paragraph. "veraltet": a code source whose anchor changed or vanished, a
 * document source that no longer exists.
 */
export function provenanceView(e: Entry, opts: { anchors?: AnchorStatus[]; exists?: (id: string) => boolean; own?: boolean } = {}): ProvenanceView {
  const prov = e.meta?.provenance ?? {}
  const history = (e.meta?.evidence ?? []).filter((ev) => normalizeQuote(ev.text).length >= 12)
  const anchorState = new Map((opts.anchors ?? []).map((a) => [a.ref, a.status]))
  const counts: Record<ParagraphStatus, number> = { belegt: 0, unbelegt: 0, veraltet: 0, neutral: 0 }
  const list: ParagraphView[] = []
  for (const p of paragraphs(e.body)) {
    if (p.neutral) {
      counts.neutral++
      list.push({ ...p, status: "neutral", sources: [] })
      continue
    }
    let sources = prov[p.key] ?? []
    let fromHistory = false
    if (!sources.length) {
      const text = normalizeQuote(p.text)
      const hits = history.filter((ev) => text.includes(normalizeQuote(ev.text)))
      if (hits.length) {
        sources = hits.map((ev) => evidenceSource(ev, undefined, "paragraph"))
        fromHistory = true
      }
    }
    // a code anchor in the paragraph itself is a source
    for (const a of parseAnchors(p.text)) if (!sources.some((s) => s.type === "code" && s.ref === a.ref)) sources = [...sources, { type: "code", ref: a.ref, at: e.meta?.updatedAt ?? nowIso(), scope: "paragraph" }]
    let status: ParagraphStatus = sources.length ? "belegt" : "unbelegt"
    let reason: string | undefined
    for (const s of sources) {
      if (s.type === "code" && s.ref) {
        const st = anchorState.get(s.ref)
        if (st === "changed" || st === "deleted") {
          status = "veraltet"
          reason = `Code ${s.ref} ${st === "changed" ? "geändert" : "gelöscht"}`
        }
      }
      if (s.type === "doc" && s.ref && /^[a-z]+:/.test(s.ref) && opts.exists && !opts.exists(s.ref)) {
        status = "veraltet"
        reason = `Quelle ${s.ref} gibt es nicht mehr`
      }
    }
    counts[status]++
    list.push({ ...p, status, sources, ...(fromHistory ? { fromHistory } : {}), ...(reason ? { reason } : {}) })
  }
  const statements = counts.belegt + counts.unbelegt + counts.veraltet
  return { paragraphs: list, counts, share: statements ? counts.belegt / statements : undefined, own: !!opts.own }
}
