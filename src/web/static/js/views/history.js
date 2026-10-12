import { get } from "../api.js"
import { ACTOR_LABEL, fmtDate, h, put, swap } from "../dom.js"

export default async function history(ctx) {
  ctx.title("Versionen")
  const q = ctx.query
  const f = { smith: q.get("smith") || "", actor: q.get("actor") || "", since: q.get("since") || "", until: q.get("until") || "", manual: q.get("manual") === "1" }
  let skip = 0
  let items = []
  const page = h("div", { class: "page" })
  const listEl = h("div")
  const set = (k, v) => {
    f[k] = v
    ctx.setQuery({ [k]: v === true ? "1" : v || undefined })
    skip = 0
    load()
  }
  put(
    page,
    h("h1", { text: "Store-Historie" }),
    h("p", { class: "page-sub", text: "Alle Commits des Wissensspeichers. Jeder Lauf ist höchstens ein Commit; Handbearbeitungen sind hervorgehoben." }),
    h(
      "div",
      { class: "toolbar" },
      h("select", { class: "input sm", onchange: (e) => set("smith", e.target.value) }, h("option", { value: "", text: "alle Smiths" }), ["skillsmith", "docsmith", "errorsmith", "toolsmith", "memorysmith", "doctor", "manual"].map((x) => h("option", { value: x, text: x, selected: f.smith === x }))),
      h("select", { class: "input sm", onchange: (e) => set("actor", e.target.value) }, h("option", { value: "", text: "alle Akteure" }), ["web", "command", "reviewer", "curator", "doctor"].map((x) => h("option", { value: x, text: ACTOR_LABEL[x] || x, selected: f.actor === x }))),
      h("input", { class: "input sm", type: "date", value: f.since, onchange: (e) => set("since", e.target.value) }),
      h("span", { class: "faint", text: "bis" }),
      h("input", { class: "input sm", type: "date", value: f.until, onchange: (e) => set("until", e.target.value) }),
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: f.manual, onchange: (e) => set("manual", e.target.checked) }), "nur Handbearbeitungen"),
    ),
    listEl,
  )
  ctx.el.replaceChildren(page)
  async function load(more = false) {
    const r = await get("history", { ...f, manual: f.manual ? "1" : undefined, limit: 100, skip })
    if (!ctx.alive()) return
    items = more ? [...items, ...r] : r
    swap(
      listEl,
      items.length
        ? h(
            "div",
            { class: "list" },
            items.map((c) =>
              h(
                "a",
                { class: "row", href: `#/commit/${c.hash}` },
                h("span", { class: "mono faint", text: c.short }),
                h("div", { class: "main" }, h("div", { class: "title", text: c.subject }), h("div", { class: "desc", text: `${fmtDate(c.date)}${c.runId ? ` · Lauf ${c.runId}` : ""}` })),
                h("div", { class: "meta" }, c.manual ? h("span", { class: "chip warn", text: "von Hand" }) : c.actor ? h("span", { class: "chip", text: `${c.smith || ""}(${c.actor})` }) : null, h("span", { text: `${c.files} Datei${c.files === 1 ? "" : "en"}` })),
              ),
            ),
          )
        : h("div", { class: "card empty", text: "Keine Commits (Git aus oder Filter zu eng)." }),
      r.length === 100 ? h("div", { class: "toolbar" }, h("button", { class: "btn", type: "button", text: "Ältere laden", onclick: () => ((skip += 100), load(true)) })) : null,
    )
  }
  await load()
}
