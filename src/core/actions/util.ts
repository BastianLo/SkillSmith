/** Helpers shared by the action modules. */
import { join } from "node:path"
import type { AiAccess, Entry, Kind, Smith } from "../../types"
import { AI_ACCESS, KINDS } from "../../types"
import { readJson } from "../../util/fs"
import { slugify } from "../../util/text"
import type { Ctx } from "../context"
import { spec } from "../kinds"
import { GuardError } from "../ops"

export function parseId(id: string): { kind: Kind; name: string } {
  const i = id.indexOf(":")
  const kind = id.slice(0, i) as Kind
  const name = id.slice(i + 1)
  if (i <= 0 || !(KINDS as string[]).includes(kind) || !name) throw new GuardError(`„${id}“ ist keine Eintrags-Id (art:name)`)
  return { kind, name }
}

export function requireEntry(ctx: Ctx, id: string): Entry {
  const { kind, name } = parseId(id)
  const e = ctx.store.fresh(kind, name)
  if (!e) throw new GuardError(`${spec(kind).label} „${name}“ nicht gefunden`)
  return e
}

export function smithOfId(id: string | undefined, fallback: Smith = "docsmith"): Smith {
  if (!id) return fallback
  const i = id.indexOf(":")
  const kind = id.slice(0, i) as Kind
  if ((KINDS as string[]).includes(kind)) return spec(kind).smith
  if (id.startsWith("state:") || id.startsWith("result:")) return "memorysmith"
  return fallback
}

/** AI access defaults per folder (knowledge/.ordner.json, tracked). */
export function folderDefaults(ctx: Ctx): Record<string, AiAccess> {
  const own = readJson<Record<string, AiAccess>>(join(ctx.store.root, "knowledge", ".ordner.json"), {})
  return { ...ctx.options.docs.folderAiAccess, ...own }
}

/** AI access for a new document of the user in a folder (nearest configured parent folder wins). */
export function defaultAccess(ctx: Ctx, folder = ""): AiAccess {
  const map = folderDefaults(ctx)
  const parts = folder.split("/").filter(Boolean)
  for (let i = parts.length; i > 0; i--) {
    const v = map[parts.slice(0, i).join("/")]
    if (v && (AI_ACCESS as string[]).includes(v)) return v
  }
  return ctx.options.docs.defaultAiAccess
}

/** Free kebab-case name for a new entry derived from a title. */
export function uniqueName(ctx: Ctx, kind: Kind, title: string, max = 60): string {
  const base = slugify(title, max) || `${kind}-${Date.now().toString(36)}`
  let name = base
  for (let i = 2; ctx.store.fresh(kind, name) || (kind === "skill" && ctx.store.get("skill", name)); i++) name = `${base.slice(0, max - String(i).length - 1)}-${i}`
  return name
}

/** Frontmatter fields the editor may set per kind (author / AI access have their own actions). */
export const EDITABLE_FIELDS: Record<Kind, string[]> = {
  skill: [],
  knowledge: ["aliases", "review_after", "template"],
  glossary: ["term", "aliases", "meanings"],
  error: ["status", "signatures", "context"],
  script: ["usage", "capabilities", "requirements", "python"],
  memory: ["type", "scope", "project", "project_name", "topic", "status", "decided_by", "valid_from", "review_after", "branch", "ticket"],
  task: [],
  project: [],
}

export function pickFields(kind: Kind, fields: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!fields) return undefined
  const allowed = new Set(EDITABLE_FIELDS[kind])
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.has(k)) throw new GuardError(`Feld „${k}“ kann hier nicht geändert werden`)
    out[k] = v
  }
  return out
}
