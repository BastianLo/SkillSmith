import { get } from "../api.js"
import { KIND_PLURAL, colorOf, h, put, swap } from "../dom.js"
import { entryRow } from "./lists.js"

const SEARCH_KINDS = ["knowledge", "office", "skill", "error", "script", "glossary", "memory", "task", "project", "arbeitsstand", "ergebnis"]

export default async function search(ctx) {
  const q = ctx.query
  const query = q.get("q") || ""
  const tag = q.get("tag") || ""
  const kinds = (q.get("kinds") || "").split(",").filter(Boolean)
  const author = q.get("autor") || ""
  ctx.title(query ? `Suche: ${query}` : tag ? `#${tag}` : "Suche")
  const input = h("input", { class: "input", style: { flex: 1 }, type: "search", value: query, placeholder: "Suchbegriffe, Frage, Fehlermeldung, T-12 …", "aria-label": "Suche" })
  const chips = SEARCH_KINDS.map((k) => {
    const cb = h("input", { type: "checkbox", value: k, checked: !kinds.length || kinds.includes(k) })
    const span = h("span", { class: "chip kind", text: KIND_PLURAL[k] })
    span.style.background = colorOf(k)
    return h("label", { class: "check" }, cb, span)
  })
  const authorSel = h("select", { class: "input" }, h("option", { value: "", text: "alle Autoren" }), h("option", { value: "ich", text: "von mir", selected: author === "ich" }), h("option", { value: "ki", text: "von der KI", selected: author === "ki" }))
  const go = (e) => {
    if (e) e.preventDefault()
    const sel = chips.map((c) => c.querySelector("input")).filter((c) => c.checked).map((c) => c.value)
    const p = new URLSearchParams()
    if (input.value.trim()) p.set("q", input.value.trim())
    if (sel.length && sel.length < SEARCH_KINDS.length) p.set("kinds", sel.join(","))
    if (authorSel.value) p.set("autor", authorSel.value)
    if (tag && !input.value.trim()) p.set("tag", tag)
    location.hash = `#/suche?${p}`
  }
  for (const c of chips) c.querySelector("input").addEventListener("change", go)
  authorSel.addEventListener("change", go)
  const results = h("div", { class: "list" })
  const page = h("div", { class: "page" })
  put(
    page,
    h("h1", { text: tag && !query ? `Tag #${tag}` : "Suche" }),
    h("form", { class: "toolbar", onsubmit: go }, input, authorSel, h("button", { class: "btn primary", type: "submit", text: "Suchen" })),
    h("div", { class: "chips", style: { gap: "8px" } }, chips),
    h("div", { style: { height: "12px" } }),
    results,
  )
  ctx.el.replaceChildren(page)
  input.focus()
  const t = /^t-?(\d+)$/i.exec(query.trim())
  if (t) {
    location.hash = `#/aufgabe/t-${t[1]}`
    return
  }
  if (tag && !query) {
    swap(results, h("div", { class: "loading" }, h("span", { class: "spinner" }), "Lade …"))
    const lists = await Promise.all(["knowledge", "office", "skill", "error", "script", "glossary", "memory", "task", "project"].filter((k) => !kinds.length || kinds.includes(k)).map((k) => get("list", { kind: k, tag, author, project: "all" }).catch(() => [])))
    if (!ctx.alive()) return
    const all = lists.flat()
    swap(results, all.length ? all.map((n) => entryRow(n)) : h("div", { class: "empty", text: `Keine Einträge mit #${tag}.` }))
    return
  }
  if (!query) {
    put(results, h("div", { class: "empty", text: "Suchbegriffe eingeben – gesucht wird nach Bedeutung und Stichworten in allen Einträgen, Aufgaben und Erinnerungen, auch in privaten Dokumenten (die sieht nur die Weboberfläche)." }))
    return
  }
  swap(results, h("div", { class: "loading" }, h("span", { class: "spinner" }), "Suche …"))
  let hits = await get("search", { q: query, kinds: kinds.join(",") })
  if (!ctx.alive()) return
  if (author) hits = hits.filter((n) => (author === "ich" ? n.own : n.own === false))
  swap(results, hits.length ? hits.map((n) => entryRow(n)) : h("div", { class: "empty", text: `Nichts gefunden zu „${query}“.` }))
}
