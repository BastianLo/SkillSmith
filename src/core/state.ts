/** Untracked runtime state: usage telemetry and per-session review state. */
import { join } from "node:path"
import type { Kind, SessionState, UsageEntry } from "../types"
import { key } from "../types"
import { ensureDir, listFiles, readJson, removePath, withLock, writeJsonAtomic } from "../util/fs"
import { nowIso, truncate } from "../util/text"

const HINT_CAP = 200

export function emptyUsage(): UsageEntry {
  return { loads: 0, hintsShown: 0, hintsFollowed: 0, reviewedLoads: 0, loadsWithIssues: 0 }
}

type UsageDelta = Partial<Record<keyof UsageEntry, number>> & { lastUsedAt?: string; lastIssue?: string; lastIssueAt?: string }

/** Who used an entry (metrics): the session decides origin, parent, agent. */
export interface UseContext {
  session?: string
  agent?: string
  origin?: "main" | "subagent" | "background" | "web"
  value?: number
  extra?: Record<string, unknown>
}

/** Receives every use with its context (metrics event log). */
export type UsageSink = (type: string, entry: string, uc: UseContext) => void

/** Usage counters keyed "kind:name"; buffered in memory and merged into state/usage.json under a lock. */
export class UsageStore {
  private file: string
  private pending = new Map<string, UsageDelta>()
  private timer?: ReturnType<typeof setTimeout>
  private cache?: { at: number; data: Record<string, UsageEntry> }
  /** metrics: every use with timestamp and session */
  sink?: UsageSink

  constructor(private stateDir: string, private locksDir: string) {
    this.file = join(stateDir, "usage.json")
  }

  private emit(type: string, kind: Kind, name: string, uc?: UseContext): void {
    if (!this.sink || !name) return
    try {
      this.sink(type, key(kind, name), uc ?? {})
    } catch {
      // metrics must never break usage tracking
    }
  }

  /** v1 stored plain skill names as keys */
  private static normalize(data: Record<string, UsageEntry>): Record<string, UsageEntry> {
    let legacy = false
    for (const k of Object.keys(data)) if (!k.includes(":")) legacy = true
    if (!legacy) return data
    const out: Record<string, UsageEntry> = {}
    for (const [k, v] of Object.entries(data)) out[k.includes(":") ? k : `skill:${k}`] = v
    return out
  }

  all(): Record<string, UsageEntry> {
    if (this.cache && Date.now() - this.cache.at < 2000) return this.merged(this.cache.data)
    const data = UsageStore.normalize(readJson<Record<string, UsageEntry>>(this.file, {}))
    this.cache = { at: Date.now(), data }
    return this.merged(data)
  }

  /** entries of one kind, keyed by plain name */
  ofKind(kind: Kind): Record<string, UsageEntry> {
    const out: Record<string, UsageEntry> = {}
    const prefix = `${kind}:`
    for (const [k, v] of Object.entries(this.all())) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v
    return out
  }

  get(kind: Kind, name: string): UsageEntry {
    return this.all()[key(kind, name)] ?? emptyUsage()
  }

  private merged(base: Record<string, UsageEntry>): Record<string, UsageEntry> {
    if (this.pending.size === 0) return base
    const out: Record<string, UsageEntry> = { ...base }
    for (const [k, delta] of this.pending) out[k] = applyDelta(out[k] ?? emptyUsage(), delta)
    return out
  }

  private add(kind: Kind, name: string, delta: Partial<Record<keyof UsageEntry, number>>, extra: { lastUsedAt?: string; lastIssue?: string; lastIssueAt?: string } = {}): void {
    if (!name) return
    const k = key(kind, name)
    const cur = this.pending.get(k) ?? {}
    for (const [f, v] of Object.entries(delta)) (cur as any)[f] = ((cur as any)[f] ?? 0) + (v as number)
    Object.assign(cur, extra)
    this.pending.set(k, cur)
    this.schedule()
  }

  recordLoad(kind: Kind, name: string, uc?: UseContext): void {
    this.add(kind, name, { loads: 1 }, { lastUsedAt: nowIso() })
    this.emit("entry.load", kind, name, uc)
  }

  recordHintShown(kind: Kind, name: string, uc?: UseContext): void {
    this.add(kind, name, { hintsShown: 1 })
    this.emit("entry.hint_shown", kind, name, uc)
  }

  recordHintFollowed(kind: Kind, name: string, uc?: UseContext): void {
    this.add(kind, name, { hintsFollowed: 1 })
    this.emit("entry.hint_followed", kind, name, uc)
  }

  /** errors: did the live hint help (next attempt succeeded) or not (same error again) */
  recordHintOutcome(kind: Kind, name: string, helped: boolean, uc?: UseContext): void {
    this.add(kind, name, helped ? { helped: 1 } : { failed: 1 }, helped ? { lastUsedAt: nowIso() } : {})
    this.emit(helped ? "entry.hint_helped" : "entry.hint_failed", kind, name, uc)
  }

  recordFeedback(kind: Kind, name: string, hadIssue: boolean, issue?: string, uc?: UseContext): void {
    this.add(
      kind,
      name,
      { reviewedLoads: 1, ...(hadIssue ? { loadsWithIssues: 1 } : {}) },
      hadIssue && issue ? { lastIssue: truncate(issue, 300), lastIssueAt: nowIso() } : {},
    )
    this.emit(hadIssue ? "entry.feedback_issue" : "entry.feedback_ok", kind, name, uc)
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, 500)
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.pending.size === 0) return
    const batch = this.pending
    this.pending = new Map()
    await withLock(this.locksDir, "usage", () => {
      ensureDir(this.stateDir)
      const data = UsageStore.normalize(readJson<Record<string, UsageEntry>>(this.file, {}))
      for (const [k, delta] of batch) data[k] = applyDelta(data[k] ?? emptyUsage(), delta)
      writeJsonAtomic(this.file, data)
      this.cache = { at: Date.now(), data }
    })
  }
}

export interface Occurrence {
  sigKey: string
  signature: string
  tool: string
  head: string
  sample: string
  count: number
  sessions: string[]
  projects: string[]
  firstSeen: string
  lastSeen: string
  /** error entry that matched (live hint) */
  entry?: string
}

/** Every observed tool error by signature (state/errors.json, untracked). */
export class OccurrenceStore {
  private file: string
  private pending = new Map<string, { o: Omit<Occurrence, "count" | "sessions" | "projects" | "firstSeen">; sessions: Set<string>; projects: Set<string>; count: number }>()
  private timer?: ReturnType<typeof setTimeout>
  private cache?: { at: number; data: Record<string, Occurrence> }
  /** metrics: every occurrence with timestamp (signature key only, never the output) */
  sink?: (sigKey: string, sessionID: string | undefined, entry: string | undefined, tool: string) => void

  constructor(private stateDir: string, private locksDir: string) {
    this.file = join(stateDir, "errors.json")
  }

  record(input: { sigKey: string; signature: string; tool: string; head: string; sample: string; sessionID?: string; project?: string; entry?: string }): void {
    try {
      this.sink?.(input.sigKey, input.sessionID, input.entry, input.tool)
    } catch {
      // ignore
    }
    const cur = this.pending.get(input.sigKey) ?? {
      o: { sigKey: input.sigKey, signature: input.signature, tool: input.tool, head: input.head, sample: input.sample, lastSeen: nowIso() },
      sessions: new Set<string>(),
      projects: new Set<string>(),
      count: 0,
    }
    cur.count++
    cur.o.lastSeen = nowIso()
    cur.o.sample = truncate(input.sample, 600)
    if (input.entry) cur.o.entry = input.entry
    if (input.sessionID) cur.sessions.add(input.sessionID)
    if (input.project) cur.projects.add(input.project)
    this.pending.set(input.sigKey, cur)
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        void this.flush()
      }, 500)
    }
  }

  all(): Record<string, Occurrence> {
    if (!this.cache || Date.now() - this.cache.at > 2000) this.cache = { at: Date.now(), data: readJson<Record<string, Occurrence>>(this.file, {}) }
    const out: Record<string, Occurrence> = { ...this.cache.data }
    for (const [k, p] of this.pending) out[k] = mergeOccurrence(out[k], p)
    return out
  }

  get(sigKey: string): Occurrence | undefined {
    return this.all()[sigKey]
  }

  sessionsFor(sigKey: string): number {
    return this.get(sigKey)?.sessions.length ?? 0
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.pending.size === 0) return
    const batch = this.pending
    this.pending = new Map()
    await withLock(this.locksDir, "errors", () => {
      ensureDir(this.stateDir)
      const data = readJson<Record<string, Occurrence>>(this.file, {})
      for (const [k, p] of batch) data[k] = mergeOccurrence(data[k], p)
      // cap: keep the 2000 most recent signatures
      const keys = Object.keys(data)
      if (keys.length > 2000) {
        for (const k of keys.sort((a, b) => data[a].lastSeen.localeCompare(data[b].lastSeen)).slice(0, keys.length - 2000)) delete data[k]
      }
      writeJsonAtomic(this.file, data)
      this.cache = { at: Date.now(), data }
    })
  }
}

function mergeOccurrence(
  base: Occurrence | undefined,
  p: { o: Omit<Occurrence, "count" | "sessions" | "projects" | "firstSeen">; sessions: Set<string>; projects: Set<string>; count: number },
): Occurrence {
  return {
    ...(base ?? { firstSeen: nowIso() }),
    ...p.o,
    entry: p.o.entry ?? base?.entry,
    firstSeen: base?.firstSeen ?? nowIso(),
    count: (base?.count ?? 0) + p.count,
    sessions: [...new Set([...(base?.sessions ?? []), ...p.sessions])].slice(-50),
    projects: [...new Set([...(base?.projects ?? []), ...p.projects])].slice(-20),
  } as Occurrence
}

export type ModelRef = { providerID: string; modelID: string }

export function rememberModel(stateDir: string, model: ModelRef): void {
  try {
    const file = join(stateDir, "model.json")
    const cur = readJson<ModelRef | null>(file, null)
    if (cur && cur.providerID === model.providerID && cur.modelID === model.modelID) return
    writeJsonAtomic(file, model)
  } catch {
    // ignore
  }
}

export function lastModel(stateDir: string): ModelRef | undefined {
  const m = readJson<ModelRef | null>(join(stateDir, "model.json"), null)
  return m && m.providerID && m.modelID ? m : undefined
}

function applyDelta(entry: UsageEntry, delta: Record<string, unknown>): UsageEntry {
  const out: UsageEntry = { ...emptyUsage(), ...entry }
  for (const [k, v] of Object.entries(delta)) {
    if (typeof v === "number") (out as any)[k] = ((out as any)[k] ?? 0) + v
    else if (v !== undefined) (out as any)[k] = v
  }
  return out
}

/** Per-session state files (state/sessions/<id>.json), cached in memory, written through. */
export class SessionStore {
  private dir: string
  private cache = new Map<string, SessionState>()
  private dirty = new Set<string>()
  private timer?: ReturnType<typeof setTimeout>

  constructor(stateDir: string) {
    this.dir = join(stateDir, "sessions")
    ensureDir(this.dir)
  }

  private file(id: string): string {
    return join(this.dir, `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`)
  }

  get(id: string, directory: string): SessionState {
    let s = this.cache.get(id)
    if (!s) {
      s = readJson<SessionState | null>(this.file(id), null) ?? {
        id,
        directory,
        userMsgsSinceReview: 0,
        lastActivityAt: nowIso(),
        reviewFailures: 0,
        hints: {},
        hinted: {},
        loaded: [],
      }
      s.hints ??= {}
      s.hinted ??= {}
      s.loaded ??= []
      this.cache.set(id, s)
    }
    return s
  }

  peek(id: string): SessionState | undefined {
    return this.cache.get(id) ?? readJson<SessionState | null>(this.file(id), null) ?? undefined
  }

  update(id: string, directory: string, fn: (s: SessionState) => void): SessionState {
    const s = this.get(id, directory)
    fn(s)
    const hintKeys = Object.keys(s.hints)
    if (hintKeys.length > HINT_CAP) for (const k of hintKeys.slice(0, hintKeys.length - HINT_CAP)) delete s.hints[k]
    const hintedKeys = Object.keys(s.hinted)
    if (hintedKeys.length > HINT_CAP) for (const k of hintedKeys.slice(0, hintedKeys.length - HINT_CAP)) delete s.hinted[k]
    if (s.loaded.length > 100) s.loaded = s.loaded.slice(-100)
    this.dirty.add(id)
    this.schedule()
    return s
  }

  /** Re-read from disk (another process may have reviewed the session). */
  reload(id: string): SessionState | undefined {
    this.flushOne(id)
    const s = readJson<SessionState | null>(this.file(id), null)
    if (s) {
      s.hints ??= {}
      s.hinted ??= {}
      s.loaded ??= []
      this.cache.set(id, s)
    }
    return s ?? undefined
  }

  all(): SessionState[] {
    this.flush()
    return listFiles(this.dir, ".json")
      .map((f) => readJson<SessionState | null>(join(this.dir, f), null))
      .filter((s): s is SessionState => !!s && !!s.id)
  }

  remove(id: string): void {
    this.cache.delete(id)
    this.dirty.delete(id)
    removePath(this.file(id))
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, 300)
  }

  private flushOne(id: string): void {
    if (!this.dirty.has(id)) return
    const s = this.cache.get(id)
    this.dirty.delete(id)
    if (s) writeJsonAtomic(this.file(id), s)
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    for (const id of [...this.dirty]) this.flushOne(id)
  }

  /** Drop session files untouched for `days` (housekeeping). */
  prune(days: number): number {
    let removed = 0
    for (const s of this.all()) {
      if (Date.now() - Date.parse(s.lastActivityAt) > days * 86_400_000) {
        this.remove(s.id)
        removed++
      }
    }
    return removed
  }
}
