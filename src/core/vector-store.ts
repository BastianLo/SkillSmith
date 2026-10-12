/**
 * Storage for embedding vectors (derived data under state/embeddings/, never versioned).
 *
 *  - SqliteVectorStore (default): one SQLite database (bun:sqlite – part of the Bun
 *    runtime opencode runs on, no extension, nothing to install). Every vector is a
 *    row; a flush writes only what changed, in one transaction. Several opencode
 *    processes share the file (WAL); each keeps an in-memory cache per namespace and
 *    picks up the others' writes through a global sequence number (+ tombstones for
 *    deletions) when `PRAGMA data_version` says another connection committed.
 *  - FileVectorStore (fallback): one Float32 file + JSON key index per namespace,
 *    rewritten completely on flush (v2.1/v2.2 format). Used when SQLite is not
 *    available or `embedding.storage: "file"` is set.
 *
 * Similarity search stays in JS on the cached vectors (brute force, fast enough for
 * tens of thousands of vectors); the store only has to persist and share them.
 */
import { readdirSync, readFileSync, renameSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import type { Logger } from "../log"
import { ensureDir, exists, readJson, removePath, withLock, writeBufferAtomic, writeJsonAtomic } from "../util/fs"
import { errorMessage } from "../util/text"

export interface StoredVector {
  hash: string
  vec: Float32Array
}

export interface VectorStoreInfo {
  backend: "sqlite" | "file"
  path: string
  bytes: number
  /** rows written by the last flush */
  lastFlushRows: number
  lastFlushMs: number
}

export interface VectorStore {
  readonly backend: "sqlite" | "file"
  get(space: string, ns: string, key: string): StoredVector | undefined
  entries(space: string, ns: string): Array<[string, StoredVector]>
  keys(space: string, ns: string): string[]
  set(space: string, ns: string, key: string, hash: string, vec: Float32Array): void
  delete(space: string, ns: string, key: string): void
  /** vectors per namespace of a space */
  count(space: string): Record<string, number>
  /** persist pending changes */
  flush(): Promise<void>
  close(): Promise<void>
  info(): VectorStoreInfo
}

const toBytes = (v: Float32Array) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
/** BLOB → Float32Array (copy: SQLite buffers need not be 4-byte aligned). */
const toVector = (b: Uint8Array) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// legacy / fallback: one file per namespace
// ---------------------------------------------------------------------------

interface FileNamespace {
  vectors: Map<string, StoredVector>
  dims: number
  dirty: boolean
  deleted: Set<string>
  loadedMtime: number
}

/** Read one namespace in the file format (also used for the migration to SQLite). */
export function readLegacyNamespace(root: string, space: string, ns: string, log?: Logger): { dims: number; map: Map<string, StoredVector> } {
  const metaFile = join(root, space, `${ns}.json`)
  const binFile = join(root, space, `${ns}.f32`)
  const meta = readJson<{ dims?: number; keys?: string[]; hashes?: string[] } | null>(metaFile, null)
  const map = new Map<string, StoredVector>()
  if (!meta?.keys?.length || !meta.dims || !exists(binFile)) return { dims: meta?.dims ?? 0, map }
  try {
    const buf = readFileSync(binFile)
    const all = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
    if (all.length !== meta.keys.length * meta.dims) throw new Error("size mismatch")
    meta.keys.forEach((k, i) => map.set(k, { hash: meta.hashes?.[i] ?? "", vec: all.slice(i * meta.dims!, (i + 1) * meta.dims!) }))
  } catch (err) {
    log?.warn(`embedding file ${binFile} unreadable – rebuilding`, errorMessage(err))
    map.clear()
  }
  return { dims: meta.dims, map }
}

export class FileVectorStore implements VectorStore {
  readonly backend = "file" as const
  private spaces = new Map<string, Map<string, FileNamespace>>()
  private last = { rows: 0, ms: 0 }

  constructor(private root: string, private locksDir: string, private log: Logger) {}

  private metaFile(space: string, ns: string): string {
    return join(this.root, space, `${ns}.json`)
  }

  private mtime(path: string): number {
    try {
      return statSync(path).mtimeMs
    } catch {
      return 0
    }
  }

  private ns(space: string, ns: string): FileNamespace {
    let s = this.spaces.get(space)
    if (!s) {
      s = new Map()
      this.spaces.set(space, s)
    }
    let n = s.get(ns)
    const m = this.mtime(this.metaFile(space, ns))
    if (!n || (!n.dirty && m > n.loadedMtime)) {
      const disk = readLegacyNamespace(this.root, space, ns, this.log)
      n = { vectors: disk.map, dims: disk.dims, dirty: false, deleted: new Set(), loadedMtime: m }
      s.set(ns, n)
    }
    return n
  }

  get(space: string, ns: string, key: string): StoredVector | undefined {
    return this.ns(space, ns).vectors.get(key)
  }

  entries(space: string, ns: string): Array<[string, StoredVector]> {
    return [...this.ns(space, ns).vectors.entries()]
  }

  keys(space: string, ns: string): string[] {
    return [...this.ns(space, ns).vectors.keys()]
  }

  set(space: string, ns: string, key: string, hash: string, vec: Float32Array): void {
    const n = this.ns(space, ns)
    if (n.dims && n.dims !== vec.length) n.vectors.clear()
    n.dims = vec.length
    n.vectors.set(key, { hash, vec })
    n.deleted.delete(key)
    n.dirty = true
  }

  delete(space: string, ns: string, key: string): void {
    const n = this.ns(space, ns)
    if (n.vectors.delete(key)) {
      n.deleted.add(key)
      n.dirty = true
    }
  }

  count(space: string): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [ns, n] of this.spaces.get(space) ?? []) out[ns] = n.vectors.size
    return out
  }

  /** Rewrites every dirty namespace completely (merged with what other processes wrote meanwhile). */
  async flush(): Promise<void> {
    const t0 = performance.now()
    let rows = 0
    for (const [space, nss] of this.spaces) {
      for (const [ns, n] of nss) {
        if (!n.dirty) continue
        await withLock(this.locksDir, `embeddings-${space}`, () => {
          const disk = readLegacyNamespace(this.root, space, ns, this.log)
          for (const [k, v] of disk.map) {
            if (!n.vectors.has(k) && !n.deleted.has(k) && v.vec.length === n.dims) n.vectors.set(k, v)
          }
          const keys = [...n.vectors.keys()].sort()
          const dims = n.dims
          const all = new Float32Array(keys.length * dims)
          const hashes: string[] = []
          keys.forEach((k, i) => {
            const v = n.vectors.get(k)!
            all.set(v.vec.subarray(0, dims), i * dims)
            hashes.push(v.hash)
          })
          const meta = this.metaFile(space, ns)
          const bin = join(this.root, space, `${ns}.f32`)
          if (!keys.length) {
            removePath(bin)
            removePath(meta)
          } else {
            writeBufferAtomic(bin, new Uint8Array(all.buffer))
            writeJsonAtomic(meta, { dims, count: keys.length, keys, hashes })
          }
          rows += keys.length
          n.dirty = false
          n.deleted.clear()
          n.loadedMtime = this.mtime(meta)
        })
      }
    }
    if (rows) this.last = { rows, ms: Math.round(performance.now() - t0) }
  }

  async close(): Promise<void> {
    await this.flush()
  }

  info(): VectorStoreInfo {
    let bytes = 0
    try {
      for (const space of readdirSync(this.root)) {
        for (const f of readdirSync(join(this.root, space))) bytes += sizeOf(join(this.root, space, f))
      }
    } catch {
      // no files yet
    }
    return { backend: "file", path: this.root, bytes, lastFlushRows: this.last.rows, lastFlushMs: this.last.ms }
  }
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

/** The part of bun:sqlite's API used here (no bun-types dependency). */
export interface SqlStatement {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): any
  all(...params: unknown[]): any[]
}
export interface SqlDatabase {
  exec(sql: string): void
  query(sql: string): SqlStatement
  prepare(sql: string): SqlStatement
  close(throwOnError?: boolean): void
}

const require_ = createRequire(import.meta.url)

export const SQLITE_FILE = "vectors.sqlite"
const SCHEMA_VERSION = 1
/** spaces (model/dimension combinations) not used for this long are deleted */
const SPACE_RETENTION_DAYS = 60
/** tombstones older than this are dropped; caches that old reload the namespace */
const TOMBSTONE_RETENTION_DAYS = 14

interface SqlNamespace {
  vectors: Map<string, StoredVector>
  /** highest sequence number applied to this cache */
  seq: number
}

type PendingOp = { space: string; ns: string; key: string; hash?: string; vec?: Float32Array }

export class SqliteVectorStore implements VectorStore {
  readonly backend = "sqlite" as const
  readonly file: string
  private db: SqlDatabase
  private cache = new Map<string, SqlNamespace>()
  private pending = new Map<string, PendingOp>()
  private dataVersion = 0
  private usedSpaces = new Set<string>()
  private last = { rows: 0, ms: 0 }
  private closed = false
  private inTx = false

  constructor(
    dir: string,
    private log: Logger,
    Database: new (path: string, opts?: Record<string, unknown>) => SqlDatabase = loadDatabaseClass(),
  ) {
    ensureDir(dir)
    this.file = join(dir, SQLITE_FILE)
    this.db = SqliteVectorStore.openFile(this.file, Database, log)
    this.dataVersion = this.version()
    this.maintenance()
  }

  private static openFile(file: string, Database: new (path: string, opts?: Record<string, unknown>) => SqlDatabase, log: Logger): SqlDatabase {
    const open = () => {
      const db = new Database(file, { create: true })
      try {
        db.exec("PRAGMA busy_timeout = 10000")
        try {
          db.exec("PRAGMA journal_mode = WAL")
        } catch {
          // some file systems do not support WAL – rollback journal works, too
        }
        db.exec("PRAGMA synchronous = NORMAL")
        db.exec(`
          CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS vectors (
            space TEXT NOT NULL, ns TEXT NOT NULL, key TEXT NOT NULL,
            hash TEXT NOT NULL, dims INTEGER NOT NULL, vec BLOB NOT NULL,
            seq INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            PRIMARY KEY (space, ns, key)
          );
          CREATE INDEX IF NOT EXISTS vectors_seq ON vectors (space, ns, seq);
          CREATE TABLE IF NOT EXISTS tombstones (
            space TEXT NOT NULL, ns TEXT NOT NULL, key TEXT NOT NULL,
            seq INTEGER NOT NULL, deleted_at INTEGER NOT NULL,
            PRIMARY KEY (space, ns, key)
          );
          CREATE TABLE IF NOT EXISTS spaces (space TEXT PRIMARY KEY, last_used INTEGER NOT NULL);
          INSERT OR IGNORE INTO meta (key, value) VALUES ('schema', '${SCHEMA_VERSION}'), ('seq', '0'), ('tomb_floor', '0');
        `)
        return db
      } catch (err) {
        try {
          db.close()
        } catch {
          // ignore
        }
        throw err
      }
    }
    try {
      return open()
    } catch (err) {
      const msg = errorMessage(err)
      // vectors are derived data: a damaged file is moved aside and rebuilt
      if (!/not a database|malformed|corrupt|file is encrypted/i.test(msg)) throw err
      const aside = `${file}.corrupt-${Date.now()}`
      log.warn(`vector database unreadable (${msg}) – moved to ${aside}, vectors will be rebuilt`)
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          renameSync(file + suffix, aside + suffix)
        } catch {
          // missing side files are fine
        }
      }
      return open()
    }
  }

  private version(): number {
    return Number(this.db.query("PRAGMA data_version").get()?.data_version ?? 0)
  }

  private metaValue(key: string): number {
    return Number(this.db.query("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? 0)
  }

  /** Old spaces (model/dimension switched long ago) and old tombstones are removed. */
  private maintenance(): void {
    try {
      const now = Date.now()
      const stale = this.db
        .query("SELECT space FROM spaces WHERE last_used < ?")
        .all(now - SPACE_RETENTION_DAYS * 86_400_000)
        .map((r) => String(r.space))
      const cutoff = now - TOMBSTONE_RETENTION_DAYS * 86_400_000
      this.tx(() => {
        for (const space of stale) {
          this.db.query("DELETE FROM vectors WHERE space = ?").run(space)
          this.db.query("DELETE FROM tombstones WHERE space = ?").run(space)
          this.db.query("DELETE FROM spaces WHERE space = ?").run(space)
        }
        const floor = this.db.query("SELECT max(seq) AS s FROM tombstones WHERE deleted_at < ?").get(cutoff)?.s
        if (floor) {
          this.db.query("DELETE FROM tombstones WHERE deleted_at < ?").run(cutoff)
          this.db.query("UPDATE meta SET value = ? WHERE key = 'tomb_floor' AND CAST(value AS INTEGER) < ?").run(String(floor), floor)
        }
      })
      if (stale.length) this.log.info(`vector store: removed unused space(s) ${stale.join(", ")}`)
    } catch (err) {
      this.log.debug("vector store maintenance skipped", errorMessage(err))
    }
  }

  /** Write transaction (takes the write lock up front). */
  private tx<T>(fn: () => T): T {
    if (this.inTx) return fn()
    this.db.exec("BEGIN IMMEDIATE")
    this.inTx = true
    try {
      const out = fn()
      this.db.exec("COMMIT")
      return out
    } catch (err) {
      try {
        this.db.exec("ROLLBACK")
      } catch {
        // ignore
      }
      throw err
    } finally {
      this.inTx = false
    }
  }

  /** Read transaction: several SELECTs see one consistent snapshot (WAL). */
  private read<T>(fn: () => T): T {
    if (this.inTx) return fn()
    this.db.exec("BEGIN")
    this.inTx = true
    try {
      return fn()
    } finally {
      this.inTx = false
      try {
        this.db.exec("COMMIT")
      } catch {
        // ignore
      }
    }
  }

  private cacheKey(space: string, ns: string): string {
    return `${space}\u0000${ns}`
  }

  private loadNamespace(space: string, ns: string): SqlNamespace {
    const loaded = this.read(() => {
      const vectors = new Map<string, StoredVector>()
      for (const r of this.db.query("SELECT key, hash, vec FROM vectors WHERE space = ? AND ns = ?").all(space, ns)) {
        vectors.set(String(r.key), { hash: String(r.hash), vec: toVector(r.vec as Uint8Array) })
      }
      // same snapshot: everything up to the current global sequence is reflected
      return { vectors, seq: this.metaValue("seq") }
    })
    this.touchSpace(space)
    return loaded
  }

  /** Remember that a space is in use (retention of old model/dimension spaces). */
  private touchSpace(space: string): void {
    if (!this.usedSpaces.has(space)) {
      this.usedSpaces.add(space)
      try {
        this.db.query("INSERT INTO spaces (space, last_used) VALUES (?, ?) ON CONFLICT(space) DO UPDATE SET last_used = excluded.last_used").run(space, Date.now())
      } catch {
        // read-only or busy: retention bookkeeping only
      }
    }
  }

  /** Apply what other connections committed since the cache was built. */
  private refresh(force = false): void {
    if (!this.cache.size) return
    const v = this.version()
    if (!force && v === this.dataVersion) return
    this.dataVersion = v
    this.read(() => this.applyRemote())
  }

  private applyRemote(): void {
    const floor = this.metaValue("tomb_floor")
    // same snapshot: after applying the rows below, every change up to `global` is reflected
    const global = this.metaValue("seq")
    for (const [ck, n] of this.cache) {
      const [space, ns] = ck.split("\u0000")
      if (n.seq < floor) {
        // tombstones we have not seen were pruned → rebuild this cache
        const fresh = this.loadNamespace(space, ns)
        n.vectors = fresh.vectors
        n.seq = fresh.seq
        this.reapplyPending(space, ns, n)
        continue
      }
      if (n.seq >= global) continue
      for (const r of this.db.query("SELECT key, hash, vec FROM vectors WHERE space = ? AND ns = ? AND seq > ?").all(space, ns, n.seq)) {
        if (!this.pending.has(`${ck}\u0000${r.key}`)) n.vectors.set(String(r.key), { hash: String(r.hash), vec: toVector(r.vec as Uint8Array) })
      }
      for (const r of this.db.query("SELECT key FROM tombstones WHERE space = ? AND ns = ? AND seq > ?").all(space, ns, n.seq)) {
        if (!this.pending.has(`${ck}\u0000${r.key}`)) n.vectors.delete(String(r.key))
      }
      n.seq = global
    }
  }

  private reapplyPending(space: string, ns: string, n: SqlNamespace): void {
    for (const op of this.pending.values()) {
      if (op.space !== space || op.ns !== ns) continue
      if (op.vec) n.vectors.set(op.key, { hash: op.hash!, vec: op.vec })
      else n.vectors.delete(op.key)
    }
  }

  private ns(space: string, ns: string): SqlNamespace {
    this.refresh()
    const ck = this.cacheKey(space, ns)
    let n = this.cache.get(ck)
    if (!n) {
      n = this.loadNamespace(space, ns)
      this.cache.set(ck, n)
    }
    return n
  }

  get(space: string, ns: string, key: string): StoredVector | undefined {
    return this.ns(space, ns).vectors.get(key)
  }

  entries(space: string, ns: string): Array<[string, StoredVector]> {
    return [...this.ns(space, ns).vectors.entries()]
  }

  keys(space: string, ns: string): string[] {
    return [...this.ns(space, ns).vectors.keys()]
  }

  set(space: string, ns: string, key: string, hash: string, vec: Float32Array): void {
    const n = this.ns(space, ns)
    n.vectors.set(key, { hash, vec })
    this.pending.set(`${this.cacheKey(space, ns)}\u0000${key}`, { space, ns, key, hash, vec })
  }

  delete(space: string, ns: string, key: string): void {
    const n = this.ns(space, ns)
    if (!n.vectors.delete(key)) return
    this.pending.set(`${this.cacheKey(space, ns)}\u0000${key}`, { space, ns, key })
  }

  count(space: string): Record<string, number> {
    const out: Record<string, number> = {}
    try {
      for (const r of this.db.query("SELECT ns, count(*) AS n FROM vectors WHERE space = ? GROUP BY ns").all(space)) out[String(r.ns)] = Number(r.n)
    } catch {
      // fall back to the caches below
    }
    for (const [ck, n] of this.cache) {
      const [s, ns] = ck.split("\u0000")
      if (s === space) out[ns] = n.vectors.size
    }
    return out
  }

  /** Writes only the changed rows (one transaction); other processes' writes are merged into the caches first. */
  async flush(): Promise<void> {
    if (!this.pending.size || this.closed) return
    const t0 = performance.now()
    const ops = [...this.pending.values()]
    const now = Date.now()
    const seq = this.tx(() => {
      // inside the write lock nobody else can commit: catch up first, then everything < seq is known
      this.refresh(true)
      const next = this.metaValue("seq") + 1
      const upsert = this.db.prepare(
        "INSERT INTO vectors (space, ns, key, hash, dims, vec, seq, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(space, ns, key) DO UPDATE SET hash = excluded.hash, dims = excluded.dims, vec = excluded.vec, seq = excluded.seq, updated_at = excluded.updated_at",
      )
      const unTomb = this.db.prepare("DELETE FROM tombstones WHERE space = ? AND ns = ? AND key = ?")
      const del = this.db.prepare("DELETE FROM vectors WHERE space = ? AND ns = ? AND key = ?")
      const tomb = this.db.prepare(
        "INSERT INTO tombstones (space, ns, key, seq, deleted_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(space, ns, key) DO UPDATE SET seq = excluded.seq, deleted_at = excluded.deleted_at",
      )
      for (const op of ops) {
        if (op.vec) {
          upsert.run(op.space, op.ns, op.key, op.hash!, op.vec.length, toBytes(op.vec), next, now)
          unTomb.run(op.space, op.ns, op.key)
        } else {
          del.run(op.space, op.ns, op.key)
          tomb.run(op.space, op.ns, op.key, next, now)
        }
      }
      this.db.query("UPDATE meta SET value = ? WHERE key = 'seq'").run(String(next))
      return next
    })
    for (const op of ops) {
      const k = `${this.cacheKey(op.space, op.ns)}\u0000${op.key}`
      // a newer set/delete for the same key may have arrived meanwhile – keep it pending
      const cur = this.pending.get(k)
      if (cur && cur.vec === op.vec && cur.hash === op.hash) this.pending.delete(k)
    }
    for (const n of this.cache.values()) if (n.seq < seq) n.seq = seq
    this.dataVersion = this.version()
    this.last = { rows: ops.length, ms: Math.round(performance.now() - t0) }
  }

  async close(): Promise<void> {
    if (this.closed) return
    try {
      await this.flush()
    } finally {
      this.closed = true
      try {
        this.db.close()
      } catch {
        // ignore
      }
    }
  }

  info(): VectorStoreInfo {
    return {
      backend: "sqlite",
      path: this.file,
      bytes: sizeOf(this.file) + sizeOf(`${this.file}-wal`),
      lastFlushRows: this.last.rows,
      lastFlushMs: this.last.ms,
    }
  }

  /** Import vectors of the file format (v2.1/v2.2) and remove the old files. Returns the imported count. */
  importLegacy(root: string): number {
    let spaces: string[]
    try {
      spaces = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch {
      return 0
    }
    let imported = 0
    for (const space of spaces) {
      const dir = join(root, space)
      let nss: string[] = []
      try {
        nss = readdirSync(dir)
          .filter((f) => f.endsWith(".json"))
          .map((f) => f.slice(0, -5))
      } catch {
        continue
      }
      if (!nss.length) continue
      const now = Date.now()
      this.tx(() => {
        const next = this.metaValue("seq") + 1
        const ins = this.db.prepare(
          "INSERT INTO vectors (space, ns, key, hash, dims, vec, seq, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(space, ns, key) DO NOTHING",
        )
        for (const ns of nss) {
          for (const [k, v] of readLegacyNamespace(root, space, ns, this.log).map) {
            ins.run(space, ns, k, v.hash, v.vec.length, toBytes(v.vec), next, now)
            imported++
          }
        }
        this.db.query("UPDATE meta SET value = ? WHERE key = 'seq'").run(String(next))
        this.db.query("INSERT INTO spaces (space, last_used) VALUES (?, ?) ON CONFLICT(space) DO NOTHING").run(space, now)
      })
      removePath(dir)
    }
    this.dataVersion = this.version()
    return imported
  }
}

export function loadDatabaseClass(): new (path: string, opts?: Record<string, unknown>) => SqlDatabase {
  const mod = require_("bun:sqlite") as { Database?: new (path: string, opts?: Record<string, unknown>) => SqlDatabase }
  if (!mod?.Database) throw new Error("bun:sqlite not available")
  return mod.Database
}

/**
 * Open the vector store: SQLite (default) with migration of old files, or the file
 * format when SQLite is unavailable or `storage: "file"` is configured.
 */
export async function openVectorStore(
  root: string,
  locksDir: string,
  log: Logger,
  opts: { storage?: "sqlite" | "file"; database?: new (path: string, opts?: Record<string, unknown>) => SqlDatabase } = {},
): Promise<VectorStore> {
  if (opts.storage !== "file") {
    try {
      const store = new SqliteVectorStore(root, log, opts.database ?? loadDatabaseClass())
      const legacy = await withLock(locksDir, "embeddings-migrate", () => store.importLegacy(root))
      if (legacy) log.info(`vector store: ${legacy} vector(s) migrated from files to SQLite`)
      return store
    } catch (err) {
      log.warn("SQLite vector store unavailable – using files", errorMessage(err))
    }
  }
  return new FileVectorStore(root, locksDir, log)
}

/** Synchronous variant for tests and tools (no lock for the migration). */
export function openVectorStoreSync(root: string, locksDir: string, log: Logger, storage: "sqlite" | "file" = "sqlite"): VectorStore {
  if (storage !== "file") {
    try {
      const store = new SqliteVectorStore(root, log)
      store.importLegacy(root)
      return store
    } catch (err) {
      log.warn("SQLite vector store unavailable – using files", errorMessage(err))
    }
  }
  return new FileVectorStore(root, locksDir, log)
}
