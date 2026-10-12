import { get } from "../api.js"
import { entryHref, fmtDate, h, kindChip, put, swap } from "../dom.js"
import { act, app, card } from "../ui.js"
import { proposalDialog } from "./entry.js"

export default async function staged(ctx) {
  ctx.title("Freigaben")
  const page = h("div", { class: "page" })
  const stagedEl = h("div")
  const shadowEl = h("div")
  put(page, h("h1", { text: "Freigaben" }), h("p", { class: "page-sub", text: "Vorschläge der KI für Ihre Dokumente (KI-Recht „Vorschlag“), vorgemerkte Änderungen (Schreibmodus „stage“ oder riskante Skripte) und Shadow-Vorschläge. Übernehmen ist je ein Commit." }), stagedEl, h("h2", { text: "Shadow-Vorschläge" }), shadowEl)
  ctx.el.replaceChildren(page)
  const load = async () => {
    const [list, shadow] = await Promise.all([get("staged"), get("shadow")])
    if (!ctx.alive()) return
    swap(
      stagedEl,
      list.length
        ? h(
            "div",
            { class: "list" },
            list.map((s) =>
              h(
                "div",
                { class: "row" },
                kindChip({ kind: s.target }),
                h("div", { class: "main" }, h("a", { class: "title", href: entryHref(`${s.target}:${s.name}`), text: `${s.action} ${s.name}` }), h("div", { class: "desc", text: s.reason || "" }), h("div", { class: "faint", style: { fontSize: "12px" }, text: `${s.smith} · ${fmtDate(s.createdAt)}${s.aiProposal ? " · Vorschlag für Ihr Dokument" : " · vorgemerkt"}` })),
                h(
                  "div",
                  { style: { display: "flex", gap: "6px" } },
                  h("button", { class: "btn sm", type: "button", text: "Ansehen", onclick: () => proposalDialog(s, load) }),
                  app.readOnly ? null : h("button", { class: "btn sm primary", type: "button", text: "Übernehmen", onclick: async () => (await act(s.aiProposal ? "proposal.accept" : "staged.approve", { id: s.id })) && load() }),
                  app.readOnly ? null : h("button", { class: "btn sm", type: "button", text: "Ablehnen", onclick: async () => (await act(s.aiProposal ? "proposal.reject" : "staged.reject", { id: s.id })) && load() }),
                ),
              ),
            ),
          )
        : card(null, h("div", { class: "faint", text: "Nichts vorgemerkt." })),
    )
    swap(
      shadowEl,
      shadow.length
        ? h("div", { class: "list" }, shadow.map((x) => h("div", { class: "row" }, kindChip({ kind: x.target }), h("div", { class: "main" }, h("div", { class: "title", text: `${x.action} ${x.name}` }), h("div", { class: "desc", text: `${x.smith} · ${fmtDate(x.at)}${x.reason ? ` – ${x.reason}` : ""}` })), app.readOnly ? null : h("button", { class: "btn sm", type: "button", text: "Anwenden", onclick: async () => (await act("shadow.apply", { index: x.index })) && load() }))))
        : h("div", { class: "faint", text: "Keine Shadow-Vorschläge (nur im Schreibmodus „shadow“)." }),
    )
  }
  await load()
}
