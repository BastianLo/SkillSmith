import { appendFileSync, renameSync, statSync } from "node:fs"
import { join } from "node:path"
import { ensureDir } from "./util/fs"

export type Level = "debug" | "info" | "warn" | "error"
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const MAX_BYTES = 2 * 1024 * 1024

export interface Logger {
  debug(msg: string, data?: unknown): void
  info(msg: string, data?: unknown): void
  warn(msg: string, data?: unknown): void
  error(msg: string, data?: unknown): void
  child(scope: string): Logger
}

export type LogSink = (level: Level, scope: string, msg: string, data?: unknown) => void

export function createLogger(dir: string, debug: boolean, sink?: LogSink, scope = "skillsmith"): Logger {
  const min = debug ? ORDER.debug : ORDER.info
  const file = join(dir, "skillsmith.log")
  let ready = false
  const write = (level: Level, s: string, msg: string, data?: unknown) => {
    if (ORDER[level] < min) return
    try {
      if (!ready) {
        ensureDir(dir)
        ready = true
      }
      try {
        if (statSync(file).size > MAX_BYTES) renameSync(file, file + ".1")
      } catch {
        // file does not exist yet
      }
      let extra = ""
      if (data !== undefined) {
        try {
          extra = " " + (typeof data === "string" ? data : JSON.stringify(data))
        } catch {
          extra = " [unserializable]"
        }
      }
      appendFileSync(file, `${new Date().toISOString()} ${level.toUpperCase()} [${s}] ${msg}${extra}\n`)
    } catch {
      // logging must never break the host
    }
    if (sink && ORDER[level] >= ORDER.warn) {
      try {
        sink(level, s, msg, data)
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
  return make(scope)
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
