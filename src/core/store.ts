/**
 * The store: one git-tracked directory with all entry kinds.
 *
 *   skills/<tier>/<name>/SKILL.md        knowledge/<tier>/<name>.md
 *   glossary/<tier>/<name>.md            errors/<tier>/<name>.md
 *   scripts/<tier>/<name>/{SCRIPT.md, <module>.py, test_<module>.py}
 *   meta/<kind>/<name>.json              candidates/<kind>/<id>.json
 *   glossary-ignore.json                 store.json
 *   state/                               (untracked runtime data)
 *
 * Reading is cached per kind and invalidated by a process-wide revision
 * counter; every mutation runs under the "store" lock and through a Run so
 * the touched paths can be committed exactly.
 */
import { readdirSync, renameSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import type { Logger } from "../log"
import type { Candidate, Entry, HistoryEntry, Kind, Meta, Run, Tier } from "../types"
import { KINDS } from "../types"
import {
  ensureDir,
  exists,
  findSkillFiles,
  isDir,
  listDirs,
  listFiles,
  readJson,
  readText,
  removePath,
  withLock,
  writeBufferAtomic,
  writeFileAtomic,
  writeJsonAtomic,
} from "../util/fs"
import { fold, nowIso, sha, slugify, tokenize } from "../util/text"
import { spec, type EntryContent } from "./kinds"

export interface ForeignRoot {
  root: string
  label: string
  adoptable: boolean
}

const HISTORY_CAP = 30
const EVIDENCE_CAP = 10
export const STORE_VERSION = 2

export class StoreError extends Error {}

/** Thrown when another active run holds uncommitted changes on the same path. */
export class ClaimedError extends Error {
  constructor(readonly runId: string, readonly path: string) {
    super(`"${path}" has uncommitted changes of concurrent run ${runId}`)
  }
}

function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/")
}

function processAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || pid <= 0) return true
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM"
  }
}

/** folders that never hold entries (attachments) */
export const ATTACHMENT_DIR = "_anhaenge"

function validFolder(folder: string): boolean {
  if (!folder) return true
  if (folder.length > 200 || folder.startsWith("/") || folder.endsWith("/")) return false
  return folder.split("/").every((p) => /^[A-Za-z0-9ÄÖÜäöüß_][A-Za-z0-9ÄÖÜäöüß _.-]{0,60}$/.test(p) && p !== "." && p !== ".." && p !== ATTACHMENT_DIR && !p.startsWith("."))
}

export function normalizeFolder(folder: string | undefined): string {
  const f = (folder ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean)
    .join("/")
  if (!validFolder(f)) throw new StoreError(`invalid folder "${folder}" (letters, digits, space, _ . -; no "${ATTACHMENT_DIR}", no leading dot)`)
  return f
}

export interface CreateOptions {
  reason?: string
  /** knowledge: folder below the tier */
  folder?: string
  tier?: Tier
  /** extra files in the entry directory (dir layout only), name → content */
  files?: Record<string, string | Uint8Array>
  meta?: Partial<Meta>
  action?: string
}

export interface UpdateChange {
  title?: string
  description?: string
  tags?: string[]
  fields?: Record<string, unknown>
  body?: string
  files?: Record<string, string | Uint8Array>
  baseVersion?: string
}

export class Store {
  readonly root: string
  readonly metaDir: string
  readonly candidatesDir: string
  readonly stateDir: string
  readonly locksDir: string
  readonly runsDir: string
  private shared: { version: number }
  private cache = new Map<Kind, { at: number; version: number; list: Entry[] }>()
  private foreignCache = new Map<string, { at: number; list: Entry[] }>()
  private foreignRootsFn: () => ForeignRoot[] = () => []
  /** folder kinds: "kind:name" → folder below the tier ("" = main folder) */
  private folders = new Map<string, string>()

  constructor(root: string, private log: Logger) {
    this.root = resolve(root)
    this.metaDir = join(this.root, "meta")
    this.candidatesDir = join(this.root, "candidates")
    this.stateDir = join(this.root, "state")
    this.locksDir = join(this.stateDir, "locks")
    this.runsDir = join(this.stateDir, "runs")
    const key = Symbol.for(`skillsmith.revision:${this.root}`)
    this.shared = ((globalThis as any)[key] ??= { version: 0 })
  }

  init(): void {
    for (const kind of KINDS) {
      for (const tier of spec(kind).tiers) ensureDir(this.tierDir(kind, tier))
      ensureDir(join(this.metaDir, kind))
      ensureDir(join(this.candidatesDir, kind))
    }
    ensureDir(this.stateDir)
    ensureDir(this.locksDir)
    ensureDir(this.runsDir)
    const readme = join(this.root, "README.md")
    const text =
      "# skillsmith store\n\nManaged by the skillsmith opencode plugin (skillsmith, docsmith, errorsmith, toolsmith, memorysmith, doctor).\n\n" +
      "- `skills/<tier>/<name>/SKILL.md` – procedures (skillsmith)\n" +
      "- `knowledge/<tier>/<folder…>/<name>.md` – documentation / knowledge base (docsmith and your own documents; folders, `.ordner.json` with folder defaults, `_anhaenge/<YYYY-MM>/` attachments, `_vorlagen/` templates)\n" +
      "- `glossary/<tier>/<name>.md` – abbreviations with meanings (docsmith)\n" +
      "- `errors/<tier>/<name>.md` – known errors with solutions (errorsmith)\n" +
      "- `scripts/<tier>/<name>/` – tested Python scripts (toolsmith)\n" +
      "- `memories/<tier>/<name>.md` – decisions, conventions and experiences of projects (memorysmith)\n" +
      "- `tasks/<tier>/<t-n>.md` – tasks of the boards (yours; memorysmith only suggests) · `tasks/.counter.json` – next task id\n" +
      "- `projects/<tier>/<name>.md` – projects with home_path, board columns and pipeline\n" +
      "- `meta/<kind>/` – origin, history, evidence, test status · `candidates/<kind>/` – recurring patterns\n\n" +
      "Front matter `author` (user|agent) and `ai` (frei|vorschlag|lesen|privat) decide what the AI may do with an entry.\n\n" +
      "`state/` is local runtime data (not tracked): audit log, metrics, pipeline runs, agent jobs, board order. Every change made by a background agent, a command or the web view is one git commit.\n"
    if (readText(readme) !== text) writeFileAtomic(readme, text)
    // fresh store: v2 from the start (v1 stores are migrated through a run, see migrate())
    if (!exists(join(this.root, "store.json")) && !this.hasV1Layout() && !exists(join(this.root, ".git"))) {
      writeJsonAtomic(join(this.root, "store.json"), { version: STORE_VERSION })
    }
  }

  setForeignRoots(fn: () => ForeignRoot[]): void {
    this.foreignRootsFn = fn
    this.foreignCache.clear()
  }

  // ---------------------------------------------------------------------------
  // layout
  // ---------------------------------------------------------------------------

  tierDir(kind: Kind, tier: Tier): string {
    return join(this.root, spec(kind).dir, tier)
  }

  /** directory registered in opencode's skills.paths */
  get activeDir(): string {
    return this.tierDir("skill", "active")
  }

  /** path of the entry node that moves between tiers (directory or file) */
  node(kind: Kind, tier: Tier, name: string, folder?: string): string {
    const s = spec(kind)
    if (s.layout === "dir") return join(this.tierDir(kind, tier), name)
    const f = s.folders ? (folder ?? this.folderOf(kind, name)) : ""
    return f ? join(this.tierDir(kind, tier), ...f.split("/"), `${name}.md`) : join(this.tierDir(kind, tier), `${name}.md`)
  }

  /** Folder of an entry of a folder kind ("" = main folder or unknown). */
  folderOf(kind: Kind, name: string): string {
    if (!spec(kind).folders) return ""
    const k = `${kind}:${name}`
    const known = this.folders.get(k)
    if (known !== undefined) return known
    this.locate(kind, name)
    return this.folders.get(k) ?? ""
  }

  /** Walk the tiers of a folder kind for <name>.md (cache miss, moved by another process). */
  private locate(kind: Kind, name: string): void {
    for (const tier of spec(kind).tiers) {
      for (const hit of this.walk(this.tierDir(kind, tier))) {
        if (hit.name === name) {
          this.folders.set(`${kind}:${name}`, hit.folder)
          return
        }
      }
    }
  }

  /** *.md below a tier directory with their folder (attachments and dot folders skipped). */
  walk(dir: string, folder = "", depth = 0): Array<{ folder: string; name: string }> {
    const out: Array<{ folder: string; name: string }> = []
    if (depth > 8) return out
    for (const f of listFiles(dir, ".md")) out.push({ folder, name: f.slice(0, -3) })
    for (const d of listDirs(dir)) {
      if (d === ATTACHMENT_DIR || d.startsWith(".")) continue
      out.push(...this.walk(join(dir, d), folder ? `${folder}/${d}` : d, depth + 1))
    }
    return out
  }

  /** All folders of a folder kind (tier "active" plus every folder that holds an entry). */
  listFolders(kind: Kind): string[] {
    const out = new Set<string>()
    const scan = (dir: string, folder: string, depth: number) => {
      if (depth > 8) return
      for (const d of listDirs(dir)) {
        if (d === ATTACHMENT_DIR || d.startsWith(".")) continue
        const f = folder ? `${folder}/${d}` : d
        out.add(f)
        scan(join(dir, d), f, depth + 1)
      }
    }
    for (const tier of spec(kind).tiers) scan(this.tierDir(kind, tier), "", 0)
    return [...out].sort((a, b) => a.localeCompare(b))
  }

  mainFile(kind: Kind, tier: Tier, name: string, folder?: string): string {
    const s = spec(kind)
    return s.layout === "dir" ? join(this.node(kind, tier, name), s.main) : this.node(kind, tier, name, folder)
  }

  metaFile(kind: Kind, name: string): string {
    return join(this.metaDir, kind, `${name}.json`)
  }

  get revision(): number {
    return this.shared.version
  }

  bump(): void {
    this.shared.version++
    this.cache.clear()
  }

  rel(path: string): string {
    return relative(this.root, path).split(sep).join("/")
  }

  /** Store-relative paths a change of an entry may touch (claims). */
  entryPaths(kind: Kind, name: string): string[] {
    return [this.rel(this.metaFile(kind, name)), ...spec(kind).tiers.map((t) => this.rel(this.node(kind, t, name)))]
  }

  /** @deprecated use entryPaths("skill", name) */
  skillPaths(name: string): string[] {
    return this.entryPaths("skill", name)
  }

  candidatePath(kind: Kind, id: string): string {
    return `candidates/${kind}/${id}.json`
  }

  // ---------------------------------------------------------------------------
  // reading
  // ---------------------------------------------------------------------------

  private readEntry(kind: Kind, file: string, tier: Tier | "foreign", owned: boolean, source?: string, folder?: string): Entry | undefined {
    const content = readText(file)
    if (content === undefined) return undefined
    const s = spec(kind)
    const fallback = s.layout === "dir" ? basename(dirname(file)) : basename(file).replace(/\.md$/, "")
    const c = s.parse(content, fallback)
    return {
      kind,
      name: c.name,
      title: c.title,
      description: c.description,
      tags: c.tags,
      fields: c.fields,
      body: c.body,
      tier,
      owned,
      dir: dirname(file),
      file,
      version: sha(content),
      meta: owned ? this.readMeta(kind, c.name) : undefined,
      source,
      ...(spec(kind).folders ? { folder: folder ?? "" } : {}),
    }
  }

  list(kind: Kind): Entry[] {
    // ids from audit targets, links or older data can name an unknown kind – never crash on them
    const s = spec(kind)
    if (!s) return []
    const cached = this.cache.get(kind)
    if (cached && cached.version === this.shared.version && Date.now() - cached.at < 5000) return cached.list
    const seen = new Map<string, Entry>()
    for (const tier of s.tiers) {
      const dir = this.tierDir(kind, tier)
      const names: Array<{ name: string; folder: string }> =
        s.layout === "dir"
          ? listDirs(dir)
              .filter((n) => exists(join(dir, n, s.main)))
              .map((name) => ({ name, folder: "" }))
          : s.folders
            ? this.walk(dir)
            : listFiles(dir, ".md").map((f) => ({ name: f.slice(0, -3), folder: "" }))
      for (const { name, folder } of names) {
        if (s.folders) this.folders.set(`${kind}:${name}`, folder)
        const rec = this.readEntry(kind, this.mainFile(kind, tier, name, folder), tier, true, undefined, folder)
        if (!rec) continue
        if (seen.has(rec.name)) {
          this.log.warn(`${kind} "${rec.name}" exists in several tiers; using ${seen.get(rec.name)!.tier}`)
          continue
        }
        seen.set(rec.name, rec)
      }
    }
    const list = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
    this.cache.set(kind, { at: Date.now(), version: this.shared.version, list })
    return list
  }

  /** @deprecated use list("skill") */
  listOwned(): Entry[] {
    return this.list("skill")
  }

  listEverything(includeForeign = true): Entry[] {
    const all: Entry[] = []
    for (const kind of KINDS) all.push(...this.list(kind))
    if (includeForeign) all.push(...this.listForeign())
    return all
  }

  foreignRoots(): ForeignRoot[] {
    return this.foreignRootsFn().filter((r) => {
      const root = resolve(r.root)
      return !(root === this.root || root.startsWith(this.root + sep)) && isDir(root)
    })
  }

  /** Skills from other locations opencode loads (read-only for skillsmith). */
  listForeign(): Entry[] {
    const out: Entry[] = []
    const ownedNames = new Set(this.list("skill").map((s) => s.name))
    const seen = new Set<string>()
    for (const root of this.foreignRoots()) {
      const k = resolve(root.root)
      let cached = this.foreignCache.get(k)
      if (!cached || Date.now() - cached.at > 30_000) {
        const list: Entry[] = []
        for (const file of findSkillFiles(k, 6, true)) {
          if (file.split(sep).some((part) => part.startsWith(".archive"))) continue
          const rec = this.readEntry("skill", file, "foreign", false, root.label)
          if (rec) list.push(rec)
        }
        cached = { at: Date.now(), list }
        this.foreignCache.set(k, cached)
      }
      for (const rec of cached.list) {
        if (ownedNames.has(rec.name) || seen.has(rec.name)) continue
        seen.add(rec.name)
        out.push(rec)
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  getOwned(kind: Kind, name: string): Entry | undefined {
    return this.list(kind).find((e) => e.name === name)
  }

  get(kind: Kind, name: string): Entry | undefined {
    return this.getOwned(kind, name) ?? (kind === "skill" ? this.listForeign().find((s) => s.name === name) : undefined)
  }

  /** Fresh read from disk (bypasses caches) – used right before mutations. */
  fresh(kind: Kind, name: string): Entry | undefined {
    const s = spec(kind)
    if (!s) return undefined
    for (let attempt = 0; attempt < (s.folders ? 2 : 1); attempt++) {
      if (attempt === 1) {
        // moved by another process or the cache is stale
        this.folders.delete(`${kind}:${name}`)
        this.locate(kind, name)
      }
      const folder = s.folders ? this.folderOf(kind, name) : undefined
      for (const tier of s.tiers) {
        const file = this.mainFile(kind, tier, name, folder)
        if (exists(file)) return this.readEntry(kind, file, tier, true, undefined, folder)
      }
    }
    return undefined
  }

  readMeta(kind: Kind, name: string): Meta | undefined {
    const meta = readJson<Meta | null>(this.metaFile(kind, name), null)
    if (!meta) return undefined
    meta.kind ??= kind
    meta.history ??= []
    return meta
  }

  /** Files next to the main file (dir layout), sampled. */
  supportFiles(rec: Entry, limit = 20): string[] {
    if (spec(rec.kind).layout !== "dir") return []
    const out: string[] = []
    const walk = (dir: string, depth: number) => {
      if (depth > 3 || out.length >= limit) return
      for (const f of listFiles(dir)) {
        if (dir === rec.dir && f === spec(rec.kind).main) continue
        out.push(join(dir, f))
        if (out.length >= limit) return
      }
      for (const d of listDirs(dir)) {
        if (d === "__pycache__") continue
        walk(join(dir, d), depth + 1)
      }
    }
    walk(rec.dir, 0)
    return out
  }

  readFileOf(rec: Entry, file: string): string | undefined {
    return readText(join(rec.dir, file))
  }

  /** Glossary entries whose term or alias equals `term` (case/diacritic-insensitive). */
  glossaryByTerm(term: string): Entry[] {
    const t = fold(term).replace(/[^a-z0-9]/g, "")
    if (!t) return []
    return this.list("glossary").filter((e) => {
      const terms = [String(e.fields.term ?? ""), ...((e.fields.aliases as string[]) ?? [])]
      return terms.some((x) => fold(x).replace(/[^a-z0-9]/g, "") === t)
    })
  }

  // ---------------------------------------------------------------------------
  // claims (cross-run git attribution)
  // ---------------------------------------------------------------------------

  private touch(run: Run, ...paths: string[]): void {
    for (const p of paths) run.touched.add(this.rel(p))
    this.registerRun(run)
  }

  registerRun(run: Run): void {
    try {
      writeJsonAtomic(join(this.runsDir, `${run.id}.json`), {
        id: run.id,
        pid: process.pid,
        at: Date.now(),
        touched: [...run.touched].sort(),
      })
    } catch (err) {
      this.log.warn("could not register run", String(err))
    }
  }

  unregisterRun(run: Run): void {
    removePath(join(this.runsDir, `${run.id}.json`))
  }

  private liveRuns(maxAgeMs = 3 * 3600_000): Array<{ id: string; touched: string[] }> {
    const out: Array<{ id: string; touched: string[] }> = []
    for (const f of listFiles(this.runsDir, ".json")) {
      const data = readJson<{ id?: string; pid?: number; at?: number; touched?: string[] }>(join(this.runsDir, f), {})
      if (!data.at || Date.now() - data.at > maxAgeMs || !processAlive(data.pid)) continue
      out.push({ id: data.id ?? f.slice(0, -5), touched: data.touched ?? [] })
    }
    return out
  }

  claimedPaths(maxAgeMs = 3 * 3600_000): Set<string> {
    const out = new Set<string>()
    for (const r of this.liveRuns(maxAgeMs)) for (const t of r.touched) out.add(t)
    return out
  }

  claimedBy(runId: string, paths: string[]): { runId: string; path: string } | undefined {
    for (const r of this.liveRuns()) {
      if (r.id === runId) continue
      for (const t of r.touched) for (const p of paths) if (pathsOverlap(t, p)) return { runId: r.id, path: p }
    }
    return undefined
  }

  // ---------------------------------------------------------------------------
  // mutation helpers
  // ---------------------------------------------------------------------------

  private writeMeta(run: Run, meta: Meta): void {
    meta.history = meta.history.slice(-HISTORY_CAP)
    if (meta.evidence) meta.evidence = meta.evidence.slice(0, EVIDENCE_CAP)
    if (meta.projects) meta.projects = [...new Set(meta.projects)].slice(-20)
    if (meta.related) meta.related = [...new Set(meta.related)].slice(0, 30)
    const file = this.metaFile(meta.kind, meta.name)
    writeJsonAtomic(file, meta)
    this.touch(run, file)
  }

  private historyEntry(run: Run, action: string, reason?: string): HistoryEntry {
    return { at: nowIso(), runId: run.id, actor: run.actor, action, ...(reason ? { reason } : {}) }
  }

  private ensureMeta(rec: Entry): Meta {
    const existing = this.readMeta(rec.kind, rec.name)
    if (existing) return existing
    const now = nowIso()
    return { kind: rec.kind, name: rec.name, createdAt: now, createdBy: "command", updatedAt: now, tierChangedAt: now, history: [] }
  }

  private applyMetaPatch(meta: Meta, patch: Partial<Meta> | undefined): void {
    if (!patch) return
    const { evidence, projects, related, ...rest } = patch
    Object.assign(meta, rest)
    if (evidence?.length) meta.evidence = [...evidence, ...(meta.evidence ?? [])]
    if (projects?.length) meta.projects = [...(meta.projects ?? []), ...projects]
    if (related?.length) meta.related = [...(meta.related ?? []), ...related]
  }

  private mutate<T>(fn: () => T): Promise<T> {
    return withLock(this.locksDir, "store", () => {
      try {
        return fn()
      } finally {
        this.bump()
      }
    })
  }

  private writeEntry(kind: Kind, tier: Tier, content: EntryContent, files?: Record<string, string | Uint8Array>, folder?: string): string[] {
    const s = spec(kind)
    const main = this.mainFile(kind, tier, content.name, folder)
    ensureDir(dirname(main))
    writeFileAtomic(main, s.serialize(content))
    const written = [main]
    if (files) {
      if (s.layout !== "dir") throw new StoreError(`${kind} entries have no extra files`)
      for (const [fname, text] of Object.entries(files)) {
        if (!/^[A-Za-z0-9_.-]+$/.test(fname) || fname === s.main) throw new StoreError(`invalid file name ${fname}`)
        const p = join(dirname(main), fname)
        if (typeof text === "string") writeFileAtomic(p, text)
        else writeBufferAtomic(p, text)
        written.push(p)
      }
    }
    return written
  }

  private contentOf(rec: Entry): EntryContent {
    return { name: rec.name, title: rec.title, description: rec.description, tags: rec.tags, fields: { ...rec.fields }, body: rec.body }
  }

  // ---------------------------------------------------------------------------
  // mutations (always through a Run)
  // ---------------------------------------------------------------------------

  create(run: Run, kind: Kind, content: EntryContent, opts: CreateOptions = {}): Promise<Entry> {
    return this.mutate(() => {
      if (this.fresh(kind, content.name)) throw new StoreError(`${kind} "${content.name}" already exists`)
      const tier = opts.tier ?? "active"
      const folder = spec(kind).folders ? normalizeFolder(opts.folder) : undefined
      if (folder !== undefined) this.folders.set(`${kind}:${content.name}`, folder)
      this.writeEntry(kind, tier, content, opts.files, folder)
      this.touch(run, this.node(kind, tier, content.name, folder))
      const now = nowIso()
      const meta: Meta = {
        kind,
        name: content.name,
        createdAt: now,
        createdBy: run.actor,
        updatedAt: now,
        tierChangedAt: now,
        origin: {
          runId: run.id,
          ...(run.sessionID ? { sessionID: run.sessionID } : {}),
          ...(run.sessionAgent ? { agent: run.sessionAgent } : {}),
          project: run.project,
        },
        projects: run.project ? [run.project] : [],
        history: [this.historyEntry(run, opts.action ?? "create", opts.reason)],
      }
      this.applyMetaPatch(meta, opts.meta)
      this.writeMeta(run, meta)
      return this.fresh(kind, content.name)!
    })
  }

  update(run: Run, kind: Kind, name: string, change: UpdateChange, action: string, reason?: string, metaPatch?: Partial<Meta>): Promise<Entry> {
    return this.mutate(() => {
      const rec = this.fresh(kind, name)
      if (!rec) throw new StoreError(`${kind} "${name}" not found among skillsmith-owned entries`)
      if (change.baseVersion && change.baseVersion !== rec.version) {
        throw new StoreError(`${kind} "${name}" changed since you read it (version ${rec.version}, you had ${change.baseVersion}); read it again`)
      }
      const content = this.contentOf(rec)
      if (change.title !== undefined) content.title = change.title
      if (change.description !== undefined) content.description = change.description
      if (change.tags !== undefined) content.tags = change.tags
      if (change.fields) content.fields = { ...content.fields, ...change.fields }
      if (change.body !== undefined) content.body = change.body
      const written = this.writeEntry(kind, rec.tier as Tier, content, change.files)
      this.touch(run, ...written)
      const meta = this.ensureMeta(rec)
      meta.updatedAt = nowIso()
      if (run.project) meta.projects = [...(meta.projects ?? []), run.project]
      this.applyMetaPatch(meta, metaPatch)
      meta.history.push(this.historyEntry(run, action, reason))
      this.writeMeta(run, meta)
      return this.fresh(kind, name)!
    })
  }

  patchBody(
    run: Run,
    kind: Kind,
    name: string,
    oldText: string,
    newText: string,
    reason?: string,
    validate?: (body: string) => void,
    metaPatch?: Partial<Meta>,
  ): Promise<Entry> {
    return this.mutate(() => {
      const rec = this.fresh(kind, name)
      if (!rec) throw new StoreError(`${kind} "${name}" not found among skillsmith-owned entries`)
      if (!oldText) throw new StoreError("old_text is empty")
      const occurrences = rec.body.split(oldText).length - 1
      if (occurrences === 0) {
        throw new StoreError(`old_text not found in "${name}" (it may have changed concurrently); read it again and copy the text exactly`)
      }
      if (occurrences > 1) throw new StoreError(`old_text occurs ${occurrences} times in "${name}"; include more context`)
      const content = this.contentOf(rec)
      content.body = rec.body.replace(oldText, () => newText)
      validate?.(content.body)
      const written = this.writeEntry(kind, rec.tier as Tier, content)
      this.touch(run, ...written)
      const meta = this.ensureMeta(rec)
      meta.updatedAt = nowIso()
      if (run.project) meta.projects = [...(meta.projects ?? []), run.project]
      this.applyMetaPatch(meta, metaPatch)
      meta.history.push(this.historyEntry(run, "patch", reason))
      this.writeMeta(run, meta)
      return this.fresh(kind, name)!
    })
  }

  /** Metadata change by a function (rename: relations, related, absorbedInto are replaced, not appended). */
  editMeta(run: Run, kind: Kind, name: string, fn: (meta: Meta) => void, action?: string, reason?: string): Promise<Meta> {
    return this.mutate(() => {
      const rec = this.fresh(kind, name)
      if (!rec) throw new StoreError(`${kind} "${name}" not found`)
      const meta = this.ensureMeta(rec)
      fn(meta)
      if (action) meta.history.push(this.historyEntry(run, action, reason))
      this.writeMeta(run, meta)
      return meta
    })
  }

  /** Metadata-only change (test status, evidence, related, …). */
  updateMeta(run: Run, kind: Kind, name: string, patch: Partial<Meta>, action?: string, reason?: string): Promise<Meta> {
    return this.mutate(() => {
      const rec = this.fresh(kind, name)
      if (!rec) throw new StoreError(`${kind} "${name}" not found`)
      const meta = this.ensureMeta(rec)
      this.applyMetaPatch(meta, patch)
      if (action) meta.history.push(this.historyEntry(run, action, reason))
      this.writeMeta(run, meta)
      return meta
    })
  }

  move(run: Run, kind: Kind, name: string, to: Tier, action: string, reason?: string, extra?: Partial<Meta>): Promise<Entry> {
    return this.mutate(() => {
      const rec = this.fresh(kind, name)
      if (!rec) throw new StoreError(`${kind} "${name}" not found among skillsmith-owned entries`)
      if (!spec(kind).tiers.includes(to)) throw new StoreError(`${kind} entries have no tier "${to}"`)
      if (rec.tier === to) return rec
      const from = this.node(kind, rec.tier as Tier, name)
      const target = this.node(kind, to, name)
      if (exists(target)) removePath(target)
      ensureDir(dirname(target))
      renameSync(from, target)
      this.touch(run, from, target)
      const meta = this.ensureMeta(rec)
      meta.tierChangedAt = nowIso()
      if (extra) {
        for (const [k, v] of Object.entries(extra)) {
          if (v === undefined) delete (meta as any)[k]
          else (meta as any)[k] = v
        }
      }
      meta.history.push(this.historyEntry(run, action, reason))
      this.writeMeta(run, meta)
      return this.fresh(kind, name)!
    })
  }

  /** Rename an entry (file or directory and meta); links in other entries are the caller's job. */
  rename(run: Run, kind: Kind, from: string, to: string, reason?: string): Promise<Entry> {
    return this.mutate(() => {
      const rec = this.fresh(kind, from)
      if (!rec) throw new StoreError(`${kind} "${from}" not found among skillsmith-owned entries`)
      if (this.fresh(kind, to)) throw new StoreError(`${kind} "${to}" already exists`)
      const s = spec(kind)
      const tier = rec.tier as Tier
      const folder = rec.folder
      const oldNode = this.node(kind, tier, from, folder)
      const newNode = this.node(kind, tier, to, folder)
      ensureDir(dirname(newNode))
      renameSync(oldNode, newNode)
      if (s.folders) {
        this.folders.delete(`${kind}:${from}`)
        this.folders.set(`${kind}:${to}`, folder ?? "")
      }
      const content = this.contentOf(rec)
      content.name = to
      if (content.title === from) content.title = to
      writeFileAtomic(this.mainFile(kind, tier, to, folder), s.serialize(content))
      this.touch(run, oldNode, newNode)
      const meta = this.ensureMeta(rec)
      const oldMeta = this.metaFile(kind, from)
      meta.name = to
      meta.updatedAt = nowIso()
      meta.history.push(this.historyEntry(run, `rename(${from} → ${to})`, reason))
      this.writeMeta(run, meta)
      if (exists(oldMeta)) {
        removePath(oldMeta)
        this.touch(run, oldMeta)
      }
      return this.fresh(kind, to)!
    })
  }

  /** Delete an archived entry for good (git keeps its history). */
  remove(run: Run, kind: Kind, name: string): Promise<void> {
    return this.mutate(() => {
      const rec = this.fresh(kind, name)
      if (!rec) throw new StoreError(`${kind} "${name}" not found`)
      if (rec.tier !== "archive") throw new StoreError(`only archived entries can be deleted ("${name}" is ${rec.tier})`)
      const node = this.node(kind, "archive", name, rec.folder)
      removePath(node)
      const meta = this.metaFile(kind, name)
      if (exists(meta)) removePath(meta)
      this.folders.delete(`${kind}:${name}`)
      this.touch(run, node, meta)
    })
  }

  /** Write a binary file below the store (attachments); returns the store-relative path. */
  writeAttachment(run: Run, relPath: string, data: Uint8Array): Promise<string> {
    return this.mutate(() => {
      const full = resolve(this.root, relPath)
      if (!full.startsWith(this.root + sep)) throw new StoreError("invalid attachment path")
      ensureDir(dirname(full))
      writeBufferAtomic(full, data)
      this.touch(run, full)
      return this.rel(full)
    })
  }

  /** Write tracked JSON below the store (task counter, folder settings, …). */
  writeTracked(run: Run, relPath: string, value: unknown): Promise<void> {
    return this.mutate(() => {
      const full = resolve(this.root, relPath)
      if (!full.startsWith(this.root + sep) || full.startsWith(this.stateDir + sep)) throw new StoreError("invalid path")
      writeJsonAtomic(full, value)
      this.touch(run, full)
    })
  }

  /** Under the store lock: read-modify-write a tracked JSON file (atomic counters). */
  updateTracked<T>(run: Run, relPath: string, fallback: T, fn: (cur: T) => T): Promise<T> {
    return this.mutate(() => {
      const full = resolve(this.root, relPath)
      if (!full.startsWith(this.root + sep) || full.startsWith(this.stateDir + sep)) throw new StoreError("invalid path")
      const next = fn(readJson<T>(full, fallback))
      writeJsonAtomic(full, next)
      this.touch(run, full)
      return next
    })
  }

  /** Move an entry of a folder kind to another folder (same tier). */
  relocate(run: Run, kind: Kind, name: string, folderRaw: string, reason?: string): Promise<Entry> {
    return this.mutate(() => {
      if (!spec(kind).folders) throw new StoreError(`${kind} entries have no folders`)
      const rec = this.fresh(kind, name)
      if (!rec) throw new StoreError(`${kind} "${name}" not found among skillsmith-owned entries`)
      const folder = normalizeFolder(folderRaw)
      if ((rec.folder ?? "") === folder) return rec
      const tier = rec.tier as Tier
      const from = this.node(kind, tier, name, rec.folder ?? "")
      const target = this.node(kind, tier, name, folder)
      if (exists(target)) throw new StoreError(`target ${this.rel(target)} already exists`)
      ensureDir(dirname(target))
      renameSync(from, target)
      this.folders.set(`${kind}:${name}`, folder)
      this.touch(run, from, target)
      const meta = this.ensureMeta(rec)
      meta.history.push(this.historyEntry(run, "move-folder", reason ?? `${rec.folder || "/"} → ${folder || "/"}`))
      this.writeMeta(run, meta)
      return this.fresh(kind, name)!
    })
  }

  setPinned(run: Run, kind: Kind, name: string, pinned: boolean): Promise<Entry> {
    return this.mutate(() => {
      const rec = this.fresh(kind, name)
      if (!rec) throw new StoreError(`${kind} "${name}" not found among skillsmith-owned entries`)
      const meta = this.ensureMeta(rec)
      if (pinned) meta.pinned = true
      else delete meta.pinned
      meta.history.push(this.historyEntry(run, pinned ? "pin" : "unpin"))
      this.writeMeta(run, meta)
      return this.fresh(kind, name)!
    })
  }

  /**
   * Merge: target gets the new content (created active if new, moved to active
   * if it lived elsewhere); every other source moves to archive with absorbedInto.
   */
  merge(run: Run, kind: Kind, input: { sources: string[]; content: EntryContent; reason?: string }): Promise<Entry> {
    return this.mutate(() => {
      const target = input.content.name
      const sources = [...new Set(input.sources)]
      for (const s of sources) {
        if (!this.fresh(kind, s)) throw new StoreError(`merge source "${s}" not found among skillsmith-owned ${kind} entries`)
      }
      const archiveTier: Tier = spec(kind).tiers.includes("archive") ? "archive" : spec(kind).tiers[spec(kind).tiers.length - 1]
      const existing = this.fresh(kind, target)
      const now = nowIso()
      if (existing) {
        let tier = existing.tier as Tier
        if (tier !== "active") {
          const from = this.node(kind, tier, target)
          const to = this.node(kind, "active", target)
          ensureDir(dirname(to))
          renameSync(from, to)
          this.touch(run, from, to)
          tier = "active"
        }
        const written = this.writeEntry(kind, tier, input.content)
        this.touch(run, ...written)
        const meta = this.ensureMeta(existing)
        meta.updatedAt = now
        if (existing.tier !== "active") meta.tierChangedAt = now
        delete meta.absorbedInto
        meta.related = [...(meta.related ?? []), ...sources.filter((s) => s !== target).map((s) => `${kind}:${s}`)]
        meta.history.push(this.historyEntry(run, `merge-target(${sources.filter((s) => s !== target).join(",")})`, input.reason))
        this.writeMeta(run, meta)
      } else {
        this.writeEntry(kind, "active", input.content)
        this.touch(run, this.node(kind, "active", target))
        this.writeMeta(run, {
          kind,
          name: target,
          createdAt: now,
          createdBy: run.actor,
          updatedAt: now,
          tierChangedAt: now,
          origin: { runId: run.id, project: run.project },
          related: sources.map((s) => `${kind}:${s}`),
          history: [this.historyEntry(run, `merge-create(${sources.join(",")})`, input.reason)],
        })
      }
      for (const s of sources) {
        if (s === target) continue
        const rec = this.fresh(kind, s)!
        if (rec.tier !== archiveTier) {
          const from = this.node(kind, rec.tier as Tier, s)
          const to = this.node(kind, archiveTier, s)
          if (exists(to)) removePath(to)
          ensureDir(dirname(to))
          renameSync(from, to)
          this.touch(run, from, to)
        }
        const meta = this.ensureMeta(rec)
        meta.absorbedInto = target
        meta.tierChangedAt = now
        meta.history.push(this.historyEntry(run, `absorbed-into(${target})`, input.reason))
        this.writeMeta(run, meta)
      }
      return this.fresh(kind, target)!
    })
  }

  /** Move a foreign skill directory into the store (active tier) → skillsmith-owned. */
  adopt(run: Run, name: string): Promise<Entry> {
    return this.mutate(() => {
      if (this.fresh("skill", name)) throw new StoreError(`skill "${name}" is already owned by skillsmith`)
      const foreign = this.listForeign().find((s) => s.name === name)
      if (!foreign) throw new StoreError(`foreign skill "${name}" not found`)
      const root = this.foreignRoots().find((r) => foreign.file.startsWith(resolve(r.root) + sep))
      if (!root?.adoptable) {
        throw new StoreError(`"${name}" lives in ${root?.label ?? "an unknown location"} and cannot be adopted (only global skill folders are adoptable)`)
      }
      const target = this.node("skill", "active", name)
      if (exists(target)) throw new StoreError(`target ${target} already exists`)
      renameSync(foreign.dir, target)
      this.foreignCache.clear()
      this.touch(run, target)
      const now = nowIso()
      this.writeMeta(run, {
        kind: "skill",
        name,
        createdAt: now,
        createdBy: run.actor,
        updatedAt: now,
        tierChangedAt: now,
        origin: { runId: run.id, adoptedFrom: foreign.dir },
        history: [this.historyEntry(run, "adopt", `from ${foreign.dir}`)],
      })
      return this.fresh("skill", name)!
    })
  }

  // ---------------------------------------------------------------------------
  // candidates (recurrence gate), per kind
  // ---------------------------------------------------------------------------

  candidates(kind?: Kind): Candidate[] {
    const kinds = kind ? [kind] : KINDS
    const out: Candidate[] = []
    for (const k of kinds) {
      const dir = join(this.candidatesDir, k)
      for (const f of listFiles(dir, ".json")) {
        const c = readJson<Candidate | null>(join(dir, f), null)
        if (c && c.id) out.push({ ...c, kind: c.kind ?? k })
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  candidate(kind: Kind, id: string): Candidate | undefined {
    const c = readJson<Candidate | null>(join(this.candidatesDir, kind, `${id}.json`), null)
    return c ? { ...c, kind: c.kind ?? kind } : undefined
  }

  findSimilarCandidate(kind: Kind, summary: string, keywords: string[]): Candidate | undefined {
    const terms = new Set([...tokenize(summary), ...keywords.flatMap((k) => tokenize(k))])
    if (terms.size === 0) return undefined
    let best: { c: Candidate; score: number } | undefined
    for (const c of this.candidates(kind)) {
      if (c.promotedTo) continue
      const other = new Set([...tokenize(c.summary), ...c.keywords.flatMap((k) => tokenize(k))])
      const inter = [...terms].filter((t) => other.has(t)).length
      const union = new Set([...terms, ...other]).size
      const score = union ? inter / union : 0
      if (score >= 0.5 && (!best || score > best.score)) best = { c, score }
    }
    return best?.c
  }

  noteCandidate(
    run: Run,
    kind: Kind,
    input: { id?: string; summary: string; keywords: string[]; sessionID?: string; fixedId?: string },
    opts: { checkClaims?: boolean } = {},
  ): Promise<{ candidate: Candidate; created: boolean }> {
    return this.mutate(() => {
      let candidate = input.id ? this.candidate(kind, input.id) : undefined
      if (input.id && !candidate) throw new StoreError(`candidate "${input.id}" not found`)
      if (!candidate && input.fixedId) candidate = this.candidate(kind, input.fixedId)
      if (!candidate && !input.fixedId) candidate = this.findSimilarCandidate(kind, input.summary, input.keywords)
      if (candidate && opts.checkClaims !== false) {
        const claim = this.claimedBy(run.id, [this.candidatePath(kind, candidate.id)])
        if (claim) throw new ClaimedError(claim.runId, claim.path)
      }
      const now = nowIso()
      let created = false
      if (!candidate) {
        created = true
        const id = input.fixedId ?? `${slugify(input.summary, 40) || "candidate"}-${sha(fold(input.summary), 4)}`
        candidate = { kind, id, summary: input.summary, keywords: [], sessions: [], count: 0, createdAt: now, updatedAt: now }
      }
      candidate.kind = kind
      candidate.summary = input.summary || candidate.summary
      candidate.keywords = [...new Set([...candidate.keywords, ...input.keywords.map((k) => k.trim()).filter(Boolean)])].slice(0, 20)
      if (input.sessionID && !candidate.sessions.includes(input.sessionID)) candidate.sessions = [...candidate.sessions, input.sessionID].slice(-20)
      candidate.count += 1
      candidate.updatedAt = now
      const file = join(this.candidatesDir, kind, `${candidate.id}.json`)
      writeJsonAtomic(file, candidate)
      this.touch(run, file)
      return { candidate, created }
    })
  }

  markCandidatePromoted(run: Run, kind: Kind, id: string, name: string): Promise<void> {
    return this.mutate(() => {
      const c = this.candidate(kind, id)
      if (!c) return
      c.promotedTo = name
      c.updatedAt = nowIso()
      const file = join(this.candidatesDir, kind, `${id}.json`)
      writeJsonAtomic(file, c)
      this.touch(run, file)
    })
  }

  // ---------------------------------------------------------------------------
  // glossary ignore list (tracked)
  // ---------------------------------------------------------------------------

  ignoredTerms(): string[] {
    return readJson<string[]>(join(this.root, "glossary-ignore.json"), [])
  }

  addIgnoredTerms(run: Run, terms: string[]): Promise<string[]> {
    return this.mutate(() => {
      const file = join(this.root, "glossary-ignore.json")
      const list = readJson<string[]>(file, [])
      for (const t of terms) if (!list.some((x) => fold(x) === fold(t))) list.push(t)
      list.sort((a, b) => a.localeCompare(b))
      writeJsonAtomic(file, list)
      this.touch(run, file)
      return list
    })
  }

  // ---------------------------------------------------------------------------
  // migration v1 → v2
  // ---------------------------------------------------------------------------

  storeVersion(): number {
    const v = readJson<{ version?: number }>(join(this.root, "store.json"), {})
    if (typeof v.version === "number") return v.version
    return this.hasV1Layout() ? 1 : 0
  }

  private hasV1Layout(): boolean {
    return listFiles(this.metaDir, ".json").length > 0 || listFiles(this.candidatesDir, ".json").length > 0
  }

  /** Move v1 meta/candidates into kind folders and write store.json. Returns moved file count. */
  migrate(run: Run): Promise<number> {
    return this.mutate(() => {
      let moved = 0
      for (const f of listFiles(this.metaDir, ".json")) {
        const from = join(this.metaDir, f)
        const to = join(this.metaDir, "skill", f)
        const meta = readJson<Record<string, unknown>>(from, {})
        writeJsonAtomic(to, { ...meta, kind: "skill" })
        removePath(from)
        this.touch(run, from, to)
        moved++
      }
      for (const f of listFiles(this.candidatesDir, ".json")) {
        const from = join(this.candidatesDir, f)
        const to = join(this.candidatesDir, "skill", f)
        const c = readJson<Record<string, unknown>>(from, {})
        writeJsonAtomic(to, { ...c, kind: "skill" })
        removePath(from)
        this.touch(run, from, to)
        moved++
      }
      const file = join(this.root, "store.json")
      writeJsonAtomic(file, { version: STORE_VERSION })
      this.touch(run, file, join(this.root, "README.md"))
      return moved
    })
  }

  /** mtime of the newest file below a directory (shallow, for change detection). */
  dirMtime(dir: string): number {
    let max = 0
    try {
      for (const e of readdirSync(dir)) {
        try {
          max = Math.max(max, statSync(join(dir, e)).mtimeMs)
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
    return max
  }
}

/** @deprecated name kept for older imports */
export { Store as SkillStore }

/** Skill locations opencode itself discovers (mirrors opencode 1.18 skill discovery). */
export function defaultForeignRoots(input: {
  directory: string
  worktree: string
  configDir: string
  extraPaths: string[]
  env?: NodeJS.ProcessEnv
}): ForeignRoot[] {
  const env = input.env ?? process.env
  const home = homedir()
  const roots: ForeignRoot[] = []
  const add = (root: string, label: string, adoptable: boolean) => {
    if (!roots.some((r) => resolve(r.root) === resolve(root))) roots.push({ root, label, adoptable })
  }
  add(join(input.configDir, "skills"), "~/.config/opencode/skills", true)
  add(join(input.configDir, "skill"), "~/.config/opencode/skill", true)
  if (env.OPENCODE_DISABLE_EXTERNAL_SKILLS !== "1" && env.OPENCODE_DISABLE_EXTERNAL_SKILLS !== "true") {
    add(join(home, ".agents", "skills"), "~/.agents/skills", true)
    if (env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS !== "1" && env.OPENCODE_DISABLE_CLAUDE_CODE !== "1") {
      add(join(home, ".claude", "skills"), "~/.claude/skills", true)
    }
  }
  let dir = resolve(input.directory)
  const stop = resolve(input.worktree || input.directory)
  for (let i = 0; i < 20; i++) {
    add(join(dir, ".opencode", "skills"), `project ${relative(stop, join(dir, ".opencode", "skills")) || ".opencode/skills"}`, false)
    add(join(dir, ".opencode", "skill"), `project ${relative(stop, join(dir, ".opencode", "skill")) || ".opencode/skill"}`, false)
    add(join(dir, ".agents", "skills"), `project ${relative(stop, join(dir, ".agents", "skills"))}`, false)
    add(join(dir, ".claude", "skills"), `project ${relative(stop, join(dir, ".claude", "skills"))}`, false)
    if (dir === stop || dirname(dir) === dir) break
    dir = dirname(dir)
  }
  for (const p of input.extraPaths) {
    const expanded = p.startsWith("~/") ? join(home, p.slice(2)) : p
    const abs = resolve(input.directory, expanded)
    add(abs, `skills.paths ${p}`, false)
  }
  return roots
}
