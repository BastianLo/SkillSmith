/**
 * Runs a hidden background agent (reviewer/curator of a smith) in its own
 * opencode session through the SDK client: create → promptAsync (with an
 * explicit model) → wait for idle → delete. Idle is detected from the
 * plugin's event stream with a polling fallback; a session error that leaves
 * the session idle ends the wait immediately (no 15-minute hang when the
 * model is unknown). Configuration errors are classified so the queue can
 * reschedule instead of dropping work.
 */
import type { Logger } from "../log"
import { errorMessage, truncate } from "../util/text"

export type Client = any
import { agentModelSpec, chooseModel, configModelSpec, ModelChoiceError, specOf, type ModelCandidate, type ModelRef } from "./models"
export type { ModelRef }

interface Waiter {
  resolve: (r: { idle: boolean; error?: string }) => void
  seenBusy: boolean
  error?: string
  /** a non-recoverable session error was reported */
  failed?: boolean
  kick?: () => void
}

/** errors that will not go away by retrying soon: unknown model/provider/agent, auth */
export const CONFIG_ERROR_RE =
  /ProviderModelNotFound|Model not found|ModelNotFound|ProviderNoProviders|No providers are available|ProviderNoModels|No models are available|ProviderInitError|Failed to initialize provider|ProviderAuthError|AuthError|Unauthorized|invalid api key|AgentNotFound|Agent not found|agent .* not found/i

export function isConfigError(message: string | undefined): boolean {
  return !!message && CONFIG_ERROR_RE.test(message)
}

/** Errors after which opencode continues the session on its own (compaction). */
const RECOVERABLE_ERROR_RE = /ContextOverflow/i

/** Process-global: idle/error events from any plugin instance resolve waiters. */
class SessionSignals {
  private waiters = new Map<string, Waiter>()
  private internal = new Set<string>()

  markInternal(id: string): void {
    this.internal.add(id)
    if (this.internal.size > 5000) this.internal.delete(this.internal.values().next().value as string)
  }

  isInternal(id: string): boolean {
    return this.internal.has(id)
  }

  wait(id: string): { promise: Promise<{ idle: boolean; error?: string }>; waiter: Waiter } {
    let waiter!: Waiter
    const promise = new Promise<{ idle: boolean; error?: string }>((resolve) => {
      waiter = { resolve, seenBusy: false }
    })
    this.waiters.set(id, waiter)
    return { promise, waiter }
  }

  busy(id: string): void {
    const w = this.waiters.get(id)
    if (w) w.seenBusy = true
  }

  idle(id: string): void {
    const w = this.waiters.get(id)
    if (!w) return
    this.waiters.delete(id)
    w.resolve({ idle: true, error: w.error })
  }

  /** session.error: remember the message; non-recoverable errors trigger an immediate status check */
  error(id: string, message: string, name?: string): void {
    const w = this.waiters.get(id)
    if (!w) return
    if (RECOVERABLE_ERROR_RE.test(`${name ?? ""} ${message}`)) return
    w.error = truncate(message, 600)
    w.failed = true
    w.kick?.()
  }

  drop(id: string): void {
    this.waiters.delete(id)
  }
}

export function sessionSignals(): SessionSignals {
  const key = Symbol.for("skillsmith.signals")
  return ((globalThis as any)[key] ??= new SessionSignals())
}

export function unwrap<T = any>(res: any): T {
  if (res && typeof res === "object" && "error" in res && res.error) {
    throw new Error(typeof res.error === "string" ? res.error : JSON.stringify(res.error))
  }
  if (res && typeof res === "object" && "data" in res) return res.data as T
  return res as T
}

/**
 * Best-effort check whether a model is configured (GET /config/providers).
 * Returns undefined when the check itself is not possible.
 */
export async function modelAvailable(client: Client, model: ModelRef): Promise<boolean | undefined> {
  try {
    const data = unwrap<any>(await client.config.providers())
    const providers: any[] = Array.isArray(data?.providers) ? data.providers : []
    if (!providers.length) return undefined
    const p = providers.find((x) => x?.id === model.providerID)
    if (!p) return false
    const models = p.models ?? {}
    if (Array.isArray(models)) return models.some((m: any) => m?.id === model.modelID)
    return model.modelID in models || Object.values(models).some((m: any) => m?.id === model.modelID)
  } catch {
    return undefined
  }
}

export interface AgentRunInput {
  client: Client
  agent: string
  title: string
  prompt: string
  timeoutMs: number
  keepSession: boolean
  log: Logger
  /** explicit model; without it opencode falls back to the agent's or the global default model */
  model?: ModelRef
  /** called right after the session exists (before prompting) */
  onSession?: (sessionID: string) => void
  /** return the text of the last answer (drafts, chat) */
  collectText?: boolean
  /** extra request query (directory of the session) */
  query?: Record<string, string>
  /** tools switched on/off for this session (becomes session permissions; gym, read-only checks) */
  tools?: Record<string, boolean>
}

export interface AgentRunResult {
  sessionID?: string
  ok: boolean
  timedOut?: boolean
  error?: string
  /** model/provider/agent misconfiguration – retrying immediately will not help */
  configError?: boolean
  /** text of the last answer (collectText) */
  text?: string
}

export async function runAgentSession(input: AgentRunInput): Promise<AgentRunResult> {
  const signals = sessionSignals()
  let sessionID: string | undefined
  const result = (r: AgentRunResult): AgentRunResult => ({ ...r, configError: !r.ok && isConfigError(r.error) })
  try {
    // an explicit model must exist (a name without provider is repaired when unambiguous);
    // without one: the agent's model, `model` of opencode.json, opencode's default – each only if offered
    let model: ModelRef | undefined
    try {
      const candidates: ModelCandidate[] = [{ spec: specOf(input.model), label: "Modell", strict: true }]
      if (!input.model) {
        candidates.push({ spec: await agentModelSpec(input.client, input.agent), label: `Modell des Agenten ${input.agent}` })
        candidates.push({ spec: await configModelSpec(input.client), label: "model in opencode.json" })
      }
      const choice = await chooseModel(input.client, candidates)
      model = choice.model
      if (choice.note) input.log.info(`model for ${input.agent}: ${choice.note}`)
    } catch (err) {
      if (err instanceof ModelChoiceError) return result({ ok: false, error: `${err.message} (not offered by any configured provider)` })
      throw err
    }
    const session = unwrap<{ id: string }>(await input.client.session.create({ body: { title: input.title }, ...(input.query ? { query: input.query } : {}) }))
    sessionID = session.id
    signals.markInternal(sessionID)
    input.onSession?.(sessionID)
    const { promise, waiter } = signals.wait(sessionID)
    unwrap(
      await input.client.session.promptAsync({
        path: { id: sessionID },
        body: {
          agent: input.agent,
          ...(model ? { model } : {}),
          ...(input.tools ? { tools: input.tools } : {}),
          parts: [{ type: "text", text: input.prompt }],
        },
        ...(input.query ? { query: input.query } : {}),
      }),
    )
    const started = Date.now()
    let timedOut = false
    let finished = false
    let wake: (() => void) | undefined
    waiter.kick = () => wake?.()
    const nap = (ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          wake = undefined
          resolve()
        }, ms)
        wake = () => {
          clearTimeout(t)
          wake = undefined
          resolve()
        }
      })
    // polling fallback (events are the primary signal)
    const poll = (async () => {
      while (true) {
        await nap(waiter.failed ? 1500 : 5000)
        if (finished) return
        if (Date.now() - started > input.timeoutMs) {
          timedOut = true
          waiter.error ??= "timeout"
          try {
            await input.client.session.abort({ path: { id: sessionID } })
          } catch {
            // ignore
          }
          signals.idle(sessionID!)
          return
        }
        try {
          const status = unwrap<Record<string, { type?: string }>>(await input.client.session.status())
          const st = status?.[sessionID!]?.type
          if (st && st !== "idle") waiter.seenBusy = true
          const idle = !st || st === "idle"
          if (idle && waiter.failed) {
            // error reported and nothing running anymore → done (failed)
            signals.idle(sessionID!)
            return
          }
          if (idle && (waiter.seenBusy || Date.now() - started > 15_000)) {
            const done = await lastAssistantState(input.client, sessionID!)
            if (done.completed) {
              if (done.error) waiter.error ??= done.error
              signals.idle(sessionID!)
              return
            }
            if (!done.any && Date.now() - started > 90_000) {
              waiter.error ??= "the agent did not start (no response after 90 s)"
              signals.idle(sessionID!)
              return
            }
          }
        } catch {
          // ignore poll errors
        }
      }
    })()
    const res = await promise
    finished = true
    wake?.()
    void poll
    const ok = !timedOut && !res.error
    let text: string | undefined
    if (input.collectText) {
      try {
        const msgs = unwrap<Array<{ info: { role: string }; parts?: Array<{ type: string; text?: string; synthetic?: boolean }> }>>(await input.client.session.messages({ path: { id: sessionID } }))
        const last = [...msgs].reverse().find((m) => m.info.role === "assistant")
        text = (last?.parts ?? [])
          .filter((p) => p.type === "text" && !p.synthetic && typeof p.text === "string")
          .map((p) => p.text)
          .join("\n")
          .trim()
      } catch (err) {
        input.log.warn("could not read the answer", errorMessage(err))
      }
    }
    return result({ sessionID, ok, timedOut, error: res.error, text })
  } catch (err) {
    input.log.error(`agent run (${input.agent}) failed`, errorMessage(err))
    return result({ sessionID, ok: false, error: errorMessage(err) })
  } finally {
    if (sessionID) {
      signals.drop(sessionID)
      if (!input.keepSession) {
        try {
          await input.client.session.delete({ path: { id: sessionID } })
        } catch (err) {
          input.log.warn("could not delete agent session", errorMessage(err))
        }
      }
    }
  }
}

async function lastAssistantState(client: Client, sessionID: string): Promise<{ any: boolean; completed: boolean; error?: string }> {
  try {
    const msgs = unwrap<Array<{ info: { role: string; time?: { completed?: number }; error?: any } }>>(
      await client.session.messages({ path: { id: sessionID } }),
    )
    const assistants = msgs.filter((m) => m.info.role === "assistant")
    const last = msgs[msgs.length - 1]
    const err = last?.info?.error
    return {
      any: assistants.length > 0,
      completed: !!last && last.info.role === "assistant" && (!!last.info.time?.completed || !!err),
      error: err ? errorMessage(err?.data?.message ?? err?.message ?? err) : undefined,
    }
  } catch {
    return { any: false, completed: false }
  }
}

/** A small process-wide semaphore for background agent runs (all smiths). */
export class Semaphore {
  private active = 0
  private waiting: Array<() => void> = []
  constructor(public limit: number) {}
  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.waiting.push(r))
    this.active++
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      this.waiting.shift()?.()
    }
  }
  get running(): number {
    return this.active
  }
  get queued(): number {
    return this.waiting.length
  }
}

export function agentSemaphore(limit: number): Semaphore {
  const key = Symbol.for("skillsmith.agentSemaphore")
  const s: Semaphore = ((globalThis as any)[key] ??= new Semaphore(limit))
  s.limit = Math.max(s.limit, limit)
  return s
}
