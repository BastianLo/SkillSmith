/**
 * Deterministic signal extraction (no LLM): error signatures and chains,
 * abbreviations and their definitions, automation signals, code changes and
 * project documentation passages that mention changed identifiers.
 */
import { readdirSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import type { ErrorChain } from "../types"
import { readText } from "../util/fs"
import { fold, oneLine, sha, stripCode, truncate } from "../util/text"
import { CORRECTION_RE, EDIT_TOOLS, SHELL_TOOLS, type ToolCall } from "./transcript"

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

const WRAPPERS = new Set(["sudo", "env", "time", "nohup", "exec", "command", "npx", "bunx", "uv", "poetry", "pipenv"])
const SKIP_SEGMENTS = new Set(["cd", "export", "source", ".", "set", "pushd", "popd", "echo", "true", ":"])
/** commands whose exit code 1 is not an error ("no match", "differences") */
const EXIT1_OK = new Set(["grep", "egrep", "fgrep", "rg", "ag", "diff", "cmp", "test", "[", "which", "pgrep", "git-diff"])

export function commandHead(command: string): string {
  const segments = command.split(/&&|\|\||;|\n/).map((x) => x.trim()).filter(Boolean)
  for (const seg of segments) {
    const words = seg.split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
    let i = 0
    while (i < words.length && WRAPPERS.has(words[i])) i++
    const w = words[i]
    if (!w || SKIP_SEGMENTS.has(w)) continue
    const base = w.split("/").pop() ?? w
    return base.replace(/[^A-Za-z0-9_.+-]/g, "").slice(0, 30)
  }
  return ""
}

export function isIgnorableFailure(call: Pick<ToolCall, "tool" | "input" | "exit" | "output">): boolean {
  if (!SHELL_TOOLS.has(call.tool)) return false
  const cmd = String(call.input?.command ?? "")
  const head = commandHead(cmd)
  if (call.exit === 1 && EXIT1_OK.has(head)) return true
  if (call.exit === 1 && /^git$/.test(head) && /\bdiff\b.*--exit-code|--quiet/.test(cmd)) return true
  // a pipeline ending in grep (no match) is not an error either
  if (call.exit === 1 && /\|\s*(grep|rg)\b[^|]*$/.test(cmd)) return true
  return false
}

const ERROR_LINE_RE =
  /(error|fehler|failed|failure|exception|fatal|denied|not found|nicht gefunden|cannot|can't|unable|invalid|unknown|refused|timed? ?out|no such|unexpected|undefined|missing|conflict|abort)/i

export function normalizeError(text: string): string {
  const clean = text.replace(/\u001b\[[0-9;]*m/g, "").replace(/^exit -?\d+:\s*/i, "")
  const lines = clean
    .split(/\r?\n| \| /)
    .map((l) => l.trim())
    .filter(Boolean)
  const javaLike = lines.find((l) => /\b([a-zA-Z_$][\w$]*\.)+[A-Z][\w$]*(Exception|Error)\b/.test(l))
  const pyLike = [...lines].reverse().find((l) => /^[A-Z][A-Za-z]*(Error|Exception|Warning)\b:/.test(l))
  const line = javaLike ?? pyLike ?? lines.find((l) => ERROR_LINE_RE.test(l)) ?? lines[0] ?? ""
  return truncate(
    line
      .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g, "<ts>")
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)]+/gi, "<url>")
      .replace(/(?:[A-Za-z]:)?(?:\.{0,2}[\\/][\w.@~+-]+){2,}[\\/]?/g, "<path>")
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
      .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi, "<hex>")
      .replace(/(?<![A-Za-z_=-])\b\d+(?:\.\d+)*\b/g, "<n>")
      .replace(/(["'])[^"'\n]{41,}\1/g, "<s>")
      .replace(/\s+/g, " ")
      .trim(),
    200,
  )
}

export function errorSignature(tool: string, command: string, errorText: string): { signature: string; sigKey: string; head: string } {
  const head = SHELL_TOOLS.has(tool) ? commandHead(command) || tool : tool
  const signature = `${head}: ${normalizeError(errorText)}`
  return { signature, sigKey: sha(signature, 16), head }
}

/** Strings like a stack trace / error message pasted by the user. */
export function looksLikeError(text: string): boolean {
  if (text.length < 20) return false
  return /(exception|traceback|stack ?trace|\berror\b|\bfehler\b|failed|exit code|\bat [\w.$]+\(|ORA-\d|SQLCODE|SQLSTATE|ERR_[A-Z])/i.test(text)
}

/** error → retries → success? (per user turn) */
export function extractChains(
  calls: ToolCall[],
  userTexts: string[],
  sessionsFor: (sigKey: string) => number,
): ErrorChain[] {
  const chains: ErrorChain[] = []
  const byKey = new Map<string, ErrorChain>()
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i]
    if (c.ok || isIgnorableFailure(c)) continue
    const command = String(c.input?.command ?? c.summary ?? "")
    const sig = errorSignature(c.tool, command, c.error ?? "")
    const existing = byKey.get(sig.sigKey)
    if (existing && !existing.resolved) {
      existing.attempts.push(truncate(`${c.summary} → ERROR`, 200))
      continue
    }
    if (existing) continue
    const chain: ErrorChain = {
      id: `E${chains.length + 1}`,
      tool: c.tool,
      head: sig.head,
      command: truncate(c.summary, 300),
      error: truncate(c.error ?? "", 600),
      signature: sig.signature,
      sigKey: sig.sigKey,
      attempts: [],
      resolved: false,
      label: c.label,
      sessions: Math.max(1, sessionsFor(sig.sigKey)),
    }
    // look ahead within the same user turn
    for (let j = i + 1; j < calls.length && calls[j].turn === c.turn; j++) {
      const n = calls[j]
      const nHead = SHELL_TOOLS.has(n.tool) ? commandHead(String(n.input?.command ?? "")) : n.tool
      const sameTarget = n.tool === c.tool && nHead === sig.head
      if (sameTarget && n.ok) {
        chain.resolved = true
        chain.resolution = truncate(n.summary, 300)
        break
      }
      if (chain.attempts.length < 8) chain.attempts.push(truncate(`${n.tool} ${n.summary} → ${n.ok ? "ok" : "ERROR"}`, 200))
    }
    const next = userTexts[c.turn + 1]
    if (next && CORRECTION_RE.test(next)) chain.userCorrection = truncate(oneLine(next), 240)
    chains.push(chain)
    byKey.set(sig.sigKey, chain)
  }
  return chains
}

// ---------------------------------------------------------------------------
// abbreviations
// ---------------------------------------------------------------------------

const DEFAULT_IGNORE = (
  "API APIS HTTP HTTPS URL URLS URI JSON XML HTML CSS SQL CSV TSV PDF ID IDS UUID UI UX OK CLI IDE OS CPU GPU RAM ROM GB MB KB TB " +
  "AI KI LLM MCP PR PRS CI CD QA DB JS TS JSX TSX NPM JDK JVM JRE IP DNS TCP UDP SSH SSL TLS VPN AWS GCP CRUD REST SOAP YAML YML " +
  "TODO FIXME README MD EOF UTC CET CEST MEZ MESZ ISO UTF ASCII PNG JPG JPEG SVG GIF ZIP TAR GZ PATH HOME TMP ENV PID GUI FAQ ETA " +
  "ASAP FYI IT EDV USA EU DE EN PS NB ZB BZW USW ETC INFO WARN WARNING ERROR DEBUG TRACE FATAL GET POST PUT DELETE PATCH HEAD " +
  "OPTIONS SELECT FROM WHERE AND OR NOT NULL TRUE FALSE JOIN INSERT UPDATE CREATE TABLE INDEX ORDER GROUP BY LIMIT ASC DESC HAVING " +
  "VALUES SET INTO AS ON IN IS LIKE MAX MIN AVG SUM COUNT DB2 SSO OAUTH JWT SAML LDAP AD SDK APK IOS MAC PC USB WLAN LAN WIFI NAS " +
  "VM VMS RPC GRPC MVC OOP DTO DAO POJO ORM JPA JDBC ODBC SPA SSR SEO CMS IBAN BIC PIN TAN EUR USD CHF GMBH AG KG NR CA VS " +
  "MS OK YES NO ICH DU ER SIE WIR IHR ES DAS DER DIE UND ODER NICHT BITTE DANKE THE A AN TO OF FOR WITH IF ELSE THEN DONE TBD " +
  "WIP POC MVP LTS RC CVE PII GDPR DSGVO UTF8 UTF16 HTTP2 IPV4 IPV6 CORS CSRF XSS DOM SVN GIT NPMRC NVM MAVEN " +
  "ACHTUNG HINWEIS WICHTIG FEHLER WARNUNG ALLE KEINE NUR NEU ALT ENDE START STOP JA NEIN AUCH SEHR GUT OHNE MIT " +
  "NOTE NOTES IMPORTANT ALL NONE ONLY NEW OLD END NEVER ALWAYS MUST SHOULD NOT YES CHANGELOG LICENSE AGENTS SKILL"
).split(/\s+/)

export interface AbbrevFinding {
  term: string
  count: number
  contexts: string[]
  known: boolean
  definition?: { expansion: string; source: "user" | "assistant"; text: string }
}

const ABBR_RE = /(?<![\p{L}\p{N}_./@#-])([\p{Lu}][\p{L}\p{N}&]{1,11})(?![\p{L}\p{N}_/-])/gu

export function isAbbreviation(token: string): boolean {
  if (token.length < 2 || token.length > 12) return false
  if (/^\d+$/.test(token)) return false
  if (/^[QV]\d+$/i.test(token)) return false
  const upper = (token.match(/\p{Lu}/gu) ?? []).length
  const letters = (token.match(/\p{L}/gu) ?? []).length
  if (upper < 2 || letters < 2) return false
  // long all-caps words without digits are usually emphasis ("WICHTIG"), not abbreviations
  if (letters >= 7 && upper === letters && !/\d|&/.test(token)) return false
  // all-caps / mostly caps (SEPA, KWG, DB2, M&A) or camel-ish acronym (MaRisk, BaFin)
  return upper / letters >= 0.5 || /^\p{Lu}\p{Ll}{1,3}\p{Lu}/u.test(token)
}

function initials(words: string[]): string {
  return words
    .map((w) => {
      const caps = w.match(/\p{Lu}/gu) ?? []
      return (w[0] ?? "") + caps.slice(1).join("")
    })
    .join("")
}

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0
  for (const ch of hay) if (fold(ch) === fold(needle[i] ?? "")) i++
  return i >= needle.length
}

/** Does `words` plausibly expand `term`? (initials, or first letter + all letters in order) */
function fitsExpansion(term: string, words: string[]): boolean {
  const letters = term.replace(/[^\p{L}]/gu, "")
  if (!letters || !words.length) return false
  if (fold(words[0][0] ?? "") !== fold(letters[0])) return false
  return isSubsequence(letters, initials(words)) || isSubsequence(letters, words.join(""))
}

/** "Long Form (ABK)" → shortest preceding word run that expands ABK. */
function expansionBefore(text: string, idx: number, term: string): string | undefined {
  const before = text.slice(Math.max(0, idx - 160), idx).replace(/[\s(]+$/, "")
  const words = before.split(/\s+/).filter(Boolean).slice(-10)
  for (let n = 1; n <= words.length; n++) {
    const run = words.slice(words.length - n)
    if (run.some((w) => /[.:;!?]$/.test(w) && w !== run[run.length - 1])) break
    if (fitsExpansion(term, run)) return run.join(" ").replace(/[,;:]+$/, "")
  }
  return undefined
}

const DEF_AFTER = [
  /^\s*\(\s*([^()]{3,120}?)\s*\)/,
  /^\s*(?:=|:|–|—|-)\s+([^\n.;,()]{3,120})/,
  /^\s+(?:steht für|bedeutet|heißt|heisst|meint|ist die abkürzung für|ist kurz für|stands for|means|is short for)\s+([^\n.;,()]{3,120})/i,
]

export function detectAbbreviations(input: {
  userTexts: string[]
  assistantText: string
  isKnown: (term: string) => boolean
  ignore: string[]
  redact: (s: string) => string
}): AbbrevFinding[] {
  const ignore = new Set([...DEFAULT_IGNORE, ...input.ignore].map((t) => fold(t)))
  const found = new Map<string, AbbrevFinding>()
  const sources: Array<{ text: string; source: "user" | "assistant" }> = [
    ...input.userTexts.map((t) => ({ text: t, source: "user" as const })),
    { text: input.assistantText, source: "assistant" as const },
  ]
  for (const { text: raw, source } of sources) {
    const text = stripCode(raw).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ")
    for (const m of text.matchAll(ABBR_RE)) {
      const term = m[1]
      if (!isAbbreviation(term) || ignore.has(fold(term))) continue
      const idx = m.index ?? 0
      let f = found.get(term)
      if (!f) {
        f = { term, count: 0, contexts: [], known: input.isKnown(term) }
        found.set(term, f)
      }
      f.count++
      if (f.contexts.length < 3) f.contexts.push(input.redact(oneLine(text.slice(Math.max(0, idx - 60), idx + term.length + 60))))
      if (!f.definition) {
        const after = text.slice(idx + term.length, idx + term.length + 160)
        let expansion: string | undefined
        for (const re of DEF_AFTER) {
          const d = re.exec(after)
          if (d) {
            const cand = d[1].trim().replace(/\s+/g, " ")
            const words = cand.split(" ")
            // accept when the words fit the abbreviation or it is an explicit "steht für" definition
            if (words.length <= 10 && (fitsExpansion(term, words) || re === DEF_AFTER[2])) {
              expansion = cand
              break
            }
          }
        }
        if (!expansion && /^\s*\)/.test(text.slice(idx + term.length)) && text[idx - 1] === "(") {
          expansion = expansionBefore(text, idx - 1, term)
        }
        if (expansion && fold(expansion) !== fold(term)) {
          f.definition = { expansion: truncate(expansion, 120), source, text: input.redact(oneLine(text.slice(Math.max(0, idx - 80), idx + term.length + 120))) }
        }
      }
    }
  }
  return [...found.values()].sort((a, b) => b.count - a.count || a.term.localeCompare(b.term)).slice(0, 30)
}

// ---------------------------------------------------------------------------
// automation signals
// ---------------------------------------------------------------------------

export interface AutomationSignals {
  score: number
  items: string[]
  userRequested: boolean
}

const AUTOMATE_RE =
  /\b(automatisier\w*|automate\w*|skript\w*|script\w*|jedes mal|immer wieder|wiederkehrend\w*|regelmäßig\w*|regelmaessig\w*|wiederhol\w*|repetitive|every time)\b/i

function normCommand(cmd: string): string {
  return cmd
    .replace(/(["']).*?\1/g, "<s>")
    .replace(/(?:\.{0,2}\/)?(?:[\w.@~+-]+\/)+[\w.@~+-]*/g, "<path>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
}

export function automationSignals(calls: ToolCall[], userText: string): AutomationSignals {
  const items: string[] = []
  let score = 0
  const add = (points: number, what: string) => {
    score += points
    if (items.length < 12) items.push(what)
  }
  const seen = new Map<string, number>()
  const tempScripts = new Set<string>()
  for (const c of calls) {
    if (EDIT_TOOLS.has(c.tool)) {
      const p = String(c.input?.filePath ?? c.input?.path ?? "")
      if (/\.(py|sh)$/.test(p)) tempScripts.add(p.split("/").pop()!)
      continue
    }
    if (!SHELL_TOOLS.has(c.tool)) continue
    const cmd = String(c.input?.command ?? "")
    if (/\bpython3?\s+-c\b|\bpython3?\s+-\s*<<|<<\s*['"]?(EOF|PY|PYTHON)['"]?[\s\S]*\b(import|print)\b/.test(cmd)) add(2, `inline python: ${truncate(oneLine(cmd), 200)}`)
    else if (/\b(node|perl|ruby)\s+-e\b/.test(cmd)) add(2, `inline script: ${truncate(oneLine(cmd), 200)}`)
    const pipes = (cmd.match(/(?<!\|)\|(?!\|)/g) ?? []).length
    if (pipes >= 3) add(1, `long pipeline (${pipes} pipes): ${truncate(oneLine(cmd), 160)}`)
    if (/\b(jq|awk|sed)\b/.test(cmd) && pipes >= 1) add(1, `text processing: ${truncate(oneLine(cmd), 160)}`)
    if (/\b(for|while)\b[^;]*;\s*do\b/.test(cmd)) add(1, `shell loop: ${truncate(oneLine(cmd), 160)}`)
    for (const t of tempScripts) if (cmd.includes(t)) add(2, `ad-hoc script ${t} executed`)
    const n = normCommand(cmd)
    if (n.length > 8) {
      const count = (seen.get(n) ?? 0) + 1
      seen.set(n, count)
      if (count === 3) add(2, `repeated command (3×): ${truncate(oneLine(cmd), 160)}`)
    }
  }
  const userRequested = AUTOMATE_RE.test(userText)
  if (userRequested) add(3, "user mentions automation/scripts/repetition")
  return { score, items, userRequested }
}

// ---------------------------------------------------------------------------
// code changes and project docs
// ---------------------------------------------------------------------------

const CODE_STOP = new Set(
  (
    "function return const let var class public private protected static void import export from new this true false null " +
    "undefined if else for while switch case break continue default try catch finally throw async await interface type enum " +
    "string number boolean any unknown never object extends implements package final abstract override super int long double " +
    "float char byte short self def lambda none pass yield with elif print println string list map set array value values key keys " +
    "data item items result results error errors index length size name names test tests expect describe todo"
  ).split(/\s+/),
)

export interface CodeChanges {
  files: string[]
  text: string
  identifiers: string[]
}

function idents(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*(?:[.-][A-Za-z_][A-Za-z0-9_]*)*/g)) {
    const t = m[0]
    if (t.length < 4 || CODE_STOP.has(t.toLowerCase())) continue
    out.add(t)
  }
  return out
}

export function codeChanges(calls: ToolCall[], redact: (s: string) => string, maxChars: number): CodeChanges {
  const files: string[] = []
  const parts: string[] = []
  const removed = new Set<string>()
  const added = new Set<string>()
  for (const c of calls) {
    if (!EDIT_TOOLS.has(c.tool) || !c.ok) continue
    const inp = c.input ?? {}
    const file = String(inp.filePath ?? inp.path ?? "")
    if (c.tool === "edit" || c.tool === "multiedit") {
      const edits: Array<{ oldString?: unknown; newString?: unknown }> = Array.isArray(inp.edits) ? (inp.edits as any[]) : [inp as any]
      for (const e of edits) {
        const o = String(e.oldString ?? "")
        const n = String(e.newString ?? "")
        const oi = idents(o)
        const ni = idents(n)
        for (const t of oi) if (!ni.has(t)) removed.add(t)
        for (const t of ni) if (!oi.has(t)) added.add(t)
        parts.push(`--- ${file}\n${truncate(o, 600).split("\n").map((l) => `- ${l}`).join("\n")}\n${truncate(n, 600).split("\n").map((l) => `+ ${l}`).join("\n")}`)
      }
    } else if (c.tool === "write") {
      const content = String(inp.content ?? "")
      for (const t of idents(content.slice(0, 4000))) added.add(t)
      parts.push(`--- ${file} (written)\n${truncate(content, 800)}`)
    } else {
      const patch = String(inp.patchText ?? inp.patch ?? inp.input ?? "")
      for (const m of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$|^\+\+\+ b\/(.+)$/gm)) files.push((m[1] ?? m[2]).trim())
      for (const line of patch.split("\n")) {
        if (line.startsWith("-") && !line.startsWith("---")) for (const t of idents(line)) removed.add(t)
        if (line.startsWith("+") && !line.startsWith("+++")) for (const t of idents(line)) added.add(t)
      }
      parts.push(truncate(patch, 1200))
    }
    if (file) files.push(file)
  }
  for (const t of added) removed.delete(t)
  const fileIds = files.map((f) => f.split("/").pop() ?? f).filter((f) => f.length >= 4)
  const identifiers = [...new Set([...removed, ...fileIds, ...[...added].filter((t) => /[A-Z_]{4,}|[a-z][A-Z]|\./.test(t))])].slice(0, 40)
  let text = redact(parts.join("\n\n"))
  if (text.length > maxChars) text = text.slice(0, maxChars) + "\n[… truncated …]"
  return { files: [...new Set(files)], text, identifiers }
}

const DOC_SKIP = new Set(["node_modules", ".git", "dist", "build", "target", "out", "coverage", "vendor", ".venv", "venv", "__pycache__", ".next", ".idea"])

export function scanRepoDocs(root: string, identifiers: string[], maxChars: number): Array<{ file: string; line: number; text: string }> {
  if (!identifiers.length || maxChars <= 0) return []
  const files: string[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || files.length >= 400) return
    let entries: import("node:fs").Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (DOC_SKIP.has(e.name) || (e.name.startsWith(".") && e.name !== ".github")) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (e.isFile() && /\.md$/i.test(e.name)) files.push(p)
      if (files.length >= 400) return
    }
  }
  walk(root, 0)
  const res = identifiers.map((id) => ({ id, re: new RegExp(`(?<![A-Za-z0-9_])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`) }))
  const out: Array<{ file: string; line: number; text: string }> = []
  let used = 0
  for (const f of files) {
    try {
      if (statSync(f).size > 300_000) continue
    } catch {
      continue
    }
    const lines = (readText(f) ?? "").split("\n")
    for (let i = 0; i < lines.length; i++) {
      if (!res.some((r) => r.re.test(lines[i]))) continue
      const text = lines.slice(Math.max(0, i - 1), i + 3).join("\n").trim()
      if (used + text.length > maxChars) return out
      out.push({ file: relative(root, f).split(sep).join("/"), line: i + 1, text })
      used += text.length
      i += 2
    }
  }
  return out
}
