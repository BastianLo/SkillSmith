/**
 * Project documentation index (read-only): the project's .md files are split
 * into sections (by heading, max ~1500 characters), indexed with BM25 and –
 * when embeddings are available – embedded into a per-project namespace.
 * Used by docsmith (doc passages related to code changes / the session) and
 * by the docs_search tool of the main agent. Files are only read, never written.
 */
import { readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, relative, resolve, sep } from "node:path"
import type { Options } from "../config"
import type { Logger } from "../log"
import { readText } from "../util/fs"
import { sha, truncate } from "../util/text"
import { MiniIndex, rrf } from "./bm25"
import type { Purpose, SemanticIndex } from "./embeddings"

export interface DocChunk {
  key: string
  file: string
  line: number
  heading: string
  text: string
}

export interface DocHit extends DocChunk {
  score: number
  similarity?: number
  matched: string[]
}

const SKIP = new Set(["node_modules", ".git", "dist", "build", "target", "out", "coverage", "vendor", ".venv", "venv", "__pycache__", ".next", ".idea", ".gradle", ".m2"])
const MAX_CHUNK = 1500
const MIN_CHUNK = 40

/** Split markdown into heading sections, long sections into paragraph chunks. */
export function chunkMarkdown(file: string, content: string): DocChunk[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  const out: DocChunk[] = []
  const path: string[] = []
  let start = 0
  let buf: string[] = []
  let inFence = false
  const flush = () => {
    const text = buf.join("\n").trim()
    if (text.length >= MIN_CHUNK) {
      const heading = path.filter(Boolean).join(" › ")
      if (text.length <= MAX_CHUNK) out.push({ key: `${file}#${start + 1}`, file, line: start + 1, heading, text })
      else {
        // split by paragraphs
        let cur: string[] = []
        let curStart = start
        let offset = start
        for (const para of text.split(/\n{2,}/)) {
          const joined = [...cur, para].join("\n\n")
          if (cur.length && joined.length > MAX_CHUNK) {
            out.push({ key: `${file}#${curStart + 1}`, file, line: curStart + 1, heading, text: cur.join("\n\n") })
            cur = []
            curStart = offset
          }
          cur.push(truncate(para, MAX_CHUNK))
          offset += para.split("\n").length + 1
        }
        if (cur.length) out.push({ key: `${file}#${curStart + 1}`, file, line: curStart + 1, heading, text: cur.join("\n\n") })
      }
    }
    buf = []
  }
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    const m = !inFence ? /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line) : null
    if (m) {
      flush()
      const level = m[1].length
      path.length = level - 1
      path[level - 1] = m[2].trim()
      start = i
      buf.push(line)
      return
    }
    if (!buf.length) start = i
    buf.push(line)
  })
  flush()
  return out
}

/**
 * Root for reading project docs: the git worktree, else the directory. Never "/" or the
 * home directory (opencode reports worktree "/" for directories outside git) – scanning
 * those would read unrelated files.
 */
export function safeDocsRoot(directory: string, worktree?: string, home = homedir()): string | undefined {
  const norm = (p: string) => resolve(p)
  const dir = norm(directory)
  const wt = worktree ? norm(worktree) : undefined
  const candidate = wt && wt !== sep && (dir === wt || dir.startsWith(wt + sep)) ? wt : dir
  if (candidate === sep || candidate === norm(home) || /^[A-Za-z]:\\?$/.test(candidate)) return undefined
  return candidate
}

export class ProjectDocs {
  private chunks: DocChunk[] = []
  private lexical?: MiniIndex
  private stamps = new Map<string, { mtime: number; size: number; chunks: DocChunk[] }>()
  private scannedAt = 0
  private syncing?: Promise<number>
  readonly ns: string

  constructor(
    private root: string,
    private o: Options,
    private log: Logger,
    private redact: (s: string) => string,
    private semantic?: SemanticIndex,
  ) {
    this.ns = `docs-${sha(root, 10)}`
  }

  get enabled(): boolean {
    return this.o.docsmith.projectIndex
  }

  private walk(): string[] {
    const files: string[] = []
    const max = this.o.docsmith.projectIndexMaxFiles
    const visit = (dir: string, depth: number) => {
      if (depth > 8 || files.length >= max) return
      let entries: import("node:fs").Dirent[]
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (SKIP.has(e.name) || (e.name.startsWith(".") && e.name !== ".github")) continue
        const p = join(dir, e.name)
        if (e.isDirectory()) visit(p, depth + 1)
        else if (e.isFile() && /\.(md|markdown)$/i.test(e.name)) files.push(p)
        if (files.length >= max) return
      }
    }
    visit(this.root, 0)
    return files
  }

  /** (Re)scan the project's markdown files; unchanged files are not re-read. */
  scan(force = false): DocChunk[] {
    if (!this.enabled) return []
    if (!force && Date.now() - this.scannedAt < 60_000) return this.chunks
    const seen = new Set<string>()
    const all: DocChunk[] = []
    for (const abs of this.walk()) {
      let st: { mtimeMs: number; size: number }
      try {
        st = statSync(abs)
      } catch {
        continue
      }
      if (st.size > 300_000) continue
      const rel = relative(this.root, abs).split(sep).join("/")
      seen.add(rel)
      const cached = this.stamps.get(rel)
      let chunks = cached && cached.mtime === st.mtimeMs && cached.size === st.size ? cached.chunks : undefined
      if (!chunks) {
        chunks = chunkMarkdown(rel, this.redact(readText(abs) ?? ""))
        this.stamps.set(rel, { mtime: st.mtimeMs, size: st.size, chunks })
      }
      all.push(...chunks)
      if (all.length >= this.o.docsmith.projectIndexMaxChunks) break
    }
    for (const k of [...this.stamps.keys()]) if (!seen.has(k)) this.stamps.delete(k)
    this.chunks = all.slice(0, this.o.docsmith.projectIndexMaxChunks)
    this.lexical = new MiniIndex(
      this.chunks.map((c) => ({
        id: c.key,
        fields: [
          [2, `${c.file.replace(/[/.]/g, " ")} ${c.heading}`],
          [1, c.text],
        ],
      })),
    )
    this.scannedAt = Date.now()
    return this.chunks
  }

  /** Embed new/changed sections (background). */
  syncVectors(): Promise<number> {
    if (!this.enabled || !this.semantic?.client.configured) return Promise.resolve(0)
    this.syncing ??= (async () => {
      try {
        const chunks = this.scan()
        return await this.semantic!.syncCustom(
          this.ns,
          chunks.map((c) => ({ key: c.key, text: `${c.file}${c.heading ? ` › ${c.heading}` : ""}\n${c.text}` })),
        )
      } catch (err) {
        this.log.warn("project docs embedding failed", String(err))
        return 0
      } finally {
        this.syncing = undefined
      }
    })()
    return this.syncing
  }

  /** Hybrid search over the sections (BM25 alone when embeddings are unavailable). */
  async search(query: string, opts: { limit?: number; purpose?: Purpose; minSimilarity?: number; timeoutMs?: number; minCoverage?: number } = {}): Promise<DocHit[]> {
    if (!this.enabled || !query.trim()) return []
    const chunks = this.scan()
    if (!chunks.length) return []
    const byKey = new Map(chunks.map((c) => [c.key, c]))
    const limit = opts.limit ?? 5
    const lexical = (this.lexical?.search(query, 30) ?? []).filter((h) => h.coverage >= (opts.minCoverage ?? 0))
    let semantic: Array<{ id: string; similarity: number }> = []
    const sem = this.semantic
    if (sem && sem.available()) {
      void this.syncVectors()
      const vec = await sem.embedQuery(query, opts.purpose ?? "search", opts.timeoutMs)
      if (vec) semantic = sem.scoreCustom(vec, this.ns).filter((h) => byKey.has(h.id)).slice(0, 30)
    }
    const fused = rrf(lexical, semantic, opts.minSimilarity ?? this.o.embedding.searchMinSimilarity)
    return fused.slice(0, limit).map((f) => ({
      ...byKey.get(f.id)!,
      score: Math.round(f.score * 100000) / 100000,
      similarity: f.similarity,
      matched: f.lexical?.matched ?? [],
    }))
  }
}
