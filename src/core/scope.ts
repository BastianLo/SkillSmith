/**
 * Where a memory belongs: project (stable across clones: normalized git remote
 * URL, else the worktree path), branch and ticket of a working directory.
 * Git is asked at most every 30 s per directory; without git the directory is
 * the project and there is no branch.
 */
import { execFileSync } from "node:child_process"
import { basename } from "node:path"
import { slugify } from "../util/text"

export interface Scope {
  /** stable project id: "github.com/org/repo" or "path:/abs/dir" */
  project: string
  /** readable name (repository or folder name) */
  projectName: string
  /** slug used in memory names */
  projectSlug: string
  branch?: string
  ticket?: string
}

/** git@host:org/repo.git, https://user@host:8443/org/repo.git → host/org/repo */
export function normalizeRemote(url: string): string | undefined {
  let u = url.trim()
  if (!u) return undefined
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(u)
  if (scp) u = `${scp[1]}/${scp[2]}`
  else u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^@/]+@/, "")
  u = u.replace(/\.git$/i, "").replace(/\/+$/, "").replace(/^([^/:]+):\d+\//, "$1/")
  const [host, ...rest] = u.split("/")
  if (!host) return undefined
  return [host.toLowerCase(), ...rest].join("/")
}

export function ticketOf(text: string | undefined, pattern: string): string | undefined {
  if (!text) return undefined
  try {
    return new RegExp(pattern).exec(text)?.[0]
  } catch {
    return undefined
  }
}

function runs(bin: string, args: string[]): string | undefined {
  try {
    return execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim()
  } catch {
    return undefined
  }
}

/**
 * A working git binary, found synchronously. On macOS /usr/bin/git is a shim that
 * opens an installer dialog when the Command Line Tools are missing – it is only
 * used when `xcode-select -p` succeeds.
 */
export function findGitSync(preferred?: string): string | undefined {
  const candidates = [...new Set([preferred, "/opt/homebrew/bin/git", "/usr/local/bin/git", "git", "/usr/bin/git"].filter((c): c is string => !!c))]
  let clt: boolean | undefined
  for (const c of candidates) {
    if (process.platform === "darwin") {
      const real = c.includes("/") ? c : runs("/usr/bin/which", [c])
      if (!real) continue
      if (real === "/usr/bin/git") {
        clt ??= runs("/usr/bin/xcode-select", ["-p"]) !== undefined
        if (!clt) continue
      }
    }
    if (/git version/.test(runs(c, ["--version"]) ?? "")) return c
  }
  return undefined
}

export class ScopeResolver {
  private cache = new Map<string, { at: number; scope: Scope }>()
  private bin?: string | null

  constructor(
    private preferredGit?: string,
    private ticketPattern = "[A-Z][A-Z0-9]+-\\d+",
  ) {}

  private gitBinary(): string | undefined {
    if (this.bin === undefined) this.bin = findGitSync(this.preferredGit) ?? null
    return this.bin ?? undefined
  }

  private git(dir: string, args: string[]): string | undefined {
    const bin = this.gitBinary()
    if (!bin) return undefined
    try {
      const out = execFileSync(bin, ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 })
      return out.trim() || undefined
    } catch {
      return undefined
    }
  }

  resolve(directory: string, worktree?: string): Scope {
    const hit = this.cache.get(directory)
    if (hit && Date.now() - hit.at < 30_000) return hit.scope
    const root = worktree && worktree !== "/" ? worktree : directory
    const remotes = this.git(directory, ["remote"])?.split("\n").filter(Boolean) ?? []
    const remoteName = remotes.includes("origin") ? "origin" : remotes[0]
    const remote = remoteName ? normalizeRemote(this.git(directory, ["remote", "get-url", remoteName]) ?? "") : undefined
    const project = remote ?? `path:${root}`
    const projectName = remote ? (remote.split("/").pop() ?? remote) : basename(root) || "projekt"
    let branch = this.git(directory, ["rev-parse", "--abbrev-ref", "HEAD"])
    if (branch === "HEAD") branch = undefined
    const scope: Scope = {
      project,
      projectName,
      projectSlug: slugify(projectName, 18) || "projekt",
      branch,
      ticket: ticketOf(branch, this.ticketPattern),
    }
    this.cache.set(directory, { at: Date.now(), scope })
    return scope
  }

  /** Does the branch still exist locally? (unknown → true) */
  branchExists(directory: string, branch: string): boolean {
    const r = this.git(directory, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
    if (r) return true
    // git missing or no repository: cannot tell
    return this.git(directory, ["rev-parse", "--git-dir"]) === undefined
  }
}
