import { get } from "../api.js"
import { debounce, entryHref, fmtDate, fmtRel, h, kindChip, put, swap } from "../dom.js"
import { act, app, confirmDialog } from "../ui.js"
import { proposalDialog } from "./entry.js"

const GROUP_ORDER = ["Agenten", "Konflikte", "Vorschläge für Ihre Dokumente", "Pipeline rot", "Aufgaben-Vorschläge", "Unbestätigte Entscheidungen", "Regeln aus Korrekturen", "Zur Freigabe vorgemerkt", "Änderungen der KI", "Fällige Prüfungen", "Zuerst verbessern", "Fehleranfällig", "Rote Skript-Tests", "Defekte Links", "Offene Abkürzungen", "Projekt-Doku prüfen", "Aufräumen"]

export default async function inbox(ctx) {
  ctx.title("Eingang")
  const page = h("div", { class: "page" })
  const body = h("div")
  const filter = { group: ctx.query.get("gruppe") || "" }
  ctx.el.replaceChildren(page)
  let data
  const load = async () => {
    data = await get("inbox", { since: ctx.query.get("seit") || undefined })
    if (!ctx.alive()) return
    draw()
  }
  const draw = () => {
    const groups = new Map()
    for (const it of data.items) (groups.get(it.group) ?? groups.set(it.group, []).get(it.group)).push(it)
    const ordered = [...groups.keys()].sort((a, b) => (GROUP_ORDER.indexOf(a) + 100) % 100 - (GROUP_ORDER.indexOf(b) + 100) % 100)
    swap(
      page,
      h(
        "div",
        { class: "page-head" },
        h("div", { class: "grow" }, h("h1", { text: `Zu prüfen (${data.items.length})` }), h("div", { class: "muted", text: `Was die Agenten seit ${data.since ? fmtDate(data.since) : "Ihrem letzten Besuch"} geändert haben und was eine Entscheidung braucht – mit der Aktion direkt daneben.` })),
        h(
          "div",
          { class: "toolbar" },
          h("button", { class: "btn", type: "button", text: "Als gesehen markieren", title: "Änderungen der KI ab jetzt neu zählen", onclick: async () => (await get("inbox", { mark: "1" }), ctx.setQuery({ seit: undefined }), load()) }),
          h("a", { class: "btn ghost", href: `#/eingang?seit=${encodeURIComponent(new Date(Date.now() - 7 * 86400000).toISOString())}`, text: "Letzte 7 Tage" }),
        ),
      ),
      h(
        "div",
        { class: "chips", style: { marginBottom: "12px" } },
        h("button", { class: `chip ${!filter.group ? "accent" : "outline"}`, type: "button", text: "alle", onclick: () => ((filter.group = ""), ctx.setQuery({ gruppe: undefined }), draw()) }),
        ordered.map((g) => h("button", { class: `chip ${filter.group === g ? "accent" : "outline"}`, type: "button", text: `${g} · ${groups.get(g).length}`, onclick: () => ((filter.group = g), ctx.setQuery({ gruppe: g }), draw()) })),
      ),
      body,
    )
    swap(
      body,
      data.items.length
        ? ordered
            .filter((g) => !filter.group || g === filter.group)
            .map((g) => h("div", { class: "inbox-group" }, h("h2", null, g, h("span", { class: "badge muted", text: String(groups.get(g).length) })), h("div", { class: "list" }, groups.get(g).slice(0, 100).map(itemRow))))
        : h("div", { class: "card empty-state" }, h("h2", { text: "Alles erledigt" }), h("p", { class: "muted", text: "Nichts zu prüfen – die Agenten haben seit Ihrem letzten Besuch nichts geändert und es wartet keine Entscheidung." })),
    )
  }
  const itemRow = (it) => {
    const open = it.data?.job ? `#/agenten/${encodeURIComponent(it.data.job)}` : it.type === "conflict" ? `#/konflikte?id=${encodeURIComponent(it.data.conflict)}` : it.target ? entryHref(it.target) : null
    const buttons = []
    if (it.type === "proposal" || it.type === "staged") buttons.push(h("button", { class: "btn sm", type: "button", text: "Diff ansehen", onclick: () => proposalDialog({ id: it.data.staged, smith: it.title.split(":")[0], reason: it.detail, target: it.target.split(":")[0], name: it.target.slice(it.target.indexOf(":") + 1), sessionID: it.data.session, args: {} }, load) }))
    if (it.type === "change" && it.data?.commit) buttons.push(h("a", { class: "btn sm", href: `#/commit/${it.data.commit}`, text: "Diff" }))
    if (it.type === "abbreviation") buttons.push(h("a", { class: "btn sm", href: `#/neu/glossar?titel=${encodeURIComponent(it.data.term)}`, text: "Bedeutung eintragen" }))
    if (!app.readOnly)
      for (const a of it.actions) {
        buttons.push(
          h("button", {
            class: `btn sm ${a.label === "Übernehmen" || a.label === "Bestätigen" || a.label === "Einplanen" ? "primary" : ""}`,
            type: "button",
            text: a.label,
            onclick: async () => {
              if (a.confirm && !(await confirmDialog(`${a.label}: ${it.title}?`))) return
              const r = await act(a.action, a.args || {}, { target: a.target, quiet: a.action === "feedback", skipConfirm: !!a.confirm && a.action !== "run.undo" })
              if (r) {
                if (a.action === "feedback") {
                  data.items = data.items.filter((x) => x.id !== it.id)
                  draw()
                } else load()
              }
            },
          }),
        )
      }
    return h(
      "div",
      { class: "inbox-item" },
      h("span", { class: `sev ${it.severity}` }),
      it.target ? kindChip({ id: it.target }) : null,
      h("div", { class: "grow" }, open ? h("a", { href: open, "data-id": it.target && !it.data?.job ? it.target : undefined, style: { fontWeight: 600 }, text: it.title }) : h("div", { style: { fontWeight: 600 }, text: it.title }), it.detail ? h("div", { class: "muted", style: { fontSize: "13px" }, text: it.detail }) : null, it.at ? h("div", { class: "faint", style: { fontSize: "12px" }, text: fmtRel(it.at) }) : null),
      h("div", { class: "acts" }, buttons),
    )
  }
  await load()
  const later = debounce(() => ctx.alive() && load(), 1500)
  for (const t of ["run.finished", "inbox.changed", "agent.job", "task.changed"]) ctx.on(t, later)
}

export { put }
