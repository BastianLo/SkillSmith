/**
 * Local pipeline per project (like a GitHub Action / Jenkins job, without a server):
 * the stages of a project run one after another when a card enters a trigger column,
 * on demand, or for agent tasks before the card moves to "test". Each stage has a time
 * limit; the first red stage stops the run (unless allowFailure). JUnit XML reports
 * (Surefire, Failsafe, Gradle, Jest) are evaluated. Logs are redacted, kept per run
 * (pipeline.keepRuns) and streamed live to the web view.
 *
 * Where it runs: agent tasks in their worktree, the user's own tasks in the working
 * directory below home_path, or (source: branch) on a clean checkout of the task's branch
 * in a temporary worktree. At most one run per project and pipeline.maxParallel overall.
 * Runs are local data (audit event, no commit). Only commands stored in the project run.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve, sep } from "node:path"
import { ensureDir, exists, listFiles, readJson, removePath, writeJsonAtomic } from "../util/fs"
import { errorMessage, nowIso, shortId, truncate } from "../util/text"
import type { Ctx } from "./context"
import { str } from "./frontmatter"
import { gitIn } from "./git"
import { M } from "./metrics"
import { notify } from "./notify"
import { GuardError } from "./ops"
import { expandPath, type PipelineStage } from "./projects"

export type StageStatus = "pending" | "running" | "success" | "failed" | "skipped" | "timeout" | "aborted"
export type RunStatus = "queued" | "running" | "success" | "failed" | "aborted" | "timeout" | "error" | "interrupted"

export interface TestCaseResult {
  suite: string
  name: string
  message?: string
}

export interface TestSummary {
  total: number
  failures: number
  errors: number
  skipped: number
  failed: TestCaseResult[]
}

export interface StageResult {
  name: string
  run: string
  status: StageStatus
  allowFailure?: boolean
  startedAt?: string
  endedAt?: string
  ms?: number
  exitCode?: number | null
  tests?: TestSummary
}

export interface PipelineRun {
  id: string
  project: string
  task?: string
  trigger: "column" | "manual" | "agent" | "fix" | "tests"
  by: string
  /** ad-hoc stages (test cases with a command) instead of the project's pipeline */
  defs?: PipelineStage[]
  label?: string
  status: RunStatus
  source: "arbeitsverzeichnis" | "branch" | "worktree"
  workdir: string
  branch?: string
  queuedAt: string
  startedAt?: string
  endedAt?: string
  ms?: number
  stages: StageResult[]
  tests?: TestSummary
  pid?: number
  owner: number
  error?: string
  /** the code changed since the previous run of this task (flaky test detection) */
  codeHash?: string
}

const SANDBOX_PROFILE = (workdir: string, home: string, tmp: string) => `(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "${workdir}") (subpath "${home}/.m2") (subpath "${home}/.gradle") (subpath "${home}/.npm") (subpath "${tmp}") (subpath "/private/tmp") (subpath "/private/var/folders") (literal "/dev/null") (literal "/dev/tty"))`

/** Minimal JUnit XML evaluation (testsuite counts, failed test cases with message). */
export function parseJUnit(xml: string): TestSummary {
  const out: TestSummary = { total: 0, failures: 0, errors: 0, skipped: 0, failed: [] }
  const attr = (tag: string, name: string) => {
    const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag)
    return m ? m[1] : undefined
  }
  const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
  const cases = [...xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)]
  if (cases.length) {
    for (const c of cases) {
      out.total++
      const inner = c[3] ?? ""
      const name = unescape(attr(c[1], "name") ?? "?")
      const suite = unescape(attr(c[1], "classname") ?? "")
      const fail = /<(failure|error)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/.exec(inner)
      if (fail) {
        if (fail[1] === "failure") out.failures++
        else out.errors++
        const msg = attr(fail[2], "message") ?? (fail[4] ?? "").trim().split("\n")[0]
        out.failed.push({ suite, name, message: truncate(unescape(msg ?? ""), 400) })
      } else if (/<skipped\b/.test(inner)) out.skipped++
    }
    return out
  }
  for (const s of xml.matchAll(/<testsuite\b([^>]*)>/g)) {
    out.total += Number(attr(s[1], "tests") ?? 0)
    out.failures += Number(attr(s[1], "failures") ?? 0)
    out.errors += Number(attr(s[1], "errors") ?? 0)
    out.skipped += Number(attr(s[1], "skipped") ?? 0)
  }
  return out
}

/** Glob (`*`, `?`, `**`) → regular expression over "/"-separated relative paths. */
export function globToRe(pattern: string): RegExp {
  const parts = pattern.split("/").filter(Boolean)
  let re = ""
  parts.forEach((seg, i) => {
    const last = i === parts.length - 1
    if (seg === "**") {
      re += last ? ".*" : "(?:[^/]+/)*"
      return
    }
    re += seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")
    if (!last) re += "/"
  })
  return new RegExp(`^${re}$`)
}

/** Files matching a relative glob below a directory. */
export function globFiles(root: string, pattern: string, max = 2000): string[] {
  const re = globToRe(pattern)
  const out: string[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > 12 || out.length >= max) return
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const n of names) {
      if (n === ".git" || n === "node_modules") continue
      const full = join(dir, n)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      const rel = relative(root, full).split(sep).join("/")
      if (st.isDirectory()) walk(full, depth + 1)
      else if (re.test(rel)) out.push(full)
    }
  }
  walk(root, 0)
  return out
}

function mergeTests(a: TestSummary | undefined, b: TestSummary): TestSummary {
  if (!a) return { ...b, failed: [...b.failed] }
  return { total: a.total + b.total, failures: a.failures + b.failures, errors: a.errors + b.errors, skipped: a.skipped + b.skipped, failed: [...a.failed, ...b.failed].slice(0, 200) }
}

export class Pipeline {
  private queue: Array<{ run: PipelineRun; resolve: (r: PipelineRun) => void }> = []
  private active = new Map<string, { run: PipelineRun; child?: ChildProcess; abort: boolean }>()
  /** called when a run of an agent task ends (agent fixes, card moves) */
  onFinished?: (run: PipelineRun) => void

  constructor(private ctx: Ctx) {}

  private dir(project: string): string {
    return join(this.ctx.store.stateDir, "pipeline", project.replace(/[^A-Za-z0-9_.-]/g, "_"))
  }

  private file(run: PipelineRun): string {
    return join(this.dir(run.project), `${run.id}.json`)
  }

  logFile(project: string, id: string): string {
    return join(this.dir(project), `${id.replace(/[^A-Za-z0-9_-]/g, "")}.log`)
  }

  private save(run: PipelineRun): void {
    ensureDir(this.dir(run.project))
    writeJsonAtomic(this.file(run), run)
  }

  runs(project?: string, limit = 100): PipelineRun[] {
    const base = join(this.ctx.store.stateDir, "pipeline")
    const projects = project ? [project] : (() => {
      try {
        return readdirSync(base)
      } catch {
        return []
      }
    })()
    const out: PipelineRun[] = []
    for (const p of projects) {
      const dir = project ? this.dir(p) : join(base, p)
      for (const f of listFiles(dir, ".json")) {
        const r = readJson<PipelineRun | null>(join(dir, f), null)
        if (r?.id) out.push(r)
      }
    }
    return out.sort((a, b) => b.queuedAt.localeCompare(a.queuedAt)).slice(0, limit)
  }

  get(project: string, id: string): PipelineRun | undefined {
    return readJson<PipelineRun | null>(join(this.dir(project), `${id.replace(/[^A-Za-z0-9_-]/g, "")}.json`), null) ?? undefined
  }

  /** Last run of a task (card badge). */
  lastOfTask(task: string): PipelineRun | undefined {
    const live = [...this.active.values()].map((a) => a.run).find((r) => r.task === task) ?? this.queue.find((q) => q.run.task === task)?.run
    if (live) return live
    return this.runs(undefined, 500).find((r) => r.task === task)
  }

  log(project: string, id: string, fromByte = 0): { text: string; size: number } {
    const file = this.logFile(project, id)
    try {
      const buf = readFileSync(file)
      return { text: buf.subarray(Math.max(0, fromByte)).toString("utf8"), size: buf.length }
    } catch {
      return { text: "", size: 0 }
    }
  }

  /** Runs marked as running by a process that is gone → "abgebrochen" (startup). */
  markInterrupted(): number {
    let n = 0
    for (const r of this.runs(undefined, 10_000)) {
      if (r.status !== "running" && r.status !== "queued") continue
      if (r.owner === process.pid && this.active.has(r.id)) continue
      let alive = false
      try {
        process.kill(r.owner, 0)
        alive = r.owner !== process.pid
      } catch {
        alive = false
      }
      if (alive) continue
      r.status = "interrupted"
      r.endedAt = nowIso()
      for (const s of r.stages) if (s.status === "running" || s.status === "pending") s.status = s.status === "running" ? "aborted" : "skipped"
      this.save(r)
      n++
    }
    return n
  }

  status(): { running: PipelineRun[]; queued: PipelineRun[] } {
    return { running: [...this.active.values()].map((a) => a.run), queued: this.queue.map((q) => q.run) }
  }

  /**
   * Queue a run. `workdir`: explicit (agent worktree); otherwise home_path or (source: branch)
   * a fresh worktree of the task's branch.
   */
  start(input: { project: string; task?: string; trigger: PipelineRun["trigger"]; by: string; workdir?: string; branch?: string; stages?: PipelineStage[]; label?: string }): Promise<PipelineRun> {
    const p = this.ctx.projects.get(input.project)
    if (!p) throw new GuardError(`Projekt „${input.project}“ nicht gefunden`)
    const defs = input.stages ?? p.pipeline?.stages ?? []
    if (!defs.length) throw new GuardError(`Projekt „${p.title}“ hat keine Pipeline`)
    if (!input.workdir && !p.homePath) throw new GuardError(`Projekt „${p.title}“ hat keinen home_path`)
    const source = input.workdir ? "worktree" : (p.pipeline?.source ?? "arbeitsverzeichnis")
    const run: PipelineRun = {
      id: `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${shortId(4)}`,
      project: p.name,
      task: input.task,
      trigger: input.trigger,
      by: input.by,
      status: "queued",
      source,
      workdir: input.workdir ?? expandPath(p.homePath!),
      branch: input.branch,
      queuedAt: nowIso(),
      stages: defs.map((s) => ({ name: s.name, run: s.run, status: "pending", ...(s.allowFailure ? { allowFailure: true } : {}) })),
      ...(input.stages ? { defs: input.stages, label: input.label } : {}),
      owner: process.pid,
    }
    this.save(run)
    this.prune(p.name)
    this.ctx.bus.emit("pipeline.run", { run: run.id, project: run.project, task: run.task, status: run.status })
    return new Promise((resolve) => {
      this.queue.push({ run, resolve })
      this.pump()
    })
  }

  abort(project: string, id: string): boolean {
    const a = this.active.get(id)
    if (a) {
      a.abort = true
      this.kill(a.child)
      return true
    }
    const i = this.queue.findIndex((q) => q.run.id === id && q.run.project === project)
    if (i >= 0) {
      const [q] = this.queue.splice(i, 1)
      q.run.status = "aborted"
      q.run.endedAt = nowIso()
      for (const s of q.run.stages) s.status = "skipped"
      this.save(q.run)
      this.ctx.bus.emit("pipeline.run", { run: id, project, task: q.run.task, status: "aborted" })
      q.resolve(q.run)
      return true
    }
    return false
  }

  private kill(child?: ChildProcess): void {
    if (!child?.pid) return
    try {
      process.kill(-child.pid, "SIGTERM")
    } catch {
      try {
        child.kill("SIGTERM")
      } catch {
        // gone
      }
    }
    setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL")
      } catch {
        // gone
      }
    }, 5000).unref?.()
  }

  private pump(): void {
    const max = this.ctx.options.pipeline.maxParallel
    for (let i = 0; i < this.queue.length && this.active.size < max; ) {
      const q = this.queue[i]
      if ([...this.active.values()].some((a) => a.run.project === q.run.project)) {
        i++
        continue
      }
      this.queue.splice(i, 1)
      const slot = { run: q.run, abort: false as boolean, child: undefined as ChildProcess | undefined }
      this.active.set(q.run.id, slot)
      void this.execute(slot)
        .catch((err) => {
          slot.run.status = "error"
          slot.run.error = errorMessage(err)
        })
        .finally(() => {
          this.active.delete(q.run.id)
          slot.run.endedAt ??= nowIso()
          this.save(slot.run)
          this.finished(slot.run)
          q.resolve(slot.run)
          this.pump()
        })
    }
  }

  private append(run: PipelineRun, text: string): void {
    if (!text) return
    const file = this.logFile(run.project, run.id)
    const max = this.ctx.options.pipeline.logMaxKB * 1024
    try {
      const size = exists(file) ? statSync(file).size : 0
      if (size > max) return
      const chunk = size + text.length > max ? `${text.slice(0, Math.max(0, max - size))}\n[… Log gekürzt (pipeline.logMaxKB)]\n` : text
      appendFileSync(file, chunk)
      this.ctx.bus.emit("pipeline.log", { run: run.id, project: run.project, text: chunk })
    } catch {
      // ignore log errors
    }
  }

  private async prepareWorkdir(run: PipelineRun): Promise<() => Promise<void>> {
    if (run.source !== "branch") return async () => {}
    const p = this.ctx.projects.get(run.project)!
    const home = expandPath(p.homePath!)
    const branch = run.branch ?? (run.task ? str(this.ctx.tasks.get(run.task)?.fields.branch) : "") ?? ""
    if (!branch) throw new GuardError("source: branch braucht einen Branch an der Aufgabe")
    const target = join(this.ctx.store.stateDir, "worktrees", `pipeline-${run.id}`)
    ensureDir(join(this.ctx.store.stateDir, "worktrees"))
    const bin = this.ctx.git.bin
    const r = await gitIn(bin, home, ["worktree", "add", "--detach", target, branch], 120_000)
    if (r.code !== 0) throw new Error(`git worktree add fehlgeschlagen: ${truncate(r.stderr, 300)}`)
    run.workdir = target
    run.branch = branch
    return async () => {
      await gitIn(bin, home, ["worktree", "remove", "--force", target], 60_000)
      removePath(target)
    }
  }

  private async execute(slot: { run: PipelineRun; child?: ChildProcess; abort: boolean }): Promise<void> {
    const run = slot.run
    const p = this.ctx.projects.get(run.project)
    const defs = run.defs ?? p?.pipeline?.stages
    if (!p || !defs?.length) throw new Error("Pipeline nicht mehr vorhanden")
    run.status = "running"
    run.startedAt = nowIso()
    run.pid = process.pid
    this.save(run)
    this.ctx.bus.emit("pipeline.run", { run: run.id, project: run.project, task: run.task, status: run.status })
    this.ctx.audit?.append({ actor: "pipeline", category: "pipeline", action: "start", targets: run.task ? [`task:${run.task}`, `project:${run.project}`] : [`project:${run.project}`], result: "ok", message: `${run.id} (${run.trigger}, ${run.source})`, project: run.project })
    let cleanup: () => Promise<void> = async () => {}
    try {
      cleanup = await this.prepareWorkdir(run)
      if (!exists(run.workdir)) throw new Error(`Arbeitsverzeichnis ${run.workdir} fehlt`)
      run.codeHash = await this.codeHash(run.workdir)
      this.append(run, `▶ ${run.label ?? "Pipeline"} ${p.title} · ${run.workdir}${run.branch ? ` · ${run.branch}` : ""}\n`)
      let failed = false
      for (let i = 0; i < defs.length; i++) {
        const def = defs[i]
        const st = run.stages[i]
        if (failed || slot.abort) {
          st.status = slot.abort ? "aborted" : "skipped"
          continue
        }
        st.status = "running"
        st.startedAt = nowIso()
        this.save(run)
        this.ctx.bus.emit("pipeline.run", { run: run.id, project: run.project, task: run.task, status: run.status, stage: st.name })
        this.append(run, `\n━━ ${st.name}: ${def.run}\n`)
        const res = await this.runStage(slot, def, run.workdir)
        st.endedAt = nowIso()
        st.ms = Date.parse(st.endedAt) - Date.parse(st.startedAt)
        st.exitCode = res.code
        st.status = slot.abort ? "aborted" : res.timedOut ? "timeout" : res.code === 0 ? "success" : "failed"
        if (def.reports) {
          for (const f of globFiles(run.workdir, def.reports)) {
            try {
              st.tests = mergeTests(st.tests, parseJUnit(readFileSync(f, "utf8")))
            } catch {
              // unreadable report
            }
          }
          if (st.tests) run.tests = mergeTests(run.tests, st.tests)
        }
        this.append(run, `━━ ${st.name}: ${st.status}${st.exitCode !== null && st.exitCode !== undefined ? ` (Exit ${st.exitCode})` : ""} · ${Math.round((st.ms ?? 0) / 1000)} s${st.tests ? ` · Tests ${st.tests.total}, fehlgeschlagen ${st.tests.failures + st.tests.errors}` : ""}\n`)
        this.ctx.metrics?.record({ type: M.pipelineStage, entry: `project:${run.project}`, origin: "pipeline", project: run.project, value: st.ms, extra: { stage: st.name, status: st.status, ...(st.status !== "success" ? { error: true } : {}), tests: st.tests?.total, failed: st.tests ? st.tests.failures + st.tests.errors : undefined } })
        if (st.status !== "success" && !def.allowFailure) failed = true
        this.save(run)
      }
      // test cases (ad-hoc stages) all run; any red case makes the run red
      const bad = run.stages.find((s) => (run.defs || !s.allowFailure) && (s.status === "failed" || s.status === "timeout"))
      run.status = slot.abort ? "aborted" : bad ? (bad.status === "timeout" ? "timeout" : "failed") : "success"
    } catch (err) {
      run.status = "error"
      run.error = errorMessage(err)
      this.append(run, `\n✖ ${run.error}\n`)
    } finally {
      await cleanup().catch(() => {})
    }
    run.endedAt = nowIso()
    run.ms = Date.parse(run.endedAt) - Date.parse(run.startedAt ?? run.queuedAt)
  }

  private runStage(slot: { child?: ChildProcess; abort: boolean; run: PipelineRun }, def: PipelineStage, cwd: string): Promise<{ code: number | null; timedOut: boolean }> {
    const o = this.ctx.options.pipeline
    const timeoutMs = Math.round((def.timeoutMin ?? o.timeoutMin) * 60_000)
    const shell = process.env.SHELL && process.platform !== "win32" ? process.env.SHELL : "/bin/sh"
    let cmd = shell
    let args = ["-lc", def.run]
    if (o.sandbox && process.platform === "darwin") {
      const home = process.env.HOME ?? "/"
      args = ["-p", SANDBOX_PROFILE(resolve(cwd), home, tmpdir()), shell, "-lc", def.run]
      cmd = "/usr/bin/sandbox-exec"
    }
    return new Promise((done) => {
      let timedOut = false
      let partial = ""
      const flush = (text: string, end = false) => {
        partial += text
        const cut = end ? partial.length : partial.lastIndexOf("\n") + 1
        if (cut <= 0) return
        this.append(slot.run, this.ctx.redactor.redact(partial.slice(0, cut)))
        partial = partial.slice(cut)
      }
      let child: ChildProcess
      try {
        child = spawn(cmd, args, { cwd, env: { ...process.env, CI: "true", SKILLSMITH_PIPELINE: "1" }, detached: true, stdio: ["ignore", "pipe", "pipe"] })
      } catch (err) {
        this.append(slot.run, `Start fehlgeschlagen: ${errorMessage(err)}\n`)
        done({ code: 127, timedOut: false })
        return
      }
      slot.child = child
      const timer = setTimeout(() => {
        timedOut = true
        this.append(slot.run, `\n⏱ Zeitlimit ${timeoutMs < 60_000 ? `${Math.round(timeoutMs / 1000)} s` : `${Math.round(timeoutMs / 60_000)} min`} überschritten – Abbruch\n`)
        this.kill(child)
      }, timeoutMs)
      child.stdout?.on("data", (d: Buffer) => flush(d.toString("utf8")))
      child.stderr?.on("data", (d: Buffer) => flush(d.toString("utf8")))
      child.on("error", (err) => {
        this.append(slot.run, `Fehler: ${errorMessage(err)}\n`)
      })
      child.on("close", (code) => {
        clearTimeout(timer)
        flush("", true)
        slot.child = undefined
        done({ code, timedOut })
      })
    })
  }

  /** Hash of the working tree state (HEAD + status) – flaky test detection. */
  private async codeHash(dir: string): Promise<string | undefined> {
    const bin = this.ctx.git.bin
    const head = await gitIn(bin, dir, ["rev-parse", "HEAD"], 10_000)
    if (head.code !== 0) return undefined
    const st = await gitIn(bin, dir, ["status", "--porcelain=v1", "-uno"], 20_000)
    const diff = st.stdout.trim() ? await gitIn(bin, dir, ["diff", "HEAD"], 30_000) : { stdout: "" }
    const { createHash } = await import("node:crypto")
    return createHash("sha1").update(head.stdout).update(diff.stdout).digest("hex").slice(0, 12)
  }

  private finished(run: PipelineRun): void {
    this.ctx.bus.emit("pipeline.run", { run: run.id, project: run.project, task: run.task, status: run.status, tests: run.tests ? { total: run.tests.total, failed: run.tests.failures + run.tests.errors } : undefined })
    this.ctx.metrics?.record({ type: M.pipelineRun, entry: `project:${run.project}`, origin: "pipeline", project: run.project, value: run.ms, extra: { status: run.status, trigger: run.trigger, task: run.task, tests: run.tests?.total, failed: run.tests ? run.tests.failures + run.tests.errors : undefined, ...(run.status === "success" ? {} : { error: true }), code: run.codeHash } })
    this.ctx.audit?.append({
      actor: "pipeline",
      category: "pipeline",
      action: "end",
      targets: run.task ? [`task:${run.task}`, `project:${run.project}`] : [`project:${run.project}`],
      result: run.status === "success" ? "ok" : "error",
      message: `${run.id}: ${run.status}${run.tests ? ` · Tests ${run.tests.total}, fehlgeschlagen ${run.tests.failures + run.tests.errors}` : ""}${run.error ? ` · ${run.error}` : ""}`,
      project: run.project,
    })
    const p = this.ctx.projects.get(run.project)
    const label = run.status === "success" ? "grün" : run.status === "aborted" ? "abgebrochen" : "rot"
    notify(this.ctx, "pipeline", `Pipeline ${p?.title ?? run.project}${run.task ? ` · ${run.task.toUpperCase()}` : ""}`, `${label}${run.tests ? ` (${run.tests.total} Tests, ${run.tests.failures + run.tests.errors} fehlgeschlagen)` : ""}`, {
      variant: run.status === "success" ? "success" : run.status === "aborted" ? "info" : "error",
      link: run.task ? `#/aufgabe/${run.task}` : `#/projekt/${run.project}`,
    })
    try {
      this.onFinished?.(run)
    } catch (err) {
      this.ctx.log.warn("pipeline follow-up failed", errorMessage(err))
    }
  }

  private prune(project: string): void {
    const keep = this.ctx.options.pipeline.keepRuns
    const runs = this.runs(project, 100_000).filter((r) => r.status !== "running" && r.status !== "queued")
    for (const r of runs.slice(keep)) {
      removePath(this.file(r))
      removePath(this.logFile(project, r.id))
    }
  }

  /** Card badge for a task. */
  badge(task: string): { status: string; stages: Array<{ name: string; status: string }>; at?: string; run?: string } | undefined {
    const r = this.lastOfTask(task)
    if (!r) return undefined
    return { status: r.status, stages: r.stages.map((s) => ({ name: s.name, status: s.status })), at: r.endedAt ?? r.startedAt ?? r.queuedAt, run: r.id }
  }

  /** Flaky tests: red, then green on the same code (same code hash) – statistics. */
  flaky(project?: string): Array<{ project: string; task?: string; red: string; green: string; tests: string[] }> {
    const out: Array<{ project: string; task?: string; red: string; green: string; tests: string[] }> = []
    const runs = this.runs(project, 5000).reverse()
    const lastRed = new Map<string, PipelineRun>()
    for (const r of runs) {
      if (!r.codeHash) continue
      const key = `${r.project}|${r.codeHash}`
      if (r.status === "failed") lastRed.set(key, r)
      else if (r.status === "success" && lastRed.has(key)) {
        const red = lastRed.get(key)!
        out.push({ project: r.project, task: r.task, red: red.id, green: r.id, tests: (red.tests?.failed ?? []).map((t) => `${t.suite}.${t.name}`) })
        lastRed.delete(key)
      }
    }
    return out
  }
}
