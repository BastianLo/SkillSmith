import { get } from "../api.js"
import { debounce, entryHref, fmtDate, h, kindChip, kindOf, put, statusChip, swap } from "../dom.js"
import { act, app, modal } from "../ui.js"

async function correctDialog(c) {
  const res = await modal((close) => {
    const target = h("select", { class: "input" }, h("option", { value: c.a.id, text: `A: ${c.a.title}` }), h("option", { value: c.b.id, text: `B: ${c.b.title}` }))
    const oldT = h("textarea", { class: "input mono", rows: 3, placeholder: "Stelle im veralteten Eintrag (wörtlich)" })
    const newT = h("textarea", { class: "input mono", rows: 3, placeholder: "Ersatz" })
    return {
      title: "Korrektur übernehmen",
      wide: true,
      body: [h("p", { class: "muted", text: "Ersetzt eine Stelle im veralteten Eintrag – ein Commit mit Diff." }), h("div", { class: "field" }, h("label", { text: "Eintrag" }), target), h("div", { class: "field" }, h("label", { text: "Alter Text" }), oldT), h("div", { class: "field" }, h("label", { text: "Neuer Text" }), newT)],
      foot: [h("button", { class: "btn", type: "button", text: "Abbrechen", onclick: () => close(undefined) }), h("button", { class: "btn primary", type: "button", text: "Ersetzen", onclick: () => oldT.value.trim() && close({ target: target.value, oldText: oldT.value, newText: newT.value }) })],
    }
  })
  if (res) return act("conflict.correct", { id: c.id, ...res })
  return null
}

async function mergeDialog(c) {
  const [a, b] = await Promise.all([get("entry", { id: c.a.id }), get("entry", { id: c.b.id })])
  const res = await modal((close) => {
    const desc = h("input", { class: "input wide", value: a.description || "" })
    const ta = h("textarea", { class: "input mono", rows: 18, value: `${a.body}\n\n<!-- aus ${b.node.id} -->\n${b.body}` })
    return {
      title: "Zusammenführen",
      wide: true,
      body: [h("p", { class: "muted", text: `„${a.title}“ bleibt, „${b.title}“ wird archiviert und als zusammengeführt markiert.` }), h("div", { class: "field" }, h("label", { text: "Beschreibung" }), desc), h("div", { class: "field" }, h("label", { text: "Text" }), ta)],
      foot: [h("button", { class: "btn", type: "button", text: "Abbrechen", onclick: () => close(undefined) }), h("button", { class: "btn primary", type: "button", text: "Vorschau", onclick: () => close({ description: desc.value, body: ta.value }) })],
    }
  })
  if (!res) return null
  const r = await act("entry.merge", { target: c.a.id, sources: [c.a.id, c.b.id], ...res }, { label: "Zusammenführen" })
  if (r) await act("conflict.resolve", { id: c.id, choice: "a" }, { quiet: true })
  return r
}

export default async function conflicts(ctx) {
  ctx.title("Konflikte")
  const focusId = ctx.query.get("id")
  const page = h("div", { class: "page" })
  const body = h("div")
  put(page, h("h1", { text: "Konflikte" }), h("p", { class: "page-sub", text: "Der Doktor vergleicht neue und geänderte Einträge mit ähnlichen und hält Bezüge oder Widersprüche fest. Was er nicht sicher entscheiden kann oder was Ihre Entscheidungen und Vorgaben betrifft, legt er Ihnen vor." }), body)
  ctx.el.replaceChildren(page)
  const side = (label, o) => h("div", { class: "card flat tight", style: { flex: 1, minWidth: "240px" } }, h("div", { class: "rel-top" }, h("strong", { text: label }), kindChip(o), statusChip(o.status)), o.exists ? h("a", { href: entryHref(o.id), class: "rel-title", "data-id": o.id, text: o.title }) : h("div", { class: "rel-title", text: `${o.id} (entfernt)` }), o.summary ? h("div", { class: "rel-desc", text: o.summary }) : null)
  const load = async () => {
    const list = await get("conflicts")
    if (!ctx.alive()) return
    const open = list.filter((c) => c.status !== "resolved")
    const done = list.filter((c) => c.status === "resolved")
    const run = (action, args) => async () => (await act(action, args)) && load()
    const cardOf = (c) =>
      h(
        "div",
        { class: `card ${c.status === "needs_user" ? "warn" : ""}`, id: `c-${c.id}`, style: c.id === focusId ? { outline: "2px solid var(--accent)" } : undefined },
        h("div", { class: "entry-head" }, statusChip(c.status), h("span", { class: "mono", text: c.id }), h("span", { class: "faint", text: fmtDate(c.detectedAt) }), c.similarity ? h("span", { class: "faint", text: `Ähnlichkeit ${Number(c.similarity).toFixed(2)}` }) : null, c.attempts ? h("span", { class: "faint", text: `${c.attempts} Prüfungen` }) : null),
        h("div", { class: "rel-title", style: { margin: "4px 0 8px" }, text: c.note || c.suspicion }),
        h("div", { class: "row-flex", style: { alignItems: "stretch" } }, side("A", c.a), side("B", c.b)),
        c.status === "resolved"
          ? h("div", { class: "faint", style: { marginTop: "8px" }, text: `Gelöst ${fmtDate(c.resolvedAt)}${c.resolution ? `: ${c.resolution}` : ""}` })
          : app.readOnly
            ? null
            : h(
                "div",
                { class: "toolbar" },
                h("button", { class: "btn", type: "button", text: "A gilt", title: "B ist veraltet (wird abgelöst bzw. archiviert)", onclick: run("conflict.resolve", { id: c.id, choice: "a" }) }),
                h("button", { class: "btn", type: "button", text: "B gilt", title: "A ist veraltet", onclick: run("conflict.resolve", { id: c.id, choice: "b" }) }),
                h("button", { class: "btn", type: "button", text: "Beide gelten", onclick: run("conflict.resolve", { id: c.id, choice: "both" }) }),
                h("button", { class: "btn", type: "button", text: "Kein Bezug", onclick: run("conflict.resolve", { id: c.id, choice: "unrelated" }) }),
                h("span", { class: "sep" }),
                c.a.exists && c.b.exists && kindOf(c.a.id) === kindOf(c.b.id) && !["glossary", "script", "task", "project"].includes(kindOf(c.a.id)) ? h("button", { class: "btn", type: "button", text: "Zusammenführen …", onclick: async () => (await mergeDialog(c)) && load() }) : null,
                h("button", { class: "btn", type: "button", text: "Korrektur …", onclick: async () => (await correctDialog(c)) && load() }),
                h("button", { class: "btn ghost", type: "button", text: "Erneut prüfen", onclick: run("conflict.recheck", { id: c.id }) }),
                h("button", { class: "btn ghost", type: "button", text: "Zurückstellen", onclick: run("conflict.defer", { id: c.id }) }),
              ),
      )
    swap(
      body,
      open.length ? h("div", { class: "stack" }, open.map(cardOf)) : h("div", { class: "card empty-state" }, h("h2", { text: "Keine offenen Konflikte" }), h("p", { class: "muted", text: "Der Doktor hat alles entschieden oder es gibt noch nichts zu vergleichen." })),
      done.length ? [h("h2", { text: `Gelöst (${done.length})` }), h("div", { class: "stack" }, done.slice(0, 60).map(cardOf))] : null,
      app.readOnly ? null : h("div", { class: "toolbar", style: { marginTop: "18px" } }, h("button", { class: "btn", type: "button", text: "Doktor jetzt laufen lassen", onclick: () => act("doctor.run", {}) })),
    )
    if (focusId) document.getElementById(`c-${focusId}`)?.scrollIntoView({ block: "center" })
  }
  await load()
  ctx.on("run.finished", debounce(() => ctx.alive() && load(), 1500))
}
