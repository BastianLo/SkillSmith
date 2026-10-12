/**
 * Markdown documents with YAML frontmatter. Writes a strict subset that is
 * valid YAML (JSON flow values for strings, lists and objects) and reads that
 * subset plus the usual hand-written forms (plain/quoted scalars, block
 * scalars | >, block lists "- item").
 */

export interface ParsedDoc {
  fm: Record<string, unknown>
  body: string
}

function unquote(value: string): unknown {
  const v = value.trim()
  if (!v) return ""
  if (v.startsWith("[") || v.startsWith("{")) {
    try {
      return JSON.parse(v)
    } catch {
      // YAML flow without JSON quoting: [a, b]
      if (v.startsWith("[") && v.endsWith("]")) {
        return v
          .slice(1, -1)
          .split(",")
          .map((s) => String(unquote(s)))
          .filter((s) => s !== "")
      }
      return v
    }
  }
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

export function parseDoc(content: string): ParsedDoc {
  const text = content.replace(/^﻿/, "").replace(/\r\n/g, "\n")
  const fm: Record<string, unknown> = {}
  if (!text.startsWith("---\n") && text !== "---") return { fm, body: text.trim() }
  const end = text.indexOf("\n---", 3)
  if (end < 0) return { fm, body: text.trim() }
  const head = text.slice(4, end)
  let body = text.slice(end + 4)
  const nl = body.indexOf("\n")
  body = nl >= 0 ? body.slice(nl + 1) : ""
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
      // block list ("- item") or nested map (skipped)
      const items: unknown[] = []
      let isList = false
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        const next = lines[i + 1].trim()
        if (next.startsWith("- ")) {
          isList = true
          items.push(unquote(next.slice(2)))
        }
        i++
      }
      if (isList) fm[key] = items
      continue
    }
    fm[key] = unquote(rest)
  }
  return { fm, body: body.trim() }
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || (Array.isArray(v) && v.length === 0) || v === ""
}

/** Serialize ordered fields; `name` is written plain (kebab-case), everything else as JSON flow values. */
export function serializeDoc(fields: Array<[string, unknown]>, body: string): string {
  const lines = ["---"]
  for (const [k, v] of fields) {
    if (isEmpty(v)) continue
    if (k === "name" && typeof v === "string" && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(v)) lines.push(`${k}: ${v}`)
    else if (typeof v === "number" || typeof v === "boolean") lines.push(`${k}: ${v}`)
    else lines.push(`${k}: ${JSON.stringify(v)}`)
  }
  lines.push("---", "")
  const b = body.trim()
  return lines.join("\n") + (b ? `\n${b}\n` : "")
}

export const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v))

export const strArray = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map((x) => str(x).trim()).filter(Boolean)
  if (typeof v === "string" && v.trim()) return v.split(",").map((s) => s.trim()).filter(Boolean)
  return []
}
