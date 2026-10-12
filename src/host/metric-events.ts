/**
 * Metrics from the opencode event stream (v1): model replies with tokens and cost,
 * tool calls with duration and outcome, compactions, user messages, script runs.
 * Only ids, names, numbers and times are recorded – never texts or tool arguments.
 */
import type { Ctx } from "../core/context"
import { M } from "../core/metrics"
import { branchOf, sessionInfo } from "../core/services"
import { scriptFiles } from "../core/kinds"

type AnyRecord = Record<string, any>

const SHELL = new Set(["bash", "shell"])

export class MetricEvents {
  private seenMessages = new Set<string>()
  private seenCalls = new Set<string>()
  private callStart = new Map<string, number>()

  constructor(private ctx: Ctx) {}

  private remember(set: Set<string>, id: string): boolean {
    if (set.has(id)) return false
    set.add(id)
    if (set.size > 5000) {
      const keep = [...set].slice(-2500)
      set.clear()
      for (const k of keep) set.add(k)
    }
    return true
  }

  /** event hook */
  onEvent(event: AnyRecord): void {
    const m = this.ctx.metrics
    if (!m) return
    const props = event?.properties ?? {}
    switch (event?.type) {
      case "message.updated": {
        const info = props.info
        if (!info || info.role !== "assistant" || !info.time?.completed || !info.id) return
        if (!this.remember(this.seenMessages, info.id)) return
        const sid = info.sessionID
        const model = info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : undefined
        const run = sid ? this.ctx.runs.forAgentSession(sid) : undefined
        if (run && model && !run.model) run.model = model
        const t = info.tokens ?? {}
        const input = Number(t.input) || 0
        const output = Number(t.output) || 0
        const reasoning = Number(t.reasoning) || 0
        const who = sessionInfo(this.ctx, sid, undefined, info.mode)
        m.record({
          type: M.reply,
          at: Number(info.time.completed) || undefined,
          entry: run ? `smith:${run.smith}` : `agent:${info.mode ?? "unknown"}`,
          ...who,
          model: model ?? who.model,
          project: this.ctx.project,
          value: input + output + reasoning,
          value2: Number(info.cost) || 0,
          extra: {
            input,
            output,
            reasoning,
            cacheRead: Number(t.cache?.read) || 0,
            cacheWrite: Number(t.cache?.write) || 0,
            ms: info.time.created ? Number(info.time.completed) - Number(info.time.created) : undefined,
            ...(info.error ? { error: true } : {}),
          },
        })
        return
      }
      case "message.part.updated": {
        const part = props.part
        if (!part || part.type !== "tool" || !part.callID) return
        const st = part.state ?? {}
        if (st.status !== "completed" && st.status !== "error") return
        if (!this.remember(this.seenCalls, part.callID)) return
        const start = Number(st.time?.start) || undefined
        const end = Number(st.time?.end) || undefined
        const who = sessionInfo(this.ctx, part.sessionID)
        m.record({
          type: M.toolCall,
          at: end,
          entry: `tool:${part.tool}`,
          ...who,
          project: this.ctx.project,
          value: start && end ? end - start : undefined,
          extra: st.status === "error" ? { error: true } : undefined,
        })
        return
      }
      case "session.compacted": {
        const sid = props.sessionID
        m.record({ type: M.compaction, entry: "", ...sessionInfo(this.ctx, sid), project: this.ctx.project })
        return
      }
    }
  }

  /** chat.message of a user (not internal) */
  onUserMessage(sessionID: string, agent: string | undefined, model: string | undefined): void {
    this.ctx.metrics?.record({ type: M.userMessage, entry: `agent:${agent ?? "unknown"}`, ...sessionInfo(this.ctx, sessionID, undefined, agent), model, project: this.ctx.project, branch: branchOf(this.ctx) })
  }

  onToolBefore(callID: string | undefined): void {
    if (!callID) return
    this.callStart.set(callID, Date.now())
    if (this.callStart.size > 2000) this.callStart.clear()
  }

  /** tool.execute.after: shell commands that run a store script → script.run (exit code, duration) */
  onToolAfter(sessionID: string, tool: string, callID: string | undefined, args: AnyRecord, out: AnyRecord): string | undefined {
    const started = callID ? this.callStart.get(callID) : undefined
    if (callID) this.callStart.delete(callID)
    if (!SHELL.has(tool)) return undefined
    const command = String(args?.command ?? "")
    if (!command) return undefined
    const name = scriptOfCommand(command, this.ctx.store.list("script").map((s) => s.name))
    if (!name) return undefined
    const exit = typeof out?.metadata?.exit === "number" ? (out.metadata.exit as number) : undefined
    this.ctx.usage.sink?.(M.scriptRun, `script:${name}`, { session: sessionID, value: exit ?? 0, extra: { ms: started ? Date.now() - started : undefined, ...(exit ? { error: true } : {}) } })
    return name
  }
}

/** Which store script a shell command runs: its module file or its directory in the store. */
export function scriptOfCommand(command: string, names: string[]): string | undefined {
  for (const name of names) {
    const mod = scriptFiles(name).code
    const re = new RegExp(`(^|[\\s/"'])(${escape(mod)}|scripts/(active|dormant|archive)/${escape(name)}/)`)
    if (re.test(command)) return name
  }
  return undefined
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
