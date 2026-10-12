/**
 * Session history ("ähnliche frühere Sessions"): after each review, a compact,
 * redacted record of the session is kept – what was asked, which errors came
 * up (and whether they were solved), which store entries were created, changed
 * or used, and how the session ended. The records are searchable (BM25, plus
 * embeddings in the namespace "sessions" when available) and feed the hint
 * section "Frühere Sessions", the history_search tool and /history.
 *
 * Stored in state/history.json (not versioned, shared by all projects; merged
 * under a lock on every write). Retention: history.days / history.maxRecords.
 */
import { statSync } from "node:fs"
import { join } from "node:path"
import type { Options } from "../config"
import type { Logger } from "../log"
import type { ErrorChain, Kind } from "../types"
import { readJson, withLock, writeJsonAtomic } from "../util/fs"
import { nowIso, oneLine, stripCode, truncate } from "../util/text"
import { MiniIndex, rrf } from "./bm25"
import type { Purpose, SemanticIndex } from "./embeddings"
import { spec } from "./kinds"
import { SHELL_TOOLS } from "./transcript"

export type LinkRel = "new" | "changed" | "used"

export interface HistoryLink {
  kind: Kind
  name: string
  rel: LinkRel
}

export interface HistoryProblem {
  error: string
  resolved: boolean
  fix?: string
}

export interface HistoryRecord {
  id: string
  project: string
  directory: string
  title?: string
  startedAt: string
  at: string
  /** user requests (redacted, one line each) */
  requests: string[]
  problems: HistoryProblem[]
  links: HistoryLink[]
  /** end of the last assistant answer (redacted) */
  outcome?: string
}

export interface HistoryHit {
  record: HistoryRecord
  score: number
  similarity?: number
  matched: string[]
  coverage: number
}

interface HistoryFile {
  version: 1
  records: Record<string, HistoryRecord>
}

const MAX_REQUESTS = 8
const MAX_PROBLEMS = 8
const MAX_LINKS = 16
const REL_RANK: Record<LinkRel, number> = { new: 3, changed: 2, used: 1 }

export interface SessionSegment {
  id: string
  project: string
  directory: string
  title?: string
  requests: string[]
  chains: ErrorChain[]
  links: HistoryLink[]
  outcome?: string
}

/**
 * What solved an error chain: successful shell steps between the failure and the
 * successful retry, plus the retry itself when it differs from the failing call
 * (a plain re-run is no fix worth showing).
 */
export function fixOf(c: ErrorChain): string | undefined {
  if (!c.resolved) return undefined
  const steps = c.attempts
    .filter((a) => / → ok$/.test(a) && SHELL_TOOLS.has(a.split(" ")[0]))
    .map((a) => a.replace(/ → ok$/, "").replace(/^\S+\s+/, ""))
  if (c.resolution && c.resolution !== c.command) steps.push(c.resolution)
  return steps.length ? steps.slice(-3).join(" → ") : undefined
}

/** Text that represents a record for search and embeddings. */
export function historyText(r: HistoryRecord): string {
  return [
    r.title ?? "",
    ...r.requests,
    ...r.problems.map((p) => `${p.resolved ? "solved" : "unsolved"}: ${p.error}${p.fix ? ` → ${p.fix}` : ""}`),
    ...r.links.map((l) => `${spec(l.kind).label} ${l.name.replace(/-/g, " ")}`),
    r.outcome ?? "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000)
}

/** Does the record point to something reusable (an entry or a solved problem)? */
export function isUseful(r: HistoryRecord): boolean {
  return r.links.length > 0 || r.problems.some((p) => p.resolved)
}

export function formatDate(iso: string, now = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  const dd = String(d.getDate()).padStart(2, "0")
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  return d.getFullYear() === now.getFullYear() ? `${dd}.${mm}.` : `${dd}.${mm}.${d.getFullYear()}`
}

/** opencode's placeholder titles ("New session - …") and very short titles say nothing. */
export function meaningfulTitle(title: string | undefined): boolean {
  return !!title && title.trim().length >= 8 && !/^(new session|child session|neue session)\b/i.test(title.trim())
}

/** Short reference list of the linked entries, most important first ("Fehler maven-pkix (neu)"). */
export function linkSummary(r: HistoryRecord, max = 4): string {
  const rel: Record<LinkRel, string> = { new: "neu", changed: "aktualisiert", used: "genutzt" }
  return [...r.links]
    .sort((a, b) => REL_RANK[b.rel] - REL_RANK[a.rel])
    .slice(0, max)
    .map((l) => `${spec(l.kind).label} ${l.name} (${rel[l.rel]})`)
    .join(", ")
}

export class SessionHistory {
  private file: string
  private cache?: { mtime: number; data: HistoryFile }
  private lexical?: { revision: number; index: MiniIndex }
  private revision = 0
  private syncing?: Promise<number>
  readonly ns = "sessions"

  constructor(
    stateDir: string,
    private locksDir: string,
    private o: Options,
    private log: Logger,
    private redact: (s: string) => string,
    private semantic?: SemanticIndex,
  ) {
    this.file = join(stateDir, "history.json")
  }

  get enabled(): boolean {
    return this.o.history.enabled
  }

  private load(): HistoryFile {
    let mtime = 0
    try {
      mtime = statSync(this.file).mtimeMs
    } catch {
      mtime = 0
    }
    if (this.cache && this.cache.mtime === mtime) return this.cache.data
    const data = readJson<HistoryFile>(this.file, { version: 1, records: {} })
    if (!data.records || typeof data.records !== "object") data.records = {}
    this.cache = { mtime, data }
    this.revision++
    return data
  }

  all(): HistoryRecord[] {
    return Object.values(this.load().records).sort((a, b) => b.at.localeCompare(a.at))
  }

  get(id: string): HistoryRecord | undefined {
    return this.load().records[id]
  }

  /** Merge a reviewed segment of a session into its record. */
  async record(seg: SessionSegment): Promise<HistoryRecord | undefined> {
    if (!this.enabled) return undefined
    const clean = (s: string, max: number) => truncate(oneLine(this.redact(s)), max)
    const requests = seg.requests
      .map((t) => clean(stripCode(t), 300))
      .filter((t) => t.length >= 4)
    const problems: HistoryProblem[] = seg.chains.map((c) => {
      const fix = fixOf(c)
      return { error: clean(c.signature || c.error, 240), resolved: c.resolved, fix: fix ? clean(fix, 240) : undefined }
    })
    const outcome = seg.outcome ? clean(seg.outcome, 400) : undefined
    if (!requests.length && !problems.length && !seg.links.length) return undefined
    const rec = await withLock(this.locksDir, "history", () => {
      this.cache = undefined
      const data = this.load()
      const now = nowIso()
      const cur: HistoryRecord = data.records[seg.id] ?? {
        id: seg.id,
        project: seg.project,
        directory: seg.directory,
        startedAt: now,
        at: now,
        requests: [],
        problems: [],
        links: [],
      }
      if (seg.title) cur.title = clean(seg.title, 120)
      cur.at = now
      // first and latest requests are the most telling
      const reqs = [...cur.requests, ...requests.filter((r) => !cur.requests.includes(r))]
      cur.requests = reqs.length > MAX_REQUESTS ? [...reqs.slice(0, 3), ...reqs.slice(-(MAX_REQUESTS - 3))] : reqs
      for (const p of problems) {
        const same = cur.problems.find((x) => x.error === p.error)
        if (!same) cur.problems.push(p)
        else if (p.resolved && !same.resolved) Object.assign(same, p)
      }
      cur.problems = cur.problems.slice(-MAX_PROBLEMS)
      for (const l of seg.links) {
        const same = cur.links.find((x) => x.kind === l.kind && x.name === l.name)
        if (!same) cur.links.push({ ...l })
        else if (REL_RANK[l.rel] > REL_RANK[same.rel]) same.rel = l.rel
      }
      cur.links = cur.links.sort((a, b) => REL_RANK[b.rel] - REL_RANK[a.rel]).slice(0, MAX_LINKS)
      if (outcome) cur.outcome = outcome
      data.records[seg.id] = cur
      this.prune(data)
      writeJsonAtomic(this.file, data)
      this.cache = undefined
      return cur
    })
    void this.syncVectors()
    return rec
  }

  private prune(data: HistoryFile): void {
    const cutoff = Date.now() - this.o.history.days * 86_400_000
    const recs = Object.values(data.records)
      .filter((r) => Date.parse(r.at) >= cutoff)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, this.o.history.maxRecords)
    data.records = Object.fromEntries(recs.map((r) => [r.id, r]))
  }

  /** Embed new/changed records (background). */
  syncVectors(): Promise<number> {
    if (!this.enabled || !this.semantic?.client.configured) return Promise.resolve(0)
    this.syncing ??= (async () => {
      try {
        return await this.semantic!.syncCustom(
          this.ns,
          this.all().map((r) => ({ key: r.id, text: historyText(r) })),
        )
      } catch (err) {
        this.log.warn("session history embedding failed", String(err))
        return 0
      } finally {
        this.syncing = undefined
      }
    })()
    return this.syncing
  }

  private lexicalIndex(): MiniIndex {
    const records = this.all()
    if (this.lexical && this.lexical.revision === this.revision) return this.lexical.index
    const index = new MiniIndex(
      records.map((r) => ({
        id: r.id,
        fields: [
          [2, `${r.title ?? ""} ${r.links.map((l) => l.name.replace(/-/g, " ")).join(" ")}`],
          [1, historyText(r)],
        ],
      })),
    )
    this.lexical = { revision: this.revision, index }
    return index
  }

  /**
   * Hybrid search over the records (BM25 alone without embeddings).
   * `queryVector` given (even undefined) → no extra embedding call.
   */
  async search(
    query: string,
    opts: {
      limit?: number
      exclude?: string
      project?: string
      purpose?: Purpose
      minSimilarity?: number
      timeoutMs?: number
      queryVector?: Float32Array
      usefulOnly?: boolean
    } = {},
  ): Promise<HistoryHit[]> {
    if (!this.enabled || !query.trim()) return []
    const records = this.load().records
    const ok = (id: string) => {
      const r = records[id]
      if (!r || id === opts.exclude) return false
      if (opts.project && r.project !== opts.project) return false
      return !opts.usefulOnly || isUseful(r)
    }
    const lexical = this.lexicalIndex()
      .search(query, 40)
      .filter((h) => ok(h.id))
    let semantic: Array<{ id: string; similarity: number }> = []
    const sem = this.semantic
    if (sem && sem.available()) {
      void this.syncVectors()
      const vec = "queryVector" in opts ? opts.queryVector : await sem.embedQuery(query, opts.purpose ?? "search", opts.timeoutMs)
      if (vec) semantic = sem.scoreCustom(vec, this.ns).filter((h) => ok(h.id)).slice(0, 40)
    }
    const fused = rrf(lexical, semantic, opts.minSimilarity ?? this.o.embedding.searchMinSimilarity)
    return fused.slice(0, opts.limit ?? 5).map((f) => ({
      record: records[f.id],
      score: Math.round(f.score * 100000) / 100000,
      similarity: f.similarity,
      matched: f.lexical?.matched ?? [],
      coverage: f.lexical?.coverage ?? 0,
    }))
  }
}

/** Formatting for history_search and /history. */
export function formatRecord(r: HistoryRecord, opts: { currentProject?: string; detail?: boolean } = {}): string {
  const head = `${formatDate(r.at)}${r.project !== opts.currentProject ? ` · Projekt ${r.project}` : ""}${meaningfulTitle(r.title) ? ` · „${r.title}“` : ""} (Session ${r.id})`
  const lines = [head]
  const reqs = opts.detail ? r.requests : r.requests.slice(0, 2)
  for (const q of reqs) lines.push(`   Anfrage: ${q}`)
  for (const p of opts.detail ? r.problems : r.problems.slice(0, 2)) {
    lines.push(`   Problem${p.resolved ? " (gelöst)" : " (ungelöst)"}: ${p.error}${p.fix ? `\n     Lösung: ${p.fix}` : ""}`)
  }
  if (r.links.length) lines.push(`   Einträge: ${linkSummary(r, opts.detail ? MAX_LINKS : 5)}`)
  if (r.outcome && opts.detail) lines.push(`   Ergebnis: ${r.outcome}`)
  return lines.join("\n")
}
