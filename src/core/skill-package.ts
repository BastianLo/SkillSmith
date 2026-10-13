/**
 * Skill packages: a SKILL.md plus supporting files (references/*.md, examples, templates) –
 * the layout of Anthropic/opencode skills. Accepted uploads:
 *
 *   .zip / .skill   archive with a SKILL.md (directly or in one top folder)
 *   SKILL.md / .md  the skill alone
 *   folder          from the browser as JSON {files: [{path, data (base64)}]} (name *.skilldir.json)
 *
 * Files keep their relative path (references/styleguide.md). Text files are checked for
 * secrets; hidden files, __MACOSX and unknown binary types are skipped (reported as warnings).
 */
import { parseDoc, str, strArray } from "./frontmatter"
import { unzip } from "./importer"
import { normalizeTags } from "./kinds"
import { GuardError } from "./ops"
import { slugify } from "../util/text"

export interface SkillPackage {
  name: string
  description: string
  tags: string[]
  body: string
  /** relative path → content (text as string, binaries as bytes) */
  files: Record<string, string | Uint8Array>
  warnings: string[]
}

const TEXT_EXT = new Set(["md", "markdown", "txt", "json", "yaml", "yml", "csv", "tsv", "xml", "html", "css", "py", "ts", "js", "mjs", "sh", "sql", "toml", "ini", "svg"])
const BINARY_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "pdf", "pptx", "potx", "docx", "dotx", "xlsx"])
export const SKILL_PACKAGE_LIMITS = { files: 60, fileBytes: 2 * 1024 * 1024, totalBytes: 12 * 1024 * 1024 }

const extOf = (p: string) => /\.([A-Za-z0-9]+)$/.exec(p)?.[1]?.toLowerCase() ?? ""

/** "Mein Skill/references/Style Guide.md" → "references/style-guide.md" (store-safe, keeps the folder structure) */
function safePath(rel: string): string | undefined {
  const parts = rel.split("/").filter(Boolean)
  if (!parts.length || parts.length > 3) return undefined
  const out = parts.map((seg, i) => {
    const last = i === parts.length - 1
    const ext = last ? extOf(seg) : ""
    const base = last && ext ? seg.slice(0, -(ext.length + 1)) : seg
    const slug = slugify(base, 60) || "datei"
    return ext ? `${slug}.${ext}` : slug
  })
  return out.join("/")
}

function fromFiles(entries: Array<{ path: string; data: Uint8Array }>, fallbackName: string): SkillPackage {
  const warnings: string[] = []
  const clean = entries
    .map((e) => ({ path: e.path.replace(/\\/g, "/").replace(/^\/+/, ""), data: e.data }))
    .filter((e) => {
      if (e.path.split("/").some((p) => p.startsWith(".") || p === "__MACOSX")) return false
      return !e.path.endsWith("/")
    })
  const main = clean.filter((e) => /(^|\/)skill\.md$/i.test(e.path)).sort((a, b) => a.path.split("/").length - b.path.split("/").length)[0]
  if (!main) throw new GuardError("Keine SKILL.md im Paket gefunden")
  const root = main.path.slice(0, main.path.length - "SKILL.md".length)
  const { fm, body } = parseDoc(new TextDecoder().decode(main.data))
  const folderName = root.split("/").filter(Boolean).pop()
  const name = slugify(str(fm.name) || folderName || fallbackName, 64)
  if (!name) throw new GuardError("Der Skill braucht einen Namen (name im Frontmatter)")
  const description = str(fm.description).replace(/\s+/g, " ").trim()
  if (!description) throw new GuardError("Der Skill braucht eine Beschreibung (description im Frontmatter)")
  const files: Record<string, string | Uint8Array> = {}
  let total = main.data.length
  for (const e of clean) {
    if (e === main || !e.path.startsWith(root)) continue
    const rel = e.path.slice(root.length)
    const ext = extOf(rel)
    if (!TEXT_EXT.has(ext) && !BINARY_EXT.has(ext)) {
      warnings.push(`${rel}: Dateityp nicht übernommen`)
      continue
    }
    if (e.data.length > SKILL_PACKAGE_LIMITS.fileBytes) {
      warnings.push(`${rel}: größer als ${SKILL_PACKAGE_LIMITS.fileBytes / 1024 / 1024} MB, nicht übernommen`)
      continue
    }
    const target = safePath(rel)
    if (!target || target.toLowerCase() === "skill.md") {
      warnings.push(`${rel}: Pfad zu tief verschachtelt, nicht übernommen`)
      continue
    }
    if (Object.keys(files).length >= SKILL_PACKAGE_LIMITS.files) {
      warnings.push(`mehr als ${SKILL_PACKAGE_LIMITS.files} Dateien – Rest nicht übernommen`)
      break
    }
    total += e.data.length
    if (total > SKILL_PACKAGE_LIMITS.totalBytes) throw new GuardError(`Skill-Paket größer als ${SKILL_PACKAGE_LIMITS.totalBytes / 1024 / 1024} MB`)
    files[target] = TEXT_EXT.has(ext) ? new TextDecoder().decode(e.data) : e.data
  }
  // links in SKILL.md to renamed files keep working: rewrite "references/Style Guide.md" → the stored path
  let text = body
  for (const e of clean) {
    if (!e.path.startsWith(root) || e === main) continue
    const rel = e.path.slice(root.length)
    const target = safePath(rel)
    if (target && target !== rel && files[target] !== undefined) text = text.split(rel).join(target)
  }
  return { name, description, tags: normalizeTags(strArray(fm.tags).length ? fm.tags : fm.keywords), body: text.trim(), files, warnings }
}

export function parseSkillPackage(fileName: string, data: Uint8Array): SkillPackage {
  const lower = fileName.toLowerCase()
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.(zip|skill|md|markdown|skilldir\.json)$/i, "")
  if (lower.endsWith(".skilldir.json")) {
    let raw: { files?: Array<{ path?: string; data?: string }> }
    try {
      raw = JSON.parse(new TextDecoder().decode(data))
    } catch {
      throw new GuardError("Ordner-Upload ist kein gültiges JSON")
    }
    const entries = (raw.files ?? []).filter((f) => typeof f.path === "string" && typeof f.data === "string").map((f) => ({ path: f.path!, data: new Uint8Array(Buffer.from(f.data!, "base64")) }))
    return fromFiles(entries, base)
  }
  if (lower.endsWith(".zip") || lower.endsWith(".skill") || (data[0] === 0x50 && data[1] === 0x4b)) {
    let map: Map<string, Uint8Array>
    try {
      map = unzip(data)
    } catch (err) {
      throw new GuardError(`ZIP-Datei nicht lesbar: ${(err as Error).message}`)
    }
    return fromFiles([...map.entries()].map(([path, d]) => ({ path, data: d })), base)
  }
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return fromFiles([{ path: "SKILL.md", data }], base)
  throw new GuardError("Bitte eine .zip/.skill-Datei, eine SKILL.md oder einen Ordner hochladen")
}

/** Text files of a skill (SKILL.md body first) as one block for prompts that must follow it completely. */
export function skillTextFiles(files: Array<{ rel: string; text: string }>): string {
  return files.map((f) => `### Datei ${f.rel}\n\n${f.text.trim()}`).join("\n\n")
}
