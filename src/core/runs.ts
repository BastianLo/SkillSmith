import type { WriteMode } from "../config"
import type { Actor, Run, Smith } from "../types"
import { nowIso, runId } from "../util/text"

const PREFIX: Record<Actor, string> = { reviewer: "rev", curator: "cur", command: "cmd", web: "web" }
const SMITH_PREFIX: Record<Smith, string> = { skillsmith: "sk", docsmith: "doc", errorsmith: "err", toolsmith: "tool", memorysmith: "mem", doctor: "dr" }

export interface CreateRunInput {
  smith: Smith
  actor: Actor
  trigger: string
  writeMode: WriteMode
  directory: string
  project: string
  sessionID?: string
  sessionAgent?: string
  parentSessionID?: string
  limits?: Partial<Run["limits"]>
  userText?: string
  haystack?: string
}

/** In-process registry of active runs (process-global so all plugin instances share it). */
export class RunRegistry {
  private runs = new Map<string, Run>()
  private byAgentSession = new Map<string, string>()

  create(input: CreateRunInput): Run {
    const run: Run = {
      id: runId(`${PREFIX[input.actor]}-${SMITH_PREFIX[input.smith]}`),
      smith: input.smith,
      actor: input.actor,
      trigger: input.trigger,
      writeMode: input.writeMode,
      directory: input.directory,
      project: input.project,
      sessionID: input.sessionID,
      sessionAgent: input.sessionAgent,
      parentSessionID: input.parentSessionID,
      limits: { maxNew: 0, maxChanges: 100, maxNotes: 5, ...(input.limits ?? {}) },
      created: 0,
      changes: 0,
      notes: 0,
      actions: [],
      touched: new Set(),
      userText: input.userText,
      haystack: input.haystack,
      startedAt: nowIso(),
    }
    this.runs.set(run.id, run)
    return run
  }

  attach(run: Run, agentSessionID: string): void {
    run.agentSessionID = agentSessionID
    this.byAgentSession.set(agentSessionID, run.id)
  }

  forAgentSession(sessionID: string): Run | undefined {
    const id = this.byAgentSession.get(sessionID)
    return id ? this.runs.get(id) : undefined
  }

  isAgentSession(sessionID: string): boolean {
    return this.byAgentSession.has(sessionID)
  }

  get(id: string): Run | undefined {
    return this.runs.get(id)
  }

  active(): Run[] {
    return [...this.runs.values()]
  }

  end(run: Run): void {
    this.runs.delete(run.id)
    if (run.agentSessionID) {
      // keep the session id marked as internal for a while (late events)
      const sid = run.agentSessionID
      setTimeout(() => this.byAgentSession.delete(sid), 10 * 60_000).unref?.()
    }
  }
}

export function sharedRunRegistry(): RunRegistry {
  const key = Symbol.for("skillsmith.runs")
  return ((globalThis as any)[key] ??= new RunRegistry())
}
