/**
 * Audit log (state/audit.sqlite, append only, never versioned): every event that
 * changed something or tried to – by the user (web, command), the background agents,
 * the curator, the doctor or the system. Each row answers who, when, what, why and
 * with which result, and points to run, commit, session and (local data) the full
 * before/after. Rows are chained: hash = sha256(previous hash + content), so a row
 * changed or deleted afterwards breaks the chain (verify()).
 * Several opencode processes append through the same file (WAL, IMMEDIATE transactions).
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { userInfo } from "node:os"
import { join } from "node:path"
import type { Options } from "../config"
import type { Logger } from "../log"
import type { Run } from "../types"
import { errorMessage, nowIso, oneLine, truncate } from "../util/text"
import { immediate, openStateDb, type DatabaseClass } from "./sqlite"
import type { SqlDatabase } from "./vector-store"

export type AuditActor = "user-web" | "user-command" | "reviewer" | "curator" | "doctor" | "system" | "agent" | "pipeline"
export type AuditCategory =
  | "change"
  | "staged"
  | "proposed"
  | "rejected"
  | "local"
  | "run"
  | "undo"
  | "restore"
  | "conflict"
  | "external"
  | "security"
  | "task"
  | "pipeline"
  | "agent"
export type AuditResult = "ok" | "rejected" | "staged" | "proposed" | "error"

export interface AuditInput {
  at?: string
  actor: AuditActor
  agent?: string
  model?: string
  session?: string
  directory?: string
  smith?: string
  category: AuditCategory
  action: string
  targets?: string[]
  reason?: string
  result: AuditResult
  message?: string
  run?: string
  commit?: string
  beforeHash?: string
  afterHash?: string
  /** local data: complete state before / after (JSON) */
  before?: unknown
  after?: unknown
  project?: string
}

export interface AuditEvent extends Required<Pick<AuditInput, "actor" | "category" | "action" | "result">> {
  seq: number
  at: string
  osUser: string
  agent?: string
  model?: string
  session?: string
  directory?: string
  smith?: string
  targets: string[]
  reason?: string
  message?: string
  run?: string
  commit?: string
  beforeHash?: string
  afterHash?: string
  before?: unknown
  after?: unknown
  project?: string
  hash?: string
  prev?: string
}

export interface AuditFilter {
  from?: string
  to?: string
  actor?: string[]
  smith?: string[]
  category?: string[]
  action?: string
  result?: string[]
  project?: string
  session?: string
  target?: string
  run?: string
  text?: string
  /** pagination: events with seq below this */
  before?: number
  limit?: number
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, agent TEXT, model TEXT, session TEXT,
    directory TEXT, os_user TEXT, smith TEXT, category TEXT NOT NULL, action TEXT NOT NULL, targets TEXT, reason TEXT,
    result TEXT NOT NULL, message TEXT, run TEXT, commit_hash TEXT, before_hash TEXT, after_hash TEXT,
    before_json TEXT, after_json TEXT, project TEXT, hash TEXT, prev TEXT
  );
  CREATE INDEX IF NOT EXISTS events_at ON events (at);
  CREATE INDEX IF NOT EXISTS events_run ON events (run);
  CREATE TABLE IF NOT EXISTS event_targets (seq INTEGER NOT NULL, target TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS event_targets_t ON event_targets (target, seq);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

const COLUMNS = [
  "at",
  "actor",
  "agent",
  "model",
  "session",
  "directory",
  "os_user",
  "smith",
  "category",
  "action",
  "targets",
  "reason",
  "result",
  "message",
  "run",
  "commit_hash",
  "before_hash",
  "after_hash",
  "before_json",
  "after_json",
  "project",
] as const

function osUser(): string {
  try {
    return userInfo().username
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? ""
  }
}

/**
 * Target id of a journal action. New actions carry `target` + `name`; actions written by
 * skillsmith 2.x carried only `skill` (and were always skills). Without this mapping the
 * import produced the literal id "undefined:undefined" and every reader crashed on it.
 */
function actionTarget(a: { local?: boolean; target?: string; name?: string; skill?: string }): string | undefined {
  if (a.local) return a.name
  const name = a.name ?? a.skill
  if (!name) return undefined
  return `${a.target ?? "skill"}:${name}`
}

/** Journal actions that share run + action + reason resolve to exactly one target. */
function actionKey(run: string | undefined, action: string, reason: string | undefined): string {
  return `${run ?? ""}\u001f${action}\u001f${reason ? truncate(oneLine(reason), 1000) : ""}`
}

const json = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v))
const parse = (v: unknown): unknown => {
  if (typeof v !== "string" || !v) return undefined
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}

/** Content hashed into the chain: every column except seq/hash/prev, in a fixed order. */
function chainContent(row: Record<string, unknown>): string {
  return COLUMNS.map((c) => `${c}=${row[c] ?? ""}`).join("\u001f")
}

export function chainHash(prev: string, row: Record<string, unknown>): string {
  return createHash("sha256").update(prev).update("\u001e").update(chainContent(row)).digest("hex")
}

/** Map a run's actor to the audit actor (web actions are runs with actor "web"). */
export function auditActor(run: Pick<Run, "actor" | "smith" | "trigger">): AuditActor {
  if (/^agent-task\b/.test(run.trigger)) return "agent"
  if (run.actor === "web") return "user-web"
  if (run.actor === "command") return /^(startup|lifecycle|migrate)/.test(run.trigger) ? "system" : "user-command"
  if (run.actor === "curator") return run.smith === "doctor" ? "doctor" : "curator"
  return "reviewer"
}

export class AuditLog {
  private db?: SqlDatabase
  private user = osUser()
  private securityThrottle = new Map<string, number>()
  readonly file: string

  constructor(
    private stateDir: string,
    private options: Options,
    private log: Logger,
    Database?: DatabaseClass,
  ) {
    this.file = join(stateDir, "audit.sqlite")
    this.db = openStateDb(stateDir, "audit.sqlite", SCHEMA, log, Database)
  }

  get available(): boolean {
    return !!this.db
  }

  close(): void {
    try {
      this.db?.close()
    } catch {
      // ignore
    }
    this.db = undefined
  }

  private row(e: AuditInput): Record<string, unknown> {
    return {
      at: e.at ?? nowIso(),
      actor: e.actor,
      agent: e.agent ?? null,
      model: e.model ?? null,
      session: e.session ?? null,
      directory: e.directory ?? null,
      os_user: this.user,
      smith: e.smith ?? null,
      category: e.category,
      action: e.action,
      targets: e.targets?.length ? JSON.stringify(e.targets) : null,
      reason: e.reason ? truncate(oneLine(e.reason), 1000) : null,
      result: e.result,
      message: e.message ? truncate(e.message, 4000) : null,
      run: e.run ?? null,
      commit_hash: e.commit ?? null,
      before_hash: e.beforeHash ?? null,
      after_hash: e.afterHash ?? null,
      before_json: json(e.before),
      after_json: json(e.after),
      project: e.project ?? null,
    }
  }

  /** Append events (one transaction). Never throws – the audit log must not break a run. */
  append(...events: AuditInput[]): number[] {
    const db = this.db
    if (!db || !events.length) return []
    try {
      return immediate(db, () => {
        let prev = (db.query("SELECT hash FROM events ORDER BY seq DESC LIMIT 1").get()?.hash as string | undefined) ?? ""
        const seqs: number[] = []
        const insert = db.query(`INSERT INTO events (${COLUMNS.join(", ")}, hash, prev) VALUES (${COLUMNS.map(() => "?").join(", ")}, ?, ?)`)
        const lastId = db.query("SELECT last_insert_rowid() AS seq")
        const target = db.query("INSERT INTO event_targets (seq, target) VALUES (?, ?)")
        for (const e of events) {
          const row = this.row(e)
          const hash = this.options.audit.hashChain ? chainHash(prev, row) : null
          insert.run(...COLUMNS.map((c) => row[c] as any), hash, this.options.audit.hashChain ? prev : null)
          const seq = Number(lastId.get()?.seq)
          seqs.push(seq)
          for (const t of e.targets ?? []) target.run(seq, t)
          if (hash) prev = hash
        }
        return seqs
      })
    } catch (err) {
      this.log.warn("audit append failed", errorMessage(err))
      return []
    }
  }

  /** Security event, throttled per cause (web.securityLogPerMinute). */
  security(cause: string, message: string, extra: Partial<AuditInput> = {}): void {
    const perMinute = this.options.web.securityLogPerMinute
    if (perMinute <= 0) return
    const now = Date.now()
    const key = cause
    const last = this.securityThrottle.get(key) ?? 0
    if (now - last < 60_000 / perMinute) return
    this.securityThrottle.set(key, now)
    this.append({ actor: "system", category: "security", action: cause, result: "rejected", message, ...extra })
  }

  private toEvent(r: any): AuditEvent {
    return {
      seq: Number(r.seq),
      at: r.at,
      actor: r.actor,
      agent: r.agent ?? undefined,
      model: r.model ?? undefined,
      session: r.session ?? undefined,
      directory: r.directory ?? undefined,
      osUser: r.os_user ?? "",
      smith: r.smith ?? undefined,
      category: r.category,
      action: r.action,
      targets: (parse(r.targets) as string[] | undefined) ?? [],
      reason: r.reason ?? undefined,
      result: r.result,
      message: r.message ?? undefined,
      run: r.run ?? undefined,
      commit: r.commit_hash ?? undefined,
      beforeHash: r.before_hash ?? undefined,
      afterHash: r.after_hash ?? undefined,
      before: parse(r.before_json),
      after: parse(r.after_json),
      project: r.project ?? undefined,
      hash: r.hash ?? undefined,
      prev: r.prev ?? undefined,
    }
  }

  query(f: AuditFilter = {}): { events: AuditEvent[]; more: boolean } {
    const db = this.db
    if (!db) return { events: [], more: false }
    const where: string[] = []
    const params: unknown[] = []
    const inList = (col: string, values?: string[]) => {
      if (!values?.length) return
      where.push(`${col} IN (${values.map(() => "?").join(", ")})`)
      params.push(...values)
    }
    if (f.from) {
      where.push("at >= ?")
      params.push(f.from)
    }
    if (f.to) {
      where.push("at <= ?")
      params.push(f.to.length <= 10 ? `${f.to}T23:59:59.999Z` : f.to)
    }
    inList("actor", f.actor)
    inList("smith", f.smith)
    inList("category", f.category)
    inList("result", f.result)
    if (f.action) {
      where.push("action LIKE ?")
      params.push(`%${f.action}%`)
    }
    if (f.project) {
      where.push("project = ?")
      params.push(f.project)
    }
    if (f.session) {
      where.push("session = ?")
      params.push(f.session)
    }
    if (f.run) {
      where.push("run = ?")
      params.push(f.run)
    }
    if (f.target) {
      where.push("seq IN (SELECT seq FROM event_targets WHERE target = ?)")
      params.push(f.target)
    }
    if (f.text) {
      where.push("(reason LIKE ? OR message LIKE ? OR action LIKE ? OR targets LIKE ?)")
      const t = `%${f.text}%`
      params.push(t, t, t, t)
    }
    if (f.before) {
      where.push("seq < ?")
      params.push(f.before)
    }
    const limit = Math.min(5000, Math.max(1, f.limit ?? 200))
    const rows = db.query(`SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT ?`).all(...(params as any[]), limit + 1)
    return { events: rows.slice(0, limit).map((r) => this.toEvent(r)), more: rows.length > limit }
  }

  /** Every event of one entry (also rejected attempts). */
  forTarget(id: string, limit = 300): AuditEvent[] {
    return this.query({ target: id, limit }).events
  }

  count(): number {
    return Number(this.db?.query("SELECT count(*) AS n FROM events").get()?.n ?? 0)
  }

  /** Recompute the hash chain; reports the first row that does not fit. */
  verify(): { ok: boolean; count: number; firstBad?: number; reason?: string } {
    const db = this.db
    if (!db) return { ok: true, count: 0 }
    let prev = ""
    let count = 0
    let started = false
    for (const r of db.query("SELECT * FROM events ORDER BY seq").all() as any[]) {
      count++
      if (!r.hash) {
        // events written while the chain was switched off
        started = false
        continue
      }
      if (!started) {
        // first chained row (or after a pause): only its own hash must fit its prev
        prev = r.prev ?? ""
        started = true
      }
      if ((r.prev ?? "") !== prev) return { ok: false, count, firstBad: Number(r.seq), reason: "Verkettung unterbrochen (Zeile fehlt oder wurde eingefügt)" }
      const row: Record<string, unknown> = {}
      for (const c of COLUMNS) row[c] = r[c]
      if (chainHash(prev, row) !== r.hash) return { ok: false, count, firstBad: Number(r.seq), reason: "Inhalt nachträglich geändert" }
      prev = r.hash
    }
    return { ok: true, count }
  }

  /** Rejected agent actions grouped by reason (where prompts or gates need work). */
  rejectedByReason(days = 30): Array<{ reason: string; count: number; smiths: string[]; last: string; example: string }> {
    const db = this.db
    if (!db) return []
    const from = new Date(Date.now() - days * 86_400_000).toISOString()
    const groups = new Map<string, { count: number; smiths: Set<string>; last: string; example: string }>()
    for (const r of db.query("SELECT smith, message, at FROM events WHERE result = 'rejected' AND category = 'rejected' AND at >= ?").all(from) as any[]) {
      const msg = String(r.message ?? "")
      const reason = gateOf(msg)
      const g = groups.get(reason) ?? { count: 0, smiths: new Set<string>(), last: "", example: msg }
      g.count++
      if (r.smith) g.smiths.add(r.smith)
      if (r.at > g.last) {
        g.last = r.at
        g.example = msg
      }
      groups.set(reason, g)
    }
    return [...groups.entries()]
      .map(([reason, g]) => ({ reason, count: g.count, smiths: [...g.smiths].sort(), last: g.last, example: truncate(g.example, 300) }))
      .sort((a, b) => b.count - a.count)
  }

  /** Delete events older than audit.days (0 = keep forever). The chain restarts at the oldest kept row. */
  prune(): number {
    const days = this.options.audit.days
    if (!this.db || days <= 0) return 0
    const cut = new Date(Date.now() - days * 86_400_000).toISOString()
    const n = Number(this.db.query("SELECT count(*) AS n FROM events WHERE at < ?").get(cut)?.n ?? 0)
    if (!n) return 0
    immediate(this.db, () => {
      this.db!.query("DELETE FROM event_targets WHERE seq IN (SELECT seq FROM events WHERE at < ?)").run(cut)
      this.db!.query("DELETE FROM events WHERE at < ?").run(cut)
      this.db!.query("INSERT INTO meta (key, value) VALUES ('pruned_before', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(cut)
    })
    return n
  }

  metaValue(key: string): string | undefined {
    return (this.db?.query("SELECT value FROM meta WHERE key = ?").get(key)?.value as string | undefined) ?? undefined
  }

  setMeta(key: string, value: string): void {
    this.db?.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value)
  }

  /**
   * First start: import state/journal.jsonl (one run event + one event per action).
   * The journal stays as raw format.
   */
  importJournal(): number {
    if (!this.db || this.metaValue("journal_imported")) return 0
    let lines: string[] = []
    try {
      lines = readFileSync(join(this.stateDir, "journal.jsonl"), "utf8").split("\n").filter(Boolean)
    } catch {
      lines = []
    }
    const events: AuditInput[] = []
    for (const l of lines) {
      try {
        const j = JSON.parse(l)
        const run = { actor: j.actor, smith: j.smith, trigger: j.trigger ?? "" } as Run
        const actor = auditActor(run)
        for (const a of j.actions ?? []) {
          if (a.kind === "note") continue
          const target = actionTarget(a)
          events.push({
            at: j.at,
            actor,
            agent: j.agent,
            session: j.session,
            smith: j.smith,
            category: a.local ? "local" : a.applied ? "change" : a.stagedId ? "staged" : "proposed",
            action: a.kind,
            targets: target ? [target] : [],
            reason: a.reason,
            result: a.applied ? "ok" : a.stagedId ? "staged" : "proposed",
            message: a.detail,
            run: j.run,
            commit: a.local ? undefined : j.commit,
            project: j.project,
          })
        }
        events.push({
          at: j.at,
          actor,
          agent: j.agent,
          session: j.session,
          smith: j.smith,
          category: /^undo /.test(j.trigger ?? "") ? "undo" : "run",
          action: `${j.smith}(${j.actor})`,
          reason: j.trigger,
          result: j.ok === false ? "error" : "ok",
          message: j.error ?? j.summary,
          run: j.run,
          commit: j.commit,
          project: j.project,
        })
      } catch {
        // skip broken line
      }
    }
    // chronological order keeps the chain readable
    events.sort((a, b) => String(a.at).localeCompare(String(b.at)))
    for (let i = 0; i < events.length; i += 500) this.append(...events.slice(i, i + 500))
    this.setMeta("journal_imported", nowIso())
    return events.length
  }

  /**
   * One-time repair: the first journal import wrote the literal target "undefined:undefined"
   * for skillsmith-2.x actions that carried only `skill`. Every reader that resolved such a
   * target crashed ("s.tiers"). Re-derive the real id from the journal (run + action + reason
   * identify a unique action) and re-chain the log so verify() stays green.
   */
  repairTargets(): number {
    if (!this.db || this.metaValue("targets_repaired")) return 0
    const bad = this.db.query("SELECT seq, run, action, reason FROM events WHERE targets LIKE ?").all('%undefined:undefined%') as any[]
    if (!bad.length) {
      this.setMeta("targets_repaired", nowIso())
      return 0
    }
    // map "run\u001faction\u001freason" -> target, exactly as stored (reason is one-lined/capped)
    const byKey = new Map<string, string>()
    let lines: string[] = []
    try {
      lines = readFileSync(join(this.stateDir, "journal.jsonl"), "utf8").split("\n").filter(Boolean)
    } catch {
      lines = []
    }
    for (const l of lines) {
      try {
        const j = JSON.parse(l)
        for (const a of j.actions ?? []) {
          if (a.kind === "note") continue
          const target = actionTarget(a)
          if (target) byKey.set(actionKey(j.run, a.kind, a.reason), target)
        }
      } catch {
        // skip broken line
      }
    }
    // without a readable journal we cannot resolve anything – retry on the next start
    if (!byKey.size) return 0
    let fixed = 0
    immediate(this.db, () => {
      const upd = this.db!.query("UPDATE events SET targets = ? WHERE seq = ?")
      const delT = this.db!.query("DELETE FROM event_targets WHERE seq = ?")
      const insT = this.db!.query("INSERT INTO event_targets (seq, target) VALUES (?, ?)")
      for (const r of bad) {
        const target = byKey.get(actionKey(r.run, r.action, r.reason))
        if (!target) continue
        upd.run(JSON.stringify([target]), r.seq)
        delT.run(r.seq)
        insT.run(r.seq, target)
        fixed++
      }
      if (fixed) this.rechain()
    })
    this.setMeta("targets_repaired", nowIso())
    this.log.warn(`audit: repaired ${fixed} journal target(s) written as "undefined:undefined"`)
    return fixed
  }

  /** Recompute the hash chain in place (used by repairTargets after changing row content). */
  private rechain(): void {
    const db = this.db!
    const rows = db.query("SELECT * FROM events ORDER BY seq").all() as any[]
    const upd = db.query("UPDATE events SET hash = ?, prev = ? WHERE seq = ?")
    let prev = ""
    let started = false
    for (const r of rows) {
      if (!r.hash) {
        // row written while the chain was off – leave untouched
        started = false
        continue
      }
      if (!started) {
        prev = r.prev ?? ""
        started = true
      }
      const row: Record<string, unknown> = {}
      for (const c of COLUMNS) row[c] = r[c]
      const hash = chainHash(prev, row)
      upd.run(hash, prev, r.seq)
      prev = hash
    }
  }

  /** CSV / JSONL export of a filter. */
  export(f: AuditFilter, format: "csv" | "jsonl"): string {
    const events = this.query({ ...f, limit: 5000 }).events
    if (format === "jsonl") return events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : "")
    const cols: Array<keyof AuditEvent> = ["seq", "at", "actor", "agent", "model", "smith", "category", "action", "targets", "result", "reason", "message", "run", "commit", "session", "project", "osUser"]
    const cell = (v: unknown) => {
      const s = Array.isArray(v) ? v.join(" ") : v === undefined || v === null ? "" : String(v)
      return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    return [cols.join(","), ...events.map((e) => cols.map((c) => cell(e[c])).join(","))].join("\n") + "\n"
  }
}

/** Reduce a rejection message to its gate ("evidence missing", "duplicate", …) for grouping. */
export function gateOf(message: string): string {
  const m = message.toLowerCase()
  if (/evidence/.test(m)) return "Beleg fehlt oder nicht wörtlich im Transkript"
  if (/very similar|duplicate|already exists/.test(m)) return "Duplikat / existiert schon"
  if (/sensitive data/.test(m)) return "Geheimnis im Inhalt"
  if (/limit reached/.test(m)) return "Limit des Laufs erreicht"
  if (/candidate|recurrence|session\(s\)/.test(m)) return "Wiederholung nicht belegt"
  if (/user_quote|user's own words|convention/.test(m)) return "Nutzerzitat fehlt"
  if (/chain/.test(m)) return "Fehlerkette fehlt"
  if (/pinned/.test(m)) return "angepinnt"
  if (/not found/.test(m)) return "Eintrag nicht gefunden"
  if (/concurrent run/.test(m)) return "paralleler Lauf"
  if (/ki-recht|ai access|privat|read-only document|lesen/.test(m)) return "KI-Recht des Dokuments"
  if (/section|title|description|name must|term must|expansion/.test(m)) return "Validierung (Form)"
  return truncate(message.replace(/"[^"]*"/g, "…").replace(/\d+/g, "#"), 80)
}
