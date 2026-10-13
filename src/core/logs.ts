/**
 * Reading the structured log (state/log/<day>.jsonl) for the log tab: filters, live tail with
 * a byte cursor, grouping by run and retention by days and size.
 */
import { openSync, readdirSync, readSync, closeSync, statSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import type { Level, LogLine } from "../log"
import { LEVELS } from "../log"
import { readText } from "../util/fs"
import { fold, localDay } from "../util/text"

const DAY_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface LogFilter {
  /** first and last day (YYYY-MM-DD, local) */
  from?: string
  to?: string
  /** minimum level */
  level?: Level
  areas?: string[]
  run?: string
  session?: string
  job?: string
  cid?: string
  text?: string
  limit?: number
}

export function logDays(dir: string): string[] {
  try {
    return readdirSync(dir)
      .map((f) => DAY_RE.exec(f)?.[1])
      .filter((d): d is string => !!d)
      .sort()
  } catch {
    return []
  }
}

function matches(l: LogLine, f: LogFilter, text?: string): boolean {
  if (f.level && ORDER[l.lvl] < ORDER[f.level]) return false
  if (f.areas?.length && !f.areas.includes(l.area)) return false
  if (f.run && l.run !== f.run) return false
  if (f.session && l.session !== f.session) return false
  if (f.job && l.job !== f.job) return false
  if (f.cid && l.cid !== f.cid) return false
  if (text) {
    const hay = fold(`${l.msg} ${l.scope} ${typeof l.data === "string" ? l.data : JSON.stringify(l.data ?? "")}`)
    if (!hay.includes(text)) return false
  }
  return true
}

function parseLines(text: string): LogLine[] {
  const out: LogLine[] = []
  for (const raw of text.split("\n")) {
    if (!raw) continue
    try {
      const l = JSON.parse(raw) as LogLine
      if (l && typeof l.msg === "string" && LEVELS.includes(l.lvl)) out.push(l)
    } catch {
      // partial line of a concurrent writer
    }
  }
  return out
}

/** Newest first, at most `limit` lines; `cursor` is where a live tail continues. */
export function readLogs(dir: string, f: LogFilter = {}): { lines: LogLine[]; cursor: string; days: string[]; truncated: boolean } {
  const days = logDays(dir)
  const today = localDay()
  const limit = Math.min(Math.max(f.limit ?? 500, 1), 5000)
  const text = f.text ? fold(f.text) : undefined
  const selected = days.filter((d) => (!f.from || d >= f.from) && (!f.to || d <= f.to)).reverse()
  const out: LogLine[] = []
  let truncated = false
  for (const d of selected) {
    const lines = parseLines(readText(join(dir, `${d}.jsonl`)) ?? "")
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!matches(lines[i], f, text)) continue
      if (out.length >= limit) {
        truncated = true
        break
      }
      out.push(lines[i])
    }
    if (truncated) break
  }
  return { lines: out, cursor: cursorOf(dir, today), days, truncated }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function cursorOf(dir: string, day: string): string {
  return `${day}:${sizeOf(join(dir, `${day}.jsonl`))}`
}

/** Lines written after `cursor` ("day:offset"), oldest first, plus the new cursor. */
export function tailLogs(dir: string, cursor: string, f: LogFilter = {}): { lines: LogLine[]; cursor: string } {
  const m = /^(\d{4}-\d{2}-\d{2}):(\d+)$/.exec(cursor)
  const today = localDay()
  if (!m) return { lines: [], cursor: cursorOf(dir, today) }
  const text = f.text ? fold(f.text) : undefined
  const out: LogLine[] = []
  const days = logDays(dir).filter((d) => d >= m[1])
  let next = cursorOf(dir, today)
  for (const d of days) {
    const path = join(dir, `${d}.jsonl`)
    const start = d === m[1] ? Number(m[2]) : 0
    const size = sizeOf(path)
    if (size <= start) {
      next = `${d}:${size}`
      continue
    }
    const len = Math.min(size - start, 4 * 1024 * 1024)
    const buf = Buffer.alloc(len)
    let fd: number | undefined
    try {
      fd = openSync(path, "r")
      readSync(fd, buf, 0, len, start)
    } catch {
      continue
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
    const chunk = buf.toString("utf8")
    // only complete lines – the rest is read on the next poll
    const end = chunk.lastIndexOf("\n") + 1
    for (const l of parseLines(chunk.slice(0, end))) if (matches(l, f, text)) out.push(l)
    next = `${d}:${start + Buffer.byteLength(chunk.slice(0, end), "utf8")}`
  }
  return { lines: out.slice(-2000), cursor: next }
}

/** Delete log files older than `days` and the oldest ones beyond `maxMB` (also the old text log). */
export function pruneLogs(dir: string, days: number, maxMB: number): { removed: number } {
  let removed = 0
  const cutoff = localDay(Date.now() - days * 86_400_000)
  const list = logDays(dir)
  for (const d of list) {
    if (d >= cutoff) continue
    try {
      unlinkSync(join(dir, `${d}.jsonl`))
      removed++
    } catch {
      // ignore
    }
  }
  const rest = logDays(dir)
  let total = rest.reduce((n, d) => n + sizeOf(join(dir, `${d}.jsonl`)), 0)
  const limit = maxMB * 1024 * 1024
  for (const d of rest) {
    if (total <= limit || d === localDay()) break
    total -= sizeOf(join(dir, `${d}.jsonl`))
    try {
      unlinkSync(join(dir, `${d}.jsonl`))
      removed++
    } catch {
      // ignore
    }
  }
  // text log of versions before 4.0
  for (const old of ["skillsmith.log", "skillsmith.log.1"]) {
    const p = join(dir, old)
    try {
      if (Date.now() - statSync(p).mtimeMs > days * 86_400_000) {
        unlinkSync(p)
        removed++
      }
    } catch {
      // ignore
    }
  }
  return { removed }
}

/** Lines grouped by run (log tab "nach Lauf gruppieren"). */
export function groupByRun(lines: LogLine[]): Array<{ key: string; run?: string; cid?: string; job?: string; first: string; last: string; lines: LogLine[]; worst: Level }> {
  const groups = new Map<string, { key: string; run?: string; cid?: string; job?: string; first: string; last: string; lines: LogLine[]; worst: Level }>()
  for (const l of lines) {
    const key = l.run ? `run:${l.run}` : l.cid ? `cid:${l.cid}` : l.job ? `job:${l.job}` : "ohne"
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { key, run: l.run, cid: l.cid, job: l.job, first: l.t, last: l.t, lines: [], worst: l.lvl }))
    g.lines.push(l)
    if (l.t < g.first) g.first = l.t
    if (l.t > g.last) g.last = l.t
    if (ORDER[l.lvl] > ORDER[g.worst]) g.worst = l.lvl
  }
  return [...groups.values()].sort((a, b) => b.last.localeCompare(a.last))
}
