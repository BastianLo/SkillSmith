import { get } from "../api.js"
import { areaChart, barChart, calendar, chartCard, colorAt, csvButton, heatmap, hbars, legendOf, lineChart } from "../charts.js"
import { KIND_PLURAL, entryHref, fmtCost, fmtDate, fmtDur, fmtNum, fmtPct, h, put, swap } from "../dom.js"
import { card, fill, modal, tabBar } from "../ui.js"

const AREAS = [
  ["ueberblick", "Überblick"],
  ["wissen", "Wissen"],
  ["hinweise", "Hinweise"],
  ["fehler", "Fehler"],
  ["smiths", "Smiths und Kosten"],
  ["tools", "Tools und MCPs"],
  ["tageszeiten", "Tageszeiten"],
  ["aufgaben", "Aufgaben"],
  ["pipeline", "Pipeline"],
  ["agenten", "Agenten"],
]
const TYPE_LABEL = { "session.user": "Nutzernachrichten", "entry.load": "Einträge geladen", "entry.hint_followed": "Hinweise befolgt", "entry.hint_shown": "Hinweise gezeigt", "tool.call": "Tool-Aufrufe", "error.occurrence": "Fehler aufgetreten", "error.solved": "Fehler gelöst" }

async function eventsDialog(title, params) {
  const rows = await get("stats/events", { ...params, limit: 500 })
  await modal((close) => ({
    title,
    wide: true,
    body: rows.length
      ? h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            { class: "table" },
            h("thead", null, h("tr", null, ["Zeit", "Typ", "Eintrag", "Session", "Projekt", "Agent", "Wert"].map((x) => h("th", { text: x })))),
            h(
              "tbody",
              null,
              rows.map((r) =>
                h(
                  "tr",
                  null,
                  h("td", { class: "nowrap", text: fmtDate(r.at) }),
                  h("td", { text: TYPE_LABEL[r.type] || r.type }),
                  h("td", null, /^[a-z]+:/.test(r.entry) && !/^(tool|smith|sig|verdict):/.test(r.entry) ? h("a", { href: entryHref(r.entry), text: r.entry, onclick: () => close() }) : h("span", { class: "mono", text: r.entry })),
                  h("td", null, r.session ? h("a", { href: `#/session/${encodeURIComponent(r.session)}`, class: "mono", text: r.session.slice(0, 14), onclick: () => close() }) : "–"),
                  h("td", { text: r.project || "" }),
                  h("td", { text: r.agent || r.origin || "" }),
                  h("td", { class: "num", text: r.value === undefined || r.value === null ? "" : fmtNum(r.value, 1) }),
                ),
              ),
            ),
          ),
        )
      : h("div", { class: "faint", text: "Keine Ereignisse." }),
    foot: [h("button", { class: "btn", type: "button", text: "Schließen", onclick: () => close() })],
  }))
}

const seriesCsv = (buckets, series) => () => [["Zeitraum", ...series.map((x) => x.name)], ...buckets.map((b, i) => [b, ...series.map((x) => x.values[i])])]
const tableCsv = (cols, rows) => () => [cols.map((c) => c[1]), ...rows.map((r) => cols.map((c) => r[c[0]]))]

function table(cols, rows, { onRow, empty = "Keine Daten im Zeitraum." } = {}) {
  if (!rows.length) return h("div", { class: "faint", text: empty })
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: "table" },
      h("thead", null, h("tr", null, cols.map(([, label, num]) => h("th", { class: num ? "num" : "", text: label })))),
      h("tbody", null, rows.map((r) => h("tr", { class: onRow ? "clickable" : "", onclick: onRow ? () => onRow(r) : undefined }, cols.map(([k, , num, fmt]) => h("td", { class: num ? "num" : "", text: fmt ? fmt(r[k], r) : r[k] ?? "–" }))))),
    ),
  )
}

function kpi(label, cur, prev, fmt = (v) => fmtNum(v)) {
  const delta = prev ? ((cur - prev) / prev) * 100 : null
  return h("div", { class: "card kpi" }, h("div", { class: "label", text: label }), h("div", { class: "num", text: fmt(cur) }), h("div", { class: `delta ${delta === null ? "" : delta >= 0 ? "up" : "down"}`, text: delta === null ? `Vorzeitraum ${fmt(prev || 0)}` : `${delta >= 0 ? "+" : ""}${fmtNum(delta, 0)} % zum Vorzeitraum` }))
}

const noMetrics = () => h("div", { class: "notice", text: "Metriken sind nicht verfügbar (metrics.enabled aus oder SQLite fehlt)." })

const AREA = {
  async ueberblick(days, project) {
    const s = await get("stats/overview", { days, project })
    if (!s.available) return noMetrics()
    const c = s.current
    const p = s.previous
    const series = s.series ? Object.entries(s.series.series).map(([t, values], i) => ({ name: TYPE_LABEL[t] || t, values, color: colorAt(i) })) : []
    return h(
      "div",
      { class: "stack" },
      h(
        "div",
        { class: "stat-grid" },
        kpi("Sessions", c.sessions, p.sessions),
        kpi("Hinweise befolgt", c.hintsFollowed, p.hintsFollowed),
        kpi("Neue Einträge", c.created, p.created),
        kpi("Geänderte Einträge", c.changed, p.changed),
        kpi("Fehler gelöst", c.errorsSolved, p.errorsSolved),
        kpi("Tokens", c.tokens, p.tokens),
        kpi("Kosten", c.cost, p.cost, fmtCost),
        kpi("Tool-Aufrufe", c.toolCalls, p.toolCalls),
      ),
      chartCard("Aktivität im letzten Jahr", calendar(s.calendar, { onClick: (day) => eventsDialog(`Ereignisse am ${day}`, { day }) }), "aktivitaet", () => [["Tag", "Ereignisse"], ...s.calendar.map((d) => [d.day, d.n])]),
      series.length ? chartCard("Verlauf", lineChart(s.series.buckets, series, { onClick: (i) => eventsDialog(`Ereignisse am ${s.series.buckets[i]}`, { day: s.series.buckets[i] }) }), "verlauf", seriesCsv(s.series.buckets, series)) : null,
    )
  },
  async wissen(days) {
    const s = await get("stats/knowledge", { days })
    if (!s.available) return noMetrics()
    const growth = Object.entries(s.growth.series).filter(([, v]) => v.some(Boolean)).map(([k, values], i) => ({ name: s.growth.labels[k] || k, values, color: colorAt(i) }))
    const deltaCols = [["title", "Eintrag"], ["kind", "Art", false, (v) => KIND_PLURAL[v] || v], ["uses", "jetzt", true], ["prev", "vorher", true], ["delta", "Δ", true]]
    return h(
      "div",
      { class: "stack" },
      chartCard("Meistgenutzt im Zeitraum", hbars(s.top.map((t) => ({ label: t.title, value: t.uses, href: entryHref(t.id), title: `vorher ${t.prev}` }))), "meistgenutzt", tableCsv([["id", "Id"], ["title", "Titel"], ["uses", "Nutzungen"], ["prev", "Vorzeitraum"]], s.top)),
      h("div", { class: "grid two" }, card("Aufsteiger", table(deltaCols, s.risers, { onRow: (r) => (location.hash = entryHref(r.id)) })), card("Absteiger", table(deltaCols, s.fallers, { onRow: (r) => (location.hash = entryHref(r.id)) }))),
      growth.length ? chartCard("Neue Einträge je Woche und Art", [barChart(s.growth.weeks, growth), legendOf(growth)], "wachstum", seriesCsv(s.growth.weeks, growth)) : null,
      chartCard(`90 Tage nicht genutzt (${s.unused.length})`, table([["title", "Eintrag"], ["kind", "Art", false, (v) => KIND_PLURAL[v] || v], ["never", "nie genutzt", false, (v) => (v ? "ja" : "")], ["createdAt", "angelegt", false, (v) => fmtDate(v, false)]], s.unused, { onRow: (r) => (location.hash = entryHref(r.id)) }), "ungenutzt", tableCsv([["id", "Id"], ["title", "Titel"], ["never", "nie"], ["createdAt", "angelegt"]], s.unused)),
    )
  },
  async hinweise(days) {
    const s = await get("stats/hints", { days })
    if (!s.available) return noMetrics()
    const series = s.series ? [{ name: "gezeigt", values: s.series.series["entry.hint_shown"] }, { name: "befolgt", values: s.series.series["entry.hint_followed"] }] : []
    return h(
      "div",
      { class: "stack" },
      h(
        "div",
        { class: "stat-grid" },
        h("div", { class: "card kpi" }, h("div", { class: "label", text: "Berechnungen" }), h("div", { class: "num", text: fmtNum(s.compute.n) }), h("div", { class: "sub", text: `Median ${fmtDur(s.compute.p50)} · 95 % ${fmtDur(s.compute.p95)}` })),
        h("div", { class: "card kpi" }, h("div", { class: "label", text: "Anteil semantisch" }), h("div", { class: "num", text: s.compute.semanticShare === null ? "–" : `${s.compute.semanticShare} %` }), h("div", { class: "sub", text: `mit Hinweis: ${s.compute.shownShare ?? "–"} %` })),
        h("div", { class: "card kpi" }, h("div", { class: "label", text: "Fehler-Hinweise" }), h("div", { class: "num", text: `${s.errorHints.helped} / ${s.errorHints.helped + s.errorHints.failed}` }), h("div", { class: "sub", text: "halfen" })),
        h("div", { class: "card kpi" }, h("div", { class: "label", text: "Schwellen" }), h("div", { class: "mono", text: `minScore ${s.thresholds.minScore} · Ähnlichkeit ${s.thresholds.hintMinSimilarity} · max ${s.thresholds.max}` }), h("a", { href: "#/simulator", text: "Im Simulator ausprobieren →" })),
      ),
      chartCard("Trefferquote je Art", table([["label", "Art"], ["shown", "gezeigt", true], ["followed", "befolgt", true], ["rate", "Quote", true, fmtPct]], s.perKind.filter((k) => k.shown)), "hinweise-je-art", tableCsv([["label", "Art"], ["shown", "gezeigt"], ["followed", "befolgt"], ["rate", "Quote %"]], s.perKind)),
      series.length ? chartCard("Gezeigt und befolgt", lineChart(s.series.buckets, series), "hinweise-verlauf", seriesCsv(s.series.buckets, series)) : null,
      card("Hinweise ohne Wirkung (≥ 5× gezeigt, nie befolgt)", table([["title", "Eintrag"], ["shown", "gezeigt", true]], s.noEffect, { onRow: (r) => (location.hash = entryHref(r.id)) })),
    )
  },
  async fehler(days) {
    const s = await get("stats/errors", { days })
    if (!s.available) return noMetrics()
    const series = s.series ? [{ name: "aufgetreten", values: s.series.series["error.occurrence"] }, { name: "gelöst", values: s.series.series["error.solved"] }] : []
    return h(
      "div",
      { class: "stack" },
      h("div", { class: "stat-grid" }, h("div", { class: "card kpi" }, h("div", { class: "label", text: "Zeit bis zur Lösung (Median)" }), h("div", { class: "num", text: `${fmtNum(s.medianSolveDays, 1)} Tage` })), h("div", { class: "card kpi" }, h("div", { class: "label", text: "Live-Hinweise halfen" }), h("div", { class: "num", text: `${s.liveHints.helped} / ${s.liveHints.helped + s.liveHints.failed}` }))),
      chartCard("Häufigste Fehler", table([["signature", "Signatur"], ["n", "Vorkommen", true], ["sessions", "Sessions", true], ["entry", "Eintrag", false, (v) => v || "– (noch nicht dokumentiert)"]], s.top, { onRow: (r) => r.entry && (location.hash = entryHref(r.entry)) }), "fehler", tableCsv([["signature", "Signatur"], ["n", "Vorkommen"], ["sessions", "Sessions"], ["entry", "Eintrag"]], s.top)),
      h("div", { class: "grid two" }, card("Wiederkehrend trotz Lösung", table([["title", "Fehler"], ["count", "Vorkommen", true], ["lastSeen", "zuletzt", false, (v) => fmtDate(v)]], s.recurring, { onRow: (r) => (location.hash = entryHref(r.id)) })), card("Fehler je Projekt", hbars(s.perProject.map((x) => ({ label: x.project, value: x.n }))))),
      card("Zeit vom ersten Auftreten bis zur Lösung", table([["title", "Fehler"], ["days", "Tage", true, (v) => fmtNum(v, 1)]], s.solveTimes, { onRow: (r) => (location.hash = entryHref(r.id)) })),
      series.length ? chartCard("Verlauf", lineChart(s.series.buckets, series), "fehler-verlauf", seriesCsv(s.series.buckets, series)) : null,
    )
  },
  async smiths(days) {
    const s = await get("stats/smiths", { days })
    if (!s.available) return noMetrics()
    const cost = s.costPerDay ? [{ name: "Kosten", values: s.costPerDay.series["session.reply"] }] : []
    const tokens = s.tokensPerDay ? [{ name: "Tokens", values: s.tokensPerDay.series["session.reply"] }] : []
    return h(
      "div",
      { class: "stack" },
      chartCard("Läufe je Smith", table([["smith", "Smith"], ["n", "Läufe", true], ["errors", "Fehler", true], ["p50", "Median", true, fmtDur], ["p95", "95 %", true, fmtDur]], s.runs), "laeufe", tableCsv([["smith", "Smith"], ["n", "Läufe"], ["errors", "Fehler"], ["p50", "Median ms"], ["p95", "p95 ms"]], s.runs)),
      chartCard("Tokens und Kosten je Smith und Modell (Hintergrund)", table([["smith", "Smith"], ["model", "Modell"], ["n", "Antworten", true], ["tokens", "Tokens", true, (v) => fmtNum(v)], ["cost", "Kosten", true, fmtCost]], s.tokens), "tokens", tableCsv([["smith", "Smith"], ["model", "Modell"], ["n", "Antworten"], ["tokens", "Tokens"], ["cost", "Kosten"]], s.tokens)),
      h("div", { class: "grid two" }, cost.length ? chartCard("Kosten je Tag", barChart(s.costPerDay.buckets, cost), "kosten", seriesCsv(s.costPerDay.buckets, cost)) : null, tokens.length ? chartCard("Tokens je Tag", barChart(s.tokensPerDay.buckets, tokens), "tokens-tag", seriesCsv(s.tokensPerDay.buckets, tokens)) : null),
      h(
        "div",
        { class: "grid two" },
        card("Abgelehnte Aktionen je Gate", table([["gate", "Gate"], ["n", "Anzahl", true], ["smiths", "Smiths", false, (v) => v.join(", ")]], s.rejected)),
        card("Wartezeit in der Queue und Doktor", h("div", { class: "muted", text: `${s.queueWait.n} Jobs · Median ${fmtDur(s.queueWait.p50)} · 95 % ${fmtDur(s.queueWait.p95)}` }), h("h3", { text: "Urteile des Doktors" }), hbars(s.verdicts.map((v) => ({ label: v.verdict, value: v.n })), { alt: true })),
      ),
    )
  },
  async tools(days) {
    const s = await get("stats/tools", { days })
    if (!s.available) return noMetrics()
    if (!s.enabled) return h("div", { class: "notice", text: "Tool-Aufrufe werden nicht erfasst (metrics.toolCalls aus)." })
    const detail = h("div")
    const show = async (tool) => {
      swap(detail, h("div", { class: "loading" }, h("span", { class: "spinner" }), "Lade …"))
      const d = await get("stats/tools", { days, tool })
      const daily = d.daily || []
      const series = [{ name: "Aufrufe", values: daily.map((x) => x.n) }, { name: "Fehler", values: daily.map((x) => x.errors), color: "var(--danger)" }]
      swap(
        detail,
        h(
          "div",
          { class: "card" },
          h("h3", { text: `Tool ${tool}` }),
          daily.length ? [barChart(daily.map((x) => x.day), series, { stacked: false }), legendOf(series), lineChart(daily.map((x) => x.day), [{ name: "Median ms", values: daily.map((x) => x.p50) }, { name: "95 % ms", values: daily.map((x) => x.p95) }], { height: 180 })] : h("div", { class: "faint", text: "Keine Aufrufe." }),
          h("h3", { text: "Letzte Aufrufe" }),
          table([["at", "Zeit", false, (v) => fmtDate(v)], ["agent", "Agent"], ["origin", "Herkunft"], ["ms", "Dauer", true, fmtDur], ["error", "Fehler", false, (v) => (v ? "ja" : "")]], d.recent || []),
        ),
      )
      detail.scrollIntoView({ block: "start", behavior: "smooth" })
    }
    return h(
      "div",
      { class: "stack" },
      chartCard("Tools und MCPs", table([["tool", "Tool"], ["mcp", "MCP", false, (v) => (v ? "MCP" : "")], ["n", "Aufrufe", true], ["errorRate", "Fehlerquote", true, fmtPct], ["p50", "Median", true, fmtDur], ["p95", "langsamste 5 %", true, fmtDur]], s.tools, { onRow: (r) => show(r.tool) }), "tools", tableCsv([["tool", "Tool"], ["n", "Aufrufe"], ["errors", "Fehler"], ["errorRate", "Fehlerquote %"], ["p50", "Median ms"], ["p95", "p95 ms"]], s.tools)),
      detail,
    )
  },
  async tageszeiten(days) {
    const s = await get("stats/heatmap", { days })
    if (!s.available) return noMetrics()
    return chartCard("Nutzung nach Wochentag und Stunde", [heatmap(s.grid), h("p", { class: "muted", style: { fontSize: "12.5px" }, text: "Nutzernachrichten, geladene Einträge, Tool-Aufrufe und Smith-Läufe. Hilft bei der Wahl von tasks.prepareAt (Vorschläge vorab erstellen, solange der Rechner an ist)." })], "tageszeiten", () => [["Tag", ...Array.from({ length: 24 }, (_x, i) => `${i}h`)], ...s.grid.map((r, i) => [["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"][i], ...r])])
  },
  async aufgaben(days, project) {
    const s = await get("stats/tasks", { days, project })
    const cfd = Object.entries(s.cfd.series).map(([col, values], i) => ({ name: col, values, color: colorAt(i) }))
    return h(
      "div",
      { class: "stack" },
      h("div", { class: "stat-grid" }, h("div", { class: "card kpi" }, h("div", { class: "label", text: "Durchlaufzeit (neu → erledigt)" }), h("div", { class: "num", text: `${fmtNum(s.leadDays.p50, 1)} Tage` }), h("div", { class: "sub", text: `95 %: ${fmtNum(s.leadDays.p95, 1)} · ${s.leadDays.n} Aufgaben` })), h("div", { class: "card kpi" }, h("div", { class: "label", text: "Bearbeitungszeit (in Umsetzung → erledigt)" }), h("div", { class: "num", text: `${fmtNum(s.cycleDays.p50, 1)} Tage` }), h("div", { class: "sub", text: `95 %: ${fmtNum(s.cycleDays.p95, 1)} · ${s.cycleDays.n} Aufgaben` }))),
      chartCard("Durchsatz je Woche", barChart(s.throughput.map((x) => x.week), [{ name: "erledigt", values: s.throughput.map((x) => x.n) }]), "durchsatz", () => [["Woche", "erledigt"], ...s.throughput.map((x) => [x.week, x.n])]),
      chartCard("Kumulatives Flussdiagramm", [areaChart(s.cfd.days, [...cfd].reverse()), legendOf(cfd)], "cfd", seriesCsv(s.cfd.days, cfd)),
    )
  },
  async pipeline(days, project) {
    const s = await get("stats/pipeline", { days, project })
    const weeks = [...new Set(s.stages.flatMap((st) => st.weeks.map((w) => w.week)))].sort()
    const stageSeries = s.stages.map((st, i) => ({ name: st.name, values: weeks.map((w) => st.weeks.find((x) => x.week === w)?.p50 ?? null), color: colorAt(i) }))
    return h(
      "div",
      { class: "stack" },
      chartCard("Grün-Quote je Projekt", table([["project", "Projekt"], ["runs", "Läufe", true], ["green", "grün", true], ["rate", "Quote", true, fmtPct]], s.projects, { onRow: (r) => (location.hash = `#/projekt/${encodeURIComponent(r.project)}`) }), "gruenquote", tableCsv([["project", "Projekt"], ["runs", "Läufe"], ["green", "grün"], ["rate", "Quote %"]], s.projects)),
      weeks.length ? chartCard("Dauer je Stufe (Median je Woche)", lineChart(weeks, stageSeries, { fmt: (v) => fmtDur(v) }), "stufen", seriesCsv(weeks, stageSeries)) : null,
      card("Instabile Tests (rot, dann grün ohne Codeänderung)", table([["tests", "Tests", false, (v) => (v.length ? v.join(", ") : "(Stufe ohne Testbericht)")], ["project", "Projekt"], ["task", "Aufgabe", false, (v) => (v ? v.toUpperCase() : "")], ["red", "roter Lauf"], ["green", "grüner Lauf"]], s.flaky, { onRow: (r) => (location.hash = `#/pipeline/${encodeURIComponent(r.project)}/${encodeURIComponent(r.red)}`) })),
      card("Letzte Läufe", table([["at", "Zeit", false, (v) => fmtDate(v)], ["project", "Projekt"], ["task", "Aufgabe", false, (v) => (v ? v.toUpperCase() : "")], ["status", "Status"], ["ms", "Dauer", true, fmtDur], ["tests", "Tests", false, (v) => (v ? `${v.total} / rot ${v.failed}` : "")]], s.recent, { onRow: (r) => (location.hash = `#/pipeline/${encodeURIComponent(r.project)}/${encodeURIComponent(r.id)}`) })),
    )
  },
  async agenten(days) {
    const s = await get("stats/agents", { days })
    const labels = new Map()
    for (const a of s.agents) for (const [l, n] of Object.entries(a.labels)) labels.set(`${a.agent}|${l}`, n)
    const sub = new Map()
    for (const a of s.agents) for (const [name, n] of Object.entries(a.subagents)) sub.set(name, (sub.get(name) || 0) + n)
    return h(
      "div",
      { class: "stack" },
      chartCard(
        "Je Agent und Modell",
        table(
          [
            ["agent", "Agent"],
            ["model", "Modell"],
            ["jobs", "Aufträge", true],
            ["approvedFirst", "1. Vorschlag frei", true, (v, r) => (r.jobs ? `${Math.round((v / r.jobs) * 100)} %` : "–")],
            ["revisions", "Überarbeitungen", true],
            ["fixRounds", "Nachbesserungen", true, (v, r) => v + r.improveRounds],
            ["firstGreen", "Pipeline 1× grün", true, (v, r) => (r.withPipeline ? `${Math.round((v / r.withPipeline) * 100)} %` : "–")],
            ["findings", "Review-Befunde", true],
            ["avgMinutes", "Ø Minuten", true],
            ["tokens", "Tokens", true, (v) => fmtNum(v)],
            ["cost", "Kosten", true, fmtCost],
          ],
          s.agents,
        ),
        "agenten",
        tableCsv([["agent", "Agent"], ["model", "Modell"], ["jobs", "Aufträge"], ["approvedFirst", "frei beim 1."], ["revisions", "Überarbeitungen"], ["fixRounds", "Nachbesserungen"], ["firstGreen", "1× grün"], ["withPipeline", "mit Pipeline"], ["findings", "Befunde"], ["avgMinutes", "Minuten"], ["tokens", "Tokens"], ["cost", "Kosten"]], s.agents),
      ),
      h(
        "div",
        { class: "grid two" },
        card("Je Label", table([["key", "Agent · Label"], ["n", "Aufträge", true]], [...labels.entries()].map(([k, n]) => ({ key: k.replace("|", " · "), n })))),
        card("Subagenten des Orchestrators", hbars([...sub.entries()].map(([label, value]) => ({ label, value })), { alt: true })),
      ),
      card("Vorschläge", table([["agent", "Agent"], ["created", "erstellt", true], ["approved", "freigegeben", true], ["revise", "überarbeiten", true]], s.verdicts)),
    )
  },
}

export default async function stats(ctx) {
  ctx.title("Statistik")
  let area = ctx.query.get("bereich") || "ueberblick"
  let days = Number(ctx.query.get("tage")) || 30
  let project = ctx.query.get("projekt") || ""
  const projects = await get("projects").catch(() => [])
  if (!ctx.alive()) return
  const page = h("div", { class: "page" })
  const body = h("div")
  const tabsEl = h("div")
  const head = h(
    "div",
    { class: "page-head" },
    h("div", { class: "grow" }, h("h1", { text: "Statistik" }), h("div", { class: "muted", text: "Alles lokal (state/metrics.sqlite) – nur Ids, Zahlen und Zeiten, keine Inhalte." })),
    h(
      "div",
      { class: "toolbar" },
      h("div", { class: "seg" }, [7, 30, 90, 365].map((d) => h("button", { type: "button", class: d === days ? "on" : "", text: `${d} Tage`, onclick: (e) => {
        days = d
        for (const b of e.currentTarget.parentElement.children) b.classList.toggle("on", b === e.currentTarget)
        ctx.setQuery({ tage: d === 30 ? undefined : d })
        draw()
      } }))),
      h("select", { class: "input sm", onchange: (e) => ((project = e.target.value), ctx.setQuery({ projekt: project }), draw()) }, h("option", { value: "", text: "alle Projekte" }), projects.map((p) => h("option", { value: p.name, text: p.title, selected: project === p.name }))),
    ),
  )
  put(page, head, tabsEl, body)
  ctx.el.replaceChildren(page)
  const drawTabs = () =>
    swap(
      tabsEl,
      tabBar(AREAS, area, (a) => {
        area = a
        ctx.setQuery({ bereich: a === "ueberblick" ? undefined : a })
        drawTabs()
        draw()
      }),
    )
  const draw = () => fill(body, () => AREA[area](days, project || undefined))
  drawTabs()
  draw()
}

export { csvButton }
