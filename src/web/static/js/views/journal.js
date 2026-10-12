import { get } from "../api.js"
import { copyText, editHref, h, icon, put, today } from "../dom.js"
import { mdBlock } from "../parts.js"
import { act, app, toast } from "../ui.js"

function standupOf(body) {
  const m = /## Standup-Entwurf\s*\n([\s\S]*?)(?=\n## |$)/.exec(body || "")
  return (m?.[1] ?? "").replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, "$1").replace(/\[\[(?:task:)?([^\]]+)\]\]/g, "$1").trim()
}

export default async function journal(ctx) {
  const date = ctx.query.get("datum") || today()
  ctx.title(`Tagesnotiz ${date}`)
  const id = `knowledge:journal-${date}`
  // resolve first: a missing note is normal (no 404 in the console)
  const exists = (await get("links/resolve", { targets: id }).catch(() => ({})))[id]
  const entry = exists ? await get("entry", { id }).catch(() => null) : null
  if (!ctx.alive()) return
  const page = h("div", { class: "page" })
  const dateIn = h("input", { class: "input", type: "date", value: date, max: today(), onchange: (e) => (location.hash = `#/tagesnotiz?datum=${e.target.value}`) })
  const shift = (d) => {
    const t = new Date(`${date}T12:00:00`)
    t.setDate(t.getDate() + d)
    return t.toISOString().slice(0, 10)
  }
  put(
    page,
    h(
      "div",
      { class: "page-head" },
      h("div", { class: "grow" }, h("h1", { text: `Tagesnotiz ${new Date(`${date}T12:00:00`).toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}` }), h("div", { class: "muted", text: "Vorbefüllt mit den Sessions des Tages, Fortschritt der Arbeitsstände, gelösten Fehlern, neuen Entscheidungen und Commits – dazu ein Standup-Entwurf zum Kopieren." })),
      h("div", { class: "toolbar" }, h("a", { class: "btn", href: `#/tagesnotiz?datum=${shift(-1)}`, text: "←" }), dateIn, date < today() ? h("a", { class: "btn", href: `#/tagesnotiz?datum=${shift(1)}`, text: "→" }) : null),
    ),
  )
  if (!entry) {
    put(
      page,
      h(
        "div",
        { class: "card empty-state" },
        h("h2", { text: "Noch keine Tagesnotiz" }),
        h("p", { class: "muted", text: "skillsmith legt sie im Ordner „journal“ an und füllt sie mit dem, was an diesem Tag passiert ist. Danach gehört sie Ihnen (KI-Recht „Vorschlag“)." }),
        app.readOnly
          ? null
          : h("button", { class: "btn primary", type: "button", onclick: async () => {
              const r = await act("journal.open", { date })
              if (r) ctx.reload()
            } }, icon("journal", 14), "Anlegen und vorbefüllen"),
      ),
    )
    ctx.el.replaceChildren(page)
    return
  }
  const standup = standupOf(entry.body)
  put(
    page,
    h(
      "div",
      { class: "cols" },
      h("div", { class: "card" }, h("div", { class: "card-head" }, h("h3", { class: "grow", text: entry.title }), app.readOnly ? null : h("a", { class: "btn sm primary", href: editHref(id) }, icon("edit", 13), "Bearbeiten")), mdBlock(entry.body, { checkboxes: !app.readOnly, onToggle: async (line, done) => (await act("checklist.toggle", { target: id, line, done }, { quiet: true })) && ctx.reload() })),
      h(
        "div",
        { class: "stack" },
        h(
          "div",
          { class: "card" },
          h("div", { class: "card-head" }, h("h3", { class: "grow", text: "Standup" }), h("button", { class: "btn sm", type: "button", onclick: () => (copyText(standup), toast("Standup kopiert.", { variant: "success" })) }, icon("copy", 12), "Kopieren")),
          standup ? h("pre", { style: { whiteSpace: "pre-wrap", fontFamily: "var(--sans)", margin: 0 }, text: standup }) : h("div", { class: "faint", text: "Kein Abschnitt „## Standup-Entwurf“ in der Notiz." }),
        ),
        h("div", { class: "card" }, h("h3", { text: "Schnell" }), h("div", { class: "stack" }, h("a", { href: "#/board", text: "Board" }), h("a", { href: "#/eingang", text: "Eingang" }), h("a", { href: `#/audit?from=${date}T00:00:00&to=${date}T23:59:59`, text: "Was heute geändert wurde" }))),
      ),
    ),
  )
  ctx.el.replaceChildren(page)
}
