// Review knowledge (5f): candidates from recurring review comments (confirm as convention or
// skill, reject), confirmed conventions, and the pre-PR check of a project's branch.
import { get } from "../api.js"
import { entryHref, fmtRel, h, icon, put, swap } from "../dom.js"
import { act, app, card, modal } from "../ui.js"

async function confirmDialog(c, load) {
  const res = await modal((close) => {
    const title = h("input", { class: "input wide", value: c.summary.slice(0, 80) })
    const text = h("textarea", { class: "input", rows: 5, value: c.summary })
    const as = h("select", { class: "input" }, h("option", { value: "vorgabe", text: "Vorgabe" }), h("option", { value: "skill", text: "Skill" }))
    const scope = h("select", { class: "input" }, h("option", { value: "projekt", text: "dieses Projekt" }), h("option", { value: "global", text: "Team (global)" }))
    return {
      title: "Als Vorgabe übernehmen",
      wide: true,
      body: [
        h("div", { class: "field" }, h("label", { text: "Titel" }), title),
        h("div", { class: "field" }, h("label", { text: "Regel (in eigenen Worten)" }), text),
        h("div", { class: "grid two" }, h("div", { class: "field" }, h("label", { text: "Als" }), as), h("div", { class: "field" }, h("label", { text: "Gilt für" }), scope)),
        h("details", null, h("summary", { text: `${c.comments.length} Kommentare` }), h("ul", { class: "meta-lines" }, c.items.map((x) => h("li", null, x.url ? h("a", { href: x.url, target: "_blank", rel: "noopener noreferrer", text: `${x.repo}#${x.pr}` }) : `${x.repo}#${x.pr}`, x.path ? ` ${x.path}${x.line ? `:${x.line}` : ""}` : "", ` – ${x.body}`)))),
      ],
      foot: [h("button", { class: "btn", type: "button", text: "Abbrechen", onclick: () => close(undefined) }), h("button", { class: "btn primary", type: "button", text: "Übernehmen", onclick: () => close({ id: c.id, as: as.value, scope: scope.value, title: title.value.trim(), text: text.value.trim() }) })],
    }
  })
  if (res) (await act("review.confirm", res)) && load()
}

export default async function reviews(ctx) {
  ctx.title("Review-Wissen")
  const page = h("div", { class: "page" })
  const body = h("div", { class: "stack" })
  const prOut = h("div")
  ctx.el.replaceChildren(page)
  const load = async () => {
    const d = await get("reviews")
    if (!ctx.alive()) return
    const open = d.candidates.filter((c) => c.status === "offen")
    swap(
      body,
      card(
        "Quellen",
        d.repos.length ? h("p", null, `${d.repos.join(", ")} · Quelle ${d.source} · ${d.comments} Kommentar(e)`, ...Object.entries(d.fetched).map(([r, at]) => h("span", { class: "faint", text: ` · ${r} ${fmtRel(at)}` }))) : h("p", { class: "muted", text: "Noch keine Repositories – Einstellungen → Review-Wissen aus GitHub (reviews.repos)." }),
        app.readOnly ? null : h("button", { class: "btn", type: "button", onclick: async () => (await act("job.run", { id: "review-extract" })) && load() }, icon("refresh", 14), "Jetzt abrufen"),
      ),
      card(
        `Kandidaten (${open.length})`,
        open.length
          ? h(
              "div",
              { class: "list" },
              open.map((c) =>
                h(
                  "div",
                  { class: "row", id: `k-${c.id}` },
                  icon("github", 16),
                  h("div", { class: "main" }, h("div", { class: "title", text: c.summary }), h("div", { class: "desc", text: `${c.comments.length} Kommentare von ${c.persons} Personen · ${c.repos.join(", ")}` })),
                  app.readOnly ? null : h("div", { class: "acts", style: { display: "flex", gap: "6px" } }, h("button", { class: "btn sm primary", type: "button", text: "Übernehmen …", onclick: () => confirmDialog(c, load) }), h("button", { class: "btn sm ghost", type: "button", text: "Ablehnen", onclick: async () => (await act("review.reject", { id: c.id })) && load() })),
                ),
              ),
            )
          : h("p", { class: "muted", text: "Keine offenen Kandidaten." }),
      ),
      card("Vorgaben aus Reviews", d.rules.length ? h("ul", { class: "meta-lines" }, d.rules.map((r) => h("li", null, h("a", { href: entryHref(r.id), text: r.title }), r.comments.length ? h("span", { class: "faint", text: ` · ${r.comments.length} Kommentar(e)` }) : null))) : h("p", { class: "muted", text: "Noch keine bestätigten Vorgaben." })),
      card(
        "Vor-PR-Prüfung",
        h("p", { class: "muted", text: "Vergleicht den Diff des aktuellen Branches (gegen origin/main bzw. main) mit den Vorgaben – auch als /smith-pr-check in opencode, als Prüfschritt „pr-check“ einer Spalte und mit smith pr-check." }),
        h("button", {
          class: "btn",
          type: "button",
          onclick: async () => {
            const r = await act("review.prCheck", {}, { quiet: true })
            if (!r) return
            swap(prOut, h("div", { class: "stack" }, h("strong", { text: r.message }), r.data.findings.length ? h("ul", { class: "meta-lines" }, r.data.findings.map((f) => h("li", null, h("span", { class: "mono", text: `${f.file ?? ""}${f.line ? `:${f.line}` : ""}` }), ` – ${f.text} `, h("a", { href: entryHref(f.rule), text: "Vorgabe" })))) : null))
          },
        }, icon("play", 14), "Jetzt prüfen"),
        prOut,
      ),
    )
    const k = ctx.query.get("kandidat")
    if (k) document.getElementById(`k-${k}`)?.scrollIntoView({ block: "center" })
  }
  put(page, h("h1", { text: "Review-Wissen aus GitHub" }), h("p", { class: "page-sub", text: "Wiederkehrende Review-Kommentare werden zu Vorgaben. Namen erscheinen nur als Quelle eines Kommentars." }), body)
  await load()
}
