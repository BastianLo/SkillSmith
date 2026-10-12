import { download, get } from "../api.js"
import { h, icon, put, swap } from "../dom.js"
import { act, app, card, toastError } from "../ui.js"

export default async function exportView(ctx) {
  ctx.title("Export")
  const page = h("div", { class: "page narrow" })
  const fmt = h("select", { class: "input" }, h("option", { value: "html", text: "HTML (ein Ordner mit Übersicht plus „alles.html“ als eine Datei)" }), h("option", { value: "md", text: "Markdown (ein Ordner mit .md-Dateien)" }))
  const kinds = ["knowledge", "glossary", "skill", "error"].map((k) => h("label", { class: "check", style: { marginRight: "12px" } }, h("input", { type: "checkbox", value: k, checked: k === "knowledge" || k === "glossary" }), { knowledge: "Wissen", glossary: "Glossar", skill: "Skills", error: "Fehler" }[k]))
  const priv = h("input", { type: "checkbox" })
  const result = h("div")
  const prevEl = h("div")
  const dl = (path) => () => download(`/api/download?file=${encodeURIComponent(path)}`, path.split("/").pop()).catch(toastError)
  put(
    page,
    h("h1", { text: "Statischer Export" }),
    h("p", { class: "page-sub", text: "Wissen und Glossar als HTML- oder Markdown-Paket, z. B. fürs Team-Wiki. Der Export liegt lokal unter state/exports; private Dokumente nur auf ausdrücklichen Wunsch." }),
    h(
      "div",
      { class: "card" },
      h("div", { class: "field" }, h("label", { text: "Format" }), fmt),
      h("div", { class: "field" }, h("label", { text: "Inhalt" }), h("div", null, kinds)),
      h("label", { class: "check" }, priv, "private Dokumente einschließen"),
      h(
        "div",
        { class: "toolbar" },
        h("button", {
          class: "btn primary",
          type: "button",
          disabled: app.readOnly,
          onclick: async () => {
            const r = await act("export.static", { format: fmt.value, kinds: kinds.map((l) => l.querySelector("input")).filter((i) => i.checked).map((i) => i.value), includePrivate: priv.checked || undefined })
            if (!r?.data) return
            const dir = r.data.dir.split(/[\\/]/).pop()
            swap(
              result,
              card(
                `${r.data.count} Seiten exportiert`,
                h("div", { class: "mono faint", text: r.data.dir }),
                h("div", { class: "toolbar" }, r.data.single ? h("button", { class: "btn primary", type: "button", onclick: dl(`${dir}/alles.html`) }, icon("export", 14), "alles.html laden") : null, h("button", { class: "btn", type: "button", onclick: dl(`${dir}/${fmt.value === "html" ? "index.html" : "index.md"}`) }, "Übersicht laden")),
                h("details", null, h("summary", { class: "faint", text: `Einzelne Dateien (${r.data.files.length})` }), h("div", { class: "stack", style: { gap: "2px" } }, r.data.files.map((f) => h("a", { href: "#", class: "mono", text: f, onclick: (e) => (e.preventDefault(), dl(`${dir}/${f}`)()) })))),
              ),
            )
            loadPrev()
          },
        }, icon("export", 14), "Exportieren"),
      ),
    ),
    result,
    h("h2", { text: "Frühere Exporte" }),
    prevEl,
  )
  ctx.el.replaceChildren(page)
  async function loadPrev() {
    const list = await get("exports")
    swap(prevEl, list.length ? h("div", { class: "list" }, list.map((d) => h("div", { class: "row" }, icon("folder", 15), h("div", { class: "main mono", text: d }), d.endsWith("-html") ? h("button", { class: "btn sm", type: "button", text: "alles.html", onclick: dl(`${d}/alles.html`) }) : h("button", { class: "btn sm", type: "button", text: "index.md", onclick: dl(`${d}/index.md`) })))) : h("div", { class: "faint", text: "Noch keine Exporte." }))
  }
  await loadPrev()
}
