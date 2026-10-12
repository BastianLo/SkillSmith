/** CSV and Markdown table parsing (glossary import in commands and the web view). */
import type { GlossaryMeaning } from "../../types"
import { fold } from "../../util/text"

export function parseCsv(text: string): string[][] {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim()) ?? ""
  const delim = firstLine.includes("\t") ? "\t" : (firstLine.match(/;/g) ?? []).length >= (firstLine.match(/,/g) ?? []).length ? ";" : ","
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
      continue
    }
    if (ch === '"' && cell === "") quoted = true
    else if (ch === delim) {
      row.push(cell)
      cell = ""
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++
      row.push(cell)
      if (row.some((c) => c.trim())) rows.push(row.map((c) => c.trim()))
      row = []
      cell = ""
    } else cell += ch
  }
  row.push(cell)
  if (row.some((c) => c.trim())) rows.push(row.map((c) => c.trim()))
  return rows
}

export function parseMarkdownTable(text: string): string[][] {
  const rows: string[][] = []
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim()
    if (!l.startsWith("|")) continue
    const cells = l
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split(/(?<!\\)\|/)
      .map((c) => c.replace(/\\\|/g, "|").trim())
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) continue
    rows.push(cells)
  }
  return rows
}

export function glossaryRows(rows: string[][]): Array<{ term: string; meaning: GlossaryMeaning }> {
  if (!rows.length) return []
  const header = rows[0].map((c) => fold(c))
  const isHeader = header.some((c) => /abk|term|abbr|kurzel|kuerzel|begriff/.test(c)) && header.some((c) => /bedeut|meaning|expan|langform|beschreib|descr/.test(c))
  let iTerm = 0
  let iExp = 1
  let iDesc = 2
  let iCtx = 3
  if (isHeader) {
    const find = (re: RegExp, fallback: number) => {
      const i = header.findIndex((c) => re.test(c))
      return i >= 0 ? i : fallback
    }
    iTerm = find(/abk|term|abbr|kurzel|kuerzel|begriff/, 0)
    iExp = find(/bedeut|meaning|expan|langform|ausgeschrieben/, 1)
    iDesc = find(/beschreib|descr|erklar|erlaeuter/, 2)
    iCtx = find(/kontext|context|bereich|domain/, 3)
  }
  const out: Array<{ term: string; meaning: GlossaryMeaning }> = []
  for (const r of rows.slice(isHeader ? 1 : 0)) {
    const term = (r[iTerm] ?? "").replace(/\*\*/g, "").trim()
    const expansion = (r[iExp] ?? "").trim()
    const description = (r[iDesc] ?? "").trim() || expansion
    if (!term || !expansion) continue
    const context = (r[iCtx] ?? "").trim()
    out.push({ term, meaning: { expansion, description, ...(context ? { context } : {}) } })
  }
  return out
}

