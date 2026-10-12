import { get } from "../api.js"
import { KIND_LABEL, fmtRel, h, kindChip, put, swap } from "../dom.js"
import { act, app } from "../ui.js"

const NEW_ROUTE = { skill: "#/neu/skill", error: "#/neu/fehler", glossary: "#/neu/glossar", knowledge: "#/neu/dokument", memory: "#/neu/erinnerung" }

export default async function candidates(ctx) {
  ctx.title("Kandidaten")
  const page = h("div", { class: "page" })
  const listEl = h("div")
  put(page, h("h1", { text: "Kandidaten" }), h("p", { class: "page-sub", text: "Muster, die die Smiths in mehreren Sessions gesehen, aber noch nicht als Eintrag angelegt haben (z. B. ein Ablauf, der zweimal vorkam, oder eine unbekannte Abkürzung). Befördern öffnet die Vorlage der Art." }), listEl)
  ctx.el.replaceChildren(page)
  const load = async () => {
    const list = (await get("candidates")).sort((a, b) => b.count - a.count || b.updatedAt.localeCompare(a.updatedAt))
    if (!ctx.alive()) return
    swap(
      listEl,
      list.length
        ? h(
            "div",
            { class: "list" },
            list.map((c) =>
              h(
                "div",
                { class: "row" },
                kindChip({ kind: c.kind, label: KIND_LABEL[c.kind] }),
                h("div", { class: "main" }, h("div", { class: "title", text: c.keywords.slice(0, 6).join(", ") || c.id }), h("div", { class: "desc", text: c.summary }), h("div", { class: "faint", style: { fontSize: "12px" }, text: `${c.count}× in ${c.sessions.length} Session(s) · zuletzt ${fmtRel(c.updatedAt)}` }), h("div", { class: "chips" }, c.sessions.slice(0, 5).map((s) => h("a", { class: "chip", href: `#/session/${encodeURIComponent(s)}`, text: s.slice(0, 12) })))),
                app.readOnly
                  ? null
                  : h(
                      "div",
                      { class: "acts", style: { display: "flex", gap: "6px" } },
                      NEW_ROUTE[c.kind] ? h("a", { class: "btn sm primary", href: `${NEW_ROUTE[c.kind]}?titel=${encodeURIComponent(c.keywords[0] || "")}`, text: "Befördern" }) : null,
                      h("button", { class: "btn sm", type: "button", text: "Verwerfen", onclick: async () => (await act("candidate.dismiss", { kind: c.kind, id: c.id })) && load() }),
                    ),
              ),
            ),
          )
        : h("div", { class: "card empty", text: "Keine offenen Kandidaten." }),
    )
  }
  await load()
}
