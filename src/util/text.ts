import { createHash, randomBytes } from "node:crypto"

/** Lowercase, strip diacritics (ä → a, é → e), ß → ss. */
export function fold(input: string): string {
  return input.normalize("NFKD").replace(/\p{M}+/gu, "").replace(/ß/g, "ss").toLowerCase()
}

const STOPWORDS = new Set(
  (
    // English
    "a an and are as at be been but by can could do does for from had has have how i if in into is it its " +
    "me my no not of on or our please should so that the their them then there these this to use used using " +
    "was we were what when where which while who why will with would you your yes ok okay also just " +
    // German
    "aber alle alles als also am an auch auf aus bei bin bis bitte da damit dann das dass dem den der des die " +
    "dies diese diesem diesen dieser doch du ein eine einem einen einer eines er es fur hat hatte ich ihr im in " +
    "ist ja jetzt kann kannst mal man mich mir mit muss nach nicht noch nur ob oder sehr sein sich sie sind so " +
    "soll sollte uber um und uns unter vom von vor war was weil wenn wer wie wir wird wo zu zum zur gibt geht " +
    "machen mache macht bitte danke hallo hier"
  ).split(/\s+/),
)

const SUFFIXES = [
  "ationen",
  "ungen",
  "ation",
  "ungs",
  "ings",
  "heit",
  "keit",
  "lich",
  "isch",
  "ing",
  "ung",
  "ies",
  "ern",
  "ers",
  "en",
  "er",
  "es",
  "ed",
  "ly",
  "e",
  "s",
  "n",
]

/** Very light, language-agnostic stemming for German + English. */
export function stem(token: string): string {
  if (token.length <= 4 || /\d/.test(token)) return token
  for (const suffix of SUFFIXES) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 4) return token.slice(0, -suffix.length)
  }
  return token
}

export interface TokenizeOptions {
  stem?: boolean
  stopwords?: boolean
}

/** Split text into normalized search tokens (camelCase, kebab, snake and paths are split). */
export function tokenize(input: string, opts: TokenizeOptions = {}): string[] {
  const useStem = opts.stem !== false
  const useStop = opts.stopwords !== false
  const spaced = input.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-./\\:]+/g, " ")
  const out: string[] = []
  for (const raw of fold(spaced).split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue
    if (/^\d+$/.test(raw) && raw.length < 3) continue
    if (useStop && STOPWORDS.has(raw)) continue
    out.push(useStem ? stem(raw) : raw)
  }
  return out
}

export function truncate(input: string, max: number): string {
  if (input.length <= max) return input
  if (max <= 1) return input.slice(0, max)
  return input.slice(0, max - 1).trimEnd() + "…"
}

export function oneLine(input: string): string {
  return input.replace(/\s+/g, " ").trim()
}

export function sha(input: string, length = 12): string {
  return createHash("sha256").update(input).digest("hex").slice(0, length)
}

export function slugify(input: string, max = 64): string {
  const slug = fold(input)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
  return slug.slice(0, max).replace(/-$/, "")
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function shortId(length = 4): string {
  return randomBytes(8).toString("hex").slice(0, length)
}

/** Run id like rev-20261008-2305-a1b2 (local time, sortable). */
export function runId(prefix: string, date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(
    date.getMinutes(),
  )}${pad(date.getSeconds())}`
  return `${prefix}-${stamp}-${shortId()}`
}

export function daysBetween(fromIso: string | undefined, to: Date = new Date()): number {
  if (!fromIso) return Number.POSITIVE_INFINITY
  const t = Date.parse(fromIso)
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY
  return (to.getTime() - t) / 86_400_000
}

export function maxIso(...values: Array<string | undefined>): string | undefined {
  let best: string | undefined
  let bestT = Number.NEGATIVE_INFINITY
  for (const v of values) {
    if (!v) continue
    const t = Date.parse(v)
    if (!Number.isNaN(t) && t > bestT) {
      best = v
      bestT = t
    }
  }
  return best
}

/** Remove fenced code blocks and inline code (used before searching user text). */
export function stripCode(input: string): string {
  return input.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ")
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "string") return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/** Local calendar day "YYYY-MM-DD" of a timestamp (log files, daily metrics). */
export function localDay(ms: number = Date.now()): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Literal text inside a RegExp. */
export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
