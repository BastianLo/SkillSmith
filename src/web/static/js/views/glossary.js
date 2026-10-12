import { get, saveBlob } from "../api.js"
import { entryHref, h, icon, put, swap } from "../dom.js"
import { act, app, modal } from "../ui.js"

const meaningsText = (ms) => ms.map((m) => `${m.expansion}${m.context ? ` [${m.context}]` : ""}${m.description ? ` – ${m.description}` : ""}`).join(" | ")
const parseMeanings = (s) =>
  s
    .split("|")
    .map((part) => {
      const m = /^\s*(.*?)(?:\s*\[([^\]]*)\])?(?:\s*[–-]\s+(.*))?\s*$/.exec(part)
      return m ? { expansion: m[1].trim(), context: (m[2] || "").trim() || undefined, description: (m[3] || "").trim() || undefined } : null
    })
    .filter((m) => m && m.expansion)

export default async function glossary(ctx) {
  ctx.title("Glossar")
  const page = h("div", { class: "page" })
  const filter = h("input", { class: "input", type: "search", placeholder: "Begriff filtern …", value: ctx.query.get("q") || "", style: { width: "240px" } })
  const tbody = h("tbody")
  const table = h("table", { class: "table gl-table" }, h("thead", null, h("tr", null, h("th", { text: "Begriff", style: { width: "140px" } }), h("th", { text: "Bedeutungen – „Ausschreibung [Kontext] – Erklärung | …“" }), h("th", { text: "Auch geschrieben", style: { width: "200px" } }), h("th", { style: { width: "90px" } }))), tbody)
  let rows = []
  put(
    page,
    h(
      "div",
      { class: "page-head" },
      h("div", { class: "grow" }, h("h1", { text: "Glossar" }), h("div", { class: "muted", text: "Abkürzungen mit ihren Bedeutungen je Kontext. Zellen direkt bearbeiten – Speichern beim Verlassen des Felds (ein Commit je Zeile)." })),
      h(
        "div",
        { class: "toolbar" },
        filter,
        app.readOnly ? null : h("a", { class: "btn primary", href: "#/neu/glossar" }, icon("plus", 14), "Begriff"),
        app.readOnly ? null : h("button", { class: "btn", type: "button", onclick: importDialog }, icon("upload", 14), "Import"),
        h("button", { class: "btn", type: "button", onclick: exportCsv }, icon("export", 14), "CSV"),
      ),
    ),
    h("div", { class: "table-wrap" }, table),
  )
  ctx.el.replaceChildren(page)
  const draw = () => {
    const q = filter.value.trim().toLowerCase()
    const items = rows.filter((r) => !q || `${r.term} ${r.aliases.join(" ")} ${meaningsText(r.meanings)}`.toLowerCase().includes(q))
    swap(
      tbody,
      items.length
        ? items.map((r) => {
            const term = h("input", { value: r.term, disabled: app.readOnly, "aria-label": "Begriff" })
            const means = h("input", { value: meaningsText(r.meanings), disabled: app.readOnly, "aria-label": "Bedeutungen" })
            const aliases = h("input", { value: r.aliases.join(", "), disabled: app.readOnly, "aria-label": "Aliase" })
            const save = async () => {
              const next = { term: term.value.trim(), meanings: parseMeanings(means.value), aliases: aliases.value.split(",").map((a) => a.trim()).filter(Boolean) }
              if (next.term === r.term && meaningsText(next.meanings) === meaningsText(r.meanings) && next.aliases.join(",") === r.aliases.join(",")) return
              if (!next.term || !next.meanings.length) return
              const res = await act("glossary.row", { target: r.id, term: next.term, meanings: { list: next.meanings }, aliases: next.aliases }, { quiet: true })
              if (res) Object.assign(r, next)
            }
            for (const i of [term, means, aliases]) {
              i.addEventListener("change", save)
              i.addEventListener("keydown", (e) => e.key === "Enter" && i.blur())
            }
            return h("tr", { style: r.tier !== "active" ? { opacity: 0.55 } : undefined }, h("td", null, term), h("td", null, means), h("td", null, aliases), h("td", null, h("a", { class: "btn sm ghost", href: entryHref(r.id), text: "öffnen" })))
          })
        : h("tr", null, h("td", { colspan: "4", class: "faint", text: "Keine Begriffe." })),
    )
  }
  filter.addEventListener("input", () => {
    ctx.setQuery({ q: filter.value.trim() })
    draw()
  })
  async function load() {
    rows = (await get("glossary")).sort((a, b) => a.term.localeCompare(b.term, "de"))
    if (ctx.alive()) draw()
  }
  async function importDialog() {
    const res = await modal((close) => {
      const ta = h("textarea", { class: "input mono", rows: 12, placeholder: "CSV (Begriff;Bedeutung;Kontext;Erklärung) oder eine Markdown-Tabelle einfügen – oder eine Datei hierher ziehen" })
      const fmt = h("select", { class: "input" }, h("option", { value: "csv", text: "CSV" }), h("option", { value: "md", text: "Markdown-Tabelle" }))
      ta.addEventListener("dragover", (e) => e.preventDefault())
      ta.addEventListener("drop", async (e) => {
        e.preventDefault()
        const f = e.dataTransfer.files[0]
        if (!f) return
        ta.value = await f.text()
        if (/\.md$/i.test(f.name)) fmt.value = "md"
      })
      return { title: "Glossar importieren", wide: true, body: [h("div", { class: "field" }, h("label", { text: "Format" }), fmt), ta, h("p", { class: "faint", text: "Gleiche Regeln wie beim Upsert: bekannte Bedeutungen werden aktualisiert, neue angehängt." })], foot: [h("button", { class: "btn", type: "button", text: "Abbrechen", onclick: () => close(undefined) }), h("button", { class: "btn primary", type: "button", text: "Importieren", onclick: () => ta.value.trim() && close({ text: ta.value, format: fmt.value }) })] }
    })
    if (res && (await act("glossary.import", res))) load()
  }
  function exportCsv() {
    const lines = [["Begriff", "Bedeutung", "Kontext", "Erklärung", "Aliase"]]
    for (const r of rows) for (const m of r.meanings) lines.push([r.term, m.expansion, m.context || "", m.description || "", r.aliases.join(", ")])
    const text = lines.map((l) => l.map((c) => (/[;"\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(";")).join("\n")
    saveBlob(new Blob([`﻿${text}`], { type: "text/csv" }), "glossar.csv")
  }
  await load()
}
