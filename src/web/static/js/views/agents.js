import { get } from "../api.js"
import { debounce, entryHref, fmtCost, fmtDate, fmtNum, fmtRel, h, icon, put, swap } from "../dom.js"
import { act, app, card, fill, promptDialog } from "../ui.js"

export const FINAL = new Set(["accepted", "discarded", "aborted", "error"])
const STEP_DOING = { plan: "plant", implement: "setzt um", test: "testet", verify: "verifiziert" }
const WAIT_LABEL = { plan: "wartet auf Freigabe des Plans", gate: "wartet auf Freigabe", accept: "fertig – bitte abnehmen", tests: "wartet auf manuelle Tests", manual: "wartet (Spalte ohne Agent)" }
export const STEP_LABEL = { plan: "Planung", implement: "Umsetzung", test: "Test", verify: "Verifikation" }

/** Label of a job's state (same wording as the server's phaseLabel). */
export function jobLabel(j) {
  switch (j.phase) {
    case "starting":
      return "startet"
    case "working":
      return STEP_DOING[j.step] || "arbeitet"
    case "checking":
      return "Prüfbefehle laufen"
    case "waiting":
      return WAIT_LABEL[j.waitingFor] || "wartet"
    case "halted":
      return `angehalten nach ${j.loops} Rücksprüngen`
    case "accepted":
      return "abgenommen"
    case "discarded":
      return "verworfen"
    case "aborted":
      return "abgebrochen"
    default:
      return "Fehler"
  }
}

export const jobChip = (j) => {
  const permissions = typeof j.permissions === "number" ? j.permissions : (j.permissions || []).length
  const cls = permissions || j.phase === "waiting" ? "warn" : j.phase === "halted" || j.phase === "error" ? "danger" : j.phase === "accepted" ? "ok" : FINAL.has(j.phase) ? "" : "accent"
  return h("span", { class: `chip ${cls}`, text: permissions ? `braucht Antwort (${permissions})` : jobLabel(j) })
}

function jobRow(j) {
  return h(
    "a",
    { class: "row", href: `#/agenten/${encodeURIComponent(j.id)}` },
    icon("agent", 16),
    h("div", { class: "main" }, h("div", { class: "title", text: `${j.task.toUpperCase()} · ${j.agent}${j.model ? ` · ${j.model}` : ""}` }), h("div", { class: "desc", text: `${j.project || "ohne Projekt"} · ${j.column ? `Spalte ${j.column} · ` : ""}gestartet ${fmtRel(j.startedAt)}${j.loops ? ` · ${j.loops} Rücksprung/Rücksprünge` : ""}${j.prepared ? " · vorab erstellt" : ""}` })),
    h("div", { class: "meta" }, jobChip(j), h("span", { text: `${fmtNum(j.tokens)} Tokens · ${fmtCost(j.cost)}` })),
  )
}

export default async function agents(ctx) {
  ctx.title("Aufträge")
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
      h("div", { class: "grow" }, h("h1", { text: "Agenten-Aufträge" }), h("div", { class: "muted", text: "Aufgaben laufen mit einem Agenten je Spalte durch Planung, Umsetzung, Test und Verifikation – mit Ihrer Freigabe nach der Planung und vor „erledigt“. Ein roter Test oder ein nicht erfülltes Kriterium führt zurück in die Umsetzung." })),
      app.readOnly ? null : h("div", { class: "toolbar" }, h("a", { class: "btn ghost", href: "#/liste/agent" }, icon("agent", 14), "Agenten verwalten"), h("button", { class: "btn", type: "button", title: "Für Aufgaben in der Planungsspalte, die einem Agenten zugewiesen sind, jetzt Pläne erstellen", onclick: () => act("agent.prepare", {}) }, icon("bolt", 14), "Pläne vorbereiten")),
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
    swap(activeEl, active.length ? h("div", { class: "list" }, active.map(jobRow)) : h("div", { class: "card empty", text: "Kein Agent arbeitet gerade. Übergeben Sie eine Aufgabe in ihrer Detailansicht („An Agent übergeben“) oder ziehen Sie sie in eine Spalte mit Agent." }))
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
      "Auswertung je Agent und Version (90 Tage)",
      s.agents.length
        ? h(
            "div",
            { class: "table-wrap" },
            h(
              "table",
              { class: "table" },
              h("thead", null, h("tr", null, ["Agent", "Version", "Aufträge", "Plan beim 1. Mal frei", "Rücksprünge", "angehalten", "Pipeline 1× grün", "Befunde", "Ø min", "Kosten"].map((x) => h("th", { text: x })))),
              h(
                "tbody",
                null,
                s.agents.map((a) =>
                  h(
                    "tr",
                    null,
                    h("td", { text: a.agent }),
                    h("td", { class: "mono", title: a.model, text: a.version === "opencode" ? "opencode" : a.version.slice(0, 8) }),
                    h("td", { class: "num", text: a.jobs }),
                    h("td", { class: "num", title: "Anteil der Aufträge, deren erster Plan ohne Überarbeitung freigegeben wurde", text: a.plans ? `${Math.round((a.approvedFirst / Math.max(1, a.jobs)) * 100)} %` : "–" }),
                    h("td", { class: "num", text: a.loops }),
                    h("td", { class: "num", text: a.halted }),
                    h("td", { class: "num", text: a.withPipeline ? `${Math.round((a.firstGreen / a.withPipeline) * 100)} %` : "–" }),
                    h("td", { class: "num", text: a.findings }),
                    h("td", { class: "num", text: a.avgMinutes }),
                    h("td", { class: "num", text: fmtCost(a.cost) }),
                  ),
                ),
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
