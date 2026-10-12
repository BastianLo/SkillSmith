import { get } from "../api.js"
import { h, put, swap } from "../dom.js"
import { act, app, promptDialog } from "../ui.js"

export default async function tags(ctx) {
  ctx.title("Tags")
  const page = h("div", { class: "page" })
  const cloud = h("div", { class: "card cloud" })
  const tableEl = h("div")
  put(page, h("h1", { text: "Tags" }), h("p", { class: "page-sub", text: "Alle Tags im Wissen. Umbenennen oder Zusammenführen (gleichen Namen eingeben) ändert alle Einträge in einem Commit – mit Vorschau. Die Agenten nutzen dasselbe Vokabular." }), cloud, h("h2", { text: "Verwalten" }), tableEl)
  ctx.el.replaceChildren(page)
  const load = async () => {
    const list = await get("tags")
    if (!ctx.alive()) return
    const max = Math.max(1, ...list.map((t) => t.count))
    swap(cloud, list.length ? list.slice(0, 300).map((t) => h("a", { href: `#/suche?tag=${encodeURIComponent(t.tag)}`, style: { fontSize: `${12 + Math.round(Math.sqrt(t.count / max) * 14)}px` }, title: `${t.count} Einträge`, text: `#${t.tag}` })) : h("div", { class: "faint", text: "Noch keine Tags." }))
    swap(
      tableEl,
      h(
        "table",
        { class: "table" },
        h("thead", null, h("tr", null, h("th", { text: "Tag" }), h("th", { class: "num", text: "Einträge" }), h("th"))),
        h(
          "tbody",
          null,
          list.map((t) =>
            h(
              "tr",
              null,
              h("td", null, h("a", { href: `#/suche?tag=${encodeURIComponent(t.tag)}`, text: `#${t.tag}` })),
              h("td", { class: "num", text: t.count }),
              h(
                "td",
                { class: "right" },
                app.readOnly
                  ? null
                  : h("button", {
                      class: "btn sm",
                      type: "button",
                      text: "Umbenennen / zusammenführen",
                      onclick: async () => {
                        const to = await promptDialog(`#${t.tag} umbenennen`, { label: "Neuer Tag (ein vorhandener Tag führt zusammen)", value: t.tag })
                        if (to && to !== t.tag && (await act("tags.rename", { from: t.tag, to }, { label: `#${t.tag} → #${to}` }))) load()
                      },
                    }),
              ),
            ),
          ),
        ),
      ),
    )
  }
  await load()
}
