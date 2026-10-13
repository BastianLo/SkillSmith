// "Wissen zum Code" (5c): files with anchored knowledge, per file the entries with the status
// of their anchors and the code diff; #/code?pfad=…&projekt=… opens one file, ?ref=… one anchor.
import { get } from "../api.js"
import { entryHref, fmtRel, h, icon, put, swap } from "../dom.js"
import { act, app } from "../ui.js"

const STATUS = { unchanged: ["unverändert", "ok"], changed: ["geändert", "warn"], moved: ["verschoben", "warn"], deleted: ["gelöscht", "danger"], unresolved: ["nicht auflösbar", ""] }
const chip = (st) => {
  const [label, cls] = STATUS[st] || ["ungeprüft", ""]
  return h("span", { class: `chip ${cls}`, text: label })
}

export default async function code(ctx) {
  ctx.title("Wissen zum Code")
  const page = h("div", { class: "page" })
  const filter = h("input", { class: "input", placeholder: "Datei filtern …", value: ctx.query.get("q") || "" })
  const listEl = h("div")
  const detail = h("div")
  put(
    page,
    h("div", { class: "page-head" }, h("div", { class: "grow" }, h("h1", { text: "Wissen zum Code" }), h("p", { class: "page-sub", text: "Dokumente, Erinnerungen und Skills, die mit [[code:…]] an Klassen, Methoden oder Zeilen gebunden sind. Ändert sich der Code, erscheint der Eintrag im Eingang unter „Code geändert“." })), app.readOnly ? null : h("button", { class: "btn", type: "button", onclick: async () => (await act("anchors.check", {})) && load() }, icon("refresh", 14), "Jetzt prüfen")),
    h("div", { class: "toolbar" }, filter),
    h("div", { class: "cols" }, h("div", { class: "stack" }, listEl), h("div", { class: "stack" }, detail)),
  )
  ctx.el.replaceChildren(page)
  let data = { files: [] }
  const ref = ctx.query.get("ref")
  const knoten = ctx.query.get("knoten")
  let current = ctx.query.get("pfad") ? { path: ctx.query.get("pfad"), project: ctx.query.get("projekt") || "" } : null
  const openFile = async (f) => {
    current = { path: f.path, project: f.project || "" }
    ctx.setQuery({ pfad: f.path, projekt: f.project || "", ref: "" })
    const d = await get("code/file", { path: f.path, project: f.project || "" })
    if (!ctx.alive()) return
    const { diffBox, lineDiff } = await import("../diff.js")
    swap(
      detail,
      h(
        "div",
        { class: "card" },
        h("h2", { class: "mono", text: d.path }),
        d.project ? h("div", { class: "faint", text: `Projekt ${d.project}` }) : null,
        d.entries.length
          ? d.entries.map((x) =>
              h(
                "div",
                { class: "anchor-row" },
                h("div", { class: "row-flex" }, h("a", { class: "grow", href: entryHref(x.id), text: x.title }), chip(x.status)),
                h("div", { class: "faint mono", text: x.ref }),
                x.status === "changed" || x.status === "moved" || x.status === "deleted" ? diffBox(`${d.path}${x.newPath ? ` → ${x.newPath}` : ""}`, lineDiff(x.before || "", x.after || ""), { empty: "Keine Änderung im verankerten Code." }) : null,
                !app.readOnly && x.status && x.status !== "unchanged" && x.status !== "unresolved"
                  ? h(
                      "div",
                      { class: "toolbar" },
                      x.status !== "deleted" ? h("button", { class: "btn sm", type: "button", text: "Passt noch", onclick: async () => (await act("anchor.accept", { target: x.id, ref: x.ref })) && load() }) : null,
                      h("button", { class: "btn sm", type: "button", text: "Vom Agenten beheben lassen", onclick: async () => (await act("anchor.fix", { target: x.id, ref: x.ref })) && load() }),
                    )
                  : null,
              ),
            )
          : h("p", { class: "muted", text: "Kein verankertes Wissen zu dieser Datei." }),
      ),
    )
  }
  const draw = () => {
    const q = filter.value.trim().toLowerCase()
    const files = data.files.filter((f) => !q || f.path.toLowerCase().includes(q) || f.entries.some((e) => e.title.toLowerCase().includes(q)))
    swap(
      listEl,
      !data.available
        ? h("div", { class: "card empty", text: "Code-Anker sind ausgeschaltet (Einstellungen → Qualität)." })
        : files.length
          ? h(
              "div",
              { class: "list" },
              files.map((f) => {
                const bad = f.entries.filter((e) => e.status && e.status !== "unchanged" && e.status !== "unresolved").length
                return h(
                  "a",
                  { class: `row ${current && current.path === f.path && (current.project || "") === (f.project || "") ? "active" : ""}`, href: "#", onclick: (e) => (e.preventDefault(), openFile(f).then(draw)) },
                  icon("code", 16),
                  h("div", { class: "main" }, h("div", { class: "title mono", text: f.path }), h("div", { class: "desc", text: `${f.project ? `${f.project} · ` : ""}${f.entries.length} Eintrag/Einträge` })),
                  bad ? h("span", { class: "chip warn", text: `${bad} geändert` }) : null,
                )
              }),
            )
          : h("div", { class: "card empty", text: "Noch kein Wissen ist mit [[code:…]] an Code gebunden." }),
    )
  }
  const load = async () => {
    data = await get("code")
    if (!ctx.alive()) return
    draw()
    if (knoten && !current) {
      const f = data.files.find((x) => `code:${x.project ? `${x.project}/` : ""}${x.path}` === knoten)
      if (f) await openFile(f)
    } else if (ref && !current) {
      const f = data.files.find((x) => x.entries.some((e) => e.ref === ref))
      if (f) await openFile(f)
    } else if (current) {
      const f = data.files.find((x) => x.path === current.path && (x.project || "") === (current.project || ""))
      if (f) await openFile(f)
    }
    if (data.checkedAt) put(listEl, listEl.firstChild, h("p", { class: "faint", text: `zuletzt geprüft ${fmtRel(data.checkedAt)}` }))
  }
  filter.addEventListener("input", draw)
  await load()
}
