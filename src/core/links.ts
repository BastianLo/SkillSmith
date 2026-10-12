/**
 * Links between entries, one syntax for the whole application (documents, tasks,
 * memories, comments, agent tasks):
 *
 *   [[name]] [[Titel]] [[name|Text]] [[name#Abschnitt]] [[kind:name]] [[task:T-12]]
 *   T-12 in running text (task short ids)          #tag in running text
 *
 * Links point to the stable id ("kind:name"); every resolved link is a derived graph edge
 * "references". The index is rebuilt per store revision; backlinks, mentions without a
 * link and broken links come from it. Code blocks and inline code never contain links.
 */
import type { Entry, Kind } from "../types"
import { KINDS } from "../types"
import { fold, truncate } from "../util/text"
import { normalizeTags, spec, taskName } from "./kinds"
import type { Store } from "./store"

export interface ParsedLink {
  raw: string
  target: string
  section?: string
  label?: string
  /** offset in the text */
  index: number
  /** T-12 without brackets */
  bare?: boolean
}

export interface ResolvedLink extends ParsedLink {
  id?: string
}

const LINK_RE = /\[\[([^\[\]\n|#]+)(?:#([^\[\]\n|]+))?(?:\|([^\[\]\n]+))?\]\]/g
const TAG_RE = /(^|[\s(,;])#([\p{L}\p{N}][\p{L}\p{N}_-]{1,39})(?![\p{L}\p{N}_-])/gu

/** Replace code (fenced and inline) by spaces of the same length so offsets stay valid. */
export function maskCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, " ")).replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length))
}

export function parseLinks(text: string, taskPrefix = "T"): ParsedLink[] {
  const masked = maskCode(text)
  const out: ParsedLink[] = []
  for (const m of masked.matchAll(LINK_RE)) {
    out.push({ raw: m[0], target: m[1].trim(), section: m[2]?.trim() || undefined, label: m[3]?.trim() || undefined, index: m.index ?? 0 })
  }
  // bare task ids (outside [[ ]])
  const bare = new RegExp(`(?<![\\w\\[:/-])(${taskPrefix}-\\d{1,6})(?![\\w-])`, "g")
  const inLinks = out.map((l) => [l.index, l.index + l.raw.length])
  for (const m of masked.matchAll(bare)) {
    const i = m.index ?? 0
    if (inLinks.some(([a, b]) => i >= a && i < b)) continue
    out.push({ raw: m[1], target: `task:${m[1]}`, index: i, bare: true })
  }
  return out.sort((a, b) => a.index - b.index)
}

/** #tags in running text (headings "# x" are not tags). */
export function inlineTags(text: string): string[] {
  const masked = maskCode(text)
  const out: string[] = []
  for (const line of masked.split("\n")) {
    if (/^\s{0,3}#{1,6}\s/.test(line)) continue
    for (const m of line.matchAll(TAG_RE)) out.push(m[2])
  }
  return normalizeTags(out)
}

const norm = (s: string) => fold(s).replace(/[^a-z0-9]+/g, " ").trim()

export interface LinkTargetInfo {
  id: string
  kind: Kind
  name: string
  title: string
}

export class LinkIndex {
  private built = -1
  private builtAt = 0
  private byKey = new Map<string, LinkTargetInfo>()
  private outgoing = new Map<string, ResolvedLink[]>()
  private incoming = new Map<string, Array<{ from: string; link: ResolvedLink }>>()
  private entries = new Map<string, Entry>()

  constructor(
    private store: Store,
    private taskPrefix: () => string = () => "T",
  ) {}

  private ensure(): void {
    if (this.built === this.store.revision && Date.now() - this.builtAt < 15_000) return
    this.byKey.clear()
    this.outgoing.clear()
    this.incoming.clear()
    this.entries.clear()
    const all: Entry[] = []
    for (const kind of KINDS) all.push(...this.store.list(kind))
    // names first, then titles and aliases (names win)
    for (const e of all) {
      const id = `${e.kind}:${e.name}`
      this.entries.set(id, e)
      const info = { id, kind: e.kind, name: e.name, title: e.title }
      this.byKey.set(`id:${id}`, info)
      if (e.kind === "task") this.byKey.set(`id:task:${String(e.fields.id ?? "").toLowerCase()}`, info)
      if (!this.byKey.has(`name:${e.name}`) || e.kind === "knowledge") this.byKey.set(`name:${e.name}`, info)
    }
    for (const e of all) {
      const id = `${e.kind}:${e.name}`
      for (const t of [e.title, ...((e.fields.aliases as string[] | undefined) ?? []), ...(e.kind === "glossary" ? [String(e.fields.term ?? "")] : [])]) {
        const k = `title:${norm(t)}`
        if (norm(t) && (!this.byKey.has(k) || e.kind === "knowledge")) this.byKey.set(k, { id, kind: e.kind, name: e.name, title: e.title })
      }
    }
    // mark as built before resolving (resolve() calls ensure())
    this.built = this.store.revision
    this.builtAt = Date.now()
    for (const e of all) {
      const from = `${e.kind}:${e.name}`
      const links = this.resolveAll(parseLinks(e.body, this.taskPrefix()))
      this.outgoing.set(from, links)
      for (const l of links) {
        if (!l.id || l.id === from) continue
        const list = this.incoming.get(l.id) ?? []
        list.push({ from, link: l })
        this.incoming.set(l.id, list)
      }
    }
  }

  /** Resolve a link target ("name", "Titel", "kind:name", "task:T-12", "T-12"). */
  resolve(target: string): LinkTargetInfo | undefined {
    this.ensure()
    const t = target.trim()
    const i = t.indexOf(":")
    if (i > 0) {
      const kind = t.slice(0, i).toLowerCase() as Kind
      if ((KINDS as string[]).includes(kind)) {
        const name = t.slice(i + 1).trim()
        return this.byKey.get(`id:${kind}:${kind === "task" ? taskName(name) : name}`) ?? this.byKey.get(`id:${kind}:${name.toLowerCase()}`)
      }
    }
    if (new RegExp(`^${this.taskPrefix()}-\\d+$`, "i").test(t)) return this.byKey.get(`id:task:${t.toLowerCase()}`)
    return this.byKey.get(`name:${t}`) ?? this.byKey.get(`name:${t.toLowerCase()}`) ?? this.byKey.get(`title:${norm(t)}`)
  }

  resolveAll(links: ParsedLink[]): ResolvedLink[] {
    return links.map((l) => ({ ...l, id: this.resolve(l.target)?.id }))
  }

  /** Links of a text that is not stored yet (editor preview, agent task). */
  linksOf(text: string): ResolvedLink[] {
    this.ensure()
    return this.resolveAll(parseLinks(text, this.taskPrefix()))
  }

  outgoingOf(id: string): ResolvedLink[] {
    this.ensure()
    return this.outgoing.get(id) ?? []
  }

  backlinksOf(id: string): Array<{ from: string; link: ResolvedLink }> {
    this.ensure()
    return this.incoming.get(id) ?? []
  }

  /** Every resolved link as (from, to) pair (graph edges "references"). */
  pairs(): Array<{ from: string; to: string; label?: string }> {
    this.ensure()
    const out: Array<{ from: string; to: string; label?: string }> = []
    for (const [from, links] of this.outgoing) {
      const seen = new Set<string>()
      for (const l of links) {
        if (!l.id || l.id === from || seen.has(l.id)) continue
        seen.add(l.id)
        out.push({ from, to: l.id, label: l.label })
      }
    }
    return out
  }

  /** Links that do not resolve, per entry. */
  broken(): Array<{ from: string; target: string; raw: string }> {
    this.ensure()
    const out: Array<{ from: string; target: string; raw: string }> = []
    for (const [from, links] of this.outgoing) for (const l of links) if (!l.id && !l.bare) out.push({ from, target: l.target, raw: l.raw })
    return out
  }

  /** Entries whose text mentions the title or an alias of `id` without linking it. */
  mentionsOf(id: string, max = 30): Array<{ from: string; phrase: string; excerpt: string }> {
    this.ensure()
    const e = this.entries.get(id)
    if (!e) return []
    const phrases = [e.title, ...((e.fields.aliases as string[] | undefined) ?? [])].map((p) => p.trim()).filter((p) => p.length >= 4 && p !== e.name)
    if (!phrases.length) return []
    const linkedFrom = new Set(this.backlinksOf(id).map((b) => b.from))
    const out: Array<{ from: string; phrase: string; excerpt: string }> = []
    for (const [other, o] of this.entries) {
      if (other === id || linkedFrom.has(other)) continue
      const text = maskCode(o.body)
      for (const p of phrases) {
        const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(p)}(?![\\p{L}\\p{N}])`, "iu")
        const m = re.exec(text)
        if (!m) continue
        const start = Math.max(0, (m.index ?? 0) - 60)
        out.push({ from: other, phrase: p, excerpt: truncate(o.body.slice(start, (m.index ?? 0) + p.length + 60).replace(/\s+/g, " "), 180) })
        break
      }
      if (out.length >= max) break
    }
    return out
  }

  /** Candidates for the [[ completion (name, title, kind label). */
  complete(prefix: string, limit = 20): Array<LinkTargetInfo & { label: string }> {
    this.ensure()
    const q = norm(prefix)
    const out: Array<LinkTargetInfo & { label: string; score: number }> = []
    for (const [id, e] of this.entries) {
      const hay = `${norm(e.name)} ${norm(e.title)} ${norm(String(e.fields.id ?? ""))}`
      if (q && !hay.includes(q)) continue
      const score = !q ? 0 : norm(e.title).startsWith(q) || norm(e.name).startsWith(q) ? 2 : 1
      out.push({ id, kind: e.kind, name: e.name, title: e.title, label: spec(e.kind).label, score })
    }
    return out
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
      .slice(0, limit)
      .map(({ score: _s, ...x }) => x)
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Rewrite links after a rename: [[old]], [[old|x]], [[old#s]], [[kind:old…]] → new name.
 * Title links ([[Titel]]) keep working as long as the title stays.
 */
export function rewriteLinks(text: string, kind: Kind, oldName: string, newName: string): { text: string; count: number } {
  let count = 0
  const out = text.replace(LINK_RE, (raw, target: string, section?: string, label?: string) => {
    const t = target.trim()
    let replaced: string | undefined
    if (t === oldName) replaced = newName
    else if (t.toLowerCase() === `${kind}:${oldName}`.toLowerCase()) replaced = `${kind}:${newName}`
    if (!replaced) return raw
    count++
    return `[[${replaced}${section ? `#${section}` : ""}${label ? `|${label}` : ""}]]`
  })
  return { text: out, count }
}

/** "[[target]]" for an id: short form for documents, "kind:name" otherwise, T-12 for tasks. */
export function linkFor(id: string, label?: string): string {
  const i = id.indexOf(":")
  const kind = id.slice(0, i)
  const name = id.slice(i + 1)
  const target = kind === "knowledge" ? name : kind === "task" ? `task:${name.toUpperCase()}` : id
  return `[[${target}${label ? `|${label}` : ""}]]`
}
