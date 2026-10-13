import { get } from "../api.js"
import { AI_ACCESS, KIND_PLURAL, MEMORY_PLURAL, aiChip, debounce, entryHref, fmtRel, h, icon, kindChip, put, select, statusChip, swap, tagChips } from "../dom.js"
import { act, app, promptDialog } from "../ui.js"

const NEW_ROUTE = { knowledge: "#/neu/dokument", skill: "#/neu/skill", error: "#/neu/fehler", glossary: "#/neu/glossar", memory: "#/neu/erinnerung", task: "#/board?neu=1", project: "#/projekt-neu", script: "#/werkstatt?neu=1", agent: "#/neu/agent" }

/** One row of an entry list (also used by search and documents). */
export function entryRow(n, { selectable, selected, onSelect, extra } = {}) {
  const cb = selectable ? h("input", { type: "checkbox", class: "sel", checked: selected, "aria-label": "auswählen" }) : null
  if (cb) {
    cb.addEventListener("click", (e) => e.stopPropagation())
    cb.addEventListener("change", () => onSelect(n.id, cb.checked))
  }
  return h(
    "a",
    { class: "row", href: entryHref(n.id), "data-id": n.id },
    cb,
    kindChip(n),
    h(
      "div",
      { class: "main" },
      h("div", { class: "title", text: n.title || n.id }),
      n.snippet || n.summary ? h("div", { class: "desc", text: n.snippet || n.summary }) : null,
      n.tags?.length ? tagChips(n.tags, 6) : null,
      extra || null,
    ),
    h(
      "div",
      { class: "meta" },
      h("div", { class: "row-flex", style: { gap: "4px", justifyContent: "flex-end" } }, n.own ? h("span", { class: "chip accent", text: "von mir" }) : null, n.ai && n.ai !== "frei" ? aiChip(n.ai) : null, statusChip(n.status), n.pinned ? icon("pin", 12) : null),
      n.tier && n.tier !== "active" ? h("div", { text: n.tierLabel || n.tier }) : null,
      n.folder ? h("div", { class: "mono", text: n.folder }) : null,
      n.date ? h("div", { text: fmtRel(n.date) }) : null,
      n.score !== undefined ? h("div", { text: `Treffer ${Number(n.score).toFixed(2)}` }) : null,
    ),
  )
}

export function bulkBar(selected, onDone) {
  const bar = h("div", { class: "toolbar card tight", style: { position: "sticky", top: "60px", zIndex: 5 } })
  const draw = () => {
    swap(
      bar,
      h("strong", { text: `${selected.size} ausgewählt` }),
      h("button", { class: "btn sm", type: "button", text: "Archivieren", onclick: () => run("archive") }),
      h("button", { class: "btn sm", type: "button", text: "Wiederherstellen", onclick: () => run("restore") }),
      h("button", { class: "btn sm", type: "button", text: "Tag hinzufügen", onclick: async () => run("tag", await promptDialog("Tag hinzufügen", { label: "Tag" })) }),
      h("button", { class: "btn sm", type: "button", text: "Tag entfernen", onclick: async () => run("untag", await promptDialog("Tag entfernen", { label: "Tag" })) }),
      h("button", { class: "btn sm", type: "button", text: "KI-Recht …", onclick: async () => run("ai", await promptDialog("KI-Recht setzen", { label: "frei, vorschlag, lesen oder privat", value: "vorschlag" })) }),
      h("button", { class: "btn sm", type: "button", text: "Verknüpfen mit …", onclick: async () => run("relate", await promptDialog("Alle verknüpfen mit", { label: "Id des Ziels (art:name)", placeholder: "knowledge:…" })) }),
      h("button", { class: "btn sm ghost", type: "button", text: "Auswahl aufheben", onclick: () => onDone(true) }),
    )
    bar.classList.toggle("hidden", !selected.size)
  }
  async function run(op, value) {
    if ((op === "tag" || op === "untag" || op === "ai" || op === "relate") && !value) return
    const r = await act("entries.bulk", { ids: [...selected], op, value })
    if (r) onDone(true)
  }
  draw()
  return { el: bar, draw }
}

export default async function lists(ctx) {
  const kind = ctx.params.kind
  const q = ctx.query
  const type = q.get("type") || ""
  ctx.title(type ? MEMORY_PLURAL[type] : KIND_PLURAL[kind] || kind)
  const volatile = kind === "arbeitsstand" || kind === "ergebnis"
  const filters = {
    tier: q.get("tier") || "",
    type,
    project: q.get("project") || "",
    author: q.get("autor") || "",
    ai: q.get("ki") || "",
    tag: q.get("tag") || "",
    aiChangedSince: q.get("kiSeit") || "",
    proposals: q.get("vorschlaege") || "",
  }
  const page = h("div", { class: "page" })
  const listEl = h("div", { class: "list" }, h("div", { class: "loading" }, h("span", { class: "spinner" }), "Lade …"))
  const selected = new Set()
  const bulk = bulkBar(selected, (clear) => {
    if (clear) selected.clear()
    load()
  })
  const apply = (patch) => {
    const map = { tier: "tier", type: "type", project: "project", author: "autor", ai: "ki", tag: "tag", aiChangedSince: "kiSeit", proposals: "vorschlaege" }
    const next = {}
    for (const [k, v] of Object.entries(patch)) next[map[k]] = v
    ctx.setQuery(next)
    Object.assign(filters, patch)
    load()
  }
  const bar = h(
    "div",
    { class: "toolbar" },
    volatile
      ? null
      : select(
          [
            ["", "alle Stufen"],
            ["active", "aktiv"],
            ["dormant", "ruhend"],
            ["archive", "archiviert"],
          ],
          filters.tier,
          (v) => apply({ tier: v }),
        ),
    kind === "memory"
      ? select([["", "alle Typen"], ...Object.entries(MEMORY_PLURAL)], filters.type, (v) => apply({ type: v }))
      : null,
    kind === "memory" || volatile ? select([["", "dieses Projekt"], ["all", "alle Projekte"]], filters.project, (v) => apply({ project: v })) : null,
    volatile
      ? null
      : [
          select([["", "alle Autoren"], ["ich", "von mir"], ["ki", "von der KI"]], filters.author, (v) => apply({ author: v })),
          select([["", "jedes KI-Recht"], ...Object.entries(AI_ACCESS).map(([k, v]) => [k, `KI: ${v.label}`])], filters.ai, (v) => apply({ ai: v })),
          select([["", "jederzeit"], [new Date(Date.now() - 86400000).toISOString(), "von der KI geändert: 24 h"], [new Date(Date.now() - 7 * 86400000).toISOString(), "… seit 7 Tagen"], [new Date(Date.now() - 30 * 86400000).toISOString(), "… seit 30 Tagen"]], filters.aiChangedSince, (v) => apply({ aiChangedSince: v })),
          h("label", { class: "check" }, h("input", { type: "checkbox", checked: filters.proposals === "1", onchange: (e) => apply({ proposals: e.target.checked ? "1" : "" }) }), "Vorschläge offen"),
        ],
    filters.tag ? h("span", { class: "chip accent" }, `#${filters.tag}`, h("span", { class: "x", text: "×", onclick: () => apply({ tag: "" }) })) : null,
    h("span", { class: "grow" }),
    kind === "agent" && !app.readOnly ? h("button", { class: "btn", type: "button", title: "Die Agenten aus opencode.json und den Agent-Dateien als erste Version in den Store übernehmen (KI-Recht „Vorschlag“)", onclick: async () => (await act("agent.import", {})) && load() }, icon("import", 14), "Aus opencode übernehmen") : null,
    NEW_ROUTE[kind] && !app.readOnly ? h("a", { class: "btn primary", href: NEW_ROUTE[kind] }, icon("plus", 14), "Neu") : null,
  )
  const head = h("h1")
  put(page, head, bar, bulk.el, listEl)
  ctx.el.replaceChildren(page)

  async function load() {
    const items = await get("list", { kind, tier: filters.tier, type: filters.type, project: filters.project, author: filters.author, ai: filters.ai, tag: filters.tag, aiChangedSince: filters.aiChangedSince, proposals: filters.proposals })
    if (!ctx.alive()) return
    head.textContent = `${type ? MEMORY_PLURAL[type] : KIND_PLURAL[kind] || kind} (${items.length})`
    bulk.draw()
    swap(listEl, items.length ? items.map((n) => entryRow(n, { selectable: !volatile && !app.readOnly, selected: selected.has(n.id), onSelect: (id, on) => (on ? selected.add(id) : selected.delete(id), bulk.draw()) })) : h("div", { class: "empty", text: "Keine Einträge für diese Filter." }))
  }
  await load()
  ctx.on("run.finished", debounce(() => ctx.alive() && load(), 1500))
}
