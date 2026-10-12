/**
 * Vector storage: SQLite (default) and the file fallback behave the same for the
 * semantic index; SQLite writes incrementally, shares changes between processes,
 * migrates the old files and recovers from a damaged database.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { normalize } from "../../src/core/embeddings"
import { FileVectorStore, openVectorStore, openVectorStoreSync, SQLITE_FILE, SqliteVectorStore, type VectorStore } from "../../src/core/vector-store"
import { silentLogger } from "../../src/log"
import { tmp } from "./helpers"

const v = (...xs: number[]) => normalize(xs)
const backends: Array<["sqlite" | "file", (dir: string, locks: string) => VectorStore]> = [
  ["sqlite", (dir) => new SqliteVectorStore(dir, silentLogger)],
  ["file", (dir, locks) => new FileVectorStore(dir, locks, silentLogger)],
]

for (const [name, open] of backends) {
  describe(`vector store (${name})`, () => {
    test("persists, reloads and merges writes of two processes", async () => {
      const dir = join(tmp(), "emb")
      const locks = join(tmp(), "locks")
      const a = open(dir, locks)
      const b = open(dir, locks)
      a.set("sp", "entry-skill", "one", "h1", v(1, 0, 0))
      b.set("sp", "entry-skill", "two", "h2", v(0, 1, 0))
      await a.flush()
      await b.flush()
      const c = open(dir, locks)
      expect(c.keys("sp", "entry-skill").sort()).toEqual(["one", "two"])
      expect(c.get("sp", "entry-skill", "two")?.hash).toBe("h2")
      expect([...c.get("sp", "entry-skill", "one")!.vec]).toEqual([1, 0, 0])
      c.delete("sp", "entry-skill", "one")
      await c.flush()
      expect(open(dir, locks).keys("sp", "entry-skill")).toEqual(["two"])
      expect(c.count("sp")).toEqual({ "entry-skill": 1 })
      for (const s of [a, b, c]) await s.close()
    })
  })
}

describe("vector store (sqlite specifics)", () => {
  test("a flush writes only the changed rows", async () => {
    const dir = join(tmp(), "emb")
    const s = new SqliteVectorStore(dir, silentLogger)
    for (let i = 0; i < 2000; i++) s.set("sp", "docs", `k${i}`, `h${i}`, v(Math.sin(i), Math.cos(i), 1))
    await s.flush()
    expect(s.info().lastFlushRows).toBe(2000)
    s.set("sp", "docs", "k5", "changed", v(1, 2, 3))
    s.delete("sp", "docs", "k6")
    await s.flush()
    expect(s.info().lastFlushRows).toBe(2)
    expect(s.info().backend).toBe("sqlite")
    expect(existsSync(join(dir, SQLITE_FILE))).toBe(true)
    await s.close()
    const again = new SqliteVectorStore(dir, silentLogger)
    expect(again.keys("sp", "docs").length).toBe(1999)
    expect(again.get("sp", "docs", "k5")?.hash).toBe("changed")
    await again.close()
  })

  test("open caches see other processes' writes and deletions without reopening", async () => {
    const dir = join(tmp(), "emb")
    const a = new SqliteVectorStore(dir, silentLogger)
    const b = new SqliteVectorStore(dir, silentLogger)
    a.set("sp", "entry-error", "x", "h", v(1, 0))
    await a.flush()
    expect(b.keys("sp", "entry-error")).toEqual(["x"]) // b loads lazily
    a.set("sp", "entry-error", "y", "h", v(0, 1))
    a.delete("sp", "entry-error", "x")
    await a.flush()
    expect(b.keys("sp", "entry-error")).toEqual(["y"]) // refreshed via data_version
    // pending local changes win over remote ones, nothing is lost on flush
    b.set("sp", "entry-error", "z", "hb", v(1, 1))
    a.set("sp", "entry-error", "w", "ha", v(1, -1))
    await a.flush()
    await b.flush()
    const c = new SqliteVectorStore(dir, silentLogger)
    expect(c.keys("sp", "entry-error").sort()).toEqual(["w", "y", "z"])
    expect(b.keys("sp", "entry-error").sort()).toEqual(["w", "y", "z"])
    for (const s of [a, b, c]) await s.close()
  })

  test("old files are migrated once and removed", async () => {
    const root = tmp()
    const dir = join(root, "emb")
    const locks = join(root, "locks")
    const old = new FileVectorStore(dir, locks, silentLogger)
    old.set("qwen-1024", "entry-skill", "deploy", "h1", v(1, 0, 0))
    old.set("qwen-1024", "docs-abc", "README.md#1", "h2", v(0, 1, 0))
    await old.flush()
    expect(readdirSync(join(dir, "qwen-1024")).length).toBe(4)
    const s = await openVectorStore(dir, locks, silentLogger)
    expect(s.backend).toBe("sqlite")
    expect(s.get("qwen-1024", "entry-skill", "deploy")?.hash).toBe("h1")
    expect(s.keys("qwen-1024", "docs-abc")).toEqual(["README.md#1"])
    expect(existsSync(join(dir, "qwen-1024"))).toBe(false)
    await s.close()
  })

  test("damaged database is moved aside and rebuilt; storage 'file' and missing SQLite fall back to files", async () => {
    const dir = join(tmp(), "emb")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, SQLITE_FILE), "this is not a database at all, just text ".repeat(50))
    const s = new SqliteVectorStore(dir, silentLogger)
    s.set("sp", "n", "k", "h", v(1))
    await s.flush()
    expect(readdirSync(dir).some((f) => f.includes(".corrupt-"))).toBe(true)
    await s.close()
    expect(openVectorStoreSync(join(tmp(), "e"), tmp(), silentLogger, "file").backend).toBe("file")
    const broken = await openVectorStore(join(tmp(), "e"), tmp(), silentLogger, {
      database: class {
        constructor() {
          throw new Error("bun:sqlite not available")
        }
      } as any,
    })
    expect(broken.backend).toBe("file")
  })
})
