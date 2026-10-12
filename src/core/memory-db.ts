/**
 * Local memory database (state/memory.sqlite, never versioned):
 *  - volatile memories: work states (one per project + branch) and results
 *    (condensed subagent/research results),
 *  - raw captures of finished subagents for the next review,
 *  - relations that involve a volatile node,
 *  - the doctor's bookkeeping: queue, open conflicts, judged pairs.
 * Durable memories (decisions, conventions, experiences) are store entries
 * (kind "memory") and their relations live in their meta files (git).
 * Several opencode processes share the file (WAL, busy timeout).
 */
import { join } from "node:path"
import type { Logger } from "../log"
import type { Relation, RelationType } from "../types"
import { ensureDir } from "../util/fs"
import { errorMessage, sha, shortId, slugify } from "../util/text"
import { loadDatabaseClass, type SqlDatabase } from "./vector-store"

export const MEMORY_DB_FILE = "memory.sqlite"

export interface WorkState {
  id: string
  project: string
  projectName: string
  branch: string
  ticket?: string
  goal: string
  done: string[]
  open: string[]
  next: string[]
  files: string[]
  summary: string
  status: "gueltig" | "abgelaufen"
  evidence?: string
  session?: string
  run?: string
  createdAt: number
  updatedAt: number
  history: Array<{ at: number; summary: string; done: string[]; open: string[]; next: string[] }>
}

export interface ResultMemory {
  id: string
  project: string
  projectName: string
  branch?: string
  session?: string
  title: string
  question: string
  answer: string
  files: string[]
  sources: string[]
  tags: string[]
  status: "gueltig" | "abgelaufen"
  used: number
  evidence?: string
  run?: string
  createdAt: number
  updatedAt: number
}

export interface Capture {
  id: string
  session: string
  project?: string
  prompt: string
  output: string
  at: number
}

export type ConflictStatus = "open" | "needs_user" | "resolved"

export interface Conflict {
  id: string
  a: string
  b: string
  suspicion: string
  similarity: number
  status: ConflictStatus
  note?: string
  resolution?: string
  aHash?: string
  bHash?: string
  detectedAt: number
  resolvedAt?: number
  attempts: number
}

export interface EdgeRow extends Relation {
  from: string
}

const arr = (v: unknown): string[] => {
  if (typeof v !== "string" || !v) return []
  try {
    const p = JSON.parse(v)
    return Array.isArray(p) ? p.map(String) : []
  } catch {
    return []
  }
}

/** Stable node id of a work state: one per project and branch. */
export function stateId(project: string, branch: string): string {
  return `state:${sha(project, 6)}-${slugify(branch || "main", 40) || "main"}`
}

export function pairKey(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a]
}

export class MemoryDb {
  readonly file: string
  private db?: SqlDatabase
  available = false

  constructor(
    stateDir: string,
    log: Logger,
    Database?: new (path: string, opts?: Record<string, unknown>) => SqlDatabase,
  ) {
    ensureDir(stateDir)
    this.file = join(stateDir, MEMORY_DB_FILE)
    let Db = Database
    try {
      Db ??= loadDatabaseClass()
    } catch (err) {
      log.warn("memory database unavailable (no SQLite) – work states, results and the doctor queue are off", errorMessage(err))
      return
    }
    try {
      this.db = this.open(Db, this.file)
    } catch (err) {
      log.warn(`memory database ${this.file} unusable – using a temporary in-memory database`, errorMessage(err))
      try {
        this.db = this.open(Db, ":memory:")
      } catch {
        return
      }
    }
    this.available = true
  }

  private open(Db: new (path: string, opts?: Record<string, unknown>) => SqlDatabase, file: string): SqlDatabase {
    const db = new Db(file, { create: true })
    db.exec("PRAGMA busy_timeout = 10000")
    try {
      db.exec("PRAGMA journal_mode = WAL")
    } catch {
      // rollback journal is fine too
    }
    db.exec("PRAGMA synchronous = NORMAL")
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS states (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, project_name TEXT, branch TEXT, ticket TEXT,
        goal TEXT, done TEXT, open TEXT, next TEXT, files TEXT, summary TEXT, status TEXT NOT NULL,
        evidence TEXT, session TEXT, run TEXT, created_at INTEGER, updated_at INTEGER, history TEXT
      );
      CREATE TABLE IF NOT EXISTS results (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, project_name TEXT, branch TEXT, session TEXT,
        title TEXT, question TEXT, answer TEXT, files TEXT, sources TEXT, tags TEXT, status TEXT NOT NULL,
        used INTEGER DEFAULT 0, evidence TEXT, run TEXT, created_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS captures (
        id TEXT PRIMARY KEY, session TEXT NOT NULL, project TEXT, prompt TEXT, output TEXT, at INTEGER, consumed INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS relations (
        from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, strength REAL, description TEXT,
        source TEXT, at TEXT, run TEXT, PRIMARY KEY (from_id, to_id, type)
      );
      CREATE TABLE IF NOT EXISTS conflicts (
        id TEXT PRIMARY KEY, a TEXT NOT NULL, b TEXT NOT NULL, suspicion TEXT, similarity REAL, status TEXT NOT NULL,
        note TEXT, resolution TEXT, a_hash TEXT, b_hash TEXT, detected_at INTEGER, resolved_at INTEGER, attempts INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS conflicts_pair ON conflicts (a, b);
      CREATE TABLE IF NOT EXISTS checked (
        a TEXT NOT NULL, b TEXT NOT NULL, a_hash TEXT, b_hash TEXT, verdict TEXT, at INTEGER, PRIMARY KEY (a, b)
      );
      CREATE TABLE IF NOT EXISTS doctor_queue (id TEXT PRIMARY KEY, hash TEXT, at INTEGER);
    `)
    return db
  }

  private q(sql: string) {
    return this.db!.query(sql)
  }

  close(): void {
    try {
      this.db?.close()
    } catch {
      // ignore
    }
    this.available = false
  }

  // ---------------------------------------------------------------------------
  // work states
  // ---------------------------------------------------------------------------

  private toState(r: any): WorkState {
    return {
      id: r.id,
      project: r.project,
      projectName: r.project_name ?? "",
      branch: r.branch ?? "",
      ticket: r.ticket || undefined,
      goal: r.goal ?? "",
      done: arr(r.done),
      open: arr(r.open),
      next: arr(r.next),
      files: arr(r.files),
      summary: r.summary ?? "",
      status: r.status === "abgelaufen" ? "abgelaufen" : "gueltig",
      evidence: r.evidence || undefined,
      session: r.session || undefined,
      run: r.run || undefined,
      createdAt: r.created_at ?? 0,
      updatedAt: r.updated_at ?? 0,
      history: (() => {
        try {
          return JSON.parse(r.history || "[]")
        } catch {
          return []
        }
      })(),
    }
  }

  /** Insert or replace the work state of a project + branch; the previous version goes into its history. */
  upsertState(input: Omit<WorkState, "id" | "status" | "createdAt" | "updatedAt" | "history">, now = Date.now()): { state: WorkState; created: boolean } {
    if (!this.db) throw new Error("memory database unavailable")
    const id = stateId(input.project, input.branch)
    const prev = this.q("SELECT * FROM states WHERE id = ?").get(id)
    const old = prev ? this.toState(prev) : undefined
    const history = old ? [{ at: old.updatedAt, summary: old.summary, done: old.done, open: old.open, next: old.next }, ...old.history].slice(0, 10) : []
    this.q(
      `INSERT INTO states (id, project, project_name, branch, ticket, goal, done, open, next, files, summary, status, evidence, session, run, created_at, updated_at, history)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'gueltig', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET project_name = excluded.project_name, ticket = excluded.ticket, goal = excluded.goal, done = excluded.done,
         open = excluded.open, next = excluded.next, files = excluded.files, summary = excluded.summary, status = 'gueltig',
         evidence = excluded.evidence, session = excluded.session, run = excluded.run, updated_at = excluded.updated_at, history = excluded.history`,
    ).run(
      id,
      input.project,
      input.projectName,
      input.branch,
      input.ticket ?? null,
      input.goal,
      JSON.stringify(input.done),
      JSON.stringify(input.open),
      JSON.stringify(input.next),
      JSON.stringify(input.files),
      input.summary,
      input.evidence ?? null,
      input.session ?? null,
      input.run ?? null,
      old?.createdAt ?? now,
      now,
      JSON.stringify(history),
    )
    return { state: this.toState(this.q("SELECT * FROM states WHERE id = ?").get(id)), created: !old }
  }

  getState(id: string): WorkState | undefined {
    if (!this.db) return undefined
    const r = this.q("SELECT * FROM states WHERE id = ?").get(id)
    return r ? this.toState(r) : undefined
  }

  /** Current (valid) work state of a project + branch. */
  state(project: string, branch: string): WorkState | undefined {
    const s = this.getState(stateId(project, branch))
    return s && s.status === "gueltig" ? s : undefined
  }

  states(project?: string): WorkState[] {
    if (!this.db) return []
    const rows = project ? this.q("SELECT * FROM states WHERE project = ? ORDER BY updated_at DESC").all(project) : this.q("SELECT * FROM states ORDER BY updated_at DESC").all()
    return rows.map((r) => this.toState(r))
  }

  setStateStatus(id: string, status: WorkState["status"]): void {
    this.db && this.q("UPDATE states SET status = ? WHERE id = ?").run(status, id)
  }

  // ---------------------------------------------------------------------------
  // results
  // ---------------------------------------------------------------------------

  private toResult(r: any): ResultMemory {
    return {
      id: r.id,
      project: r.project,
      projectName: r.project_name ?? "",
      branch: r.branch || undefined,
      session: r.session || undefined,
      title: r.title ?? "",
      question: r.question ?? "",
      answer: r.answer ?? "",
      files: arr(r.files),
      sources: arr(r.sources),
      tags: arr(r.tags),
      status: r.status === "abgelaufen" ? "abgelaufen" : "gueltig",
      used: r.used ?? 0,
      evidence: r.evidence || undefined,
      run: r.run || undefined,
      createdAt: r.created_at ?? 0,
      updatedAt: r.updated_at ?? 0,
    }
  }

  addResult(input: Omit<ResultMemory, "id" | "status" | "used" | "createdAt" | "updatedAt">, now = Date.now()): ResultMemory {
    if (!this.db) throw new Error("memory database unavailable")
    const id = `result:${new Date(now).toISOString().slice(0, 10).replace(/-/g, "")}-${shortId(6)}`
    this.q(
      `INSERT INTO results (id, project, project_name, branch, session, title, question, answer, files, sources, tags, status, used, evidence, run, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'gueltig', 0, ?, ?, ?, ?)`,
    ).run(
      id,
      input.project,
      input.projectName,
      input.branch ?? null,
      input.session ?? null,
      input.title,
      input.question,
      input.answer,
      JSON.stringify(input.files),
      JSON.stringify(input.sources),
      JSON.stringify(input.tags),
      input.evidence ?? null,
      input.run ?? null,
      now,
      now,
    )
    return this.getResult(id)!
  }

  getResult(id: string): ResultMemory | undefined {
    if (!this.db) return undefined
    const r = this.q("SELECT * FROM results WHERE id = ?").get(id)
    return r ? this.toResult(r) : undefined
  }

  results(project?: string): ResultMemory[] {
    if (!this.db) return []
    const rows = project ? this.q("SELECT * FROM results WHERE project = ? ORDER BY created_at DESC").all(project) : this.q("SELECT * FROM results ORDER BY created_at DESC").all()
    return rows.map((r) => this.toResult(r))
  }

  markResultUsed(id: string): void {
    this.db && this.q("UPDATE results SET used = used + 1, updated_at = ? WHERE id = ?").run(Date.now(), id)
  }

  deleteResult(id: string): void {
    if (!this.db) return
    this.q("DELETE FROM results WHERE id = ?").run(id)
    this.deleteRelationsOf(id)
  }

  // ---------------------------------------------------------------------------
  // captures (raw subagent results for the next review)
  // ---------------------------------------------------------------------------

  capture(session: string, project: string | undefined, prompt: string, output: string, now = Date.now()): void {
    if (!this.db) return
    this.q("INSERT INTO captures (id, session, project, prompt, output, at, consumed) VALUES (?, ?, ?, ?, ?, ?, 0)").run(`cap-${shortId(10)}`, session, project ?? null, prompt, output, now)
  }

  captures(session: string): Capture[] {
    if (!this.db) return []
    return this.q("SELECT * FROM captures WHERE session = ? AND consumed = 0 ORDER BY at").all(session).map((r) => ({ id: r.id, session: r.session, project: r.project || undefined, prompt: r.prompt ?? "", output: r.output ?? "", at: r.at }))
  }

  consumeCaptures(ids: string[]): void {
    if (!this.db) return
    for (const id of ids) this.q("UPDATE captures SET consumed = 1 WHERE id = ?").run(id)
  }

  // ---------------------------------------------------------------------------
  // relations with a volatile end
  // ---------------------------------------------------------------------------

  addRelation(from: string, r: Relation): void {
    if (!this.db) throw new Error("memory database unavailable")
    this.q(
      `INSERT INTO relations (from_id, to_id, type, strength, description, source, at, run) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(from_id, to_id, type) DO UPDATE SET strength = excluded.strength, description = excluded.description, source = excluded.source, at = excluded.at, run = excluded.run`,
    ).run(from, r.to, r.type, r.strength, r.description, r.source, r.at, r.runId ?? null)
  }

  private toEdge(r: any): EdgeRow {
    return { from: r.from_id, to: r.to_id, type: r.type as RelationType, strength: r.strength ?? 0, description: r.description ?? "", source: r.source ?? "doctor", at: r.at ?? "", runId: r.run || undefined }
  }

  relationsOf(id: string): EdgeRow[] {
    if (!this.db) return []
    return this.q("SELECT * FROM relations WHERE from_id = ? OR to_id = ?").all(id, id).map((r) => this.toEdge(r))
  }

  allRelations(): EdgeRow[] {
    if (!this.db) return []
    return this.q("SELECT * FROM relations").all().map((r) => this.toEdge(r))
  }

  /** Remove every stored relation between two nodes (both directions). */
  deleteRelationBetween(a: string, b: string): void {
    this.db && this.q("DELETE FROM relations WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)").run(a, b, b, a)
  }

  deleteRelationsOf(id: string): void {
    this.db && this.q("DELETE FROM relations WHERE from_id = ? OR to_id = ?").run(id, id)
  }

  // ---------------------------------------------------------------------------
  // doctor bookkeeping
  // ---------------------------------------------------------------------------

  enqueue(id: string, hash: string, now = Date.now()): void {
    this.db && this.q("INSERT INTO doctor_queue (id, hash, at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET hash = excluded.hash, at = excluded.at").run(id, hash, now)
  }

  queued(limit: number): Array<{ id: string; hash: string }> {
    if (!this.db) return []
    return this.q("SELECT id, hash FROM doctor_queue ORDER BY at LIMIT ?").all(limit).map((r) => ({ id: r.id, hash: r.hash }))
  }

  dequeue(id: string): void {
    this.db && this.q("DELETE FROM doctor_queue WHERE id = ?").run(id)
  }

  queueSize(): number {
    return this.db ? Number(this.q("SELECT count(*) AS n FROM doctor_queue").get()?.n ?? 0) : 0
  }

  metaValue(key: string): string | undefined {
    return this.db ? (this.q("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? undefined) : undefined
  }

  setMeta(key: string, value: string): void {
    this.db && this.q("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value)
  }

  isChecked(a: string, b: string, aHash: string, bHash: string): boolean {
    if (!this.db) return false
    const [x, y] = pairKey(a, b)
    const [hx, hy] = x === a ? [aHash, bHash] : [bHash, aHash]
    const r = this.q("SELECT a_hash, b_hash FROM checked WHERE a = ? AND b = ?").get(x, y)
    return !!r && r.a_hash === hx && r.b_hash === hy
  }

  markChecked(a: string, b: string, aHash: string, bHash: string, verdict: string, now = Date.now()): void {
    if (!this.db) return
    const [x, y] = pairKey(a, b)
    const [hx, hy] = x === a ? [aHash, bHash] : [bHash, aHash]
    this.q(
      "INSERT INTO checked (a, b, a_hash, b_hash, verdict, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(a, b) DO UPDATE SET a_hash = excluded.a_hash, b_hash = excluded.b_hash, verdict = excluded.verdict, at = excluded.at",
    ).run(x, y, hx, hy, verdict, now)
  }

  private toConflict(r: any): Conflict {
    return {
      id: r.id,
      a: r.a,
      b: r.b,
      suspicion: r.suspicion ?? "",
      similarity: r.similarity ?? 0,
      status: r.status as ConflictStatus,
      note: r.note || undefined,
      resolution: r.resolution || undefined,
      aHash: r.a_hash || undefined,
      bHash: r.b_hash || undefined,
      detectedAt: r.detected_at ?? 0,
      resolvedAt: r.resolved_at || undefined,
      attempts: r.attempts ?? 0,
    }
  }

  /** id of the last openConflict call when it created a new conflict (audit) */
  lastConflictCreated?: string

  /** Open a conflict for a pair (no-op when an unresolved one exists). Returns its id. */
  openConflict(a: string, b: string, suspicion: string, similarity: number, aHash: string, bHash: string, now = Date.now()): string | undefined {
    this.lastConflictCreated = undefined
    if (!this.db) return undefined
    const [x, y] = pairKey(a, b)
    const [hx, hy] = x === a ? [aHash, bHash] : [bHash, aHash]
    const existing = this.q("SELECT * FROM conflicts WHERE a = ? AND b = ? AND status != 'resolved'").get(x, y)
    if (existing) {
      this.q("UPDATE conflicts SET a_hash = ?, b_hash = ?, similarity = ?, suspicion = ? WHERE id = ?").run(hx, hy, similarity, suspicion, existing.id)
      return existing.id
    }
    const n = Number(this.q("SELECT count(*) AS n FROM conflicts").get()?.n ?? 0) + 1
    const id = `k${n}`
    this.q("INSERT INTO conflicts (id, a, b, suspicion, similarity, status, a_hash, b_hash, detected_at, attempts) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, 0)").run(
      id,
      x,
      y,
      suspicion,
      similarity,
      hx,
      hy,
      now,
    )
    this.lastConflictCreated = id
    return id
  }

  conflict(id: string): Conflict | undefined {
    if (!this.db) return undefined
    const r = this.q("SELECT * FROM conflicts WHERE id = ?").get(id)
    return r ? this.toConflict(r) : undefined
  }

  conflicts(status?: ConflictStatus | ConflictStatus[]): Conflict[] {
    if (!this.db) return []
    const list = status === undefined ? undefined : Array.isArray(status) ? status : [status]
    const rows = this.q("SELECT * FROM conflicts ORDER BY detected_at").all()
    return rows.map((r) => this.toConflict(r)).filter((c) => !list || list.includes(c.status))
  }

  updateConflict(id: string, patch: { status?: ConflictStatus; note?: string; resolution?: string; attempts?: number }, now = Date.now()): void {
    if (!this.db) return
    const cur = this.conflict(id)
    if (!cur) return
    const next = { ...cur, ...patch }
    this.q("UPDATE conflicts SET status = ?, note = ?, resolution = ?, attempts = ?, resolved_at = ? WHERE id = ?").run(
      next.status,
      next.note ?? null,
      next.resolution ?? null,
      next.attempts,
      next.status === "resolved" ? now : null,
      id,
    )
  }
}
