import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { hostname } from "node:os"

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

export function exists(path: string): boolean {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

export function readJson<T>(path: string, fallback: T): T {
  const raw = readText(path)
  if (raw === undefined) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** JSON with recursively sorted object keys → stable, diff-friendly files. */
export function stableStringify(value: unknown, indent = 2): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        const item = (v as Record<string, unknown>)[key]
        if (item === undefined) continue
        out[key] = sort(item)
      }
      return out
    }
    return v
  }
  return JSON.stringify(sort(value), null, indent) + "\n"
}

let tmpCounter = 0
export function writeFileAtomic(path: string, content: string): void {
  ensureDir(dirname(path))
  const tmp = `${path}.${process.pid}.${Date.now()}.${tmpCounter++}.tmp`
  writeFileSync(tmp, content, "utf8")
  renameSync(tmp, path)
}

export function writeBufferAtomic(path: string, content: Uint8Array): void {
  ensureDir(dirname(path))
  const tmp = `${path}.${process.pid}.${Date.now()}.${tmpCounter++}.tmp`
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}

export function writeJsonAtomic(path: string, value: unknown): void {
  writeFileAtomic(path, stableStringify(value))
}

export function listDirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}

export function listFiles(path: string, suffix = ""): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(suffix) && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}

export function removePath(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

/** Find SKILL.md files below root (depth-limited, skips node_modules/.git). */
export function findSkillFiles(root: string, maxDepth = 5, includeDot = false): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return
    let entries: import("node:fs").Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue
      if (!includeDot && entry.name.startsWith(".")) continue
      const full = join(dir, entry.name)
      let isDirectory = entry.isDirectory()
      if (entry.isSymbolicLink()) isDirectory = isDir(full)
      if (isDirectory) walk(full, depth + 1)
      else if (entry.name === "SKILL.md") out.push(full)
    }
  }
  walk(root, 0)
  return out.sort()
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Locks: in-process promise chain + cross-process mkdir lock with stale reclaim
// ---------------------------------------------------------------------------

type Chain = { tail: Promise<void> }
const chains: Map<string, Chain> = ((globalThis as any)[Symbol.for("skillsmith.lockchains")] ??= new Map())

function pidAlive(pid: number): boolean {
  if (!pid || pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err?.code === "EPERM"
  }
}

export interface LockOptions {
  /** A lock older than this is considered abandoned. */
  staleMs?: number
  /** Give up waiting after this long (throws). */
  timeoutMs?: number
  pollMs?: number
}

export async function acquireFileLock(lockDir: string, name: string, opts: LockOptions = {}): Promise<() => void> {
  const staleMs = opts.staleMs ?? 120_000
  const timeoutMs = opts.timeoutMs ?? 120_000
  const pollMs = opts.pollMs ?? 50
  ensureDir(lockDir)
  const path = join(lockDir, `${name}.lock`)
  const started = Date.now()
  const host = hostname()
  for (;;) {
    try {
      mkdirSync(path)
      writeFileSync(join(path, "owner.json"), JSON.stringify({ pid: process.pid, host, at: Date.now() }))
      let released = false
      return () => {
        if (released) return
        released = true
        removePath(path)
      }
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err
    }
    const owner = readJson<{ pid?: number; host?: string; at?: number }>(join(path, "owner.json"), {})
    const age = Date.now() - (owner.at ?? statMtime(path))
    const deadOwner = owner.host === host && owner.pid !== undefined && !pidAlive(owner.pid)
    if (age > staleMs || deadOwner) {
      removePath(path)
      continue
    }
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for lock ${name}`)
    await sleep(pollMs)
  }
}

function statMtime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return Date.now()
  }
}

export function isLocked(lockDir: string, name: string, staleMs = 120_000): boolean {
  const path = join(lockDir, `${name}.lock`)
  if (!exists(path)) return false
  const owner = readJson<{ pid?: number; host?: string; at?: number }>(join(path, "owner.json"), {})
  const age = Date.now() - (owner.at ?? statMtime(path))
  if (age > staleMs) return false
  if (owner.host === hostname() && owner.pid !== undefined && !pidAlive(owner.pid)) return false
  return true
}

/** Serialize `fn` per lock name within this process and across processes. */
export async function withLock<T>(lockDir: string, name: string, fn: () => Promise<T> | T, opts: LockOptions = {}): Promise<T> {
  const key = `${lockDir}::${name}`
  let chain = chains.get(key)
  if (!chain) {
    chain = { tail: Promise.resolve() }
    chains.set(key, chain)
  }
  const previous = chain.tail
  let unlockChain!: () => void
  chain.tail = new Promise<void>((resolve) => (unlockChain = resolve))
  await previous.catch(() => {})
  let release: (() => void) | undefined
  try {
    release = await acquireFileLock(lockDir, name, opts)
    return await fn()
  } finally {
    release?.()
    unlockChain()
  }
}
