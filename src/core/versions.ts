/**
 * Versions of store entries from git: list of commits per entry (across tiers and
 * folders), semantic diff per version (properties, content, metadata in words, files),
 * comparison of any two versions, commit view and store history.
 * Git is called with execFile (no shell), paths are built from the store layout only,
 * hashes are validated. Results per commit never change and are cached.
 */
import type { Entry, Kind, Meta, Relation, Tier } from "../types"
import { KINDS } from "../types"
import { readText } from "../util/fs"
import { diffLines, diffStats, parseUnifiedDiff, toHunks, type DiffOp, type FileDiff, type Hunk } from "../util/diff"
import { truncate } from "../util/text"
import type { GitTracker } from "./git"
import { SMITH_SUBJECT_RE } from "./git"
import { spec } from "./kinds"
import type { Store } from "./store"

export const HASH_RE = /^[0-9a-f]{7,40}$/

export interface VersionItem {
  hash: string
  short: string
  date: string
  subject: string
  smith?: string
  actor?: string
  runId?: string
  /** reason lines of this commit that concern the entry */
  reasons: string[]
  additions: number
  deletions: number
  markers: string[]
  tier?: string
  manual: boolean
}

export interface FieldChange {
  field: string
  label: string
  before: string
  after: string
  /** tags: added / removed chips */
  added?: string[]
  removed?: string[]
}

export interface EntryDiff {
  id: string
  from: { rev: string; label: string; tier?: string; exists: boolean }
  to: { rev: string; label: string; tier?: string; exists: boolean }
  fields: FieldChange[]
  body: { hunks: Hunk[]; additions: number; deletions: number; truncated: boolean; full?: DiffOp[] }
  meta: string[]
  files: Array<{ path: string; status: string; hunks: Hunk[]; additions: number; deletions: number }>
  raw: FileDiff[]
  test?: { before?: string; after?: string }
}

export interface CommitView {
  hash: string
  short: string
  date: string
  subject: string
  body: string
  smith?: string
  actor?: string
  runId?: string
  manual: boolean
  entries: Array<{ id: string; kind: Kind; name: string; status: string; additions: number; deletions: number; paths: string[] }>
  other: string[]
}

const FIELD_LABEL: Record<string, string> = {
  title: "Titel",
  description: "Beschreibung",
  tags: "Tags",
  term: "Begriff",
  aliases: "Aliase",
  meanings: "Bedeutungen",
  status: "Status",
  signatures: "Signaturen",
  context: "Kontext",
  usage: "Aufruf",
  entry: "Datei",
  capabilities: "Fähigkeiten",
  requirements: "Abhängigkeiten",
  python: "Python",
  type: "Art",
  scope: "Gültigkeit",
  project: "Projekt",
  project_name: "Projektname",
  topic: "Thema",
  decided_by: "Entschieden von",
  valid_from: "Gültig seit",
  review_after: "Prüfen nach",
  superseded_by: "Abgelöst durch",
  branch: "Branch",
  ticket: "Ticket",
  folder: "Ordner",
  author: "Autor",
  ai: "KI-Recht",
}

const RELATION_WORD: Record<string, string> = {
  not_related: "kein Bezug",
  related: "verwandt",
  supplements: "ergänzt",
  duplicates: "Duplikat von",
  contradicts: "widerspricht",
  supersedes: "löst ab",
  depends_on: "setzt voraus",
  part_of: "gehört zu",
  solves: "löst",
  caused_by: "verursacht durch",
  derived_from: "abgeleitet aus",
  uses: "nutzt",
  example_of: "Beispiel für",
  references: "verweist auf",
}

const TIER_WORD: Record<string, string> = { active: "aktiv", dormant: "ruhend", archive: "Archiv" }

/** Store-relative path → entry it belongs to. */
export function entryOfPath(rel: string): { kind: Kind; name: string; tier?: Tier; meta?: boolean } | undefined {
  const parts = rel.split("/")
  if (parts[0] === "meta" && parts.length === 3 && parts[2].endsWith(".json")) {
    const kind = parts[1] as Kind
    if ((KINDS as string[]).includes(kind)) return { kind, name: parts[2].slice(0, -5), meta: true }
    return undefined
  }
  for (const kind of KINDS) {
    const s = spec(kind)
    if (parts[0] !== s.dir || parts.length < 3) continue
    const tier = parts[1] as Tier
    if (!s.tiers.includes(tier)) continue
    if (s.layout === "dir") return { kind, name: parts[2], tier }
    const file = parts[parts.length - 1]
    if (!file.endsWith(".md")) return undefined
    // folders (knowledge/<tier>/<folder…>/<name>.md); "_anhaenge" holds attachments, not entries
    if (parts.slice(2, -1).some((p) => p.startsWith("_anhaenge"))) return undefined
    return { kind, name: file.slice(0, -3), tier }
  }
  return undefined
}

/** git pathspecs of an entry: every tier (and folder), plus its meta file. */
export function entryPathspecs(kind: Kind, name: string): string[] {
  const s = spec(kind)
  const specs = [`meta/${kind}/${name}.json`]
  if (s.layout === "dir") for (const t of s.tiers) specs.push(`${s.dir}/${t}/${name}`)
  else for (const t of s.tiers) specs.push(`:(glob)${s.dir}/${t}/**/${name}.md`)
  return specs
}

function fieldText(v: unknown): string {
  if (v === undefined || v === null) return ""
  if (Array.isArray(v)) {
    return v
      .map((x) => (x && typeof x === "object" ? Object.values(x as Record<string, unknown>).filter(Boolean).join(" – ") : String(x)))
      .join("; ")
  }
  if (typeof v === "object") return JSON.stringify(v)
  return String(v)
}

export class Versions {
  private cache = new Map<string, unknown>()

  constructor(
    private store: Store,
    private git: GitTracker,
  ) {}

  private remember<T>(key: string, value: T): T {
    this.cache.set(key, value)
    if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value as string)
    return value
  }

  private async ready(): Promise<boolean> {
    return this.git.init()
  }

  /** File content at a revision (undefined when missing). */
  async fileAt(rev: string, path: string): Promise<string | undefined> {
    if (!HASH_RE.test(rev) && rev !== "HEAD") throw new Error("invalid revision")
    const r = await this.git.git(["show", `${rev}:${path}`])
    return r.code === 0 ? r.stdout : undefined
  }

  /** Files of an entry that exist at a revision (ls-tree knows no glob pathspecs → filter here). */
  private async filesAt(rev: string, kind: Kind, name: string): Promise<string[]> {
    const s = spec(kind)
    const r = await this.git.git(["ls-tree", "-r", "--name-only", rev, "--", s.dir, `meta/${kind}/${name}.json`])
    if (r.code !== 0) return []
    return r.stdout
      .split("\n")
      .filter(Boolean)
      .filter((p) => {
        const e = entryOfPath(p)
        if (e) return e.kind === kind && e.name === name
        // support files of dir entries (scripts, skills)
        return s.layout === "dir" && s.tiers.some((t) => p.startsWith(`${s.dir}/${t}/${name}/`))
      })
  }

  /** Commits that touched an entry (newest first). */
  async log(kind: Kind, name: string, limit = 200): Promise<VersionItem[]> {
    if (!(await this.ready())) return []
    const r = await this.git.git(["log", `-n${limit}`, "--format=%x1e%H%x1f%h%x1f%cI%x1f%s%x1f%b%x1d", "--numstat", "--", ...entryPathspecs(kind, name)])
    if (r.code !== 0) return []
    const out: VersionItem[] = []
    for (const chunk of r.stdout.split("\x1e")) {
      if (!chunk.trim()) continue
      const [head, stat = ""] = chunk.split("\x1d")
      const [hash, short, date, subject, body = ""] = head.split("\x1f")
      if (!hash) continue
      let additions = 0
      let deletions = 0
      const paths: string[] = []
      for (const l of stat.split("\n")) {
        const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l.trim())
        if (!m) continue
        additions += m[1] === "-" ? 0 : Number(m[1])
        deletions += m[2] === "-" ? 0 : Number(m[2])
        paths.push(m[3])
      }
      const sm = SMITH_SUBJECT_RE.exec(subject)
      const id = `${kind}:${name}`
      const reasons = body
        .split("\n")
        .filter((l) => l.startsWith("- ") && (l.includes(` ${name}`) || l.includes(id)))
        .map((l) => truncate(l.slice(2), 300))
      const markers: string[] = []
      const label = `${subject}\n${reasons.join("\n")}`
      if (/\bcreate\b|merge-create/.test(label)) markers.push("neu")
      if (/\b(archive|dormant|activate|restore)\b/.test(label)) markers.push("Stufe")
      if (/\bmerge\b|absorbed/.test(label)) markers.push("Zusammenführung")
      if (/: restore /.test(subject) || /\brestore-version\b/.test(label)) markers.push("Wiederherstellung")
      if (/: undo /.test(subject)) markers.push("Rückgängig")
      const manual = /^manual:/.test(subject)
      if (manual) markers.push("Handbearbeitung")
      const tierPath = paths.map((p) => entryOfPath(p.replace(/^.*=> /, "").replace(/[{}]/g, ""))).find((x) => x && !x.meta && x.tier)
      out.push({
        hash,
        short,
        date,
        subject,
        smith: sm?.[1],
        actor: sm?.[2],
        runId: /Run: (\S+)/.exec(body)?.[1],
        reasons,
        additions,
        deletions,
        markers,
        tier: tierPath?.tier,
        manual,
      })
    }
    return out
  }

  /** Read an entry's main content + meta + support files at a revision ("working" = files on disk now). */
  private async snapshot(rev: string, kind: Kind, name: string): Promise<{ exists: boolean; tier?: string; main?: string; meta?: Meta; files: Record<string, string> }> {
    const s = spec(kind)
    if (rev === "working") {
      const e = this.store.fresh(kind, name)
      if (!e) return { exists: false, files: {} }
      const files: Record<string, string> = {}
      for (const f of this.store.supportFiles(e, 40)) {
        const rel = f.slice(e.dir.length + 1)
        if (/\.(py|md|txt|json|sh|ya?ml|js|ts)$/.test(rel)) files[rel] = readText(f) ?? ""
      }
      return { exists: true, tier: e.tier, main: readText(e.file), meta: this.store.readMeta(kind, name), files }
    }
    if (rev === "empty") return { exists: false, files: {} }
    const paths = await this.filesAt(rev, kind, name)
    const metaPath = `meta/${kind}/${name}.json`
    const mainPath = paths.find((p) => {
      const e = entryOfPath(p)
      if (!e || e.meta) return false
      return s.layout === "dir" ? p.endsWith(`/${name}/${s.main}`) : true
    })
    const files: Record<string, string> = {}
    if (s.layout === "dir" && mainPath) {
      const dir = mainPath.slice(0, -s.main.length - 1)
      for (const p of paths) {
        if (p === mainPath || !p.startsWith(`${dir}/`) || !/\.(py|md|txt|json|sh|ya?ml|js|ts)$/.test(p)) continue
        files[p.slice(dir.length + 1)] = (await this.fileAt(rev, p)) ?? ""
      }
    }
    const metaText = paths.includes(metaPath) ? await this.fileAt(rev, metaPath) : undefined
    let meta: Meta | undefined
    try {
      meta = metaText ? (JSON.parse(metaText) as Meta) : undefined
    } catch {
      meta = undefined
    }
    return { exists: !!mainPath, tier: mainPath ? entryOfPath(mainPath)?.tier : undefined, main: mainPath ? await this.fileAt(rev, mainPath) : undefined, meta, files }
  }

  /** Parent revision of a commit ("empty" for the root commit). */
  async parentOf(hash: string): Promise<string> {
    const r = await this.git.git(["rev-parse", "--verify", "-q", `${hash}^`])
    return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : "empty"
  }

  /**
   * Semantic diff of an entry between two revisions: `to` = commit hash or "working",
   * `from` = commit hash, "parent" (default: the commit before `to`) or "empty".
   */
  async diff(kind: Kind, name: string, to: string, from = "parent", maxLines = 2000): Promise<EntryDiff> {
    if (!(await this.ready())) throw new Error("git is not available")
    for (const rev of [to, from]) {
      if (!(HASH_RE.test(rev) || rev === "working" || rev === "parent" || rev === "empty")) throw new Error(`invalid revision ${rev}`)
    }
    const fromRev = from === "parent" ? (to === "working" ? "HEAD" : await this.parentOf(to)) : from
    const resolvedFrom = fromRev === "HEAD" ? ((await this.git.git(["rev-parse", "HEAD"])).stdout.trim() || "empty") : fromRev
    const cacheKey = `${kind}:${name}|${resolvedFrom}|${to}|${maxLines}`
    if (to !== "working" && this.cache.has(cacheKey)) return this.cache.get(cacheKey) as EntryDiff
    const [a, b] = await Promise.all([this.snapshot(resolvedFrom, kind, name), this.snapshot(to, kind, name)])
    const s = spec(kind)
    const ca = a.main !== undefined ? s.parse(a.main, name) : undefined
    const cb = b.main !== undefined ? s.parse(b.main, name) : undefined
    // properties (frontmatter)
    const fields: FieldChange[] = []
    const fa: Record<string, unknown> = ca ? { title: ca.title, description: ca.description, tags: ca.tags, ...ca.fields } : {}
    const fb: Record<string, unknown> = cb ? { title: cb.title, description: cb.description, tags: cb.tags, ...cb.fields } : {}
    for (const k of [...new Set([...Object.keys(fa), ...Object.keys(fb)])]) {
      const before = fieldText(fa[k])
      const after = fieldText(fb[k])
      if (before === after) continue
      const fc: FieldChange = { field: k, label: FIELD_LABEL[k] ?? k, before, after }
      if (k === "tags" || k === "aliases" || k === "labels") {
        const x = new Set((fa[k] as string[]) ?? [])
        const y = new Set((fb[k] as string[]) ?? [])
        fc.added = [...y].filter((t) => !x.has(t))
        fc.removed = [...x].filter((t) => !y.has(t))
      }
      fields.push(fc)
    }
    if (a.tier !== b.tier && (a.exists || b.exists)) fields.push({ field: "tier", label: "Stufe", before: TIER_WORD[a.tier ?? ""] ?? a.tier ?? "–", after: TIER_WORD[b.tier ?? ""] ?? b.tier ?? "–" })
    // content
    const ops = diffLines(ca?.body ?? "", cb?.body ?? "")
    const stats = diffStats(ops)
    let hunks = toHunks(ops, 3)
    let truncated = false
    let count = 0
    hunks = hunks.filter((h) => {
      count += h.lines.length
      if (count > maxLines) truncated = true
      return count <= maxLines
    })
    // files (scripts)
    const files: EntryDiff["files"] = []
    for (const f of [...new Set([...Object.keys(a.files), ...Object.keys(b.files)])].sort()) {
      const before = a.files[f]
      const after = b.files[f]
      if (before === after) continue
      const fo = diffLines(before ?? "", after ?? "")
      const st = diffStats(fo)
      files.push({ path: f, status: before === undefined ? "added" : after === undefined ? "deleted" : "modified", hunks: toHunks(fo, 3), ...st })
    }
    // raw git diff
    let raw: FileDiff[] = []
    if (resolvedFrom !== "empty" || to !== "working") {
      const args = to === "working" ? ["diff", "-M", resolvedFrom === "empty" ? "4b825dc642cb6eb9a060e54bf8d69288fbee4904" : resolvedFrom, "--"] : ["diff", "-M", resolvedFrom === "empty" ? "4b825dc642cb6eb9a060e54bf8d69288fbee4904" : resolvedFrom, to, "--"]
      const r = await this.git.git([...args, ...entryPathspecs(kind, name)])
      if (r.code === 0) raw = parseUnifiedDiff(r.stdout)
    }
    const label = async (rev: string) => {
      if (rev === "working") return "aktueller Stand"
      if (rev === "empty") return "(nicht vorhanden)"
      const l = await this.git.git(["log", "-n1", "--format=%h · %cI", rev])
      return l.stdout.trim() || rev.slice(0, 8)
    }
    const result: EntryDiff = {
      id: `${kind}:${name}`,
      from: { rev: resolvedFrom, label: await label(resolvedFrom), tier: a.tier, exists: a.exists },
      to: { rev: to, label: await label(to), tier: b.tier, exists: b.exists },
      fields,
      body: { hunks, ...stats, truncated },
      meta: metaChanges(a.meta, b.meta),
      files,
      raw,
      test: a.meta?.test?.status !== b.meta?.test?.status ? { before: a.meta?.test?.status, after: b.meta?.test?.status } : undefined,
    }
    return to === "working" ? result : this.remember(cacheKey, result)
  }

  /** Full text of an entry at a version (restore, compare). */
  async contentAt(kind: Kind, name: string, rev: string): Promise<{ main?: string; files: Record<string, string>; meta?: Meta; tier?: string }> {
    const s = await this.snapshot(rev, kind, name)
    return { main: s.main, files: s.files, meta: s.meta, tier: s.tier }
  }

  /** A commit with every entry it changed. */
  async commit(hash: string): Promise<CommitView> {
    if (!HASH_RE.test(hash)) throw new Error("invalid commit hash")
    const cached = this.cache.get(`commit|${hash}`)
    if (cached) return cached as CommitView
    if (!(await this.ready())) throw new Error("git is not available")
    const r = await this.git.git(["show", "--format=%H%x1f%h%x1f%cI%x1f%s%x1f%b%x1d", "--numstat", "-M", hash])
    if (r.code !== 0) throw new Error(`commit ${hash} not found`)
    const [head, stat = ""] = r.stdout.split("\x1d")
    const [full, short, date, subject, body = ""] = head.split("\x1f")
    const sm = SMITH_SUBJECT_RE.exec(subject)
    const byEntry = new Map<string, CommitView["entries"][number]>()
    const other: string[] = []
    for (const l of stat.split("\n")) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l.trim())
      if (!m) continue
      // renames: "dir/{a => b}/x" or "a => b"
      const path = m[3].includes("=>") ? m[3].replace(/\{([^}]*) => ([^}]*)\}/, "$2").replace(/^.* => /, "") : m[3]
      const e = entryOfPath(path)
      if (!e) {
        other.push(path)
        continue
      }
      const id = `${e.kind}:${e.name}`
      const cur = byEntry.get(id) ?? { id, kind: e.kind, name: e.name, status: "geändert", additions: 0, deletions: 0, paths: [] }
      cur.additions += m[1] === "-" ? 0 : Number(m[1])
      cur.deletions += m[2] === "-" ? 0 : Number(m[2])
      cur.paths.push(path)
      if (m[3].includes("=>") && !e.meta) cur.status = "verschoben"
      byEntry.set(id, cur)
    }
    const view: CommitView = { hash: full, short, date, subject, body: body.trim(), smith: sm?.[1], actor: sm?.[2], runId: /Run: (\S+)/.exec(body)?.[1], manual: /^manual:/.test(subject), entries: [...byEntry.values()], other }
    return this.remember(`commit|${hash}`, view)
  }

  /** Store history with filters (newest first). */
  async history(f: { smith?: string; actor?: string; since?: string; until?: string; manual?: boolean; limit?: number; skip?: number } = {}): Promise<
    Array<{ hash: string; short: string; date: string; subject: string; smith?: string; actor?: string; runId?: string; manual: boolean; files: number }>
  > {
    if (!(await this.ready())) return []
    const args = ["log", `-n${Math.min(2000, (f.limit ?? 100) + (f.skip ?? 0) + 500)}`, "--format=%x1e%H%x1f%h%x1f%cI%x1f%s%x1f%b%x1d", "--shortstat"]
    if (f.since && /^\d{4}-\d{2}-\d{2}/.test(f.since)) args.push(`--since=${f.since}`)
    if (f.until && /^\d{4}-\d{2}-\d{2}/.test(f.until)) args.push(`--until=${f.until}T23:59:59`)
    const r = await this.git.git(args)
    if (r.code !== 0) return []
    const out: Array<{ hash: string; short: string; date: string; subject: string; smith?: string; actor?: string; runId?: string; manual: boolean; files: number }> = []
    for (const chunk of r.stdout.split("\x1e")) {
      if (!chunk.trim()) continue
      const [head, stat = ""] = chunk.split("\x1d")
      const [hash, short, date, subject, body = ""] = head.split("\x1f")
      const sm = SMITH_SUBJECT_RE.exec(subject)
      const manual = /^manual:/.test(subject)
      if (f.smith && sm?.[1] !== f.smith) continue
      if (f.actor && sm?.[2] !== f.actor) continue
      if (f.manual && !manual) continue
      out.push({ hash, short, date, subject, smith: sm?.[1], actor: sm?.[2], runId: /Run: (\S+)/.exec(body)?.[1], manual, files: Number(/(\d+) files? changed/.exec(stat)?.[1] ?? 0) })
    }
    return out.slice(f.skip ?? 0, (f.skip ?? 0) + (f.limit ?? 100))
  }
}

/** Metadata changes in words ("Verknüpfung hinzugefügt: ergänzt → knowledge:x (0,8)", …). */
export function metaChanges(a: Meta | undefined, b: Meta | undefined): string[] {
  const out: string[] = []
  if (!a && !b) return out
  if (!a && b) out.push("Eintrag angelegt")
  if (a && !b) out.push("Metadaten entfernt")
  if (!a || !b) return out
  const relKey = (r: Relation) => `${r.type}|${r.to}`
  const ra = new Map((a.relations ?? []).map((r) => [relKey(r), r]))
  const rb = new Map((b.relations ?? []).map((r) => [relKey(r), r]))
  const fmt = (r: Relation) => `${RELATION_WORD[r.type] ?? r.type} → ${r.to} (${r.strength.toFixed(1).replace(".", ",")})`
  for (const [k, r] of rb) {
    const old = ra.get(k)
    if (!old) out.push(`Verknüpfung hinzugefügt: ${fmt(r)}${r.description ? ` – ${truncate(r.description, 120)}` : ""}`)
    else if (old.strength !== r.strength || old.description !== r.description) out.push(`Verknüpfung geändert: ${fmt(r)}`)
  }
  for (const [k, r] of ra) if (!rb.has(k)) out.push(`Verknüpfung entfernt: ${fmt(r)}`)
  const ea = new Set((a.evidence ?? []).map((e) => `${e.at}|${e.text}`))
  for (const e of b.evidence ?? []) if (!ea.has(`${e.at}|${e.text}`)) out.push(`Beleg hinzugefügt: „${truncate(e.text, 140)}“`)
  if (!a.pinned && b.pinned) out.push("angepinnt")
  if (a.pinned && !b.pinned) out.push("Pin entfernt")
  if (a.absorbedInto !== b.absorbedInto) out.push(b.absorbedInto ? `zusammengeführt in ${b.absorbedInto}` : "nicht mehr zusammengeführt")
  if ((a.doubts?.length ?? 0) !== (b.doubts?.length ?? 0)) out.push((b.doubts?.length ?? 0) > (a.doubts?.length ?? 0) ? `Zweifel vermerkt: ${truncate(b.doubts?.[b.doubts.length - 1]?.note ?? "", 140)}` : "Zweifel aufgelöst")
  if (a.test?.status !== b.test?.status && b.test) out.push(`Tests: ${a.test?.status ?? "–"} → ${b.test.status}`)
  if (a.verifiedAt !== b.verifiedAt && b.verifiedAt) out.push(`bestätigt am ${b.verifiedAt.slice(0, 10)}`)
  if (a.tierChangedAt !== b.tierChangedAt && b.tierChangedAt) out.push("Stufe gewechselt")
  const ha = a.history?.length ?? 0
  for (const h of (b.history ?? []).slice(ha)) out.push(`Verlauf: ${h.action}${h.reason ? ` – ${truncate(h.reason, 140)}` : ""}`)
  return out
}

/** Helper for the web view: does an entry exist (owned)? */
export function ownedEntry(store: Store, id: string): Entry | undefined {
  const i = id.indexOf(":")
  if (i <= 0) return undefined
  const kind = id.slice(0, i) as Kind
  if (!(KINDS as string[]).includes(kind)) return undefined
  return store.getOwned(kind, id.slice(i + 1))
}
