/**
 * Code anchors (5c): knowledge bound to code. In the text of an entry:
 *
 *   [[code:src/main/java/de/acme/TokenStore.java]]       a file
 *   [[code:TokenStore]]                                   a class (searched in the project)
 *   [[code:TokenStore#revoke]]                            a method of a class
 *   [[code:src/auth/token.ts#revoke]]                     a function / method in a file
 *   [[code:src/auth/token.ts#L40-L58]]                    a line range
 *
 * An anchor is resolved in the home_path of the projects (and the current worktree); the
 * entry's meta keeps path, kind, signature, a hash of the anchored code and the commit of
 * the project repository at that time. The job "anchors" checks every anchor after new
 * commits and on start: unchanged, changed, moved (git rename or symbol found elsewhere)
 * or deleted. Results live in state/anchors.json (local); affected entries appear in the
 * inbox under „Code geändert“ with the code diff next to the passage of the document.
 *
 * Resolution is lightweight (patterns for Java, Kotlin, TypeScript/JavaScript); the
 * IntelliJ plugin (5i) can pin anchors with exact symbol resolution through the web API.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { extname, join, relative, resolve, sep } from "node:path"
import type { AnchorRecord, Entry, Kind } from "../types"
import { KINDS } from "../types"
import { readJson, writeJsonAtomic } from "../util/fs"
import { nowIso, sha } from "../util/text"
import type { Ctx } from "./context"
import { finalizeRun } from "./finalize"
import { gitIn } from "./git"
import { spec } from "./kinds"
import { maskCode } from "./links"
import { expandPath } from "./projects"
import { safeDocsRoot } from "./project-docs"

export type AnchorKind = AnchorRecord["kind"]
export type AnchorState = "unchanged" | "changed" | "moved" | "deleted" | "unresolved"

export interface AnchorRef {
  /** text of the link ("[[code:TokenStore#revoke]]") */
  raw: string
  /** canonical reference without brackets ("TokenStore#revoke") */
  ref: string
  path?: string
  symbol?: string
  member?: string
  lines?: [number, number]
}

export interface AnchorStatus {
  ref: string
  status: AnchorState
  project?: string
  path?: string
  newPath?: string
  hash?: string
  newHash?: string
  lines?: [number, number]
  newLines?: [number, number]
  /** anchored code then (from the commit of the record) and now */
  before?: string
  after?: string
  note?: string
}

export interface AnchorFile {
  checkedAt?: string
  /** HEAD per project root at the last check */
  heads: Record<string, string>
  /** hash of all pinned anchors at the last check */
  sig?: string
  entries: Record<string, AnchorStatus[]>
}

const CODE_LINK_RE = /\[\[code:([^\[\]\n|#]+)(?:#([^\[\]\n|]+))?(?:\|([^\[\]\n]+))?\]\]/g
const LINES_RE = /^L?(\d{1,7})(?:\s*-\s*L?(\d{1,7}))?$/i
const SOURCE_EXT = new Set([".java", ".kt", ".kts", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".scala", ".groovy", ".cs", ".go", ".py"])
const SKIP_DIRS = new Set(["node_modules", ".git", "build", "target", "dist", "out", ".gradle", ".idea", ".next", "coverage", "vendor", "__pycache__", ".venv", "venv"])
const MAX_FILES = 20_000
const MAX_FILE_BYTES = 2_000_000

/** All code anchors in a text (code blocks and inline code never contain anchors). */
export function parseAnchors(text: string): AnchorRef[] {
  const out: AnchorRef[] = []
  const seen = new Set<string>()
  for (const m of maskCode(text).matchAll(CODE_LINK_RE)) {
    const target = m[1].trim()
    const section = m[2]?.trim()
    if (!target) continue
    const a: AnchorRef = { raw: m[0], ref: section ? `${target}#${section}` : target }
    if (looksLikePath(target)) a.path = target.replace(/^\.?\//, "")
    else a.symbol = target.split(".").pop()
    if (section) {
      const lm = LINES_RE.exec(section)
      if (lm && a.path) {
        const from = Number(lm[1])
        const to = Number(lm[2] ?? lm[1])
        a.lines = [Math.min(from, to), Math.max(from, to)]
      } else a.member = section
    }
    if (seen.has(a.ref)) continue
    seen.add(a.ref)
    out.push(a)
  }
  return out
}

function looksLikePath(t: string): boolean {
  return t.includes("/") || /\.[A-Za-z0-9]{1,6}$/.test(t)
}

/** Whitespace-insensitive content hash of anchored code. */
export function codeHash(text: string): string {
  return sha(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join("\n"),
    12,
  )
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Declaration of a type (class, interface, enum, record, object, type alias, function, const). */
function typeDeclRe(name: string): RegExp {
  return new RegExp(`(^|[^\\w$])(?:class|interface|enum|record|object|trait|struct|type|function|def|func)\\s+${esc(name)}(?![\\w$])|(^|[^\\w$])(?:const|let|var|val)\\s+${esc(name)}\\s*[:=]`)
}

/** Declaration of a method / function inside a block. */
function memberDeclRe(name: string): RegExp {
  return new RegExp(
    [
      // Java / Kotlin / C#: "public Foo revoke(", "fun revoke(", "void revoke(String x)"
      `(^|[\\s>\\]])(?:fun\\s+|def\\s+|func\\s+)?${esc(name)}\\s*(?:<[^>\\n]*>\\s*)?\\(`,
      // TS / JS: "revoke = (", "revoke: (", "revoke = async (", "async revoke("
      `(^|[\\s{,])${esc(name)}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\()`,
    ].join("|"),
  )
}

/** Remove string/char literals and comments (same length) so braces can be counted. */
function stripLiterals(src: string): string {
  let out = ""
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") {
        out += " "
        i++
      }
      continue
    }
    if (c === "/" && d === "*") {
      out += "  "
      i += 2
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " "
        i++
      }
      if (i < n) {
        out += "  "
        i += 2
      }
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      out += " "
      i++
      while (i < n && src[i] !== c) {
        if (src[i] === "\\") {
          out += " "
          i++
        }
        if (i < n) out += src[i] === "\n" ? "\n" : " "
        i++
      }
      if (i < n) {
        out += " "
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}

/** Lines [from, to] (1-based) of the block that starts at the declaration on line `line`. */
function blockAt(lines: string[], masked: string[], line: number): [number, number] {
  let depth = 0
  let opened = false
  for (let i = line; i < masked.length; i++) {
    for (const ch of masked[i]) {
      if (ch === "{") {
        depth++
        opened = true
      } else if (ch === "}") depth--
      else if (ch === ";" && !opened && depth === 0) return [line + 1, i + 1]
      if (opened && depth === 0) return [line + 1, i + 1]
    }
    // python-like: indentation block
    if (!opened && i === line && /:\s*$/.test(masked[i]) && !/[{(]\s*$/.test(masked[i])) {
      const indent = /^\s*/.exec(lines[line])![0].length
      let end = line
      for (let j = line + 1; j < lines.length; j++) {
        if (!lines[j].trim()) continue
        if (/^\s*/.exec(lines[j])![0].length <= indent) break
        end = j
      }
      return [line + 1, end + 1]
    }
    if (!opened && i - line > 8) break
  }
  return [line + 1, line + 1]
}

export interface Located {
  kind: AnchorKind
  lines: [number, number]
  text: string
  signature?: string
}

/** Locate a symbol (type, optionally member) or a line range in a source text. */
export function locate(source: string, a: Pick<AnchorRef, "symbol" | "member" | "lines">): Located | undefined {
  const lines = source.split("\n")
  if (a.lines) {
    const [from, to] = a.lines
    if (from < 1 || from > lines.length) return undefined
    const end = Math.min(to, lines.length)
    return { kind: "lines", lines: [from, end], text: lines.slice(from - 1, end).join("\n") }
  }
  const masked = stripLiterals(source).split("\n")
  let scope: [number, number] = [1, lines.length]
  let kind: AnchorKind = "file"
  let signature: string | undefined
  if (a.symbol) {
    const re = typeDeclRe(a.symbol)
    const i = masked.findIndex((l) => re.test(l))
    if (i < 0) return undefined
    scope = blockAt(lines, masked, i)
    kind = "class"
    signature = lines[i].trim().replace(/\s*\{\s*$/, "")
  }
  if (a.member) {
    const re = memberDeclRe(a.member)
    const kw = /^\s*(if|for|while|switch|catch|return|new|else|throw)\b/
    let found = -1
    for (let i = scope[0] - 1 + (a.symbol ? 1 : 0); i < scope[1]; i++) {
      if (re.test(masked[i]) && !kw.test(masked[i])) {
        found = i
        break
      }
    }
    if (found < 0) return undefined
    scope = blockAt(lines, masked, found)
    kind = "method"
    signature = lines[found].trim().replace(/\s*\{\s*$/, "")
  }
  return { kind, lines: scope, text: lines.slice(scope[0] - 1, scope[1]).join("\n"), signature }
}

export interface AnchorRoot {
  project: string
  root: string
}

/** Source files below a root (bounded walk, cached for a minute). */
const fileCache = new Map<string, { at: number; files: string[] }>()

export function sourceFiles(root: string): string[] {
  const hit = fileCache.get(root)
  if (hit && Date.now() - hit.at < 60_000) return hit.files
  const files: string[] = []
  const walk = (dir: string, depth: number) => {
    if (files.length >= MAX_FILES || depth > 25) return
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const n of names) {
      if (files.length >= MAX_FILES) return
      if (n.startsWith(".") && n !== ".github") continue
      const p = join(dir, n)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(n)) walk(p, depth + 1)
      } else if (SOURCE_EXT.has(extname(n)) && st.size <= MAX_FILE_BYTES) files.push(relative(root, p).split(sep).join("/"))
    }
  }
  walk(root, 0)
  fileCache.set(root, { at: Date.now(), files })
  return files
}

const read = (p: string): string | undefined => {
  try {
    return readFileSync(p, "utf8")
  } catch {
    return undefined
  }
}

/** Candidate files for a symbol: file name equal to the symbol first, then a content scan. */
function filesDeclaring(root: string, symbol: string, limit = 3): string[] {
  const files = sourceFiles(root)
  const out: string[] = []
  const re = typeDeclRe(symbol)
  const base = (f: string) => f.slice(f.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "")
  const ordered = [...files.filter((f) => base(f) === symbol), ...files.filter((f) => base(f) !== symbol)]
  for (const f of ordered) {
    const text = read(join(root, f))
    if (text && text.includes(symbol) && stripLiterals(text).split("\n").some((l) => re.test(l))) out.push(f)
    if (out.length >= limit) break
  }
  return out
}

export interface Resolved {
  project: string
  root: string
  path: string
  located: Located
}

/** Resolve an anchor in the given roots (first hit wins; a path relative to the root first). */
export function resolveAnchor(a: AnchorRef, roots: AnchorRoot[]): Resolved | undefined {
  for (const r of roots) {
    let paths: string[] = []
    if (a.path) {
      const full = resolve(r.root, a.path)
      if (!full.startsWith(resolve(r.root) + sep)) continue
      if (existsSync(full)) paths = [a.path]
      else {
        // only a file name or a partial path: search by suffix
        const suffix = `/${a.path}`
        paths = sourceFiles(r.root).filter((f) => `/${f}`.endsWith(suffix)).slice(0, 3)
      }
    } else if (a.symbol) paths = filesDeclaring(r.root, a.symbol)
    for (const p of paths) {
      const text = read(join(r.root, p))
      if (text === undefined) continue
      // a member given after a path is a method / function in that file
      const located = locate(text, a.path ? { member: a.member, lines: a.lines } : a)
      if (located) return { project: r.project, root: r.root, path: p, located }
    }
  }
  return undefined
}

export function recordOf(a: AnchorRef, r: Resolved, commit?: string): AnchorRecord {
  return {
    ref: a.ref,
    project: r.project,
    path: r.path,
    kind: r.located.kind,
    ...(a.symbol ? { symbol: a.symbol } : {}),
    ...(a.member ? { member: a.member } : {}),
    ...(r.located.kind === "lines" ? { lines: r.located.lines } : {}),
    ...(r.located.signature ? { signature: r.located.signature } : {}),
    hash: codeHash(r.located.text),
    ...(commit ? { commit } : {}),
    at: nowIso(),
  }
}

/** Entries that can carry anchors. */
export const ANCHOR_KINDS: Kind[] = KINDS.filter((k) => k !== "project")

export class Anchors {
  private headCache = new Map<string, { at: number; head?: string }>()

  constructor(private ctx: Ctx) {}

  private get file(): string {
    return join(this.ctx.store.stateDir, "anchors.json")
  }

  state(): AnchorFile {
    return readJson<AnchorFile>(this.file, { heads: {}, entries: {} })
  }

  /** Roots to resolve anchors in: projects with an existing home_path, then this worktree. */
  roots(project?: string): AnchorRoot[] {
    const out: AnchorRoot[] = []
    const seen = new Set<string>()
    const push = (p: string, root: string) => {
      const r = resolve(root)
      if (seen.has(r) || !existsSync(r)) return
      seen.add(r)
      out.push({ project: p, root: r })
    }
    const projects = this.ctx.projects?.list() ?? []
    const preferred = project ? projects.filter((p) => p.name === project) : []
    for (const p of [...preferred, ...projects]) if (p.homePath && p.homeExists) push(p.name, expandPath(p.homePath))
    const wt = safeDocsRoot(this.ctx.directory, this.ctx.worktree)
    if (wt) push(this.ctx.project, wt)
    return out
  }

  private async bin(): Promise<string | undefined> {
    return this.ctx.git.bin ?? (await this.ctx.git.init().then(() => this.ctx.git.bin).catch(() => undefined))
  }

  async head(root: string): Promise<string | undefined> {
    const c = this.headCache.get(root)
    if (c && Date.now() - c.at < 5_000) return c.head
    const r = await gitIn(await this.bin(), root, ["rev-parse", "HEAD"], 15_000).catch(() => undefined)
    const head = r?.code === 0 ? r.stdout.trim() : undefined
    this.headCache.set(root, { at: Date.now(), head })
    return head
  }

  /**
   * Records for the anchors of a text: unchanged references keep their record (the pinned
   * hash stays until the user confirms a change), new ones are resolved now.
   */
  async pin(text: string, previous: AnchorRecord[] = [], repin: string[] = [], project?: string): Promise<{ records: AnchorRecord[]; unresolved: string[] }> {
    const refs = parseAnchors(text)
    const records: AnchorRecord[] = []
    const unresolved: string[] = []
    if (!refs.length) return { records, unresolved }
    const roots = this.roots(project)
    for (const a of refs) {
      const prev = previous.find((p) => p.ref === a.ref)
      if (prev && repin.includes(a.ref)) {
        const fresh = await this.repin(prev)
        if (fresh) {
          records.push(fresh)
          continue
        }
      }
      if (prev) {
        records.push(prev)
        continue
      }
      const r = resolveAnchor(a, roots)
      if (!r) {
        unresolved.push(a.ref)
        continue
      }
      records.push(recordOf(a, r, await this.head(r.root)))
    }
    return { records, unresolved }
  }

  /** A fresh record for one reference (user confirms "passt noch"). */
  async repin(record: AnchorRecord, override?: { path?: string }): Promise<AnchorRecord | undefined> {
    const a = refOf(record)
    if (override?.path) a.path = override.path
    const r = resolveAnchor(a, this.roots(record.project))
    if (!r) return undefined
    return recordOf({ ...a, ref: record.ref }, r, await this.head(r.root))
  }

  private rootOf(record: AnchorRecord): AnchorRoot | undefined {
    const roots = this.roots(record.project)
    return roots.find((r) => r.project === record.project) ?? roots[0]
  }

  /** Text of the anchored code at the record's commit (diff "then ↔ now"). */
  private async before(root: string, record: AnchorRecord): Promise<string | undefined> {
    if (!record.commit) return undefined
    const r = await gitIn(await this.bin(), root, ["show", `${record.commit}:${record.path}`], 15_000).catch(() => undefined)
    if (!r || r.code !== 0) return undefined
    return locate(r.stdout, recordLocator(record))?.text
  }

  /** Path a file was renamed to since the record's commit (git rename detection). */
  private async renamedTo(root: string, record: AnchorRecord): Promise<string | undefined> {
    if (!record.commit) return undefined
    const bin = await this.bin()
    const committed = await gitIn(bin, root, ["diff", "--name-status", "-M", record.commit, "HEAD"], 30_000).catch(() => undefined)
    const work = await gitIn(bin, root, ["status", "--porcelain"], 15_000).catch(() => undefined)
    for (const line of (committed?.stdout ?? "").split("\n")) {
      const parts = line.split("\t")
      if (/^R\d*/.test(parts[0]) && parts[1] === record.path && parts[2]) return parts[2]
    }
    for (const line of (work?.stdout ?? "").split("\n")) {
      const m = /^R. (.+) -> (.+)$/.exec(line)
      if (m && m[1] === record.path) return m[2]
    }
    return undefined
  }

  /** Check one record against the code as it is now. */
  async check(record: AnchorRecord): Promise<AnchorStatus> {
    const base: AnchorStatus = { ref: record.ref, status: "unresolved", project: record.project, path: record.path, hash: record.hash, lines: record.lines }
    const root = this.rootOf(record)
    if (!root) return { ...base, note: "Projektverzeichnis nicht gefunden" }
    const loc = recordLocator(record)
    const full = join(root.root, record.path)
    const now = existsSync(full) ? read(full) : undefined
    let found: { path: string; located: Located } | undefined
    if (now !== undefined) {
      const l = locate(now, loc)
      if (l) found = { path: record.path, located: l }
    }
    let moved = false
    if (!found) {
      const renamed = await this.renamedTo(root.root, record)
      if (renamed) {
        const t = read(join(root.root, renamed))
        const l = t !== undefined ? locate(t, loc) : undefined
        if (l) {
          found = { path: renamed, located: l }
          moved = true
        }
      }
    }
    if (!found && record.symbol) {
      for (const f of filesDeclaring(root.root, record.symbol)) {
        if (f === record.path) continue
        const t = read(join(root.root, f))
        const l = t !== undefined ? locate(t, loc) : undefined
        if (l) {
          found = { path: f, located: l }
          moved = true
          break
        }
      }
    }
    const before = await this.before(root.root, record)
    if (!found) return { ...base, status: "deleted", before, note: now === undefined ? "Datei gibt es nicht mehr" : "Symbol nicht mehr gefunden" }
    const newHash = codeHash(found.located.text)
    // a line range whose content moved inside the file
    if (record.kind === "lines" && newHash !== record.hash && before && now !== undefined) {
      const shifted = findBlock(now, before)
      if (shifted) return { ...base, status: "moved", newLines: shifted, newHash: record.hash, before, after: before, note: "Zeilen verschoben" }
    }
    if (moved) return { ...base, status: "moved", newPath: found.path, newHash, newLines: record.kind === "lines" ? found.located.lines : undefined, before, after: found.located.text }
    if (newHash === record.hash) return { ...base, status: "unchanged", newHash }
    return { ...base, status: "changed", newHash, before, after: found.located.text }
  }

  /** Entries with anchors (store entries the AI may see, plus the user's own). */
  anchored(): Entry[] {
    const out: Entry[] = []
    for (const k of ANCHOR_KINDS) for (const e of this.ctx.store.list(k)) if (e.meta?.anchors?.length) out.push(e)
    return out
  }

  /** Entries whose text has anchors without a record (written before 5c, or not resolvable then). */
  unpinned(): Array<{ entry: Entry; refs: AnchorRef[] }> {
    const out: Array<{ entry: Entry; refs: AnchorRef[] }> = []
    for (const k of ANCHOR_KINDS) {
      for (const e of this.ctx.store.list(k)) {
        if (e.tier === "archive") continue
        const have = new Set((e.meta?.anchors ?? []).map((a) => a.ref))
        const refs = parseAnchors(e.body).filter((a) => !have.has(a.ref))
        if (refs.length) out.push({ entry: e, refs })
      }
    }
    return out
  }

  /** Heads of all roots – the check runs only when one changed (or forced). */
  async heads(): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const r of this.roots()) {
      this.headCache.delete(r.root)
      const h = await this.head(r.root)
      if (h) out[r.root] = h
    }
    return out
  }

  /** Check all anchors; returns counts per status. */
  async checkAll(force = false): Promise<{ checked: number; changed: number; skipped: boolean; byStatus: Record<string, number> }> {
    const st = this.state()
    const heads = await this.heads()
    const anchored = this.anchored()
    // what is pinned (a re-pin or a new entry also triggers a check)
    const sig = sha(JSON.stringify(anchored.map((e) => [`${e.kind}:${e.name}`, e.meta!.anchors!.map((a) => `${a.ref}@${a.hash}@${a.path}`)])), 16)
    const same = JSON.stringify(heads) === JSON.stringify(st.heads) && st.sig === sig
    if (same && !force) return { checked: 0, changed: 0, skipped: true, byStatus: {} }
    const entries: Record<string, AnchorStatus[]> = {}
    const byStatus: Record<string, number> = {}
    let checked = 0
    for (const e of anchored) {
      const list: AnchorStatus[] = []
      for (const rec of e.meta!.anchors!) {
        const s = await this.check(rec)
        list.push(s)
        byStatus[s.status] = (byStatus[s.status] ?? 0) + 1
        checked++
      }
      entries[`${e.kind}:${e.name}`] = list
    }
    writeJsonAtomic(this.file, { checkedAt: nowIso(), heads, sig, entries } satisfies AnchorFile)
    return { checked, changed: checked - (byStatus.unchanged ?? 0), skipped: false, byStatus }
  }

  /**
   * The job "anchors": pin anchors written before 5c (one run, one commit of the meta files),
   * then check every anchor when a project's HEAD moved (or by hand).
   */
  async runJob(trigger: string, force = false): Promise<{ summary: string; commits: string[]; status?: "ok" | "skipped" | "warn" }> {
    const commits: string[] = []
    const missing = this.unpinned().filter((u) => !spec(u.entry.kind).userOwned && u.entry.owned)
    let pinned = 0
    if (missing.length) {
      const run = this.ctx.runs.create({
        smith: "docsmith",
        actor: "curator",
        trigger: `anchors (${trigger})`,
        writeMode: "auto",
        directory: this.ctx.directory,
        project: this.ctx.project,
        limits: { maxNew: 0, maxChanges: 10_000, maxNotes: 0 },
      })
      let error: string | undefined
      try {
        for (const { entry } of missing) {
          const { records } = await this.pin(entry.body, entry.meta?.anchors ?? [])
          if (records.length === (entry.meta?.anchors?.length ?? 0)) continue
          try {
            await this.ctx.ops.setAnchors(run, entry.kind, entry.name, records, "Code-Anker verankert")
            pinned += records.length - (entry.meta?.anchors?.length ?? 0)
          } catch (err) {
            this.ctx.log.warn(`anchors: ${entry.kind}:${entry.name}: ${String(err)}`)
          }
        }
      } catch (err) {
        error = String(err)
      }
      const fin = await finalizeRun(this.ctx, run, { ok: !error, error })
      if (fin.commit) commits.push(fin.commit)
    }
    const r = await this.checkAll(force || pinned > 0)
    if (r.skipped && !pinned) return { summary: "keine neuen Commits in den Projekten", commits, status: "skipped" }
    const parts = Object.entries(r.byStatus).map(([k, v]) => `${v} ${STATUS_LABEL[k as AnchorState] ?? k}`)
    return { summary: `${pinned ? `${pinned} Anker verankert; ` : ""}${r.checked} Anker geprüft${parts.length ? ` (${parts.join(", ")})` : ""}`, commits, status: r.changed ? "warn" : "ok" }
  }

  /** Status of the anchors of one entry (last check). */
  statusOf(id: string): AnchorStatus[] {
    return this.state().entries[id] ?? []
  }

  /** Forget the stored status of one reference (after "passt noch" / a fix). */
  clear(id: string, ref?: string): void {
    const st = this.state()
    const list = st.entries[id]
    if (!list) return
    st.entries[id] = ref ? list.filter((s) => s.ref !== ref) : []
    writeJsonAtomic(this.file, st)
  }

  /** Files with anchored knowledge: path → entries (the view "Wissen zu einer Datei"). */
  byFile(): Array<{ project?: string; path: string; entries: Array<{ id: string; title: string; ref: string; kind: AnchorKind; status?: AnchorState }> }> {
    const st = this.state()
    const map = new Map<string, { project?: string; path: string; entries: Array<{ id: string; title: string; ref: string; kind: AnchorKind; status?: AnchorState }> }>()
    for (const e of this.anchored()) {
      const id = `${e.kind}:${e.name}`
      for (const a of e.meta!.anchors!) {
        const k = `${a.project ?? ""}|${a.path}`
        const row = map.get(k) ?? map.set(k, { project: a.project, path: a.path, entries: [] }).get(k)!
        row.entries.push({ id, title: e.title, ref: a.ref, kind: a.kind, status: st.entries[id]?.find((s) => s.ref === a.ref)?.status })
      }
    }
    return [...map.values()].sort((a, b) => a.path.localeCompare(b.path))
  }
}

export function refOf(r: AnchorRecord): AnchorRef {
  return { raw: `[[code:${r.ref}]]`, ref: r.ref, path: r.path, symbol: r.symbol, member: r.member, lines: r.lines }
}

function recordLocator(r: AnchorRecord): Pick<AnchorRef, "symbol" | "member" | "lines"> {
  if (r.kind === "lines") return { lines: r.lines }
  if (r.kind === "file") return {}
  return { symbol: r.kind === "class" || r.symbol ? r.symbol : undefined, member: r.member }
}

/** Lines of `block` inside `text` (exact, whitespace-insensitive per line). */
function findBlock(text: string, block: string): [number, number] | undefined {
  const want = block.split("\n").map((l) => l.trim())
  const lines = text.split("\n").map((l) => l.trim())
  if (!want.length) return undefined
  outer: for (let i = 0; i + want.length <= lines.length; i++) {
    for (let j = 0; j < want.length; j++) if (lines[i + j] !== want[j]) continue outer
    return [i + 1, i + want.length]
  }
  return undefined
}

export const STATUS_LABEL: Record<AnchorState, string> = {
  unchanged: "unverändert",
  changed: "geändert",
  moved: "verschoben",
  deleted: "gelöscht",
  unresolved: "nicht auflösbar",
}

/** Node id of a code file in the graph. */
export function codeNodeId(project: string | undefined, path: string): string {
  return `code:${project ? `${project}/` : ""}${path}`
}
