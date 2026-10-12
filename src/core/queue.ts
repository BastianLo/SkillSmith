/**
 * Persistent review queue (state/queue/<sessionID>.json).
 * - every trigger becomes a job; jobs are never dropped (only when the
 *   session is gone): failures retry with backoff, configuration errors
 *   (unknown model, …) retry every 10 minutes
 * - at most one job per session (coalescing); a trigger during a running
 *   review schedules a follow-up run that covers the new messages
 * - jobs run in parallel up to reviewConcurrency (process-wide)
 * - a per-session lock prevents two opencode processes reviewing the same session
 */
import { join } from "node:path"
import type { JobReason, ReviewJob } from "../types"
import { acquireFileLock, ensureDir, listFiles, readJson, removePath, writeJsonAtomic } from "../util/fs"
import { errorMessage, nowIso } from "../util/text"
import type { Ctx } from "./context"
import { M } from "./metrics"
import type { ReviewResult } from "./reviewer"

const PRIORITY: Record<JobReason, number> = { manual: 5, remember: 5, compaction: 5, threshold: 4, subagent: 3, idle: 2, catchup: 1 }

class Pool {
  active = 0
  constructor(public limit: number) {}
  tryAcquire(): boolean {
    if (this.active >= this.limit) return false
    this.active++
    return true
  }
  release(): void {
    this.active = Math.max(0, this.active - 1)
  }
}

function sharedPool(limit: number): Pool {
  const key = Symbol.for("skillsmith.pool")
  const pool: Pool = ((globalThis as any)[key] ??= new Pool(limit))
  pool.limit = Math.max(pool.limit, limit)
  return pool
}

const pumps: Set<() => void> = ((globalThis as any)[Symbol.for("skillsmith.pumps")] ??= new Set())

export class ReviewQueue {
  readonly dir: string
  private running = new Set<string>()
  private timer?: ReturnType<typeof setInterval>
  private pool: Pool
  private stopped = false
  /** jobs are persisted immediately but only run after start() (startup: git init, cleanup) */
  private started = false
  private pumpRef = () => this.pump()

  constructor(private ctx: Ctx, private handler: (job: ReviewJob) => Promise<ReviewResult>) {
    this.dir = join(ctx.store.stateDir, "queue")
    ensureDir(this.dir)
    this.pool = sharedPool(ctx.options.reviewConcurrency)
  }

  private file(sessionID: string): string {
    return join(this.dir, `${sessionID.replace(/[^A-Za-z0-9_-]/g, "_")}.json`)
  }

  enqueue(sessionID: string, reason: JobReason, force = false): void {
    const file = this.file(sessionID)
    const existing = readJson<ReviewJob | null>(file, null)
    const now = nowIso()
    const job: ReviewJob = existing
      ? {
          ...existing,
          reason: PRIORITY[reason] > PRIORITY[existing.reason] ? reason : existing.reason,
          force: existing.force || force,
          rerun: this.running.has(sessionID) ? true : existing.rerun,
          enqueuedAt: now,
          notBefore: force ? undefined : existing.notBefore,
        }
      : { sessionID, directory: this.ctx.directory, reason, enqueuedAt: now, force, attempts: 0 }
    writeJsonAtomic(file, job)
    this.ctx.log.debug(`enqueued ${sessionID} (${job.reason}${job.rerun ? ", follow-up" : ""})`)
    this.pump()
  }

  pending(): ReviewJob[] {
    return listFiles(this.dir, ".json")
      .map((f) => readJson<ReviewJob | null>(join(this.dir, f), null))
      .filter((j): j is ReviewJob => !!j)
  }

  runningCount(): number {
    return this.running.size
  }

  start(): void {
    if (this.started || this.stopped) return
    this.started = true
    pumps.add(this.pumpRef)
    this.timer = setInterval(() => this.pump(), 30_000)
    ;(this.timer as any).unref?.()
    this.pump()
  }

  stop(): void {
    this.stopped = true
    pumps.delete(this.pumpRef)
    if (this.timer) clearInterval(this.timer)
  }

  pump(): void {
    if (this.stopped || !this.started) return
    const now = Date.now()
    const jobs = this.pending()
      .filter((j) => j.directory === this.ctx.directory && !this.running.has(j.sessionID))
      .filter((j) => !j.notBefore || Date.parse(j.notBefore) <= now)
      .sort((a, b) => PRIORITY[b.reason] - PRIORITY[a.reason] || a.enqueuedAt.localeCompare(b.enqueuedAt))
    for (const job of jobs) {
      if (!this.pool.tryAcquire()) break
      this.running.add(job.sessionID)
      void this.runJob(job)
    }
  }

  private async runJob(job: ReviewJob): Promise<void> {
    const sid = job.sessionID
    const startedAt = nowIso()
    let release: (() => void) | undefined
    let outcome: ReviewResult = { outcome: "failed" }
    let lockedElsewhere = false
    try {
      // clear the follow-up flag: triggers from now on schedule another run
      const current = readJson<ReviewJob | null>(this.file(sid), null)
      if (current) writeJsonAtomic(this.file(sid), { ...current, rerun: false })
      try {
        release = await acquireFileLock(this.ctx.store.locksDir, `review-${sid}`, {
          staleMs: (2 * this.ctx.options.reviewTimeoutMin + 5) * 60_000,
          timeoutMs: 0,
        })
      } catch {
        lockedElsewhere = true
        return
      }
      this.ctx.metrics?.record({ type: M.queueWait, entry: `job:${job.reason}`, session: sid, origin: "background", value: Math.max(0, Date.now() - Date.parse(job.enqueuedAt)) })
      outcome = await this.handler(job)
    } catch (err) {
      this.ctx.log.error(`review job ${sid} crashed`, errorMessage(err))
      outcome = { outcome: "failed", error: errorMessage(err) }
    } finally {
      release?.()
      this.running.delete(sid)
      this.pool.release()
      if (!lockedElsewhere) this.settle(job, outcome, startedAt)
      // wake every instance of this process (a pool slot is free)
      for (const p of pumps) {
        try {
          p()
        } catch {
          // ignore
        }
      }
    }
  }

  private settle(job: ReviewJob, result: ReviewResult, startedAt: string): void {
    const file = this.file(job.sessionID)
    const current = readJson<ReviewJob | null>(file, null)
    if (!current) return
    const outcome = result.outcome
    if (outcome === "gone") {
      removePath(file)
      return
    }
    if (outcome === "config-error") {
      // configuration problem (model/provider): keep the job, retry every 10 minutes, never drop
      writeJsonAtomic(file, { ...current, rerun: false, lastError: result.error, notBefore: new Date(Date.now() + 10 * 60_000).toISOString() })
      return
    }
    const followUp = current.rerun || current.enqueuedAt > startedAt
    if (outcome === "failed" && !followUp) {
      const attempts = (current.attempts ?? 0) + 1
      const delayMin = Math.min(60, 2 ** attempts)
      this.ctx.log.warn(`review of ${job.sessionID} failed (attempt ${attempts}); retry in ${delayMin} min`, result.error)
      writeJsonAtomic(file, { ...current, attempts, lastError: result.error, notBefore: new Date(Date.now() + delayMin * 60_000).toISOString() })
      return
    }
    if (followUp) {
      writeJsonAtomic(file, { ...current, rerun: false, force: false, attempts: 0, lastError: undefined, notBefore: undefined })
      return
    }
    removePath(file)
  }
}
