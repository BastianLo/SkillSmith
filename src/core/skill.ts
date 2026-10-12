/** SKILL.md parsing, serialization and validation (agentskills / opencode format). */

export const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

export interface ParsedSkill {
  frontmatter: Record<string, string>
  name?: string
  description?: string
  body: string
}

function unquote(value: string): string {
  const v = value.trim()
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v)
    } catch {
      return v.slice(1, -1)
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'")
  return v
}

/**
 * Minimal YAML-frontmatter reader: top-level `key: value`, quoted scalars and
 * block scalars (| > with chomping indicators). Nested maps/lists are skipped.
 */
export function parseSkill(content: string): ParsedSkill {
  const text = content.replace(/^﻿/, "").replace(/\r\n/g, "\n")
  const fm: Record<string, string> = {}
  if (!text.startsWith("---\n") && text !== "---") return { frontmatter: fm, body: text.trim() }
  const end = text.indexOf("\n---", 3)
  if (end < 0) return { frontmatter: fm, body: text.trim() }
  const head = text.slice(4, end)
  let body = text.slice(end + 4)
  if (body.startsWith("\n")) body = body.slice(1)
  const lines = head.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = /^([A-Za-z0-9_-]+):(.*)$/.exec(line)
    if (!m) continue
    const key = m[1]
    const rest = m[2].trim()
    if (/^[|>][+-]?$/.test(rest)) {
      const folded = rest.startsWith(">")
      const collected: string[] = []
      let indent: number | undefined
      while (i + 1 < lines.length) {
        const next = lines[i + 1]
        if (next.trim() === "") {
          collected.push("")
          i++
          continue
        }
        const ind = next.length - next.trimStart().length
        if (ind === 0) break
        indent ??= ind
        collected.push(next.slice(Math.min(ind, indent)))
        i++
      }
      while (collected.length && collected[collected.length - 1] === "") collected.pop()
      fm[key] = folded ? collected.join(" ").replace(/\s+/g, " ").trim() : collected.join("\n")
      continue
    }
    if (rest === "") {
      // nested map / list → skip indented children
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) i++
      continue
    }
    fm[key] = unquote(rest)
  }
  return { frontmatter: fm, name: fm.name, description: fm.description, body: body.trim() }
}

export function serializeSkill(input: { name: string; description: string; body: string }): string {
  return `---\nname: ${input.name}\ndescription: ${JSON.stringify(input.description)}\n---\n\n${input.body.trim()}\n`
}

export function validateName(name: string): string | undefined {
  if (!name) return "name is empty"
  if (name.length > 64) return "name is longer than 64 characters"
  if (!NAME_RE.test(name)) return "name must be lowercase kebab-case (a-z, 0-9, single hyphens), e.g. db2-explain-plan"
  return undefined
}

export function validateDescription(description: string, max: number): string | undefined {
  const d = description.trim()
  if (!d) return "description is empty"
  if (/\n/.test(d)) return "description must be a single line"
  if (d.length > max) return `description is longer than ${max} characters (${d.length})`
  return undefined
}

export function validateBody(body: string, max: number): string | undefined {
  const b = body.trim()
  if (!b) return "body is empty"
  if (b.startsWith("---")) return "body must not contain frontmatter; pass name/description separately"
  if (b.length > max) return `body is longer than ${max} characters (${b.length}); condense it`
  if (/\bTODO\b/.test(b)) return "body contains TODO placeholders; write the actual content"
  return undefined
}

export function headings(body: string): string[] {
  return body
    .split("\n")
    .filter((l) => /^#{1,6}\s/.test(l))
    .map((l) => l.replace(/^#{1,6}\s+/, "").trim())
}

/** Heuristic lint: warns (never blocks) about log-like skill bodies. */
export function lintBody(body: string): string[] {
  const warnings: string[] = []
  const ticketRefs = body.match(/\b([A-Z][A-Z0-9]+-\d+|#\d{2,})\b/g) ?? []
  if (ticketRefs.length >= 4) warnings.push("body references many ticket/PR numbers; skills should contain lessons, not logs")
  const dates = body.match(/\b20\d{2}-\d{2}-\d{2}\b/g) ?? []
  if (dates.length >= 3) warnings.push("body contains several dates; keep timeless rules instead")
  if (!/^##\s/m.test(body)) warnings.push('no "## " sections; prefer When to use / Steps / Pitfalls / Verification')
  return warnings
}
