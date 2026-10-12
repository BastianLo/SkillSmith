/**
 * Metrics (state/metrics.sqlite, never versioned): every use with its timestamp.
 *
 *   events  one row per event: time, type, entry ("kind:name", "tool:bash", "smith:docsmith" …),
 *           session + parent, project, branch, agent, model, origin, two numbers, small JSON extra
 *   daily   per local day, type and entry: count and sums (charts over months read only this)
 *
 * Only ids, names, numbers and times are stored – never message texts, tool arguments
 * or search queries. Writes are buffered and flushed in one IMMEDIATE transaction
 * (several opencode processes share the file). Without SQLite everything here is a no-op;
 * the totals in state/usage.json keep working as before.
 */
import { join } from "node:path"
import type { Options } from "../config"
import type { Logger } from "../log"
import type { UsageEntry } from "../types"
import { readJson } from "../util/fs"
import { errorMessage } from "../util/text"
import { immediate, localDay, openStateDb, type DatabaseClass } from "./sqlite"
import type { SqlDatabase } from "./vector-store"

export type MetricOrigin = "main" | "subagent" | "background" | "web" | "pipeline" | "system"

export interface MetricEvent {
  at?: number
  type: string
  entry?: string
  session?: string
  parent?: string
  project?: string
  branch?: string
  agent?: string
  model?: string
  origin?: MetricOrigin
  /** main number: duration ms, tokens, exit code … */
  value?: number
  /** second number: cost */
  value2?: number
  extra?: Record<string, unknown>
}

export interface MetricRow extends Required<Pick<MetricEvent, "type">> {
  id: number
  at: number
  entry: string
  session?: string
  parent?: string
  project?: string
  branch?: string
  agent?: string
  model?: string
  origin?: string
  value?: number
  value2?: number
  extra?: Record<string, unknown>
}

/** Event types (stable names – charts and tests rely on them). */
export const M = {
  load: "entry.load",
  hintShown: "entry.hint_shown",
  hintFollowed: "entry.hint_followed",
  hintHelped: "entry.hint_helped",
  hintFailed: "entry.hint_failed",
  feedbackOk: "entry.feedback_ok",
  feedbackIssue: "entry.feedback_issue",
  view: "entry.view",
  scriptRun: "script.run",
  userMessage: "session.user",
  reply: "session.reply",
  compaction: "session.compaction",
  toolCall: "tool.call",
  errorOccurrence: "error.occurrence",
  errorSolved: "error.solved",
  smithRun: "smith.run",
  smithAction: "smith.action",
  smithRejected: "smith.rejected",
  queueWait: "smith.queue_wait",
  doctorVerdict: "doctor.verdict",
  search: "search.query",
  hintCompute: "hint.compute",
  embedCall: "embed.call",
  taskMove: "task.move",
  taskCreate: "task.create",
  pipelineRun: "pipeline.run",
  pipelineStage: "pipeline.stage",
  agentRun: "agent.run",
  agentProposal: "agent.proposal",
  agentDelegate: "agent.delegate",
} as const

/** Uses of an entry (usage chart, relevance). */
export const USE_TYPES = [M.load, M.hintFollowed, M.scriptRun, M.hintHelped] as const

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, type TEXT NOT NULL, entry TEXT NOT NULL DEFAULT '',
    session TEXT, parent TEXT, project TEXT, branch TEXT, agent TEXT, model TEXT, origin TEXT,
    value REAL, value2 REAL, extra TEXT
  );
  CREATE INDEX IF NOT EXISTS events_at ON events (at);
  CREATE INDEX IF NOT EXISTS events_entry ON events (entry, at);
  CREATE INDEX IF NOT EXISTS events_type ON events (type, at);
  CREATE TABLE IF NOT EXISTS daily (
    day TEXT NOT NULL, type TEXT NOT NULL, entry TEXT NOT NULL DEFAULT '', n INTEGER NOT NULL DEFAULT 0,
    sum REAL NOT NULL DEFAULT 0, sum2 REAL NOT NULL DEFAULT 0, PRIMARY KEY (day, type, entry)
  );
  CREATE INDEX IF NOT EXISTS daily_entry ON daily (entry, day);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

/** usage.json totals imported once land on this day (all-time counts include them, time windows do not) */
export const BASELINE_DAY = "0000-00-00"

const DAY = 86_400_000

function dayList(days: number, now = Date.now()): string[] {
  const out: string[] = []
  for (let i = days - 1; i >= 0; i--) out.push(localDay(now - i * DAY))
  return out
}

/** Monday of the week of a local day (YYYY-MM-DD). */
export function weekOf(day: string): string {
  const [y, m, d] = day.split("-").map(Number)
  const dt = new Date(y, m - 1, d)
  const shift = (dt.getDay() + 6) % 7
  dt.setDate(dt.getDate() - shift)
  return localDay(dt.getTime())
}

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[i]
}

export class Metrics {
  private db?: SqlDatabase
  private pending: MetricEvent[] = []
  private timer?: ReturnType<typeof setTimeout>
  readonly file: string

  constructor(
    private stateDir: string,
    private options: Options,
    private log: Logger,
    Database?: DatabaseClass,
  ) {
    this.file = join(stateDir, "metrics.sqlite")
    if (options.metrics.enabled) this.db = openStateDb(stateDir, "metrics.sqlite", SCHEMA, log, Database)
  }

  get available(): boolean {
    return !!this.db
  }

  /** Is this category switched on? */
  wants(type: string): boolean {
    if (!this.db) return false
    const m = this.options.metrics
    if (type === M.toolCall) return m.toolCalls
    if (type === M.reply) return m.tokens
    if (type === M.view) return m.webViews
    return true
  }

  record(e: MetricEvent): void {
    if (!this.wants(e.type)) return
    this.pending.push({ ...e, at: e.at ?? Date.now() })
    if (this.pending.length >= 500) void this.flush()
    else this.schedule()
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, this.options.metrics.flushMs)
    ;(this.timer as any).unref?.()
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    const db = this.db
    if (!db || !this.pending.length) return
    const batch = this.pending
    this.pending = []
    try {
      immediate(db, () => {
        const ins = db.query(
          "INSERT INTO events (at, type, entry, session, parent, project, branch, agent, model, origin, value, value2, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        const up = db.query(
          `INSERT INTO daily (day, type, entry, n, sum, sum2) VALUES (?, ?, ?, 1, ?, ?)
           ON CONFLICT(day, type, entry) DO UPDATE SET n = n + 1, sum = sum + excluded.sum, sum2 = sum2 + excluded.sum2`,
        )
        for (const e of batch) {
          const at = e.at ?? Date.now()
          const entry = e.entry ?? ""
          ins.run(
            at,
            e.type,
            entry,
            e.session ?? null,
            e.parent ?? null,
            e.project ?? null,
            e.branch ?? null,
            e.agent ?? null,
            e.model ?? null,
            e.origin ?? null,
            e.value ?? null,
            e.value2 ?? null,
            e.extra && Object.keys(e.extra).length ? JSON.stringify(e.extra) : null,
          )
          up.run(localDay(at), e.type, entry, e.value ?? 0, e.value2 ?? 0)
        }
      })
    } catch (err) {
      this.log.warn("metrics flush failed", errorMessage(err))
    }
  }

  close(): void {
    try {
      // synchronous last flush
      void this.flush()
      this.db?.close()
    } catch {
      // ignore
    }
    this.db = undefined
  }

  /** Raw events older than metrics.rawDays go; daily sums stay. */
  prune(now = Date.now()): number {
    const db = this.db
    if (!db) return 0
    const cut = now - this.options.metrics.rawDays * DAY
    const n = Number(db.query("SELECT count(*) AS n FROM events WHERE at < ?").get(cut)?.n ?? 0)
    if (n) db.query("DELETE FROM events WHERE at < ?").run(cut)
    return n
  }

  /** Delete every metric (settings: "Metriken löschen"). */
  clear(): void {
    const db = this.db
    if (!db) return
    this.pending = []
    immediate(db, () => {
      db.exec("DELETE FROM events; DELETE FROM daily; DELETE FROM meta;")
    })
  }

  /** One-time: totals of state/usage.json as baseline (all-time counts stay complete). */
  importUsageBaseline(): number {
    const db = this.db
    if (!db) return 0
    if (db.query("SELECT value FROM meta WHERE key = 'usage_baseline'").get()) return 0
    const usage = readJson<Record<string, UsageEntry>>(join(this.stateDir, "usage.json"), {})
    let rows = 0
    immediate(db, () => {
      const up = db.query("INSERT INTO daily (day, type, entry, n, sum, sum2) VALUES (?, ?, ?, ?, 0, 0) ON CONFLICT(day, type, entry) DO UPDATE SET n = n + excluded.n")
      for (const [rawKey, u] of Object.entries(usage)) {
        const entry = rawKey.includes(":") ? rawKey : `skill:${rawKey}`
        const pairs: Array<[string, number]> = [
          [M.load, u.loads ?? 0],
          [M.hintShown, u.hintsShown ?? 0],
          [M.hintFollowed, u.hintsFollowed ?? 0],
          [M.hintHelped, u.helped ?? 0],
          [M.hintFailed, u.failed ?? 0],
          [M.feedbackIssue, u.loadsWithIssues ?? 0],
          [M.feedbackOk, Math.max(0, (u.reviewedLoads ?? 0) - (u.loadsWithIssues ?? 0))],
        ]
        for (const [type, n] of pairs) {
          if (n > 0) {
            up.run(BASELINE_DAY, type, entry, n)
            rows++
          }
        }
      }
      db.query("INSERT INTO meta (key, value) VALUES ('usage_baseline', ?)").run(new Date().toISOString())
    })
    return rows
  }

  // ---------------------------------------------------------------------------
  // queries
  // ---------------------------------------------------------------------------

  private q(sql: string) {
    return this.db!.query(sql)
  }

  /** Per-day (or per-week) counts of types for one entry (or all entries with a prefix, or all). */
  series(opts: { entry?: string; prefix?: string; types: string[]; days: number; bucket?: "day" | "week"; field?: "n" | "sum" | "sum2"; now?: number }): {
    buckets: string[]
    series: Record<string, number[]>
  } {
    const days = dayList(opts.days, opts.now)
    const bucket = opts.bucket ?? (opts.days > 120 ? "week" : "day")
    const buckets = bucket === "week" ? [...new Set(days.map(weekOf))] : days
    const index = new Map(buckets.map((b, i) => [b, i]))
    const series: Record<string, number[]> = Object.fromEntries(opts.types.map((t) => [t, new Array(buckets.length).fill(0)]))
    if (!this.db || !opts.types.length) return { buckets, series }
    const field = opts.field ?? "n"
    const where = [`type IN (${opts.types.map(() => "?").join(", ")})`, "day >= ?", "day <= ?"]
    const params: unknown[] = [...opts.types, days[0], days[days.length - 1]]
    if (opts.entry !== undefined) {
      where.push("entry = ?")
      params.push(opts.entry)
    } else if (opts.prefix) {
      where.push("entry LIKE ?")
      params.push(`${opts.prefix}%`)
    }
    for (const r of this.q(`SELECT day, type, sum(${field}) AS v FROM daily WHERE ${where.join(" AND ")} GROUP BY day, type`).all(...(params as any[])) as any[]) {
      const b = bucket === "week" ? weekOf(r.day) : r.day
      const i = index.get(b)
      if (i !== undefined) series[r.type][i] += Number(r.v) || 0
    }
    return { buckets, series }
  }

  /** All-time totals per type of one entry (incl. the usage.json baseline). */
  totals(entry: string): Record<string, number> {
    if (!this.db) return {}
    const out: Record<string, number> = {}
    for (const r of this.q("SELECT type, sum(n) AS n FROM daily WHERE entry = ? GROUP BY type").all(entry) as any[]) out[r.type] = Number(r.n) || 0
    return out
  }

  /** Totals per entry and type in a window (days = 0: all time). */
  totalsByEntry(types: string[], days = 0, prefix?: string, now = Date.now()): Map<string, Record<string, number>> {
    const out = new Map<string, Record<string, number>>()
    if (!this.db || !types.length) return out
    const where = [`type IN (${types.map(() => "?").join(", ")})`]
    const params: unknown[] = [...types]
    if (days > 0) {
      where.push("day >= ? AND day != ?")
      params.push(localDay(now - (days - 1) * DAY), BASELINE_DAY)
    }
    if (prefix) {
      where.push("entry LIKE ?")
      params.push(`${prefix}%`)
    }
    for (const r of this.q(`SELECT entry, type, sum(n) AS n FROM daily WHERE ${where.join(" AND ")} GROUP BY entry, type`).all(...(params as any[])) as any[]) {
      const cur = out.get(r.entry) ?? {}
      cur[r.type] = Number(r.n) || 0
      out.set(r.entry, cur)
    }
    return out
  }

  private toRow(r: any): MetricRow {
    let extra: Record<string, unknown> | undefined
    if (r.extra) {
      try {
        extra = JSON.parse(r.extra)
      } catch {
        extra = undefined
      }
    }
    return {
      id: Number(r.id),
      at: Number(r.at),
      type: r.type,
      entry: r.entry ?? "",
      session: r.session ?? undefined,
      parent: r.parent ?? undefined,
      project: r.project ?? undefined,
      branch: r.branch ?? undefined,
      agent: r.agent ?? undefined,
      model: r.model ?? undefined,
      origin: r.origin ?? undefined,
      value: r.value ?? undefined,
      value2: r.value2 ?? undefined,
      extra,
    }
  }

  /** Raw events (newest first). */
  events(opts: { entry?: string; prefix?: string; types?: string[]; from?: number; to?: number; session?: string; limit?: number } = {}): MetricRow[] {
    if (!this.db) return []
    const where: string[] = []
    const params: unknown[] = []
    if (opts.entry !== undefined) {
      where.push("entry = ?")
      params.push(opts.entry)
    }
    if (opts.prefix) {
      where.push("entry LIKE ?")
      params.push(`${opts.prefix}%`)
    }
    if (opts.types?.length) {
      where.push(`type IN (${opts.types.map(() => "?").join(", ")})`)
      params.push(...opts.types)
    }
    if (opts.from) {
      where.push("at >= ?")
      params.push(opts.from)
    }
    if (opts.to) {
      where.push("at <= ?")
      params.push(opts.to)
    }
    if (opts.session) {
      where.push("session = ?")
      params.push(opts.session)
    }
    const limit = Math.min(200_000, Math.max(1, opts.limit ?? 100))
    return this.q(`SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC LIMIT ?`)
      .all(...(params as any[]), limit)
      .map((r) => this.toRow(r))
  }

  /** Totals per entry and type between two local days (inclusive). */
  totalsBetween(types: string[], fromDay: string, toDay: string, prefix?: string): Map<string, Record<string, number>> {
    const out = new Map<string, Record<string, number>>()
    if (!this.db || !types.length) return out
    const params: unknown[] = [...types, fromDay, toDay]
    let sql = `SELECT entry, type, sum(n) AS n FROM daily WHERE type IN (${types.map(() => "?").join(", ")}) AND day >= ? AND day <= ? AND day != '${BASELINE_DAY}'`
    if (prefix) {
      sql += " AND entry LIKE ?"
      params.push(`${prefix}%`)
    }
    for (const r of this.q(`${sql} GROUP BY entry, type`).all(...(params as any[])) as any[]) {
      const cur = out.get(r.entry) ?? {}
      cur[r.type] = Number(r.n) || 0
      out.set(r.entry, cur)
    }
    return out
  }

  /** Raw rows of some types in a window (statistics that need extra fields). */
  rows(types: string[], from: number, to = Date.now(), project?: string): MetricRow[] {
    if (!this.db || !types.length) return []
    const params: unknown[] = [...types, from, to]
    let sql = `SELECT * FROM events WHERE type IN (${types.map(() => "?").join(", ")}) AND at >= ? AND at < ?`
    if (project) {
      sql += " AND project = ?"
      params.push(project)
    }
    return this.q(`${sql} ORDER BY at`).all(...(params as any[])).map((r) => this.toRow(r))
  }

  /** Which agents and projects use an entry (window). */
  usersOf(entry: string, days: number, now = Date.now()): { agents: Array<{ name: string; n: number }>; projects: Array<{ name: string; n: number }>; sessions: number } {
    if (!this.db) return { agents: [], projects: [], sessions: 0 }
    const from = now - days * DAY
    const types = [...USE_TYPES]
    const ph = types.map(() => "?").join(", ")
    const agents = this.q(`SELECT agent AS name, count(*) AS n FROM events WHERE entry = ? AND at >= ? AND type IN (${ph}) AND agent IS NOT NULL GROUP BY agent ORDER BY n DESC LIMIT 10`).all(entry, from, ...types) as any[]
    const projects = this.q(`SELECT project AS name, count(*) AS n FROM events WHERE entry = ? AND at >= ? AND type IN (${ph}) AND project IS NOT NULL GROUP BY project ORDER BY n DESC LIMIT 10`).all(entry, from, ...types) as any[]
    const sessions = Number(this.q(`SELECT count(DISTINCT session) AS n FROM events WHERE entry = ? AND at >= ? AND type IN (${ph})`).get(entry, from, ...types)?.n ?? 0)
    return { agents: agents.map((a) => ({ name: a.name, n: Number(a.n) })), projects: projects.map((p) => ({ name: p.name, n: Number(p.n) })), sessions }
  }

  /** Decayed use score per entry (relevance): Σ weight · 0.5^(age/halfLife), at most 2 per session. */
  decayedUse(halfLifeDays: number, weights: Record<string, number>, now = Date.now()): Map<string, { score: number; sessions: number; uses: number }> {
    const out = new Map<string, { score: number; sessions: number; uses: number }>()
    if (!this.db) return out
    const types = Object.keys(weights)
    const from = now - Math.min(this.options.metrics.rawDays, halfLifeDays * 8) * DAY
    const perSession = new Map<string, number>()
    const sessionsOf = new Map<string, Set<string>>()
    for (const r of this.q(`SELECT at, type, entry, session FROM events WHERE at >= ? AND type IN (${types.map(() => "?").join(", ")}) AND entry != ''`).all(from, ...types) as any[]) {
      const w = (weights[r.type] ?? 0) * Math.pow(0.5, (now - Number(r.at)) / (halfLifeDays * DAY))
      const sk = `${r.entry}|${r.session ?? r.at}`
      const used = perSession.get(sk) ?? 0
      const add = Math.max(0, Math.min(2 - used, w))
      perSession.set(sk, used + add)
      const cur = out.get(r.entry) ?? { score: 0, sessions: 0, uses: 0 }
      cur.score += add
      if (r.type !== M.hintShown) cur.uses++
      out.set(r.entry, cur)
      if (r.session) {
        const s = sessionsOf.get(r.entry) ?? new Set<string>()
        s.add(r.session)
        sessionsOf.set(r.entry, s)
      }
    }
    for (const [entry, s] of sessionsOf) out.get(entry)!.sessions = s.size
    return out
  }

  /** Activity per local day (calendar). */
  calendar(days: number, now = Date.now()): Array<{ day: string; n: number }> {
    const list = dayList(days, now)
    const map = new Map(list.map((d) => [d, 0]))
    if (this.db) {
      for (const r of this.q(`SELECT day, sum(n) AS n FROM daily WHERE day >= ? AND type IN (?, ?, ?) GROUP BY day`).all(list[0], M.userMessage, M.load, M.toolCall) as any[]) {
        if (map.has(r.day)) map.set(r.day, Number(r.n) || 0)
      }
    }
    return list.map((day) => ({ day, n: map.get(day) ?? 0 }))
  }

  /** Weekday (0 = Monday) × hour, counts of user messages and tool calls. */
  heatmap(days: number, now = Date.now()): number[][] {
    const grid = Array.from({ length: 7 }, () => new Array(24).fill(0))
    if (!this.db) return grid
    const from = now - days * DAY
    for (const r of this.q(
      `SELECT CAST(strftime('%w', at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS wd, CAST(strftime('%H', at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hr, count(*) AS n
       FROM events WHERE at >= ? AND type IN (?, ?, ?, ?) GROUP BY wd, hr`,
    ).all(from, M.userMessage, M.toolCall, M.load, M.smithRun) as any[]) {
      grid[(Number(r.wd) + 6) % 7][Number(r.hr)] += Number(r.n) || 0
    }
    return grid
  }

  /** Sums of a window [from, to) per type (KPIs). */
  windowTotals(types: string[], from: number, to: number): Record<string, { n: number; sum: number; sum2: number }> {
    const out: Record<string, { n: number; sum: number; sum2: number }> = Object.fromEntries(types.map((t) => [t, { n: 0, sum: 0, sum2: 0 }]))
    if (!this.db || !types.length) return out
    for (const r of this.q(`SELECT type, count(*) AS n, total(value) AS s, total(value2) AS s2 FROM events WHERE at >= ? AND at < ? AND type IN (${types.map(() => "?").join(", ")}) GROUP BY type`).all(from, to, ...types) as any[]) {
      out[r.type] = { n: Number(r.n) || 0, sum: Number(r.s) || 0, sum2: Number(r.s2) || 0 }
    }
    return out
  }

  distinctSessions(from: number, to: number, type: string = M.userMessage): number {
    if (!this.db) return 0
    return Number(this.q("SELECT count(DISTINCT session) AS n FROM events WHERE at >= ? AND at < ? AND type = ? AND session IS NOT NULL").get(from, to, type)?.n ?? 0)
  }

  /** Grouped statistics of raw events: count, errors (extra.error), duration percentiles, sums. */
  grouped(type: string, by: "entry" | "model" | "agent" | "project" | "origin", from: number, to = Date.now(), prefix?: string): Array<{
    key: string
    n: number
    errors: number
    p50: number
    p95: number
    avg: number
    sum: number
    sum2: number
  }> {
    if (!this.db) return []
    const rows = this.q(`SELECT ${by} AS k, value, value2, extra FROM events WHERE type = ? AND at >= ? AND at < ? ${prefix ? "AND entry LIKE ?" : ""}`).all(
      ...([type, from, to, ...(prefix ? [`${prefix}%`] : [])] as any[]),
    ) as any[]
    const groups = new Map<string, { count: number; vals: number[]; errors: number; sum: number; sum2: number }>()
    for (const r of rows) {
      const k = r.k ?? ""
      const g = groups.get(k) ?? { count: 0, vals: [], errors: 0, sum: 0, sum2: 0 }
      g.count++
      const v = r.value === null || r.value === undefined ? NaN : Number(r.value)
      if (Number.isFinite(v)) g.vals.push(v)
      g.sum += Number.isFinite(v) ? v : 0
      g.sum2 += Number(r.value2) || 0
      if (r.extra && /"error":true|"ok":false/.test(r.extra)) g.errors++
      groups.set(k, g)
    }
    return [...groups.entries()]
      .map(([key, g]) => {
        const sorted = [...g.vals].sort((a, b) => a - b)
        return { key, n: g.count, errors: g.errors, p50: percentile(sorted, 50), p95: percentile(sorted, 95), avg: sorted.length ? g.sum / sorted.length : 0, sum: g.sum, sum2: g.sum2 }
      })
      .sort((a, b) => b.n - a.n)
  }

  meta(key: string): string | undefined {
    return (this.db?.query("SELECT value FROM meta WHERE key = ?").get(key)?.value as string | undefined) ?? undefined
  }
}
