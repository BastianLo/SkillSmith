// Escaping Markdown renderer of the web view. Text is escaped first; only a fixed set of
// tags is produced. Supports [[links]] (resolved through a callback), task ids (T-12),
// ticket ids, #tags, checklists with source lines, attachments (anhang:…), Mermaid and
// highlighted code (both loaded lazily from vendor/).
import { attachmentUrl, download } from "./api.js"
import { hoverPreview } from "./ui.js"

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])

const WIKI_RE = /\[\[([^\[\]\n|#]+)(?:#([^\[\]\n|]+))?(?:\|([^\[\]\n]+))?\]\]/g
const TICKET_DENY = new Set(["UTF", "ISO", "SHA", "RFC", "HTTP", "TLS", "SSL", "AES", "RSA", "CP", "WIN", "X"])

export function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
}

/** Link targets in a text (for one batch call of links/resolve). */
export function linkTargets(src) {
  const text = String(src || "").replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "")
  const out = new Set()
  for (const m of text.matchAll(WIKI_RE)) out.add(m[1].trim())
  return [...out]
}

/** Headings of a text (outline). */
export function outline(src) {
  const out = []
  let fence = false
  const seen = new Map()
  String(src || "")
    .split("\n")
    .forEach((line, i) => {
      if (/^\s*```/.test(line)) fence = !fence
      if (fence) return
      const m = /^(#{1,6})\s+(.*)$/.exec(line)
      if (!m) return
      let id = slug(m[2])
      const n = seen.get(id) || 0
      seen.set(id, n + 1)
      if (n) id = `${id}-${n}`
      out.push({ level: m[1].length, text: m[2].replace(/[*`]/g, ""), line: i, id })
    })
  return out
}

function makeInline(o) {
  const taskRe = new RegExp(`(^|[^\\w\\[:/-])(${o.taskPrefix || "T"}-\\d{1,6})(?![\\w-])`, "g")
  const ticketRe = o.ticketPattern ? new RegExp(`(^|[^\\w/-])(${o.ticketPattern})(?![\\w-])`, "g") : null
  return function inline(s) {
    const stash = []
    const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`
    let t = String(s)
      .split(/(`[^`]+`)/g)
      .map((p) => (p.length > 1 && p.startsWith("`") && p.endsWith("`") ? keep(`<code>${esc(p.slice(1, -1))}</code>`) : p))
      .join("")
    // attachments (before escaping: the path pattern is strict)
    t = t.replace(/!\[([^\]\n]*)\]\(anhang:([A-Za-z0-9._/-]+)\)/g, (_m, alt, path) => keep(`<img data-att="${esc(path)}" alt="${esc(alt)}" loading="lazy">`))
    t = t.replace(/\[([^\]\n]+)\]\(anhang:([A-Za-z0-9._/-]+)\)/g, (_m, label, path) => keep(`<a href="#" class="att" data-att-link="${esc(path)}">📎 ${esc(label)}</a>`))
    // [[links]]
    t = t.replace(WIKI_RE, (_m, target, section, label) => {
      const r = o.resolve ? o.resolve(target.trim()) : undefined
      const text = esc((label || target).trim())
      if (r && r.id) {
        const href = `${entryRoute(r.id)}${section ? `${entryRoute(r.id).includes("?") ? "&" : "?"}abschnitt=${encodeURIComponent(slug(section))}` : ""}`
        return keep(`<a class="wl" href="${esc(href)}" data-id="${esc(r.id)}" title="${esc(r.title || r.id)}">${text}</a>`)
      }
      if (r === undefined && !o.strict) return keep(`<a class="wl" href="#/suche?q=${encodeURIComponent(target.trim())}">${text}</a>`)
      return keep(`<span class="broken" title="Link-Ziel „${esc(target.trim())}“ nicht gefunden">${text}</span>`)
    })
    // markdown links
    t = t.replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|#\/)[^\s)]+)\)/g, (_m, label, url) => keep(`<a href="${esc(url)}"${url.startsWith("#") ? "" : ' target="_blank" rel="noopener noreferrer"'}>${esc(label)}</a>`))
    t = t.replace(/(^|[\s(])(https?:\/\/[^\s<>()]+[^\s<>().,;:!?])/g, (_m, pre, url) => `${pre}${keep(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`)}`)
    t = esc(t)
    t = t.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    t = t.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, "$1<em>$2</em>")
    t = t.replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    // ids, task ids, tickets, tags
    t = t.replace(/(^|[\s(„"])((?:skill|knowledge|glossary|error|script|memory|state|result|session|task|project):[A-Za-z0-9][A-Za-z0-9_.-]*[A-Za-z0-9])/g, (_m, pre, id) => `${pre}${keep(`<a class="wl" href="${esc(entryRoute(id))}" data-id="${esc(id)}">${esc(id)}</a>`)}`)
    t = t.replace(taskRe, (_m, pre, id) => `${pre}${keep(`<a class="wl" href="#/aufgabe/${id.toLowerCase()}" data-id="task:${id.toLowerCase()}">${id}</a>`)}`)
    if (ticketRe) {
      t = t.replace(ticketRe, (m, pre, id) => {
        const head = id.split("-")[0]
        if (TICKET_DENY.has(head) || /\u0000/.test(id)) return m
        return `${pre}${keep(`<a href="#/ticket/${encodeURIComponent(id)}" title="Ticket ${id}">${id}</a>`)}`
      })
    }
    t = t.replace(/(^|[\s(,;])#([\p{L}\p{N}][\p{L}\p{N}_-]{1,39})(?![\p{L}\p{N}_-])/gu, (_m, pre, tag) => `${pre}${keep(`<a class="tag" href="#/suche?tag=${encodeURIComponent(tag.toLowerCase())}">#${tag}</a>`)}`)
    return t.replace(/\u0000(\d+)\u0000/g, (_m, i) => stash[Number(i)])
  }
}

export function entryRoute(id) {
  if (id.startsWith("task:")) return `#/aufgabe/${encodeURIComponent(id.slice(5))}`
  if (id.startsWith("project:")) return `#/projekt/${encodeURIComponent(id.slice(8))}`
  if (id.startsWith("session:")) return `#/session/${encodeURIComponent(id.slice(8))}`
  return `#/eintrag/${encodeURIComponent(id)}`
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const isBlockStart = (l) => /^\s*```/.test(l) || /^#{1,6}\s/.test(l) || LIST_RE.test(l) || /^\s*>/.test(l) || /^\s*\|.*\|\s*$/.test(l) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(l)

/**
 * Render markdown to safe HTML.
 * opts: resolve(target) → {id,title}|null|undefined, taskPrefix, ticketPattern, checkboxes (interactive), strict
 */
export function render(src, opts = {}) {
  const inline = makeInline(opts)
  const ids = new Map()
  const headingId = (text) => {
    let id = slug(text)
    const n = ids.get(id) || 0
    ids.set(id, n + 1)
    return n ? `${id}-${n}` : id
  }
  const block = (lines, base) => {
    const out = []
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      if (/^\s*```/.test(line)) {
        const lang = line.trim().slice(3).trim().toLowerCase()
        const buf = []
        i++
        while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++])
        i++
        if (lang === "mermaid") out.push(`<div class="mermaid-block"><pre class="mermaid-src">${esc(buf.join("\n"))}</pre></div>`)
        else out.push(`<pre${lang ? ` data-lang="${esc(lang)}"` : ""}><code>${esc(buf.join("\n"))}</code></pre>`)
        continue
      }
      if (/^\s*<!--.*-->\s*$/.test(line)) {
        i++
        continue
      }
      const hm = /^(#{1,6})\s+(.*)$/.exec(line)
      if (hm) {
        const lvl = hm[1].length
        out.push(`<h${lvl} id="${esc(headingId(hm[2]))}" data-line="${base + i}">${inline(hm[2])}</h${lvl}>`)
        i++
        continue
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        out.push("<hr>")
        i++
        continue
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim())
        const head = cells(line)
        i += 2
        const rows = []
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]))
        out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`)
        continue
      }
      if (/^\s*>/.test(line)) {
        const start = i
        const buf = []
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""))
        out.push(`<blockquote>${block(buf, base + start)}</blockquote>`)
        continue
      }
      const lm = LIST_RE.exec(line)
      if (lm) {
        const indent = lm[1].length
        const ordered = /\d/.test(lm[2])
        const items = []
        while (i < lines.length) {
          const m = LIST_RE.exec(lines[i])
          if (!m || m[1].length !== indent) break
          const at = base + i
          const sub = []
          i++
          const subStart = i
          while (i < lines.length && lines[i].trim() && (/^\s*/.exec(lines[i]) || [""])[0].length > indent) sub.push(lines[i++])
          const minIndent = sub.length ? Math.min(...sub.map((l) => (/^\s*/.exec(l) || [""])[0].length)) : 0
          const subHtml = sub.length ? block(sub.map((l) => l.slice(minIndent)), base + subStart) : ""
          const cb = /^\[( |x|X)\]\s+(.*)$/.exec(m[3])
          if (cb) {
            const done = cb[1] !== " "
            items.push(`<li class="task${done ? " done" : ""}" data-line="${at}"><input type="checkbox"${done ? " checked" : ""}${opts.checkboxes ? "" : " disabled"} aria-label="erledigt"><span class="text">${inline(cb[2])}${opts.subtasks && !done ? `<button type="button" class="btn sm ghost to-sub" data-line="${at}" title="In eine Unteraufgabe umwandeln">→ Unteraufgabe</button>` : ""}</span>${subHtml}</li>`)
          } else items.push(`<li>${inline(m[3])}${subHtml}</li>`)
        }
        out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`)
        continue
      }
      if (!line.trim()) {
        i++
        continue
      }
      const buf = []
      while (i < lines.length && lines[i].trim() && !(buf.length && isBlockStart(lines[i]))) {
        const l = lines[i++]
        buf.push(/( {2}|\\)$/.test(l) ? `${l.replace(/( {2}|\\)$/, "")}\u0001` : l.trim())
      }
      out.push(`<p>${buf.map((l) => inline(l.replace(/\u0001$/, ""))+(l.endsWith("\u0001") ? "<br>" : "")).join(" ")}</p>`)
    }
    return out.join("\n")
  }
  return block(String(src || "").replace(/\r/g, "").split("\n"), 0)
}

// ---------------------------------------------------------------------------
// enhancement after insertion: attachments, mermaid, highlighting, checkboxes
// ---------------------------------------------------------------------------
let hljsP = null
let mermaidP = null
let mermaidSeq = 0

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script")
    s.src = src
    s.onload = () => resolve()
    s.onerror = () => reject(new Error(`${src} nicht geladen`))
    document.head.append(s)
  })
}

function darkTheme() {
  const t = document.documentElement.dataset.theme
  return t === "dark" || (!t && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches)
}

export function enhance(el, opts = {}) {
  for (const img of el.querySelectorAll("img[data-att]")) {
    attachmentUrl(img.dataset.att)
      .then((u) => (img.src = u))
      .catch(() => img.replaceWith(Object.assign(document.createElement("span"), { className: "broken", textContent: `Anhang fehlt: ${img.dataset.att}` })))
  }
  for (const a of el.querySelectorAll("a[data-att-link]")) {
    a.addEventListener("click", (e) => {
      e.preventDefault()
      download(`/api/attachment?path=${encodeURIComponent(a.dataset.attLink)}`, a.dataset.attLink.split("/").pop()).catch(() => {})
    })
  }
  const codes = el.querySelectorAll("pre[data-lang] > code")
  if (codes.length) {
    hljsP ??= import("../vendor/highlight.js").then((m) => m.default)
    hljsP
      .then((hljs) => {
        for (const c of codes) {
          const lang = c.parentElement.dataset.lang
          if (!hljs.getLanguage(lang)) continue
          try {
            c.innerHTML = hljs.highlight(c.textContent, { language: lang, ignoreIllegals: true }).value
            c.classList.add("hljs")
          } catch (_) {
            // leave plain
          }
        }
      })
      .catch(() => {})
  }
  const blocks = el.querySelectorAll(".mermaid-block")
  if (blocks.length) {
    mermaidP ??= loadScript("vendor/mermaid.min.js").then(() => {
      window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: darkTheme() ? "dark" : "default", fontFamily: "inherit" })
      return window.mermaid
    })
    mermaidP
      .then(async (mermaid) => {
        for (const b of blocks) {
          const src = b.querySelector(".mermaid-src")?.textContent ?? ""
          try {
            const { svg } = await mermaid.render(`mmd-${++mermaidSeq}`, src)
            b.innerHTML = svg
          } catch (err) {
            b.classList.add("error")
            b.textContent = `Mermaid: ${String(err && err.message ? err.message : err).slice(0, 400)}`
          }
        }
      })
      .catch(() => {})
  }
  if (opts.onToggle) {
    for (const cb of el.querySelectorAll("li.task > input[type=checkbox]")) {
      cb.disabled = false
      cb.addEventListener("change", () => opts.onToggle(Number(cb.parentElement.dataset.line), cb.checked, cb))
    }
  }
  if (opts.onToSubtask) {
    for (const b of el.querySelectorAll("button.to-sub")) b.addEventListener("click", () => opts.onToSubtask(Number(b.dataset.line)))
  }
  if (opts.section) {
    const target = el.querySelector(`#${CSS.escape(opts.section)}`)
    if (target) setTimeout(() => target.scrollIntoView({ block: "start" }), 50)
  }
  hoverPreview(el)
  return el
}
