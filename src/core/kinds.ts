/**
 * Registry of entry kinds. Every kind shares the store mechanics (tiers,
 * meta, candidates, git, search); this file defines what differs: layout,
 * frontmatter fields, search fields and labels.
 */
import type { Smith } from "../types"
import type { AiAccess, Entry, GlossaryMeaning, Kind, MemoryType, Tier } from "../types"
import { AI_ACCESS, MEMORY_TYPES } from "../types"
import { fold, slugify } from "../util/text"
import { parseDoc, serializeDoc, str, strArray } from "./frontmatter"
import { headings } from "./skill"

export interface EntryContent {
  name: string
  title: string
  description: string
  tags: string[]
  fields: Record<string, unknown>
  body: string
}

export interface KindSpec {
  kind: Kind
  smith: Smith
  /** store sub directory */
  dir: string
  /** dir: <dir>/<tier>/<name>/<main>; file: <dir>/<tier>/<name>.md */
  layout: "dir" | "file"
  main: string
  tiers: Tier[]
  label: string
  labelPlural: string
  /** names accepted in commands */
  aliases: string[]
  parse(content: string, fallbackName: string): EntryContent
  serialize(e: EntryContent): string
  searchFields(e: Entry): Array<[number, string]>
  /** entries live in nested folders below the tier (knowledge) */
  folders?: boolean
  /** maintained by the user only (tasks, projects): no reviewer, curator or doctor */
  userOwned?: boolean
}

/** Fields every kind may carry: author (user | agent) and AI access. */
function commonIn(fm: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const ai = str(fm.ai)
  if ((AI_ACCESS as string[]).includes(ai)) out.ai = ai
  const author = str(fm.author)
  if (author === "user" || author === "agent") out.author = author
  return out
}

function commonOut(f: Record<string, unknown>): Array<[string, unknown]> {
  return [
    ["author", str(f.author)],
    ["ai", str(f.ai)],
  ]
}

/** AI access of an entry: frontmatter, else frei (entries of the AI) – user documents get their default on creation. */
export function aiAccessOf(e: Pick<Entry, "fields">): AiAccess {
  const a = str(e.fields.ai)
  return (AI_ACCESS as string[]).includes(a) ? (a as AiAccess) : "frei"
}

export function isPrivate(e: Pick<Entry, "fields">): boolean {
  return aiAccessOf(e) === "privat"
}

/** Written by the user (frontmatter author, or created through a command / the web view). */
export function isOwnDoc(e: Pick<Entry, "fields" | "meta">): boolean {
  const a = str(e.fields.author)
  if (a) return a === "user"
  return e.meta?.createdBy === "command" || e.meta?.createdBy === "web"
}

export const TASK_PRIORITIES = ["niedrig", "normal", "hoch", "kritisch"] as const

/** "T-12" ↔ "t-12" */
export function taskName(id: string): string {
  return id.trim().toLowerCase()
}
export function taskId(name: string): string {
  return name.toUpperCase()
}

export function normalizeTags(input: unknown): string[] {
  const out: string[] = []
  for (const raw of strArray(input)) {
    const t = slugify(raw.replace(/^#/, ""), 40)
    if (t && !out.includes(t)) out.push(t)
    if (out.length >= 12) break
  }
  return out
}

export function meaningsOf(v: unknown): GlossaryMeaning[] {
  if (!Array.isArray(v)) return []
  const out: GlossaryMeaning[] = []
  for (const m of v) {
    if (!m || typeof m !== "object") continue
    const r = m as Record<string, unknown>
    const expansion = str(r.expansion).trim()
    if (!expansion) continue
    const meaning: GlossaryMeaning = { expansion, description: str(r.description).trim() }
    const ctx = str(r.context).trim()
    if (ctx) meaning.context = ctx
    out.push(meaning)
  }
  return out
}

/** Slug used as file name for a glossary term ("M&A" → "m-a", "DB2" → "db2"). */
export function glossarySlug(term: string): string {
  return slugify(term, 50) || `term-${fold(term).replace(/[^a-z0-9]/g, "").slice(0, 20) || "x"}`
}

const bodyField = (e: Entry): Array<[number, string]> => [
  [1.5, headings(e.body).join(" ")],
  [1, e.body],
]

const SPECS: Record<Kind, KindSpec> = {
  skill: {
    kind: "skill",
    smith: "skillsmith",
    dir: "skills",
    layout: "dir",
    main: "SKILL.md",
    tiers: ["active", "dormant", "archive"],
    label: "Skill",
    labelPlural: "Skills",
    aliases: ["skill", "skills"],
    parse(content, fallbackName) {
      const { fm, body } = parseDoc(content)
      const name = str(fm.name) || fallbackName
      return { name, title: name, description: str(fm.description), tags: normalizeTags(fm.tags), fields: { ...commonIn(fm) }, body }
    },
    serialize(e) {
      return serializeDoc(
        [
          ["name", e.name],
          ["description", e.description],
          ["tags", e.tags],
          ...commonOut(e.fields),
        ],
        e.body,
      )
    },
    searchFields(e) {
      return [[3, e.name.replace(/-/g, " ")], [2, e.description], [3, e.tags.join(" ")], ...bodyField(e)]
    },
  },
  knowledge: {
    kind: "knowledge",
    smith: "docsmith",
    dir: "knowledge",
    layout: "file",
    main: ".md",
    tiers: ["active", "archive"],
    label: "Wissen",
    labelPlural: "Wissen",
    aliases: ["knowledge", "wissen", "doku", "docs", "dokument", "dokumente"],
    folders: true,
    parse(content, fallbackName) {
      const { fm, body } = parseDoc(content)
      const name = str(fm.name) || fallbackName
      const fields: Record<string, unknown> = { ...commonIn(fm) }
      const aliases = strArray(fm.aliases)
      if (aliases.length) fields.aliases = aliases
      if (str(fm.review_after)) fields.review_after = str(fm.review_after)
      if (str(fm.template)) fields.template = str(fm.template)
      return { name, title: str(fm.title) || name, description: str(fm.description), tags: normalizeTags(fm.tags), fields, body }
    },
    serialize(e) {
      return serializeDoc(
        [
          ["name", e.name],
          ["title", e.title],
          ["description", e.description],
          ["tags", e.tags],
          ["aliases", strArray(e.fields.aliases)],
          ...commonOut(e.fields),
          ["review_after", str(e.fields.review_after)],
          ["template", str(e.fields.template)],
        ],
        e.body,
      )
    },
    searchFields(e) {
      return [[3, e.title], [1.5, e.name.replace(/-/g, " ")], [2, e.description], [3, e.tags.join(" ")], ...bodyField(e)]
    },
  },
  glossary: {
    kind: "glossary",
    smith: "docsmith",
    dir: "glossary",
    layout: "file",
    main: ".md",
    tiers: ["active", "archive"],
    label: "Glossar",
    labelPlural: "Glossar",
    aliases: ["glossary", "glossar", "abk", "abkuerzung", "abkürzung"],
    parse(content, fallbackName) {
      const { fm, body } = parseDoc(content)
      const name = str(fm.name) || fallbackName
      const term = str(fm.term) || name.toUpperCase()
      const meanings = meaningsOf(fm.meanings)
      return {
        name,
        title: term,
        description: meanings.map((m) => m.expansion).join(" / "),
        tags: normalizeTags(fm.tags),
        fields: { term, aliases: strArray(fm.aliases), meanings, ...commonIn(fm) },
        body,
      }
    },
    serialize(e) {
      return serializeDoc(
        [
          ["name", e.name],
          ["term", str(e.fields.term) || e.title],
          ["aliases", strArray(e.fields.aliases)],
          ["meanings", meaningsOf(e.fields.meanings)],
          ["tags", e.tags],
          ...commonOut(e.fields),
        ],
        e.body,
      )
    },
    searchFields(e) {
      const meanings = meaningsOf(e.fields.meanings)
      return [
        [5, str(e.fields.term)],
        [4, strArray(e.fields.aliases).join(" ")],
        [3, meanings.map((m) => m.expansion).join(" ")],
        [1.5, meanings.map((m) => `${m.description} ${m.context ?? ""}`).join(" ")],
        [3, e.tags.join(" ")],
        [1, e.body],
      ]
    },
  },
  error: {
    kind: "error",
    smith: "errorsmith",
    dir: "errors",
    layout: "file",
    main: ".md",
    tiers: ["active", "dormant", "archive"],
    label: "Fehler",
    labelPlural: "Fehler",
    aliases: ["error", "errors", "fehler"],
    parse(content, fallbackName) {
      const { fm, body } = parseDoc(content)
      const name = str(fm.name) || fallbackName
      return {
        name,
        title: str(fm.title) || name,
        description: str(fm.description),
        tags: normalizeTags(fm.tags),
        fields: {
          status: str(fm.status) === "open" ? "open" : "solved",
          signatures: strArray(fm.signatures),
          context: strArray(fm.context),
          ...commonIn(fm),
        },
        body,
      }
    },
    serialize(e) {
      return serializeDoc(
        [
          ["name", e.name],
          ["title", e.title],
          ["description", e.description],
          ["status", str(e.fields.status) || "solved"],
          ["signatures", strArray(e.fields.signatures)],
          ["context", strArray(e.fields.context)],
          ["tags", e.tags],
          ...commonOut(e.fields),
        ],
        e.body,
      )
    },
    searchFields(e) {
      return [
        [3, e.title],
        [2, e.description],
        [2.5, strArray(e.fields.signatures).join(" ")],
        [2, strArray(e.fields.context).join(" ")],
        [3, e.tags.join(" ")],
        ...bodyField(e),
      ]
    },
  },
  script: {
    kind: "script",
    smith: "toolsmith",
    dir: "scripts",
    layout: "dir",
    main: "SCRIPT.md",
    tiers: ["active", "dormant", "archive"],
    label: "Skript",
    labelPlural: "Skripte",
    aliases: ["script", "scripts", "skript", "skripte", "tool", "tools"],
    parse(content, fallbackName) {
      const { fm, body } = parseDoc(content)
      const name = str(fm.name) || fallbackName
      return {
        name,
        title: name,
        description: str(fm.description),
        tags: normalizeTags(fm.tags),
        fields: {
          usage: str(fm.usage),
          entry: str(fm.entry) || `${name.replace(/-/g, "_")}.py`,
          capabilities: strArray(fm.capabilities),
          requirements: strArray(fm.requirements),
          python: str(fm.python),
          ...commonIn(fm),
        },
        body,
      }
    },
    serialize(e) {
      return serializeDoc(
        [
          ["name", e.name],
          ["description", e.description],
          ["usage", str(e.fields.usage)],
          ["entry", str(e.fields.entry)],
          ["capabilities", strArray(e.fields.capabilities)],
          ["requirements", strArray(e.fields.requirements)],
          ["python", str(e.fields.python)],
          ["tags", e.tags],
          ...commonOut(e.fields),
        ],
        e.body,
      )
    },
    searchFields(e) {
      return [
        [3, e.name.replace(/-/g, " ")],
        [2, e.description],
        [1.5, str(e.fields.usage)],
        [3, e.tags.join(" ")],
        ...bodyField(e),
      ]
    },
  },
  memory: {
    kind: "memory",
    smith: "memorysmith",
    dir: "memories",
    layout: "file",
    main: ".md",
    tiers: ["active", "archive"],
    label: "Erinnerung",
    labelPlural: "Erinnerungen",
    aliases: ["memory", "memories", "erinnerung", "erinnerungen", "mem", "gedaechtnis"],
    parse(content, fallbackName) {
      const { fm, body } = parseDoc(content)
      const name = str(fm.name) || fallbackName
      const type = (MEMORY_TYPE_SET.has(str(fm.type)) ? str(fm.type) : "erfahrung") as MemoryType
      return {
        name,
        title: str(fm.title) || name,
        description: str(fm.description),
        tags: normalizeTags(fm.tags),
        fields: {
          type,
          scope: str(fm.scope) === "global" ? "global" : "projekt",
          project: str(fm.project),
          project_name: str(fm.project_name),
          topic: str(fm.topic),
          status: ["gueltig", "vorgeschlagen", "abgeloest"].includes(str(fm.status)) ? str(fm.status) : "gueltig",
          decided_by: str(fm.decided_by),
          valid_from: str(fm.valid_from),
          review_after: str(fm.review_after),
          superseded_by: str(fm.superseded_by),
          branch: str(fm.branch),
          ticket: str(fm.ticket),
          ...commonIn(fm),
        },
        body,
      }
    },
    serialize(e) {
      const f = e.fields
      return serializeDoc(
        [
          ["name", e.name],
          ["type", str(f.type) || "erfahrung"],
          ["scope", str(f.scope) || "projekt"],
          ["project", str(f.project)],
          ["project_name", str(f.project_name)],
          ["topic", str(f.topic)],
          ["title", e.title],
          ["description", e.description],
          ["status", str(f.status) || "gueltig"],
          ...(str(f.decided_by) ? ([["decided_by", str(f.decided_by)]] as Array<[string, unknown]>) : []),
          ...(str(f.valid_from) ? ([["valid_from", str(f.valid_from)]] as Array<[string, unknown]>) : []),
          ...(str(f.review_after) ? ([["review_after", str(f.review_after)]] as Array<[string, unknown]>) : []),
          ...(str(f.superseded_by) ? ([["superseded_by", str(f.superseded_by)]] as Array<[string, unknown]>) : []),
          ...(str(f.branch) ? ([["branch", str(f.branch)]] as Array<[string, unknown]>) : []),
          ...(str(f.ticket) ? ([["ticket", str(f.ticket)]] as Array<[string, unknown]>) : []),
          ["tags", e.tags],
          ...commonOut(f),
        ],
        e.body,
      )
    },
    searchFields(e) {
      return [
        [3, e.title],
        [2, e.description],
        [2, str(e.fields.topic).replace(/[/-]/g, " ")],
        [3, e.tags.join(" ")],
        [1, `${str(e.fields.type)} ${str(e.fields.project_name)} ${str(e.fields.ticket)}`],
        ...bodyField(e),
      ]
    },
  },
  task: {
    kind: "task",
    smith: "memorysmith",
    dir: "tasks",
    layout: "file",
    main: ".md",
    tiers: ["active", "archive"],
    label: "Aufgabe",
    labelPlural: "Aufgaben",
    aliases: ["task", "tasks", "aufgabe", "aufgaben", "karte"],
    userOwned: true,
    parse(content, fallbackName) {
      const { fm, body } = parseDoc(content)
      const name = taskName(str(fm.id) || str(fm.name) || fallbackName)
      const fields: Record<string, unknown> = {
        id: taskId(name),
        status: str(fm.status) || "neu",
        priority: (TASK_PRIORITIES as readonly string[]).includes(str(fm.priority)) ? str(fm.priority) : "normal",
        ...commonIn(fm),
      }
      for (const k of ["due", "parent", "assignee", "agent", "model", "project", "branch", "ticket", "created_by", "proposal", "worktree", "workdir"]) {
        if (str(fm[k])) fields[k] = str(fm[k])
      }
      if (fm.suggested === true || fm.suggested === "true") fields.suggested = true
      if (fm.attachments !== undefined) fields.attachments = strArray(fm.attachments)
      return { name, title: str(fm.title) || taskId(name), description: str(fm.description), tags: normalizeTags(fm.labels ?? fm.tags), fields, body }
    },
    serialize(e) {
      const f = e.fields
      return serializeDoc(
        [
          ["id", str(f.id) || taskId(e.name)],
          ["title", e.title],
          ["description", e.description],
          ["status", str(f.status) || "neu"],
          ["priority", str(f.priority) || "normal"],
          ["labels", e.tags],
          ...["due", "parent", "assignee", "agent", "model", "project", "branch", "ticket", "created_by", "proposal", "worktree", "workdir"].map((k) => [k, str(f[k])] as [string, unknown]),
          ["suggested", f.suggested === true ? true : undefined],
          ["attachments", strArray(f.attachments)],
          ...commonOut(f),
        ],
        e.body,
      )
    },
    searchFields(e) {
      return [
        [4, str(e.fields.id)],
        [3, e.title],
        [2, e.description],
        [3, e.tags.join(" ")],
        [1, `${str(e.fields.project)} ${str(e.fields.ticket)} ${str(e.fields.branch)}`],
        ...bodyField(e),
      ]
    },
  },
  project: {
    kind: "project",
    smith: "memorysmith",
    dir: "projects",
    layout: "file",
    main: ".md",
    tiers: ["active", "archive"],
    label: "Projekt",
    labelPlural: "Projekte",
    aliases: ["project", "projects", "projekt", "projekte"],
    userOwned: true,
    parse(content, fallbackName) {
      const { fm, body } = parseDoc(content)
      const name = str(fm.name) || fallbackName
      const fields: Record<string, unknown> = { ...commonIn(fm) }
      for (const k of ["home_path", "agent", "model", "color", "repo"]) if (str(fm[k])) fields[k] = str(fm[k])
      if (fm.columns !== undefined) fields.columns = strArray(fm.columns)
      if (fm.wip && typeof fm.wip === "object" && !Array.isArray(fm.wip)) fields.wip = fm.wip
      if (fm.pipeline && typeof fm.pipeline === "object" && !Array.isArray(fm.pipeline)) fields.pipeline = fm.pipeline
      if (fm.aliases !== undefined) fields.aliases = strArray(fm.aliases)
      return { name, title: str(fm.title) || name, description: str(fm.description), tags: normalizeTags(fm.tags), fields, body }
    },
    serialize(e) {
      const f = e.fields
      return serializeDoc(
        [
          ["name", e.name],
          ["title", e.title],
          ["description", e.description],
          ["home_path", str(f.home_path)],
          ["repo", str(f.repo)],
          ["agent", str(f.agent)],
          ["model", str(f.model)],
          ["color", str(f.color)],
          ["columns", strArray(f.columns)],
          ["wip", f.wip && typeof f.wip === "object" && Object.keys(f.wip).length ? f.wip : undefined],
          ["pipeline", f.pipeline && typeof f.pipeline === "object" ? f.pipeline : undefined],
          ["aliases", strArray(f.aliases)],
          ["tags", e.tags],
          ...commonOut(f),
        ],
        e.body,
      )
    },
    searchFields(e) {
      return [[4, e.title], [3, e.name.replace(/-/g, " ")], [2, e.description], [2, e.tags.join(" ")], [1, str(e.fields.home_path)], ...bodyField(e)]
    },
  },
}

const MEMORY_TYPE_SET = new Set<string>(MEMORY_TYPES)

export const MEMORY_TYPE_LABEL: Record<string, string> = {
  entscheidung: "Entscheidung",
  vorgabe: "Vorgabe",
  erfahrung: "Erfahrung",
  arbeitsstand: "Arbeitsstand",
  ergebnis: "Ergebnis",
  session: "Session",
}

/** Topic key "typ/thema" (lowercase, kebab); accepts "Token Speicherung" or "entscheidung/token-speicherung". */
export function topicKey(type: string, raw: string): string {
  const parts = raw.trim().toLowerCase().split("/")
  const subject = parts.length > 1 && parts[0] === type ? parts.slice(1).join("-") : raw
  const slug = slugify(subject, 40) || "eintrag"
  return `${type}/${slug}`
}

/** Store name of a durable memory: <project-slug>-<type>-<subject> (≤ 64, kebab). */
export function memoryName(projectSlug: string, topic: string): string {
  const [type, subject] = topic.split("/")
  const p = slugify(projectSlug, 18) || "global"
  const name = `${p}-${type}-${subject ?? "eintrag"}`
  return name.length <= 64 ? name : name.slice(0, 64).replace(/-+$/, "")
}

export function spec(kind: Kind): KindSpec {
  return SPECS[kind]
}

export function kindFromAlias(input: string): Kind | undefined {
  const a = fold(input.trim())
  for (const s of Object.values(SPECS)) if (s.aliases.includes(a) || s.kind === a) return s.kind
  return undefined
}

export function kindsOf(smith: Smith): Kind[] {
  return Object.values(SPECS)
    .filter((s) => s.smith === smith)
    .map((s) => s.kind)
}

export const TIER_LABEL: Record<string, string> = {
  active: "aktiv",
  dormant: "ruhend",
  archive: "archiviert",
  foreign: "extern",
}

/** module file names of a script entry */
export function scriptFiles(name: string): { module: string; code: string; test: string } {
  const module = name.replace(/-/g, "_")
  return { module, code: `${module}.py`, test: `test_${module}.py` }
}
