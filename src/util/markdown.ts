/**
 * Small escaping Markdown renderer (static export). Text is escaped first; only a fixed
 * set of tags is produced. [[links]] are resolved by a callback.
 */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string)

export interface MdOptions {
  /** [[target|label]] → href (undefined = plain text) */
  link?: (target: string, section?: string) => { href: string; title?: string } | undefined
}

function inline(s: string, o: MdOptions): string {
  return s
    .split(/(`[^`]+`)/g)
    .map((p) => {
      if (p.length > 1 && p.startsWith("`") && p.endsWith("`")) return `<code>${esc(p.slice(1, -1))}</code>`
      let t = esc(p)
      t = t.replace(/\[\[([^\[\]|#\n]+)(?:#([^\[\]|\n]+))?(?:\|([^\[\]\n]+))?\]\]/g, (_m, target: string, section: string | undefined, label: string | undefined) => {
        const r = o.link?.(target.trim(), section?.trim())
        const text = label ?? target
        return r ? `<a href="${r.href}"${r.title ? ` title="${r.title}"` : ""}>${text}</a>` : `<span class="broken">${text}</span>`
      })
      t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, txt, url) => `<a href="${url}" rel="noopener noreferrer">${txt}</a>`)
      t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      t = t.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>")
      return t
    })
    .join("")
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const isBlockStart = (l: string) => /^```/.test(l) || /^#{1,6}\s/.test(l) || LIST_RE.test(l) || /^\s*>/.test(l) || /^\s*\|.*\|\s*$/.test(l)

export function renderMarkdown(src: string, o: MdOptions = {}): string {
  const lines = String(src || "").replace(/\r/g, "").split("\n")
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      const lang = line.trim().slice(3).trim()
      const buf: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++])
      i++
      out.push(`<pre${lang ? ` data-lang="${esc(lang)}"` : ""}><code>${esc(buf.join("\n"))}</code></pre>`)
      continue
    }
    const hm = /^(#{1,6})\s+(.*)$/.exec(line)
    if (hm) {
      const lvl = Math.min(4, hm[1].length)
      const id = hm[2].toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "")
      out.push(`<h${lvl} id="${esc(id)}">${inline(hm[2], o)}</h${lvl}>`)
      i++
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("<hr>")
      i++
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim())
      const head = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]))
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c, o)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, o)}</td>`).join("")}</tr>`).join("")}</tbody></table>`)
      continue
    }
    if (/^\s*>/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""))
      out.push(`<blockquote>${renderMarkdown(buf.join("\n"), o)}</blockquote>`)
      continue
    }
    const lm = LIST_RE.exec(line)
    if (lm) {
      const indent = lm[1].length
      const ordered = /\d/.test(lm[2])
      const items: string[] = []
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i])
        if (!m || m[1].length !== indent) break
        const sub: string[] = []
        i++
        while (i < lines.length && lines[i].trim() && (/^\s+/.exec(lines[i]) || [""])[0].length > indent) sub.push(lines[i++])
        const minIndent = Math.min(...sub.map((l) => (/^\s*/.exec(l) || [""])[0].length))
        const subMd = sub.length ? renderMarkdown(sub.map((l) => l.slice(minIndent)).join("\n"), o) : ""
        const cb = /^\[( |x|X)\]\s+(.*)$/.exec(m[3])
        items.push(cb ? `<li class="task"><input type="checkbox" disabled${cb[1] !== " " ? " checked" : ""}> ${inline(cb[2], o)}${subMd}</li>` : `<li>${inline(m[3], o)}${subMd}</li>`)
      }
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`)
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    const buf: string[] = []
    while (i < lines.length && lines[i].trim() && !(buf.length && isBlockStart(lines[i]))) buf.push(lines[i++].trim())
    out.push(`<p>${inline(buf.join(" "), o)}</p>`)
  }
  return out.join("\n")
}

export { esc as escapeHtml }
