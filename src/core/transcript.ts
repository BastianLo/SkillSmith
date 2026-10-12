/**
 * Turns opencode session messages (SDK `session.messages`) into
 *  - a compact, redacted transcript for the background agents,
 *  - structured tool calls (for error chains, automation signals, code changes),
 *  - entry feedback (what happened after a skill/script/knowledge entry was used),
 *  - an evidence haystack (user text, assistant text, tool outputs) for quote checks.
 */
import type { Kind } from "../types"
import { oneLine, truncate } from "../util/text"

export interface MsgInfo {
  id: string
  sessionID?: string
  role: "user" | "assistant" | string
  time?: { created?: number; completed?: number }
  agent?: string
  mode?: string
  error?: unknown
  model?: { providerID?: string; modelID?: string }
  providerID?: string
  modelID?: string
}

export interface MsgPart {
  id?: string
  type: string
  text?: string
  synthetic?: boolean
  ignored?: boolean
  tool?: string
  callID?: string
  filename?: string
  mime?: string
  agent?: string
  prompt?: string
  description?: string
  state?: {
    status?: string
    input?: Record<string, unknown>
    output?: string
    error?: string
    title?: string
    metadata?: Record<string, unknown>
  }
}

export interface Msg {
  info: MsgInfo
  parts: MsgPart[]
}

export const INTERNAL_PREFIX = "[skillsmith]"
export const HINT_PART_PREFIX = "prt_skillsmith"
export const SKILL_TOOLS = new Set(["skill", "skill_read"])
export const SHELL_TOOLS = new Set(["bash", "shell", "pwsh", "powershell", "cmd"])
export const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "multiedit", "patch"])
const KNOWN_ERROR_RE = /\n*<known_error[\s\S]*?<\/known_error>\n*/g

export function stripPluginNotes(text: string): string {
  return text.replace(KNOWN_ERROR_RE, "\n").trim()
}

export function userText(msg: Msg): string {
  return msg.parts
    .filter((p) => p.type === "text" && !p.synthetic && !p.ignored && !(p.id ?? "").startsWith(HINT_PART_PREFIX))
    .map((p) => p.text ?? "")
    .join("\n")
    .trim()
}

export function isInternalMessage(msg: Msg): boolean {
  return msg.info.role === "user" && userText(msg).startsWith(INTERNAL_PREFIX)
}

export function sliceUnreviewed(messages: Msg[], lastReviewedID?: string): Msg[] {
  if (!lastReviewedID) return messages
  const idx = messages.findIndex((m) => m.info.id === lastReviewedID)
  if (idx < 0) return messages.filter((m) => m.info.id > lastReviewedID)
  return messages.slice(idx + 1)
}

/** Model of the most recent message (user: info.model, assistant: providerID/modelID). */
export function sessionModel(messages: Msg[]): { providerID: string; modelID: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i].info
    if (info.role === "assistant" && info.providerID && info.modelID) return { providerID: info.providerID, modelID: info.modelID }
    if (info.role === "user" && info.model?.providerID && info.model?.modelID) {
      return { providerID: info.model.providerID, modelID: info.model.modelID }
    }
  }
  return undefined
}

function s(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v)
}

function inputSummary(tool: string, input: Record<string, unknown> | undefined): string {
  if (!input) return ""
  if (SHELL_TOOLS.has(tool) && input.command) return truncate(oneLine(s(input.command)), 300)
  if ((SKILL_TOOLS.has(tool) || tool.endsWith("_read")) && input.name) return s(input.name)
  for (const key of ["filePath", "path", "pattern", "url", "query"]) {
    if (input[key]) return truncate(oneLine(`${key}=${s(input[key])}`), 200)
  }
  if (tool === "task") {
    return truncate(oneLine(`${s(input.subagent_type ?? input.agent ?? "")}: ${s(input.description ?? input.prompt ?? "")}`), 200)
  }
  const keys = Object.keys(input).slice(0, 4)
  return truncate(oneLine(keys.map((k) => `${k}=${s(input[k])}`).join(" ")), 160)
}

export interface ToolOutcome {
  ok: boolean
  error?: string
  exit?: number
}

export function toolOutcome(part: MsgPart): ToolOutcome | undefined {
  const st = part.state
  if (!st || (st.status !== "completed" && st.status !== "error")) return undefined
  if (st.status === "error") return { ok: false, error: oneLine(st.error ?? "error") }
  if (SHELL_TOOLS.has(part.tool ?? "")) {
    const exit = typeof st.metadata?.exit === "number" ? (st.metadata.exit as number) : undefined
    if (exit !== undefined && exit !== 0) {
      const out = stripPluginNotes(String(st.output ?? st.metadata?.output ?? ""))
      const tail = out.split("\n").filter((l) => l.trim()).slice(-4).join(" | ")
      return { ok: false, exit, error: `exit ${exit}${tail ? `: ${oneLine(tail)}` : ""}` }
    }
    return { ok: true, exit }
  }
  return { ok: true }
}

export interface ToolCall {
  label: string
  /** index of the preceding user message (0-based; -1 before the first) */
  turn: number
  tool: string
  input: Record<string, unknown>
  summary: string
  ok: boolean
  exit?: number
  /** redacted error line (incl. output tail for shells) */
  error?: string
  /** redacted, plugin notes stripped, truncated */
  output: string
  /** a live known-error hint was attached to this call */
  hinted?: string
}

export interface EntryUse {
  kind: Kind
  name: string
  label: string
  errors: string[]
  recovered: string[]
  userCorrection?: string
}

/** @deprecated name kept for older imports */
export type SkillLoad = EntryUse & { skill: string }

export interface TranscriptResult {
  text: string
  userText: string
  userTexts: string[]
  assistantText: string
  messages: number
  userMessages: number
  toolCalls: number
  errors: number
  omitted: number
  firstMessageID?: string
  lastMessageID?: string
  agents: string[]
  calls: ToolCall[]
  /** uses of store entries (skills, knowledge, scripts) with what happened afterwards */
  uses: EntryUse[]
  /** @deprecated skill uses only */
  loads: SkillLoad[]
  searchText: string
  haystack: string
}

export const CORRECTION_RE =
  /\b(nein|falsch|stimmt nicht|nicht so|stattdessen|lieber|doch nicht|funktioniert nicht|geht nicht|klappt nicht|wrong|incorrect|instead|don't|do not|doesn't work|does not work|not what|that's not|stop)\b/i

export interface TranscriptOptions {
  maxChars: number
  redact: (s: string) => string
  /** maps a shell command to the name of a store script it runs */
  scriptOf?: (command: string) => string | undefined
}

const READ_TOOL_KIND: Record<string, Kind> = { skill: "skill", skill_read: "skill", knowledge_read: "knowledge", script_read: "script" }

export function buildTranscript(allMessages: Msg[], opts: TranscriptOptions): TranscriptResult {
  const messages = allMessages.filter((m) => !isInternalMessage(m))
  const blocks: string[] = []
  const userTexts: string[] = []
  const assistantTexts: string[] = []
  const outputs: string[] = []
  const errorLines: string[] = []
  const agents = new Set<string>()
  const calls: ToolCall[] = []
  let toolCalls = 0
  let errors = 0
  let u = 0
  let a = 0
  const uses: EntryUse[] = []
  let open: EntryUse[] = []
  const failedInputs = new Map<string, string>()

  for (const msg of messages) {
    if (msg.info.agent) agents.add(msg.info.agent)
    if (msg.info.role === "user") {
      u++
      const label = `U${u}`
      const text = userText(msg)
      for (const use of open) {
        if (!use.userCorrection && CORRECTION_RE.test(text)) use.userCorrection = truncate(oneLine(opts.redact(text)), 240)
      }
      open = []
      failedInputs.clear()
      const files = msg.parts.filter((p) => p.type === "file").map((p) => p.filename ?? p.mime ?? "file")
      const subtasks = msg.parts.filter((p) => p.type === "subtask").map((p) => `${p.agent ?? "subagent"}: ${p.description ?? ""}`)
      let body = opts.redact(truncate(text, 3000))
      if (files.length) body += `\n(attached: ${files.join(", ")})`
      if (subtasks.length) body += `\n(subtask: ${subtasks.join("; ")})`
      userTexts.push(text)
      blocks.push(`[${label}]${msg.info.agent ? ` (agent ${msg.info.agent})` : ""}\n${body || "(empty)"}`)
      continue
    }
    if (msg.info.role !== "assistant") continue
    a++
    const label = `A${a}`
    const lines: string[] = []
    for (const part of msg.parts) {
      if (part.type === "text" && part.text && !part.synthetic) {
        const t = opts.redact(truncate(part.text.trim(), 2000))
        assistantTexts.push(t)
        lines.push(t)
        continue
      }
      if (part.type !== "tool") continue
      const tool = part.tool ?? "tool"
      const outcome = toolOutcome(part)
      if (!outcome) continue
      toolCalls++
      const input = (part.state?.input ?? {}) as Record<string, unknown>
      const summary = opts.redact(inputSummary(tool, input))
      const rawOut = String(part.state?.output ?? part.state?.metadata?.output ?? "")
      const hinted = /<known_error[^>]*name="([^"]+)"/.exec(rawOut)?.[1]
      const output = opts.redact(truncate(stripPluginNotes(rawOut), 4000))
      if (output) outputs.push(output)
      const call: ToolCall = {
        label,
        turn: u - 1,
        tool,
        input,
        summary,
        ok: outcome.ok,
        exit: outcome.exit,
        error: outcome.ok ? undefined : truncate(opts.redact(outcome.error ?? "error"), 600),
        output,
        hinted,
      }
      calls.push(call)
      const inputKey = `${tool}::${JSON.stringify(input)}`
      const readKind = READ_TOOL_KIND[tool]
      const scriptName = SHELL_TOOLS.has(tool) && opts.scriptOf ? opts.scriptOf(String(input.command ?? "")) : undefined
      if (outcome.ok) {
        lines.push(`  · ${tool} ${summary} → ok`)
        if (readKind && typeof input.name === "string") {
          const use: EntryUse = { kind: readKind, name: String(input.name), label, errors: [], recovered: [] }
          uses.push(use)
          open.push(use)
        } else if (failedInputs.has(tool) && failedInputs.get(tool) !== inputKey) {
          for (const use of open) use.recovered.push(truncate(`${tool} ${summary}`, 200))
          failedInputs.delete(tool)
        }
        if (scriptName) {
          const use: EntryUse = { kind: "script", name: scriptName, label, errors: [], recovered: [] }
          uses.push(use)
          open.push(use)
        }
      } else {
        errors++
        const err = call.error!
        lines.push(`  · ${tool} ${summary} → ERROR ${truncate(err, 300)}${hinted ? ` (known error hint: ${hinted})` : ""}`)
        errorLines.push(err)
        failedInputs.set(tool, inputKey)
        if (scriptName) {
          const use: EntryUse = { kind: "script", name: scriptName, label, errors: [truncate(`${tool} ${summary} → ${err}`, 300)], recovered: [] }
          uses.push(use)
          open.push(use)
        } else {
          for (const use of open) use.errors.push(truncate(`${tool} ${summary} → ${err}`, 300))
        }
      }
    }
    if (msg.info.error) {
      const err = truncate(oneLine(typeof msg.info.error === "string" ? msg.info.error : JSON.stringify(msg.info.error)), 300)
      lines.push(`  · (assistant error) ${opts.redact(err)}`)
    }
    if (lines.length) blocks.push(`[${label}]\n${lines.join("\n")}`)
  }

  let omitted = 0
  let total = blocks.reduce((n, b) => n + b.length + 2, 0)
  while (total > opts.maxChars && blocks.length > 1) {
    total -= blocks[0].length + 2
    blocks.shift()
    omitted++
  }
  let text = blocks.join("\n\n")
  if (omitted) text = `[… ${omitted} earlier blocks omitted …]\n\n${text}`
  if (text.length > opts.maxChars) text = text.slice(text.length - opts.maxChars)

  const allUser = userTexts.join("\n")
  const assistantText = assistantTexts.join("\n")
  const haystack = [opts.redact(allUser), assistantText, ...outputs].join("\n").slice(0, 400_000)
  return {
    text,
    userText: allUser,
    userTexts,
    assistantText,
    messages: messages.length,
    userMessages: u,
    toolCalls,
    errors,
    omitted,
    firstMessageID: messages[0]?.info.id,
    lastMessageID: allMessages[allMessages.length - 1]?.info.id,
    agents: [...agents],
    calls,
    uses,
    loads: uses.filter((x) => x.kind === "skill").map((x) => ({ ...x, skill: x.name })),
    searchText: opts.redact([allUser, ...errorLines].join("\n")).slice(0, 6000),
    haystack,
  }
}
