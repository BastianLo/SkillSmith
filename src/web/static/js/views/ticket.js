import { get } from "../api.js"
import { colLabel, entryHref, fmtDate, fmtRel, h, icon, put } from "../dom.js"
import { card } from "../ui.js"

export default async function ticket(ctx) {
  const id = ctx.params.id
  ctx.title(`Ticket ${id}`)
  const d = await get("ticket", { id })
  if (!ctx.alive()) return
  const page = h("div", { class: "page" })
  const list = (items, row, empty = "–") => (items.length ? h("div", { class: "list" }, items.map(row)) : h("div", { class: "faint", text: empty }))
  put(
    page,
    h(
      "div",
      { class: "page-head" },
      h("div", { class: "grow" }, h("div", { class: "entry-head" }, h("span", { class: "chip", text: "Ticket" })), h("h1", { text: id }), h("div", { class: "muted", text: "Alles, was zu diesem Ticket gehört: Arbeitsstände der Branches, Aufgaben, Erinnerungen, Sessions und Dokumente." })),
      d.url ? h("a", { class: "btn", href: d.url, target: "_blank", rel: "noopener noreferrer" }, icon("ticket", 14), "Im Ticketsystem öffnen") : null,
    ),
    h(
      "div",
      { class: "grid two" },
      card("Arbeitsstände", list(d.states, (s) => h("a", { class: "row", href: entryHref(s.id) }, icon("state", 15), h("div", { class: "main" }, h("div", { class: "title", text: s.branch }), h("div", { class: "desc", text: s.summary || "" }), h("div", { class: "faint", style: { fontSize: "12px" }, text: `${s.open.length} offen · ${s.next.length} als Nächstes · ${s.done.length} erledigt` })), h("div", { class: "meta", text: fmtRel(s.updatedAt) })), "Kein Arbeitsstand zu diesem Ticket.")),
      card("Aufgaben", list(d.tasks, (t) => h("a", { class: "row", href: entryHref(t.id) }, h("span", { class: "mono", text: t.short }), h("div", { class: "main" }, h("div", { class: "title", text: t.title })), h("div", { class: "meta" }, h("span", { class: "chip", text: colLabel(t.status) }), t.project ? h("span", { text: t.project }) : null)), "Keine Aufgabe.")),
      card("Erinnerungen", list(d.memories, (m) => h("a", { class: "row", href: entryHref(m.id) }, h("span", { class: "chip", text: m.type }), h("div", { class: "main" }, h("div", { class: "title", text: m.title })), m.status === "vorgeschlagen" ? h("span", { class: "chip warn", text: "unbestätigt" }) : null))),
      card("Sessions", list(d.sessions, (s) => h("a", { class: "row", href: `#/session/${encodeURIComponent(s.id)}` }, icon("chat", 15), h("div", { class: "main" }, h("div", { class: "title", text: s.title || s.id })), h("div", { class: "meta", text: fmtDate(s.at) })))),
      card("Dokumente", list(d.docs, (x) => h("a", { class: "row", href: entryHref(x.id), "data-id": x.id }, icon("doc", 15), h("div", { class: "main" }, h("div", { class: "title", text: x.title }))))),
    ),
  )
  ctx.el.replaceChildren(page)
}
