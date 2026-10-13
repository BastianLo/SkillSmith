// Document import (5h): drop PDF, Word, PowerPoint, Markdown or text; pages on the left,
// findings live on the right (each with its quote and page); take over, edit, merge into an
// existing entry or discard; "Übernehmen" writes everything selected in one commit.
import { get, importFile, post } from "../api.js"
import { entryHref, fmtRel, h, icon, put, swap } from "../dom.js"
import { act, app, confirmDialog, toast } from "../ui.js"
import { targetPicker } from "../parts.js"

const TYPE_LABEL = { wissen: "Wissen", begriff: "Glossar-Kandidat", anforderung: "Vorgabe", entscheidung: "Entscheidung", ablauf: "Runbook/Skill", offen: "Aufgabe" }
const STATUS = { bereit: "bereit", laeuft: "läuft", angehalten: "angehalten", fertig: "fertig", fehler: "Fehler", uebernommen: "übernommen" }
const ACCEPT = ".pdf,.docx,.doc,.pptx,.md,.markdown,.txt"

/** PDF → text per page with the vendored pdf.js (worker from /vendor). */
async function pdfPages(file) {
  const pdfjs = await import("/vendor/pdf.min.mjs")
  pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs"
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise
  const pages = []
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const tc = await page.getTextContent()
    let text = ""
    for (const it of tc.items) text += `${it.str}${it.hasEOL ? "\n" : " "}`
    pages.push({ n, text: text.replace(/[ \t]+/g, " ").trim() })
  }
  return pages
}

async function upload(files, ai) {
  for (const f of files) {
    try {
      const body = /\.pdf$/i.test(f.name) ? new TextEncoder().encode(JSON.stringify({ pages: await pdfPages(f) })) : f
      const r = await importFile(f.name, body, ai || undefined)
      toast(r.message, { variant: "success" })
      if (files.length === 1 && r.open) location.hash = r.open
    } catch (err) {
      toast(`${f.name}: ${err.message || err}`, { variant: "error" })
    }
  }
}

function listPage(ctx) {
  const page = h("div", { class: "page" })
  const listEl = h("div")
  const ai = h("select", { class: "input", title: "KI-Recht der importierten Dokumente" }, h("option", { value: "", text: "KI-Recht: Standard (vorschlag)" }), ["frei", "vorschlag", "lesen", "privat"].map((x) => h("option", { value: x, text: `KI-Recht: ${x}` })))
  const input = h("input", { type: "file", multiple: true, accept: ACCEPT, style: { display: "none" }, onchange: () => upload([...input.files], ai.value).then(load) })
  const drop = h("div", { class: "dropzone", onclick: () => input.click() }, icon("import", 28), h("div", { text: "Dateien hierher ziehen oder klicken" }), h("div", { class: "faint", text: "PDF, Word (DOCX, DOC), PowerPoint (PPTX), Markdown, Text" }))
  drop.addEventListener("dragover", (e) => (e.preventDefault(), drop.classList.add("over")))
  drop.addEventListener("dragleave", () => drop.classList.remove("over"))
  drop.addEventListener("drop", (e) => {
    e.preventDefault()
    drop.classList.remove("over")
    upload([...e.dataTransfer.files], ai.value).then(load)
  })
  const load = async () => {
    const list = await get("imports")
    if (!ctx.alive()) return
    swap(listEl, list.length ? h("div", { class: "list" }, list.map((j) => h("a", { class: "row", href: `#/import/${j.id}` }, icon("doc", 16), h("div", { class: "main" }, h("div", { class: "title", text: j.file }), h("div", { class: "desc", text: `${j.pages} Seiten · ${j.findings} Funde · ${fmtRel(j.createdAt)}${j.error ? ` · ${j.error}` : ""}` })), h("span", { class: `chip ${j.status === "fehler" ? "danger" : j.status === "uebernommen" ? "ok" : ""}`, text: j.status === "laeuft" ? `läuft ${j.done}/${j.total}` : STATUS[j.status] })))) : h("p", { class: "muted", text: "Noch keine Importe." }))
  }
  put(page, h("h1", { text: "Dokument-Import" }), h("p", { class: "page-sub", text: "Der Text wird lokal gelesen, der Assistent arbeitet Abschnitt für Abschnitt. Jeder Fund trägt Datei, Seite und das wörtliche Zitat; was nicht in der Datei steht, kommt in keinen Fund." }), app.readOnly ? null : h("div", { class: "stack" }, h("div", { class: "toolbar" }, ai), drop, input), listEl)
  ctx.el.replaceChildren(page)
  ctx.on("import.progress", () => load())
  return load()
}

export default async function importView(ctx) {
  ctx.title("Import")
  const id = ctx.params.id
  if (!id) return listPage(ctx)
  const page = h("div", { class: "page wide" })
  ctx.el.replaceChildren(page)
  const edits = new Map()
  let current = null
  const preview = h("div", { class: "import-pages" })
  const right = h("div", { class: "stack" })
  const head = h("div")
  const mark = (f) => {
    for (const el of preview.querySelectorAll(".hl")) el.classList.remove("hl")
    const el = preview.querySelector(`[data-page="${f.page}"]`)
    if (!el) return
    el.classList.add("hl")
    el.scrollIntoView({ block: "center" })
    const pre = el.querySelector("pre")
    const t = pre.textContent
    const i = t.indexOf(f.quote.slice(0, 40))
    if (i >= 0) put(pre, t.slice(0, i), h("mark", { text: t.slice(i, i + f.quote.length) }), t.slice(i + f.quote.length))
  }
  const draw = (j) => {
    current = j
    const running = j.status === "laeuft"
    swap(
      head,
      h(
        "div",
        { class: "page-head" },
        h("div", { class: "grow" }, h("h1", { text: j.file }), h("p", { class: "page-sub", text: `${j.pages.length} ${j.pages[0]?.label ?? "Seite"}(n) · ${j.findings.length} Funde · ${STATUS[j.status]}${running ? ` (${j.sections.filter((s) => s.done).length}/${j.sections.length})` : ""}${j.error ? ` – ${j.error}` : ""} · KI-Recht ${j.ai}` }), j.changes?.previous ? h("div", { class: "notice" }, `Neue Fassung: ${j.changes.changed.length} Seite(n) geändert gegenüber dem letzten Import`, j.changes.entries.length ? [" · betroffen: ", ...j.changes.entries.slice(0, 6).map((e) => h("a", { class: "chip", href: entryHref(e), text: e }))] : null) : null),
        app.readOnly || j.status === "uebernommen"
          ? null
          : h(
              "div",
              { class: "toolbar" },
              running ? h("button", { class: "btn", type: "button", text: "Anhalten", onclick: () => act("import.stop", { id: j.id }) }) : h("button", { class: "btn", type: "button", text: j.findings.length ? "Fortsetzen" : "Extraktion starten", onclick: () => act("import.start", { id: j.id }) }),
              h("button", { class: "btn primary", type: "button", disabled: running, onclick: async () => {
                const r = await act("import.apply", { id: j.id, edits: [...edits.values()] }, { label: "Funde übernehmen" })
                if (r) load()
              } }, icon("check", 14), "Übernehmen"),
              h("button", { class: "btn ghost", type: "button", text: "Verwerfen", onclick: async () => (await confirmDialog("Import verwerfen?", { danger: true, ok: "Verwerfen" })) && (await act("import.delete", { id: j.id })) && (location.hash = "#/import") }),
            ),
      ),
    )
    put(preview, j.pages.map((p) => h("div", { class: "import-page", "data-page": p.n }, h("div", { class: "faint", text: `${p.label} ${p.n}` }), h("pre", { text: p.text }))))
    swap(
      right,
      j.applied ? h("div", { class: "notice ok" }, `Übernommen ${fmtRel(j.applied.at)}: `, ...j.applied.entries.filter((e) => !e.startsWith("candidate:")).map((e) => h("a", { class: "chip", href: entryHref(e), text: e }))) : null,
      j.findings.length
        ? j.findings.map((f) => {
            const e = edits.get(f.index) ?? { index: f.index }
            const sel = h("input", { type: "checkbox", checked: e.selected ?? f.selected, disabled: j.status === "uebernommen", onchange: (ev) => edits.set(f.index, { ...e, selected: ev.target.checked }) })
            const title = h("input", { class: "input wide", value: e.title ?? f.title, onchange: (ev) => edits.set(f.index, { ...(edits.get(f.index) ?? e), title: ev.target.value }) })
            const text = h("textarea", { class: "input", rows: 4, value: e.text ?? f.text, onchange: (ev) => edits.set(f.index, { ...(edits.get(f.index) ?? e), text: ev.target.value }) })
            const merge = h("div", { class: "faint" })
            const setTarget = (id, label) => {
              edits.set(f.index, { ...(edits.get(f.index) ?? e), target: id })
              swap(merge, `ergänzt Eintrag `, h("a", { href: entryHref(id), text: label }), " ", h("button", { class: "btn sm ghost", type: "button", text: "×", onclick: () => (edits.set(f.index, { ...(edits.get(f.index) ?? e), target: undefined }), swap(merge)) }))
            }
            if (e.target) setTarget(e.target, e.target)
            return h(
              "div",
              { class: `card finding ${f.verdict && f.verdict !== "gestuetzt" ? "weak" : ""}` },
              h("div", { class: "row-flex" }, sel, h("span", { class: "chip", text: TYPE_LABEL[f.type] }), h("a", { href: "#", class: "faint", text: `Seite ${f.page}`, onclick: (ev) => (ev.preventDefault(), mark(f)) }), f.verdict ? h("span", { class: `chip ${f.verdict === "gestuetzt" ? "ok" : "warn"}`, title: f.verdictReason || "", text: f.verdict === "gestuetzt" ? "gestützt" : f.verdict === "widersprochen" ? "widersprochen" : "nicht gestützt" }) : null),
              title,
              text,
              h("blockquote", { class: "faint", text: `„${f.quote}“` }),
              f.similar && !e.target ? h("div", { class: "notice" }, "ähnelt ", h("a", { href: entryHref(f.similar.id), text: f.similar.title }), " ", h("button", { class: "btn sm", type: "button", text: "ergänzt diesen Eintrag", onclick: () => setTarget(f.similar.id, f.similar.title) })) : null,
              merge,
              j.status === "uebernommen" || app.readOnly ? null : h("details", null, h("summary", { class: "faint", text: "mit anderem Eintrag zusammenführen …" }), targetPicker((x) => setTarget(x.id, x.title)).el),
            )
          })
        : h("p", { class: "muted", text: j.status === "laeuft" ? "Der Assistent liest …" : "Noch keine Funde." }),
    )
  }
  const load = async () => {
    const j = await get("imports/one", { id })
    if (!ctx.alive()) return
    if (!j.found) return put(page, h("div", { class: "card empty", text: "Import nicht gefunden." }))
    draw(j)
  }
  put(page, head, h("div", { class: "import-cols" }, preview, right))
  ctx.on("import.progress", (d) => d.id === id && load())
  await load()
  void post
  void current
}
