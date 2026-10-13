/**
 * Structured log (5a): one JSONL file per local day in state/log/<YYYY-MM-DD>.jsonl.
 *
 *   {"t":"…Z","lvl":"info","area":"pipeline","scope":"skillsmith:pipeline","msg":"…","data":…,
 *    "run":"…","session":"…","job":"…","cid":"…","pid":123}
 *
 * The area is the first child scope (`log.child("pipeline")`); the minimum level is per area
 * (log.areas) or global (log.level). Correlation ids come from an AsyncLocalStorage context:
 * a job run, a web action (run), a review (session) or an agent task (job) wraps its work in
 * `withLogContext(...)`, and every line written inside carries the ids – the log tab, audit
 * events, job runs and agent tasks link to their lines through them. Messages and data are
 * redacted like everything else (the redactor is attached once it exists).
 */
import { AsyncLocalStorage } from "node:async_hooks"
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { ensureDir } from "./util/fs"
import { localDay } from "./util/text"

export type Level = "debug" | "info" | "warn" | "error"
export const LEVELS: Level[] = ["debug", "info", "warn", "error"]
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface Logger {
  debug(msg: string, data?: unknown): void
  info(msg: string, data?: unknown): void
  warn(msg: string, data?: unknown): void
  error(msg: string, data?: unknown): void
  child(scope: string): Logger
}

export type LogSink = (level: Level, scope: string, msg: string, data?: unknown) => void

/** Correlation of a line: web action / smith run, session, agent task, job run. */
export interface LogContext {
  run?: string
  session?: string
  /** agent task ("aj-…") */
  job?: string
  /** job run of the scheduler ("jr-…") or another correlation id */
  cid?: string
}

const als: AsyncLocalStorage<LogContext> = ((globalThis as any)[Symbol.for("skillsmith.logContext")] ??= new AsyncLocalStorage<LogContext>())

/** Run `fn` with correlation ids (merged into the current context). */
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  const cur = als.getStore()
  return als.run({ ...cur, ...Object.fromEntries(Object.entries(ctx).filter(([, v]) => v !== undefined)) }, fn)
}

export function logContext(): LogContext {
  return als.getStore() ?? {}
}

export interface LogLine extends LogContext {
  t: string
  lvl: Level
  area: string
  scope: string
  msg: string
  data?: unknown
  pid: number
}

/** Settings read on every write (live options). */
export interface LogConfig {
  level(area: string): Level
  redact?: (s: string) => string
  sink?: LogSink
}

const AREA_ALIAS: Record<string, string> = { embed: "embeddings", docs: "docsmith", memory: "memorysmith", hub: "agent", agents: "agent" }

export function areaOf(scope: string): string {
  const parts = scope.split(":")
  const a = parts[1] ?? "core"
  return AREA_ALIAS[a] ?? a
}

export interface LoggerHandle extends Logger {
  /** attach the redactor / sink once they exist */
  configure(patch: Partial<LogConfig>): void
  readonly dir: string
}

/**
 * `config` may be a boolean (old signature: debug on/off) or a LogConfig with a level per area.
 */
export function createLogger(dir: string, config: boolean | LogConfig, sink?: LogSink, scope = "skillsmith"): LoggerHandle {
  const cfg: LogConfig = typeof config === "boolean" ? { level: () => (config ? "debug" : "info"), sink } : { ...config, sink: config.sink ?? sink }
  let ready = false
  const write = (level: Level, s: string, msg: string, data?: unknown) => {
    const area = areaOf(s)
    let min: Level = "info"
    try {
      min = cfg.level(area)
    } catch {
      min = "info"
    }
    if (ORDER[level] >= ORDER[min]) {
      try {
        if (!ready) {
          ensureDir(dir)
          ready = true
        }
        const red = cfg.redact ?? ((x: string) => x)
        let dataOut: unknown
        if (data !== undefined) {
          try {
            const text = typeof data === "string" ? data : JSON.stringify(data)
            const r = red(text.length > 20_000 ? `${text.slice(0, 20_000)}…` : text)
            dataOut = typeof data === "string" ? r : safeParse(r)
          } catch {
            dataOut = "[unserializable]"
          }
        }
        const line: LogLine = { t: new Date().toISOString(), lvl: level, area, scope: s, msg: red(msg), ...(dataOut !== undefined ? { data: dataOut } : {}), ...logContext(), pid: process.pid }
        appendFileSync(join(dir, `${localDay()}.jsonl`), `${JSON.stringify(line)}\n`)
      } catch {
        // logging must never break the host
      }
    }
    if (cfg.sink && ORDER[level] >= ORDER.warn) {
      try {
        cfg.sink(level, s, msg, data)
      } catch {
        // ignore
      }
    }
  }
  const make = (s: string): Logger => ({
    debug: (m, d) => write("debug", s, m, d),
    info: (m, d) => write("info", s, m, d),
    warn: (m, d) => write("warn", s, m, d),
    error: (m, d) => write("error", s, m, d),
    child: (sub) => make(`${s}:${sub}`),
  })
  const root = make(scope)
  return Object.assign(root, {
    dir,
    configure(patch: Partial<LogConfig>) {
      Object.assign(cfg, patch)
    },
  })
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger
  },
}
