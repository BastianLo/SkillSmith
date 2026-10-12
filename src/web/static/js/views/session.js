import { get } from "../api.js"
import { KIND_LABEL, entryHref, fmtCost, fmtDate, fmtNum, h, icon, kindChip, put } from "../dom.js"
import { auditTable } from "../parts.js"
import { act, app, card } from "../ui.js"

const REL = { new: "neu", changed: "geändert", used: "genutzt" }
const USE = { "entry.load": "geladen", "entry.hint_shown": "Hinweis gezeigt", "entry.hint_followed": "Hinweis befolgt", "entry.hint_helped": "Fehler-Hinweis half", "entry.hint_failed": "Fehler-Hinweis half nicht", "entry.view": "geöffnet" }

export default async function session(ctx) {
  const id = ctx.params.id
  const d = await get("session", { id })
  if (!ctx.alive()) return
  const r = d.record
  ctx.title(r?.title || `Session ${id}`)
  const page = h("div", { class: "page" })
  put(
    page,
    h(
      "div",
      { class: "page-head" },
      h("div", { class: "grow" }, h("div", { class: "entry-head" }, h("span", { class: "chip", text: "Session" }), h("span", { class: "mono faint", text: id })), h("h1", { text: r?.title || r?.requests?.[0] || id }), r ? h("div", { class: "muted", text: `${fmtDate(r.startedAt)} – ${fmtDate(r.at)} · ${r.project}` }) : h("div", { class: "muted", text: "Kein Eintrag im Session-Verlauf (noch nicht bewertet oder history aus)." })),
      app.readOnly
        ? null
        : h(
            "div",
            { class: "toolbar" },
            h("button", { class: "btn", type: "button", title: "Session jetzt von den Smiths bewerten lassen", onclick: () => act("session.review", { session: id }) }, icon("refresh", 14), "Jetzt bewerten"),
            h("a", { class: "btn", href: `#/neu/dokument?session=${encodeURIComponent(id)}` }, icon("doc", 14), "Daraus dokumentieren"),
          ),
    ),
    h("div", { class: "stat-grid" }, h("div", { class: "card kpi" }, h("div", { class: "label", text: "Tokens" }), h("div", { class: "num", text: fmtNum(d.tokens) })), h("div", { class: "card kpi" }, h("div", { class: "label", text: "Kosten" }), h("div", { class: "num", text: fmtCost(d.cost) })), h("div", { class: "card kpi" }, h("div", { class: "label", text: "Tool-Aufrufe" }), h("div", { class: "num", text: fmtNum(d.tools) })), h("div", { class: "card kpi" }, h("div", { class: "label", text: "Änderungen" }), h("div", { class: "num", text: fmtNum(d.changes.length) }))),
  )
  if (r) {
    put(
      page,
      h(
        "div",
        { class: "grid two", style: { marginTop: "14px" } },
        card("Anfragen", h("ol", { class: "meta-lines" }, r.requests.map((x) => h("li", { text: x })))),
        card("Gelernt und genutzt", r.links.length ? h("div", { class: "list" }, r.links.map((l) => h("a", { class: "row", href: entryHref(`${l.kind}:${l.name}`), "data-id": `${l.kind}:${l.name}` }, kindChip({ kind: l.kind, label: KIND_LABEL[l.kind] }), h("div", { class: "main" }, h("div", { class: "title", text: l.name })), h("span", { class: `chip ${l.rel === "new" ? "ok" : l.rel === "changed" ? "accent" : ""}`, text: REL[l.rel] })))) : h("div", { class: "faint", text: "–" })),
        r.problems.length ? card("Fehler und Lösungen", r.problems.map((p) => h("div", { class: "evidence" }, h("div", { class: "mono", text: p.error }), h("div", { class: p.resolved ? "st-ok" : "st-bad", text: p.resolved ? `gelöst${p.fix ? `: ${p.fix}` : ""}` : "ungelöst" })))) : null,
        r.outcome ? card("Ergebnis", h("div", { style: { whiteSpace: "pre-wrap" }, text: r.outcome })) : null,
      ),
    )
  }
  put(page, h("h2", { text: "Änderungen aus dieser Session" }), auditTable(d.changes.map((c) => ({ ...c, actor: c.smith ? "reviewer" : "system" }))))
  if (d.usage.length) put(page, h("h2", { text: "Nutzung von Einträgen" }), h("div", { class: "list" }, d.usage.slice(0, 100).map((u) => h("a", { class: "row", href: entryHref(u.entry) }, kindChip({ id: u.entry }), h("div", { class: "main mono", text: u.entry }), h("div", { class: "meta" }, h("span", { text: USE[u.type] || u.type }), h("span", { text: fmtDate(u.at) }))))))
  ctx.el.replaceChildren(page)
}
