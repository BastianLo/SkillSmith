import { get } from "../api.js"
import { colLabel, debounce, entryHref, fmtDate, fmtDur, fmtRel, h, icon, put } from "../dom.js"
import { act, app, card } from "../ui.js"
import { pipelineBadge, taskCard } from "./board.js"

export function runsTable(runs) {
  if (!runs.length) return h("div", { class: "faint", text: "Noch keine Läufe." })
  return h(
    "div",
    { class: "list" },
    runs.map((r) =>
      h(
        "a",
        { class: "row", href: `#/pipeline/${encodeURIComponent(r.project)}/${encodeURIComponent(r.id)}` },
        pipelineBadge({ status: r.status, stages: r.stages }),
        h("div", { class: "main" }, h("div", { class: "title", text: `${r.status === "success" ? "grün" : r.status === "failed" ? "rot" : r.status}${r.task ? ` · ${r.task.toUpperCase()}` : ""}${r.tests ? ` · ${r.tests.total} Tests, ${r.tests.failures + r.tests.errors} rot` : ""}` }), h("div", { class: "desc", text: `${r.trigger || ""} · ${r.by || ""}${r.source ? ` · ${r.source}` : ""}` })),
        h("div", { class: "meta" }, h("span", { text: fmtRel(r.queuedAt) }), h("span", { text: fmtDur(r.ms) })),
      ),
    ),
  )
}

export default async function project(ctx) {
  const name = ctx.params.name
  const load = async () => {
    const d = await get("project", { name })
    if (!ctx.alive()) return
    if (d.error) {
      ctx.el.replaceChildren(h("div", { class: "page narrow" }, h("div", { class: "notice error", text: `Projekt „${name}“ nicht gefunden.` })))
      return
    }
    const p = d.project
    ctx.title(p.title)
    const cols = p.columns
    const page = h("div", { class: "page" })
    put(
      page,
      h(
        "div",
        { class: "page-head" },
        h("div", { class: "grow" }, h("div", { class: "entry-head" }, h("span", { class: "chip kind", style: { background: p.color || "var(--k-project)" }, text: "Projekt" }), h("span", { class: "mono faint", text: p.homePath || "kein home_path" }), p.homePath && !p.homeExists ? h("span", { class: "chip danger", text: "Verzeichnis fehlt" }) : null), h("h1", { text: p.title }), p.description ? h("p", { class: "entry-sub", text: p.description }) : null),
        h(
          "div",
          { class: "toolbar" },
          h("a", { class: "btn primary", href: `#/board?projekt=${encodeURIComponent(p.name)}` }, icon("board", 14), "Board"),
          p.pipeline && !app.readOnly ? h("button", { class: "btn", type: "button", onclick: async () => (await act("pipeline.start", { project: p.name })) && load() }, icon("play", 14), "Pipeline starten") : null,
          app.readOnly ? null : h("a", { class: "btn", href: `#/projekt/${encodeURIComponent(p.name)}/bearbeiten` }, icon("edit", 14), "Bearbeiten"),
          h("a", { class: "btn", href: `#/eintrag/${encodeURIComponent(`project:${p.name}`)}?tab=versionen` }, "Versionen"),
        ),
      ),
    )
    // board summary
    put(
      page,
      h(
        "div",
        { class: "grid" },
        cols.map((c) => {
          const n = d.tasks.filter((t) => t.status === c).length
          const limit = p.wip?.[c]
          return h("a", { class: "card", href: `#/board?projekt=${encodeURIComponent(p.name)}` }, h("div", { class: "label", text: colLabel(c) }), h("div", { class: "num", style: limit && n > limit ? { color: "var(--danger)" } : undefined, text: limit ? `${n}/${limit}` : String(n) }))
        }),
      ),
    )
    const inWork = d.tasks.filter((t) => t.status !== cols[0] && t.status !== cols[cols.length - 1])
    put(
      page,
      h(
        "div",
        { class: "cols", style: { marginTop: "16px" } },
        h(
          "div",
          { class: "stack" },
          card("In Arbeit", inWork.length ? h("div", { class: "grid wide" }, inWork.map((t) => taskCard(t))) : h("div", { class: "faint", text: "Nichts in Arbeit." })),
          card(
            "Arbeitsstände der Branches",
            d.states.length
              ? h(
                  "div",
                  { class: "stack" },
                  d.states.map((s) =>
                    h(
                      "div",
                      { class: "card flat tight" },
                      h("div", { class: "row-flex" }, h("a", { href: entryHref(s.id), style: { fontWeight: 600 }, text: s.branch }), s.ticket ? h("a", { class: "chip", href: `#/ticket/${encodeURIComponent(s.ticket)}`, text: s.ticket }) : null, h("span", { class: "faint", text: fmtRel(s.updatedAt) }), s.status !== "gueltig" ? h("span", { class: "chip", text: s.status }) : null),
                      s.summary ? h("div", { class: "muted", text: s.summary }) : null,
                      h(
                        "div",
                        { class: "grid", style: { gridTemplateColumns: "repeat(3, 1fr)", marginTop: "6px", fontSize: "12.5px" } },
                        [
                          ["Offen", s.open],
                          ["Als Nächstes", s.next],
                          ["Erledigt", s.done],
                        ].map(([l, items]) => h("div", null, h("strong", { text: `${l} (${items.length})` }), h("ul", { class: "meta-lines" }, items.slice(0, 6).map((x) => h("li", { text: x }))))),
                      ),
                    ),
                  ),
                )
              : h("div", { class: "faint", text: "Keine Arbeitsstände zu diesem Projekt." }),
          ),
          card("Pipeline-Läufe", p.pipeline ? runsTable(d.runs) : h("div", { class: "faint" }, "Keine Pipeline eingerichtet. ", app.readOnly ? null : h("a", { href: `#/projekt/${encodeURIComponent(p.name)}/bearbeiten`, text: "Einrichten" }))),
        ),
        h(
          "div",
          { class: "stack" },
          p.pipeline
            ? card(
                "Pipeline",
                h("div", { class: "muted", style: { fontSize: "12.5px", marginBottom: "6px" }, text: `Auslöser: ${(p.pipeline.trigger || []).map(colLabel).join(", ") || "–"} · Quelle: ${p.pipeline.source === "branch" ? "sauberer Branch-Checkout" : "Arbeitsverzeichnis"}` }),
                h("ol", { class: "meta-lines" }, p.pipeline.stages.map((s) => h("li", null, h("strong", { text: s.name }), " ", h("code", { text: s.run }), s.allowFailure ? h("span", { class: "chip", text: "darf scheitern" }) : null))),
              )
            : null,
          card("Vorgaben", d.rules.length ? h("ul", { class: "meta-lines" }, d.rules.map((r) => h("li", null, h("a", { href: entryHref(r.id), text: r.title })))) : h("div", { class: "faint", text: "–" })),
          card("Entscheidungen", d.decisions.length ? h("ul", { class: "meta-lines" }, d.decisions.map((r) => h("li", null, h("a", { href: entryHref(r.id), text: r.title }), r.status === "vorgeschlagen" ? h("span", { class: "chip warn", text: "unbestätigt" }) : null))) : h("div", { class: "faint", text: "–" })),
          card("Agenten-Aufträge", d.jobs.length ? h("ul", { class: "meta-lines" }, d.jobs.map((j) => h("li", null, h("a", { href: `#/agenten/${encodeURIComponent(j.id)}`, text: `${j.task.toUpperCase()} · ${j.agent}` }), ` – ${j.phase}, ${fmtDate(j.startedAt)}`))) : h("div", { class: "faint", text: "–" })),
          d.results.length ? card("Ergebnisse", h("ul", { class: "meta-lines" }, d.results.map((r) => h("li", null, h("a", { href: entryHref(r.id), text: r.title }))))) : null,
          d.docs.length ? card("Verlinkt von", h("ul", { class: "meta-lines" }, d.docs.map((r) => h("li", null, h("a", { href: entryHref(r.id), text: r.title }))))) : null,
        ),
      ),
    )
    ctx.el.replaceChildren(page)
  }
  await load()
  const later = debounce(() => ctx.alive() && load(), 1000)
  ctx.on("pipeline.run", (d) => d.project === name && later())
  ctx.on("task.changed", later)
}
