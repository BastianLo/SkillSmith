import { get } from "../api.js"
import { debounce, entryHref, fmtCost, fmtDate, fmtNum, fmtRel, h, icon, put, swap } from "../dom.js"
import { act, app, card, fill, promptDialog } from "../ui.js"

const FINAL = new Set(["accepted", "discarded", "aborted", "error"])
export const PHASE_LABEL = { starting: "startet", proposal: "plant", awaiting_approval: "wartet auf Freigabe", revising: "überarbeitet Vorschlag", implementing: "setzt um", checking: "Prüfbefehle laufen", fixing: "bessert nach", reviewing: "Review läuft", in_test: "fertig – bitte prüfen", accepted: "abgenommen", discarded: "verworfen", aborted: "abgebrochen", error: "Fehler" }
export const phaseChip = (phase, permissions) =>
  h("span", { class: `chip ${permissions ? "warn" : phase === "awaiting_approval" || phase === "in_test" ? "warn" : phase === "error" ? "danger" : phase === "accepted" ? "ok" : FINAL.has(phase) ? "" : "accent"}`, text: permissions ? `braucht Antwort (${permissions})` : PHASE_LABEL[phase] || phase })

function jobRow(j) {
  return h(
    "a",
    { class: "row", href: `#/agenten/${encodeURIComponent(j.id)}` },
    icon("agent", 16),
    h("div", { class: "main" }, h("div", { class: "title", text: `${j.task.toUpperCase()} · ${j.agent}${j.model ? ` · ${j.model}` : ""}` }), h("div", { class: "desc", text: `${j.project || "ohne Projekt"} · gestartet ${fmtRel(j.startedAt)}${j.prepared ? " · vorab erstellt" : ""}` })),
    h("div", { class: "meta" }, phaseChip(j.phase, j.permissions), h("span", { text: `${fmtNum(j.tokens)} Tokens · ${fmtCost(j.cost)}` })),
  )
}

export default async function agents(ctx) {
  ctx.title("Agenten")
  const page = h("div", { class: "page" })
  const activeEl = h("div")
  const histEl = h("div")
  const statsEl = h("div")
  const rulesEl = h("div")
  put(
    page,
    h(
      "div",
      { class: "page-head" },
      h("div", { class: "grow" }, h("h1", { text: "Agenten-Aufträge" }), h("div", { class: "muted", text: "Aufgaben, die Sie an opencode-Agenten übergeben haben: erst Vorschlag (ohne Schreibrechte), dann Ihre Freigabe, dann Umsetzung im Worktree, Pipeline und Review – abnehmen nur Sie." })),
      app.readOnly ? null : h("div", { class: "toolbar" }, h("button", { class: "btn", type: "button", title: "Für eingeplante, Agenten zugewiesene Aufgaben jetzt Vorschläge erstellen (Idee 21)", onclick: () => act("agent.prepare", {}) }, icon("bolt", 14), "Vorschläge vorbereiten")),
    ),
    h("h2", { text: "Laufend" }),
    activeEl,
    h("div", { class: "grid two", style: { marginTop: "16px" } }, statsEl, rulesEl),
    h("h2", { text: "Verlauf" }),
    histEl,
  )
  ctx.el.replaceChildren(page)
  const load = async () => {
    const jobs = await get("jobs", { limit: 200 })
    if (!ctx.alive()) return
    const active = jobs.filter((j) => !FINAL.has(j.phase))
    swap(activeEl, active.length ? h("div", { class: "list" }, active.map(jobRow)) : h("div", { class: "card empty", text: "Kein Agent arbeitet gerade. Übergeben Sie eine Aufgabe in ihrer Detailansicht („An Agent übergeben“)." }))
    const done = jobs.filter((j) => FINAL.has(j.phase))
    swap(histEl, done.length ? h("div", { class: "list" }, done.slice(0, 100).map(jobRow)) : h("div", { class: "faint", text: "Noch keine abgeschlossenen Aufträge." }))
  }
  const loadRules = async () => {
    const rules = (await get("rules")).filter((r) => r.status === "candidate")
    if (!ctx.alive()) return
    swap(
      rulesEl,
      card(
        `Regeln aus Ihren Korrekturen (${rules.length})`,
        h("p", { class: "muted", style: { fontSize: "13px" }, text: "Begründungen beim Überarbeiten oder Nachbessern werden zu Kandidaten. Bestätigt bekommt der nächste Agent sie als Vorgabe von Anfang an." }),
        rules.length
          ? h(
              "div",
              { class: "stack" },
              rules.map((r) =>
                h(
                  "div",
                  { class: "card flat tight" },
                  h("div", { text: r.text }),
                  h("div", { class: "faint", style: { fontSize: "12px" }, text: `${r.kind === "skill" ? "Skill-Änderung" : "Vorgabe"}${r.project ? ` · ${r.project}` : ""}${r.task ? ` · ${r.task.toUpperCase()}` : ""} · ${fmtDate(r.at)}` }),
                  app.readOnly
                    ? null
                    : h(
                        "div",
                        { class: "toolbar", style: { marginBottom: 0 } },
                        h("button", { class: "btn sm primary", type: "button", text: "Bestätigen", onclick: async () => (await act("rule.decide", { id: r.id, decision: "confirm" })) && loadRules() }),
                        h("button", { class: "btn sm", type: "button", text: "Anpassen …", onclick: async () => {
                          const text = await promptDialog("Regel anpassen", { value: r.text, multiline: true })
                          if (text && (await act("rule.decide", { id: r.id, decision: "confirm", text }))) loadRules()
                        } }),
                        h("button", { class: "btn sm", type: "button", text: "Verwerfen", onclick: async () => (await act("rule.decide", { id: r.id, decision: "dismiss" })) && loadRules() }),
                      ),
                ),
              ),
            )
          : h("div", { class: "faint", text: "Keine offenen Kandidaten." }),
      ),
    )
  }
  fill(statsEl, async () => {
    const s = await get("stats/agents", { days: 90 })
    return card(
      "Auswertung je Agent und Modell (90 Tage)",
      s.agents.length
        ? h(
            "div",
            { class: "table-wrap" },
            h(
              "table",
              { class: "table" },
              h("thead", null, h("tr", null, ["Agent", "Modell", "Aufträge", "1. Vorschlag frei", "Überarb.", "Nachbess.", "Pipeline 1× grün", "Befunde", "Ø min", "Kosten"].map((x) => h("th", { text: x })))),
              h(
                "tbody",
                null,
                s.agents.map((a) => h("tr", null, h("td", { text: a.agent }), h("td", { class: "mono", text: a.model }), h("td", { class: "num", text: a.jobs }), h("td", { class: "num", text: a.jobs ? `${Math.round((a.approvedFirst / a.jobs) * 100)} %` : "–" }), h("td", { class: "num", text: a.revisions }), h("td", { class: "num", text: a.fixRounds + a.improveRounds }), h("td", { class: "num", text: a.withPipeline ? `${Math.round((a.firstGreen / a.withPipeline) * 100)} %` : "–" }), h("td", { class: "num", text: a.findings }), h("td", { class: "num", text: a.avgMinutes }), h("td", { class: "num", text: fmtCost(a.cost) }))),
              ),
            ),
          )
        : h("div", { class: "faint", text: "Noch keine Aufträge im Zeitraum." }),
      h("div", { style: { marginTop: "8px" } }, h("a", { href: "#/statistik?bereich=agenten", text: "Mehr in der Statistik →" })),
    )
  })
  await Promise.all([load(), loadRules()])
  const later = debounce(() => ctx.alive() && (load(), loadRules()), 800)
  ctx.on("agent.job", later)
  ctx.on("inbox.changed", later)
}

export { entryHref }
