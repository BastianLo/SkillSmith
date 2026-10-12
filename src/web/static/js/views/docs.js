import { get } from "../api.js"
import { AI_ACCESS, debounce, h, icon, put, select, swap } from "../dom.js"
import { act, app, promptDialog } from "../ui.js"
import { bulkBar, entryRow } from "./lists.js"

export default async function docs(ctx) {
  ctx.title("Dokumente")
  const q = ctx.query
  let folder = q.has("ordner") ? q.get("ordner") : null
  let author = q.get("autor") || ""
  let ai = q.get("ki") || ""
  let tier = q.get("tier") || "active"
  const page = h("div", { class: "page" })
  const tree = h("div", { class: "card tree-folders" })
  const listEl = h("div", { class: "list" })
  const head = h("div", { class: "page-head" })
  const selected = new Set()
  const bulk = bulkBar(selected, (clear) => {
    if (clear) selected.clear()
    load()
  })
  put(page, head, h("div", { class: "cols left" }, tree, h("div", null, bulk.el, listEl)))
  ctx.el.replaceChildren(page)

  let folders = { folders: [], defaults: {}, global: "vorschlag" }
  async function loadTree() {
    folders = await get("folders")
    if (!ctx.alive()) return
    const visible = folders.folders.filter((f) => !f.startsWith("_anhaenge"))
    const link = (path, label, depth) => {
      const def = path ? folders.defaults[path] : null
      return h(
        "a",
        { href: "#", class: folder === path ? "on" : "", style: { paddingLeft: `${8 + depth * 14}px` }, onclick: (e) => {
          e.preventDefault()
          folder = path
          ctx.setQuery({ ordner: path === null ? undefined : path })
          loadTree()
          load()
        } },
        icon(path === null ? "doc" : "folder", 14),
        h("span", { class: "ellipsis", text: label }),
        def ? h("span", { class: "ai chip", title: `Standard-KI-Recht für neue Dokumente: ${def}`, text: AI_ACCESS[def]?.label ?? def }) : null,
      )
    }
    swap(
      tree,
      h("h3", { style: { marginTop: 0 }, text: "Ordner" }),
      link(null, "Alle Dokumente", 0),
      link("", "Hauptordner", 0),
      visible.map((f) => link(f, f.split("/").pop(), f.split("/").length)),
      app.readOnly
        ? null
        : h(
            "div",
            { class: "toolbar" },
            h("button", { class: "btn sm", type: "button", onclick: async () => {
              const name = await promptDialog("Neuer Ordner", { label: "Pfad (z. B. betrieb/runbooks)", value: folder ? `${folder}/` : "" })
              if (name && (await act("folder.create", { path: name }))) loadTree()
            } }, icon("plus", 12), "Ordner"),
            folder
              ? [
                  h("button", { class: "btn sm", type: "button", text: "Umbenennen", onclick: async () => {
                    const to = await promptDialog("Ordner umbenennen", { label: "Neuer Pfad – Links im Store werden angepasst", value: folder })
                    if (to && to !== folder && (await act("folder.rename", { from: folder, to }, { label: "Ordner umbenennen" }))) {
                      folder = to
                      ctx.setQuery({ ordner: to })
                      loadTree()
                      load()
                    }
                  } }),
                  select([["", "KI-Recht …"], ["standard", "Standard"], ...Object.keys(AI_ACCESS).map((k) => [k, AI_ACCESS[k].label])], "", async (v) => v && (await act("folder.setAi", { folder, ai: v })) && loadTree(), { class: "input sm", title: "Standard-KI-Recht für neue Dokumente in diesem Ordner" }),
                ]
              : null,
          ),
      h("p", { class: "faint", style: { fontSize: "12px", margin: "10px 0 0" }, text: `Standard für neue Dokumente: ${AI_ACCESS[folders.global]?.label ?? folders.global}. Eigene Vorlagen liegen im Ordner _vorlagen.` }),
    )
  }

  const filterBar = () =>
    h(
      "div",
      { class: "toolbar", style: { margin: 0 } },
      select([["active", "aktiv"], ["archive", "archiviert"], ["", "alle Stufen"]], tier, (v) => ((tier = v), ctx.setQuery({ tier: v === "active" ? undefined : v || "alle" }), load())),
      select([["", "alle Autoren"], ["ich", "von mir"], ["ki", "von der KI"]], author, (v) => ((author = v), ctx.setQuery({ autor: v }), load())),
      select([["", "jedes KI-Recht"], ...Object.entries(AI_ACCESS).map(([k, v]) => [k, `KI: ${v.label}`])], ai, (v) => ((ai = v), ctx.setQuery({ ki: v }), load())),
      app.readOnly ? null : h("a", { class: "btn primary", href: `#/neu/dokument${folder ? `?ordner=${encodeURIComponent(folder)}` : ""}` }, icon("plus", 14), "Dokument"),
      h("a", { class: "btn", href: "#/tagesnotiz" }, icon("journal", 14), "Tagesnotiz"),
    )

  async function load() {
    const items = await get("list", { kind: "knowledge", tier: tier === "alle" ? "" : tier, author, ai, folder: folder === null ? undefined : folder })
    if (!ctx.alive()) return
    swap(head, h("div", { class: "grow" }, h("h1", { text: folder === null ? "Dokumente" : folder === "" ? "Hauptordner" : folder }), h("div", { class: "muted", text: `${items.length} Dokument${items.length === 1 ? "" : "e"} · Ihre Dokumente und das Wissen der KI liegen in derselben Ablage` })), filterBar())
    bulk.draw()
    swap(listEl, items.length ? items.filter((n) => !String(n.folder || "").startsWith("_anhaenge")).map((n) => entryRow(n, { selectable: !app.readOnly, selected: selected.has(n.id), onSelect: (id, on) => (on ? selected.add(id) : selected.delete(id), bulk.draw()) })) : h("div", { class: "empty", text: "Keine Dokumente." }))
  }
  if (q.get("tier") === "alle") tier = "alle"
  await Promise.all([loadTree(), load()])
  ctx.on("run.finished", debounce(() => ctx.alive() && load(), 1500))
}
