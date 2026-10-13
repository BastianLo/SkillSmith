/**
 * Small helper for the local SQLite databases in state/ (audit log, metrics, tasks):
 * bun:sqlite loaded lazily, WAL, busy timeout, schema on open, in-memory fallback
 * when the file is unusable. Callers treat `undefined` as "feature off".
 */
import { join } from "node:path"
import type { Logger } from "../log"
import { ensureDir } from "../util/fs"
import { errorMessage } from "../util/text"
import { loadDatabaseClass, type SqlDatabase } from "./vector-store"

export type DatabaseClass = new (path: string, opts?: Record<string, unknown>) => SqlDatabase

export function openStateDb(stateDir: string, file: string, schema: string, log: Logger, Database?: DatabaseClass): SqlDatabase | undefined {
  ensureDir(stateDir)
  let Db = Database
  try {
    Db ??= loadDatabaseClass()
  } catch (err) {
    log.warn(`${file}: SQLite not available – feature off`, errorMessage(err))
    return undefined
  }
  const open = (path: string) => {
    const db = new Db!(path, { create: true })
    db.exec("PRAGMA busy_timeout = 10000")
    try {
      db.exec("PRAGMA journal_mode = WAL")
    } catch {
      // rollback journal is fine too
    }
    db.exec("PRAGMA synchronous = NORMAL")
    db.exec(schema)
    return db
  }
  try {
    return open(join(stateDir, file))
  } catch (err) {
    log.warn(`${file} unusable – using a temporary in-memory database`, errorMessage(err))
    try {
      return open(":memory:")
    } catch {
      return undefined
    }
  }
}

/** Run `fn` in an IMMEDIATE transaction (serializes writers across processes). */
export function immediate<T>(db: SqlDatabase, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE")
  try {
    const out = fn()
    db.exec("COMMIT")
    return out
  } catch (err) {
    try {
      db.exec("ROLLBACK")
    } catch {
      // ignore
    }
    throw err
  }
}

/** Local calendar day (YYYY-MM-DD) of a timestamp. */
export { localDay } from "../util/text"
