/**
 * Git tracking of the store. Exactly one commit per mutating run
 * (reviewer, curator, command), containing only the paths that run touched.
 * Manual edits found before a run commit are committed separately first.
 */
import { execFile } from "node:child_process"
import { join } from "node:path"
import type { Logger } from "../log"
import type { ActionKind, Run, RunAction } from "../types"
import { exists, readText, withLock, writeFileAtomic } from "../util/fs"
import { truncate } from "../util/text"
import type { SkillStore } from "./store"

const IDENTITY = { name: "skillsmith", email: "skillsmith@local" }

const KIND_ORDER: ActionKind[] = [
  "migrate",
  "create",
  "upsert",
  "merge",
  "update",
  "patch",
  "rewrite",
  "retest",
  "restore",
  "activate",
  "dormant",
  "archive",
  "flag",
  "pin",
  "unpin",
  "adopt",
  "ignore",
  "note",
]

export const SMITH_SUBJECT_RE = /^(skillsmith|docsmith|errorsmith|toolsmith|memorysmith|doctor)\((reviewer|curator|command|web)\): /

/** "create foo" for skills, "upsert glossary db2" for every other kind */
export function actionLabel(a: Pick<RunAction, "kind" | "target" | "name">): string {
  return a.target === "skill" ? `${a.kind} ${a.name}` : `${a.kind} ${a.target} ${a.name}`
}

export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

function run(bin: string, args: string[], cwd: string, timeoutMs = 30_000, identity = true): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          ...(identity
            ? { GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email, GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email }
            : {}),
          LC_ALL: "C",
        },
      },
      (err: any, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? "") + (err && typeof err.code !== "number" ? String(err.message ?? err) : ""),
        })
      },
    )
  })
}

/** git in any directory (project repositories, worktrees of agent tasks); never through a shell. */
export async function gitIn(bin: string | undefined, cwd: string, args: string[], timeoutMs = 60_000): Promise<GitResult> {
  // the user's repositories: their own git identity (merges, commits of agent work);
  // only without any configured identity the commit is made as "skillsmith"
  const b = bin ?? "git"
  const commits = args[0] === "commit" || args[0] === "merge" || args[0] === "revert" || args[0] === "cherry-pick"
  if (!commits) return run(b, args, cwd, timeoutMs, false)
  const email = await run(b, ["config", "user.email"], cwd, 10_000, false)
  return run(b, args, cwd, timeoutMs, !email.stdout.trim())
}

/** Locate a usable git binary without triggering the macOS CLT install dialog. */
export async function findGit(preferred?: string): Promise<string | undefined> {
  const candidates: string[] = []
  if (preferred) candidates.push(preferred)
  candidates.push(
    "/opt/homebrew/bin/git",
    "/usr/local/bin/git",
    "/Library/Developer/CommandLineTools/usr/bin/git",
    "/Applications/Xcode.app/Contents/Developer/usr/bin/git",
  )
  const which = (globalThis as any).Bun?.which?.("git") as string | null | undefined
  if (which) candidates.push(which)
  candidates.push("/usr/bin/git")
  for (const c of candidates) {
    if (!c || (c.startsWith("/") && !exists(c))) continue
    if (process.platform === "darwin" && c === "/usr/bin/git") {
      // /usr/bin/git is a shim that opens an installer dialog when the Command Line Tools are missing
      const sel = await run("/usr/bin/xcode-select", ["-p"], "/", 5000)
      if (sel.code !== 0) continue
    }
    const v = await run(c, ["--version"], "/", 10_000)
    if (v.code === 0 && /git version/.test(v.stdout)) return c
  }
  return undefined
}

export function commitMessage(run: Run): string {
  // local actions (state/memory.sqlite) are not part of the commit
  const actions = [...run.actions]
    .filter((a) => a.applied && !a.local)
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.target.localeCompare(b.target) || a.name.localeCompare(b.name))
  const parts = actions.map((a) => actionLabel(a))
  const dedup = [...new Set(parts)]
  let subject = `${run.smith}(${run.actor}): `
  const room = 72 - subject.length
  let summary = ""
  let used = 0
  for (const p of dedup) {
    const next = summary ? `${summary}; ${p}` : p
    if (next.length > room - 10 && used > 0) break
    summary = next
    used++
  }
  if (used < dedup.length) summary += ` (+${dedup.length - used} more)`
  subject += summary || "update"
  if (run.subject) subject = run.subject
  const meta = [run.trigger]
  if (run.sessionID) meta.push(`session ${run.sessionID}`)
  if (run.parentSessionID) meta.push(`parent ${run.parentSessionID}`)
  if (run.sessionAgent) meta.push(`agent ${run.sessionAgent}`)
  if (run.project) meta.push(`project ${run.project}`)
  const lines = [subject, "", `Run: ${run.id}`, `Trigger: ${meta.join(" · ")}`]
  if (actions.length) lines.push("")
  for (const a of actions) {
    const reason = a.reason ? `: ${truncate(a.reason.replace(/\s+/g, " ").trim(), 200)}` : ""
    const detail = a.detail ? ` (${a.detail})` : ""
    lines.push(`- ${actionLabel(a)}${detail}${reason}`)
  }
  return lines.join("\n") + "\n"
}

/** Parse `git status --porcelain=v1 -z` into changed paths. */
export function parsePorcelain(out: string): string[] {
  const paths: string[] = []
  const entries = out.split("\0")
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (!e || e.length < 4) continue
    const x = e[0]
    paths.push(e.slice(3))
    if (x === "R" || x === "C") i++ // skip rename source
  }
  return paths
}

function under(path: string, prefixes: Set<string>): boolean {
  for (const p of prefixes) {
    if (path === p || path.startsWith(p.endsWith("/") ? p : p + "/")) return true
  }
  return false
}

export class GitTracker {
  bin?: string
  private ready = false
  private initPromise?: Promise<boolean>

  constructor(private store: SkillStore, private enabled: boolean, private preferred: string | undefined, private log: Logger) {}

  get available(): boolean {
    return this.ready
  }

  init(): Promise<boolean> {
    this.initPromise ??= this.doInit()
    return this.initPromise
  }

  private async doInit(): Promise<boolean> {
    if (!this.enabled) return false
    this.bin = await findGit(this.preferred)
    if (!this.bin) {
      this.log.warn("git not found – skill changes will not be versioned")
      return false
    }
    const root = this.store.root
    const gitignore = join(root, ".gitignore")
    if (readText(gitignore) === undefined) writeFileAtomic(gitignore, "state/\n*.tmp\n.DS_Store\n")
    return withLock(this.store.locksDir, "git", async () => {
      if (!exists(join(root, ".git"))) {
        let r = await this.git(["init", "-q", "-b", "main"])
        if (r.code !== 0) r = await this.git(["init", "-q"])
        if (r.code !== 0) {
          this.log.error("git init failed", r.stderr)
          return false
        }
      }
      await this.git(["config", "user.name", IDENTITY.name])
      await this.git(["config", "user.email", IDENTITY.email])
      await this.git(["config", "commit.gpgsign", "false"])
      await this.git(["config", "core.autocrlf", "false"])
      await this.git(["config", "core.quotepath", "false"])
      const head = await this.git(["rev-parse", "--verify", "HEAD"])
      if (head.code !== 0) {
        await this.git(["add", "-A", "--", "."])
        // never fold uncommitted changes of an active run into the init commit
        const claimed = [...this.store.claimedPaths()]
        if (claimed.length) await this.git(["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...claimed])
        await this.git(["commit", "-q", "--no-verify", "--allow-empty", "-m", "skillsmith: init store\n"])
      }
      this.ready = true
      return true
    })
  }

  git(args: string[], timeoutMs?: number): Promise<GitResult> {
    return run(this.bin ?? "git", args, this.store.root, timeoutMs)
  }

  private async changedPaths(): Promise<string[]> {
    const r = await this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])
    if (r.code !== 0) return []
    return parsePorcelain(r.stdout).filter((p) => !p.startsWith("state/"))
  }

  /** Commit uncommitted paths that no active run claims as "manual: external changes". */
  private async commitExternal(exclude: Set<string>): Promise<string | undefined> {
    const changed = await this.changedPaths()
    const external = changed.filter((p) => !under(p, exclude))
    if (external.length === 0) return undefined
    await this.git(["add", "-A", "--", ...external])
    const staged = await this.git(["diff", "--cached", "--quiet"])
    if (staged.code === 0) return undefined
    const r = await this.git(["commit", "-q", "--no-verify", "-m", "manual: external changes\n\nChanges made outside skillsmith runs.\n"])
    if (r.code !== 0) {
      this.log.warn("external-changes commit failed", r.stderr)
      return undefined
    }
    return (await this.git(["rev-parse", "--short", "HEAD"])).stdout.trim()
  }

  /** Commit everything the run touched; returns the short hash or undefined (nothing to commit). */
  async commitRun(runInfo: Run): Promise<string | undefined> {
    if (!(await this.init())) return undefined
    if (runInfo.touched.size === 0) return undefined
    return withLock(this.store.locksDir, "git", async () => {
      const claimed = this.store.claimedPaths()
      for (const t of runInfo.touched) claimed.add(t)
      await this.commitExternal(claimed)
      const changed = await this.changedPaths()
      const mine = changed.filter((p) => under(p, runInfo.touched))
      if (mine.length === 0) return undefined
      // reset index first so nothing foreign is accidentally included
      await this.git(["reset", "-q"])
      const add = await this.git(["add", "-A", "--", ...mine])
      if (add.code !== 0) {
        this.log.error("git add failed", add.stderr)
        return undefined
      }
      const staged = await this.git(["diff", "--cached", "--quiet"])
      if (staged.code === 0) return undefined
      const msg = commitMessage(runInfo)
      const r = await this.git(["commit", "-q", "--no-verify", "-m", msg])
      if (r.code !== 0) {
        this.log.error("git commit failed", r.stderr)
        return undefined
      }
      const hash = (await this.git(["rev-parse", "--short", "HEAD"])).stdout.trim()
      this.log.info(`committed ${hash}`, msg.split("\n")[0])
      return hash
    })
  }

  async recent(n = 5): Promise<Array<{ hash: string; date: string; subject: string }>> {
    if (!(await this.init())) return []
    const r = await this.git(["log", `-n${n}`, "--format=%h%x09%cI%x09%s"])
    if (r.code !== 0) return []
    return r.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [hash, date, ...rest] = l.split("\t")
        return { hash, date, subject: rest.join("\t") }
      })
  }

  /** Find the commit of a run id, or the newest run commit of any smith (optionally of one smith). */
  async findRunCommit(runIdOrHash?: string, smith?: string): Promise<{ hash: string; subject: string; runId?: string } | undefined> {
    if (!(await this.init())) return undefined
    if (runIdOrHash && /^[0-9a-f]{6,40}$/.test(runIdOrHash)) {
      const r = await this.git(["log", "-n1", "--format=%h%x09%s%x09%b", runIdOrHash])
      if (r.code === 0 && r.stdout.trim()) {
        const [hash, subject, body] = r.stdout.split("\t")
        return { hash, subject, runId: /Run: (\S+)/.exec(body ?? "")?.[1] }
      }
    }
    const args = ["log", "-n50", "--format=%h%x09%s%x09%b%x1e"]
    const r = await this.git(args)
    if (r.code !== 0) return undefined
    for (const entry of r.stdout.split("\x1e")) {
      const [hashRaw, subject, body] = entry.split("\t")
      const hash = hashRaw?.trim()
      if (!hash || !subject) continue
      const m = SMITH_SUBJECT_RE.exec(subject)
      if (!m) continue
      if ((m[2] === "command" || m[2] === "web") && /^\S+\((command|web)\): (undo|restore) /.test(subject)) continue
      if (smith && m[1] !== smith) continue
      const id = /Run: (\S+)/.exec(body ?? "")?.[1]
      if (!runIdOrHash || id === runIdOrHash) return { hash, subject, runId: id }
    }
    return undefined
  }

  /** Revert a commit as part of `undoRun` (staged only; the caller commits through its own run). */
  async revertToIndex(hash: string): Promise<{ ok: boolean; paths: string[]; message: string }> {
    if (!(await this.init())) return { ok: false, paths: [], message: "git is not available" }
    return withLock(this.store.locksDir, "git", async () => {
      const files = await this.git(["show", "--name-only", "--format=", hash])
      const paths = files.stdout.split("\n").filter(Boolean)
      const r = await this.git(["revert", "--no-commit", "--no-edit", hash])
      if (r.code !== 0) {
        await this.git(["revert", "--abort"])
        return { ok: false, paths: [], message: `git revert failed: ${truncate(r.stderr.trim(), 300)}` }
      }
      // keep the reverted content in the working tree, but unstage it – commitRun stages exactly
      await this.git(["reset", "-q"])
      await this.git(["update-ref", "-d", "REVERT_HEAD"])
      return { ok: true, paths, message: "reverted" }
    })
  }
}
