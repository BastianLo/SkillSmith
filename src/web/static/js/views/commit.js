import { get } from "../api.js"
import { ACTOR_LABEL, entryHref, fmtDate, h, icon, kindChip, put } from "../dom.js"
import { act, app, card, fill } from "../ui.js"

export default async function commit(ctx) {
  const hash = ctx.params.hash
  const c = await get("commit", { hash })
  if (!ctx.alive()) return
  ctx.title(`Commit ${c.short}`)
  const { renderEntryDiff } = await import("../diff.js")
  const page = h("div", { class: "page" })
  put(
    page,
    h(
      "div",
      { class: "page-head" },
      h("div", { class: "grow" }, h("div", { class: "entry-head" }, h("span", { class: "chip mono", text: c.short }), c.manual ? h("span", { class: "chip warn", text: "von Hand" }) : c.actor ? h("span", { class: "chip", text: `${c.smith || ""} · ${ACTOR_LABEL[c.actor] || c.actor}` }) : null, h("span", { class: "faint", text: fmtDate(c.date) })), h("h1", { text: c.subject }), c.body ? h("pre", { class: "muted", style: { whiteSpace: "pre-wrap", fontFamily: "var(--sans)", margin: "6px 0 0" }, text: c.body }) : null),
      h(
        "div",
        { class: "toolbar" },
        c.runId ? h("a", { class: "btn", href: `#/audit?run=${encodeURIComponent(c.runId)}` }, icon("audit", 14), "Audit") : null,
        c.runId && !app.readOnly ? h("button", { class: "btn", type: "button", onclick: async () => (await act("run.undo", { run: c.runId }, { label: "Lauf rückgängig machen" })) && ctx.reload() }, icon("undo", 14), "Lauf rückgängig") : null,
      ),
    ),
  )
  for (const e of c.entries) {
    const box = h("div")
    put(page, h("div", { class: "card", style: { marginBottom: "12px" } }, h("div", { class: "card-head" }, kindChip(e), h("a", { class: "grow", href: entryHref(e.id), style: { fontWeight: 600 }, text: e.id }), h("span", { class: "chip", text: e.status }), h("span", { class: "faint", text: `+${e.additions} −${e.deletions}` })), box))
    fill(box, async () => renderEntryDiff(await get("diff", { id: e.id, to: c.hash, from: "parent" })))
  }
  if (c.other?.length) put(page, card("Weitere Dateien", h("ul", { class: "meta-lines" }, c.other.map((p) => h("li", { class: "mono", text: p })))))
  ctx.el.replaceChildren(page)
}
