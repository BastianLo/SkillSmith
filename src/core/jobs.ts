/**
 * Jobs (5a): one register and one runner for everything recurring – curator lifecycle and
 * consolidation, doctor, script re-tests, embedding sync, prepared agent proposals, clean-up,
 * and later code anchors, gym, review extractor, script jobs.
 *
 * Schedule per job (defaults of the job ⊕ `jobs.<id>` of the options/settings page):
 *   start        once per process start
 *   daily        local times ("08:30"), optionally only on weekdays (1 = Monday … 7 = Sunday)
 *   intervalMin  every n minutes (weekdays filter applies)
 *   idleMin      once per idle phase of n minutes without user messages
 *   cron         5-field cron expression (local time)
 *   afterReview  after every finished review of this process
 * Missed slots (computer off) are run once at the next start or skipped (`catchUp`).
 *
 * One process runs a job at a time (file lock job-<id>); the shared state (last run, history,
 * pause) lives in state/jobs.json. Each run has an id ("jr-…") that every log line of the run
 * carries (log context cid) – the history links to them.
 */
import { join } from "node:path"
import type { JobConfig, Options } from "../config"
import { withLogContext, type Logger } from "../log"
import { cronNext, cronPrev, parseCron } from "../util/cron"
import { acquireFileLock, readJson, withLock, writeJsonAtomic } from "../util/fs"
import { errorMessage, nowIso, shortId, truncate } from "../util/text"
import type { Ctx } from "./context"
import { notify } from "./notify"

export interface JobSchedule {
  enabled: boolean
  start: boolean
  daily: string[]
  weekdays: string[]
  intervalMin: number
  idleMin: number
  cron: string
  afterReview: boolean
  catchUp: "once" | "skip"
  params: Record<string, string>
}

export interface JobParam {
  name: string
  label: string
  /** allowed values (multiple separated by comma) */
  values?: string[]
  multiple?: boolean
}

export interface JobRunContext {
  id: string
  trigger: string
  params: Record<string, string>
  signal: AbortSignal
  log: Logger
  /** short progress text for the jobs page */
  progress(text: string): void
}

export interface JobOutcome {
  summary: string
  status?: "ok" | "skipped" | "warn"
  commit?: string
  commits?: string[]
  tokens?: number
}

export interface JobDef {
  id: string
  label: string
  description: string
  /** log area of the job's own lines */
  area: string
  defaults(o: Options): Partial<JobSchedule>
  params?: JobParam[]
  /** why the job cannot run right now (feature switched off …) */
  unavailable?(ctx: Ctx): string | undefined
  /** last run before the register existed (seeds the state once) */
  previousRun?(ctx: Ctx): string | undefined
  run(ctx: Ctx, jr: JobRunContext): Promise<JobOutcome>
}

export type JobStatus = "running" | "ok" | "warn" | "skipped" | "error" | "aborted"

export interface JobRunRecord {
  id: string
  job: string
  trigger: string
  startedAt: string
  endedAt?: string
  status: JobStatus
  summary?: string
  error?: string
  commits?: string[]
  tokens?: number
  params?: Record<string, string>
  pid: number
  progress?: string
}

interface JobState {
  /** first time this job was seen – slots before it are never "missed" */
  since?: string
  lastRunAt?: string
  /** slots before this time are skipped (catch-up "skip") */
  skipBefore?: string
  paused?: boolean
  runs: JobRunRecord[]
}

const BASE: JobSchedule = { enabled: true, start: false, daily: [], weekdays: [], intervalMin: 0, idleMin: 0, cron: "", afterReview: false, catchUp: "once", params: {} }
const KEEP_RUNS = 30
const TICK_MS = 30_000

/** Activity of the user in this process (chat messages) – idle schedules measure from it. */
export function userActivity(): { last: number } {
  return ((globalThis as any)[Symbol.for("skillsmith.userActivity")] ??= { last: Date.now() })
}

function slotsOfDay(day: Date, times: string[], weekdays: string[]): Date[] {
  const wd = ((day.getDay() + 6) % 7) + 1
  if (weekdays.length && !weekdays.includes(String(wd))) return []
  return times.map((t) => {
    const [h, m] = t.split(":").map(Number)
    const d = new Date(day.getTime())
    d.setHours(h, m, 0, 0)
    return d
  })
}

/** Most recent daily/cron slot at or before `now`. */
export function prevSlot(s: JobSchedule, now: Date): Date | undefined {
  let best: Date | undefined
  if (s.daily.length) {
    for (let back = 0; back < 8 && !best; back++) {
      const day = new Date(now.getTime())
      day.setDate(day.getDate() - back)
      for (const d of slotsOfDay(day, s.daily, s.weekdays)) if (d <= now && (!best || d > best)) best = d
    }
  }
  if (s.cron) {
    try {
      const c = cronPrev(parseCron(s.cron), now)
      if (c && (!best || c > best)) best = c
    } catch {
      // invalid cron is reported by the options validator
    }
  }
  return best
}

/** Next daily/cron/interval time after `now` (for the jobs page). */
export function nextSlot(s: JobSchedule, now: Date, lastRunAt?: string): Date | undefined {
  const cands: Date[] = []
  if (s.daily.length) {
    for (let fwd = 0; fwd < 8; fwd++) {
      const day = new Date(now.getTime())
      day.setDate(day.getDate() + fwd)
      const next = slotsOfDay(day, s.daily, s.weekdays).filter((d) => d > now).sort((a, b) => a.getTime() - b.getTime())[0]
      if (next) {
        cands.push(next)
        break
      }
    }
  }
  if (s.cron) {
    try {
      const c = cronNext(parseCron(s.cron), now)
      if (c) cands.push(c)
    } catch {
      // ignore
    }
  }
  if (s.intervalMin > 0) {
    const base = lastRunAt ? Date.parse(lastRunAt) : now.getTime()
    cands.push(new Date(Math.max(now.getTime(), base + s.intervalMin * 60_000)))
  }
  return cands.sort((a, b) => a.getTime() - b.getTime())[0]
}

function weekdayOk(s: JobSchedule, now: Date): boolean {
  if (!s.weekdays.length) return true
  return s.weekdays.includes(String(((now.getDay() + 6) % 7) + 1))
}

/** Human-readable schedule ("beim Start · täglich 08:30 · alle 2 h (Mo–Fr)"). */
export function describeSchedule(s: JobSchedule): string {
  const parts: string[] = []
  if (!s.enabled) return "aus"
  const days = s.weekdays.length ? ` (${s.weekdays.map((d) => ["", "Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"][Number(d)]).join(", ")})` : ""
  if (s.start) parts.push("beim Start")
  if (s.afterReview) parts.push("nach jedem Review")
  if (s.daily.length) parts.push(`täglich ${s.daily.join(", ")}${days}`)
  if (s.intervalMin > 0) parts.push(`alle ${s.intervalMin % 1440 === 0 ? `${s.intervalMin / 1440} Tag(e)` : s.intervalMin % 60 === 0 ? `${s.intervalMin / 60} h` : `${s.intervalMin} min`}${s.daily.length ? "" : days}`)
  if (s.idleMin > 0) parts.push(`bei ${s.idleMin} min Leerlauf`)
  if (s.cron) parts.push(`cron ${s.cron}`)
  return parts.join(" · ") || "nur von Hand"
}

export class JobScheduler {
  private timer?: ReturnType<typeof setInterval>
  private running = new Map<string, { record: JobRunRecord; abort: AbortController; done: Promise<JobRunRecord> }>()
  private readonly processStart = Date.now()
  private started = false

  constructor(
    private ctx: Ctx,
    private defs: () => JobDef[],
  ) {}

  private get file(): string {
    return join(this.ctx.store.stateDir, "jobs.json")
  }

  private readState(): Record<string, JobState> {
    return readJson<Record<string, JobState>>(this.file, {})
  }

  private async updateState(id: string, fn: (s: JobState) => void): Promise<JobState> {
    return withLock(this.ctx.store.locksDir, "jobs-state", () => {
      const all = this.readState()
      const s = (all[id] ??= { runs: [] })
      s.runs ??= []
      fn(s)
      s.runs = s.runs.slice(-KEEP_RUNS)
      writeJsonAtomic(this.file, all)
      return s
    })
  }

  def(id: string): JobDef | undefined {
    return this.defs().find((d) => d.id === id)
  }

  /** Effective schedule: base ⊕ job defaults ⊕ options/settings (`jobs.<id>`). */
  schedule(id: string): JobSchedule {
    const d = this.def(id)
    const cfg: JobConfig = this.ctx.options.jobs[id] ?? {}
    const s: JobSchedule = { ...BASE, ...(d?.defaults(this.ctx.options) ?? {}) }
    for (const [k, v] of Object.entries(cfg)) if (v !== undefined) (s as any)[k] = v
    s.params = { ...(d?.defaults(this.ctx.options).params ?? {}), ...(cfg.params ?? {}) }
    return s
  }

  /** Jobs with schedule, state and the next planned time (jobs page, CLI status). */
  list(now = new Date()): Array<Record<string, unknown>> {
    const state = this.readState()
    return this.defs().map((d) => {
      const s = this.schedule(d.id)
      const st = state[d.id] ?? { runs: [] }
      const running = this.running.get(d.id)?.record ?? st.runs.find((r) => r.status === "running" && r.pid !== process.pid && pidAlive(r.pid))
      const last = [...st.runs].reverse().find((r) => r.status !== "running")
      return {
        id: d.id,
        label: d.label,
        description: d.description,
        area: d.area,
        params: d.params ?? [],
        schedule: s,
        defaults: { ...BASE, ...d.defaults(this.ctx.options) },
        configured: this.ctx.options.jobs[d.id] ?? {},
        text: describeSchedule(s),
        paused: !!st.paused,
        unavailable: d.unavailable?.(this.ctx) ?? null,
        running: running ?? null,
        last: last ?? null,
        lastRunAt: st.lastRunAt ?? null,
        next: s.enabled && !st.paused ? (nextSlot(s, now, st.lastRunAt)?.toISOString() ?? null) : null,
        failures: st.runs.slice(-5).filter((r) => r.status === "error").length,
      }
    })
  }

  history(id: string): JobRunRecord[] {
    return [...(this.readState()[id]?.runs ?? [])].reverse()
  }

  /** Start ticking: start jobs run once, missed slots are caught up or skipped. */
  start(): void {
    if (this.started) return
    this.started = true
    void this.boot()
    this.timer = setInterval(() => void this.tick().catch((err) => this.ctx.log.child("jobs").warn("job tick failed", errorMessage(err))), TICK_MS)
    ;(this.timer as any).unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const r of this.running.values()) r.abort.abort()
  }

  private async boot(): Promise<void> {
    const now = new Date()
    for (const d of this.defs()) {
      const s = this.schedule(d.id)
      let st = this.readState()[d.id]
      // first sight: slots before now are not "missed"
      if (!st?.since) {
        const prev = d.previousRun?.(this.ctx)
        await this.updateState(d.id, (x) => {
          x.lastRunAt ??= prev
          x.since = x.since ?? x.lastRunAt ?? now.toISOString()
        })
        st = this.readState()[d.id]
      }
      if (!s.enabled) continue
      // catch-up policy for slots missed while no process ran
      const last = st?.lastRunAt ? Date.parse(st.lastRunAt) : Date.parse(st?.since ?? now.toISOString())
      const missedSlot = prevSlot(s, now)
      const missedInterval = s.intervalMin > 0 && st?.lastRunAt && now.getTime() - Date.parse(st.lastRunAt) >= s.intervalMin * 60_000
      if (((missedSlot && missedSlot.getTime() > last && missedSlot.getTime() < this.processStart) || missedInterval) && s.catchUp === "skip") {
        await this.updateState(d.id, (x) => (x.skipBefore = new Date(this.processStart).toISOString()))
      }
    }
    // start jobs (after a short delay, so opencode finishes starting)
    const startJobs = this.defs().filter((d) => {
      const s = this.schedule(d.id)
      return s.enabled && s.start
    })
    for (const d of startJobs) {
      if (this.readState()[d.id]?.paused) continue
      await this.trigger(d.id, "Start").done.catch(() => undefined)
    }
    await this.tick()
  }

  /** Why a job is due now, or undefined. */
  dueReason(id: string, now = new Date()): string | undefined {
    const s = this.schedule(id)
    const st = this.readState()[id]
    if (!s.enabled || st?.paused || this.running.has(id)) return undefined
    const last = Math.max(st?.lastRunAt ? Date.parse(st.lastRunAt) : 0, st?.since ? Date.parse(st.since) : 0, st?.skipBefore ? Date.parse(st.skipBefore) : 0)
    const slot = prevSlot(s, now)
    if (slot && slot.getTime() > last) return slot.getTime() < this.processStart ? "nachgeholt" : s.cron && !s.daily.length ? "Cron" : "Zeitplan"
    if (s.intervalMin > 0 && weekdayOk(s, now)) {
      const base = Math.max(st?.lastRunAt ? Date.parse(st.lastRunAt) : Date.parse(st?.since ?? now.toISOString()), st?.skipBefore ? Date.parse(st.skipBefore) : 0)
      if (now.getTime() - base >= s.intervalMin * 60_000) return base + s.intervalMin * 60_000 < this.processStart ? "nachgeholt" : "Intervall"
    }
    if (s.idleMin > 0) {
      const act = userActivity().last
      if (now.getTime() - act >= s.idleMin * 60_000 && last < act) return "Leerlauf"
    }
    return undefined
  }

  async tick(now = new Date()): Promise<void> {
    try {
      this.ctx.settings?.refreshIfChanged()
    } catch {
      // settings are best effort here
    }
    for (const d of this.defs()) {
      const why = this.dueReason(d.id, now)
      if (why) this.trigger(d.id, why)
    }
  }

  /** Event from the host ("after-review"): jobs with that trigger start. */
  event(name: "after-review"): void {
    for (const d of this.defs()) {
      const s = this.schedule(d.id)
      if (name === "after-review" && s.enabled && s.afterReview && !this.readState()[d.id]?.paused) this.trigger(d.id, "nach Review")
    }
  }

  /** Start a run in the background; `done` resolves with the record. */
  trigger(id: string, trigger: string, params?: Record<string, string>): { id: string; done: Promise<JobRunRecord> } {
    const existing = this.running.get(id)
    if (existing) return { id: existing.record.id, done: existing.done }
    const def = this.def(id)
    if (!def) throw new Error(`unbekannter Job ${id}`)
    const record: JobRunRecord = { id: `jr-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(2, 14)}-${shortId(3)}`, job: id, trigger, startedAt: nowIso(), status: "running", params: { ...this.schedule(id).params, ...(params ?? {}) }, pid: process.pid }
    const abort = new AbortController()
    const done = this.execute(def, record, abort)
    this.running.set(id, { record, abort, done })
    void done.finally(() => this.running.delete(id))
    return { id: record.id, done }
  }

  /** Run and wait (tests, CLI). */
  run(id: string, trigger = "von Hand", params?: Record<string, string>): Promise<JobRunRecord> {
    return this.trigger(id, trigger, params).done
  }

  abort(id: string): boolean {
    const r = this.running.get(id)
    if (!r) return false
    r.abort.abort()
    return true
  }

  async pause(id: string, paused: boolean): Promise<void> {
    if (!this.def(id)) throw new Error(`unbekannter Job ${id}`)
    await this.updateState(id, (s) => (s.paused = paused))
  }

  private async execute(def: JobDef, record: JobRunRecord, abort: AbortController): Promise<JobRunRecord> {
    const log = this.ctx.log.child("jobs")
    const unavailable = def.unavailable?.(this.ctx)
    if (unavailable) {
      withLogContext({ cid: record.id }, () => log.info(`job ${def.id} skipped (${record.trigger}): ${unavailable}`))
      record.status = "skipped"
      record.summary = unavailable
      record.endedAt = nowIso()
      await this.updateState(def.id, (s) => {
        s.runs.push(record)
        s.lastRunAt = record.endedAt
      })
      return record
    }
    let release: (() => void) | undefined
    try {
      release = await acquireFileLock(this.ctx.store.locksDir, `job-${def.id}`, { timeoutMs: 0, staleMs: 6 * 3_600_000 })
    } catch {
      record.status = "skipped"
      record.summary = "läuft gerade in einem anderen opencode-Prozess"
      record.endedAt = nowIso()
      return record
    }
    await this.updateState(def.id, (s) => s.runs.push(record))
    this.ctx.bus?.emit("job.changed", { job: def.id, run: record.id, status: "running" })
    const started = Date.now()
    try {
      await withLogContext({ cid: record.id }, async () => {
        log.info(`job ${def.id} started (${record.trigger})`, record.params && Object.keys(record.params).length ? { params: record.params } : undefined)
        const out = await def.run(this.ctx, {
          id: record.id,
          trigger: record.trigger,
          params: record.params ?? {},
          signal: abort.signal,
          log: this.ctx.log.child(def.area),
          progress: (text) => {
            record.progress = truncate(text, 200)
            this.ctx.bus?.emit("job.changed", { job: def.id, run: record.id, status: "running", progress: record.progress })
          },
        })
        record.status = abort.signal.aborted ? "aborted" : (out.status ?? "ok")
        record.summary = truncate(out.summary, 2000)
        record.commits = [...(out.commits ?? []), ...(out.commit ? [out.commit] : [])]
        record.tokens = out.tokens
        log.info(`job ${def.id} ${record.status} in ${Date.now() - started} ms`, { summary: truncate(out.summary, 300) })
      })
    } catch (err) {
      record.status = abort.signal.aborted ? "aborted" : "error"
      record.error = truncate(errorMessage(err), 2000)
      withLogContext({ cid: record.id }, () => log.error(`job ${def.id} failed`, record.error))
      if (record.status === "error") notify(this.ctx, "job-failed", `Job fehlgeschlagen: ${def.label}`, truncate(record.error, 200), { variant: "error", link: `#/jobs?job=${encodeURIComponent(def.id)}` })
    } finally {
      release?.()
    }
    record.endedAt = nowIso()
    record.progress = undefined
    await this.updateState(def.id, (s) => {
      const i = s.runs.findIndex((r) => r.id === record.id)
      if (i >= 0) s.runs[i] = record
      else s.runs.push(record)
      s.lastRunAt = record.endedAt
    })
    this.ctx.bus?.emit("job.changed", { job: def.id, run: record.id, status: record.status })
    return record
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err?.code === "EPERM"
  }
}

/** One scheduler per store and process (worktree instances of agent tasks share it). */
export function sharedScheduler(ctx: Ctx, defs: () => JobDef[]): { scheduler: JobScheduler; owner: boolean } {
  const key = Symbol.for(`skillsmith.jobs:${ctx.store.root}`)
  const existing = (globalThis as any)[key] as JobScheduler | undefined
  if (existing) return { scheduler: existing, owner: false }
  const s = new JobScheduler(ctx, defs)
  ;(globalThis as any)[key] = s
  return { scheduler: s, owner: true }
}

export function releaseScheduler(ctx: Ctx, s: JobScheduler): void {
  const key = Symbol.for(`skillsmith.jobs:${ctx.store.root}`)
  if ((globalThis as any)[key] === s) delete (globalThis as any)[key]
}
