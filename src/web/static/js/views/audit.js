import { get, saveBlob } from "../api.js"
import { ACTOR_LABEL, fmtDate, h, put, swap } from "../dom.js"
import { auditTable } from "../parts.js"
import { card, fill } from "../ui.js"

const CATEGORIES = ["change", "staged", "proposed", "rejected", "local", "run", "undo", "restore", "conflict", "external", "security", "task", "pipeline", "agent"]
const CAT_LABEL = { change: "Änderung", staged: "vorgemerkt", proposed: "Vorschlag", rejected: "abgelehnt", local: "lokal", run: "Lauf", undo: "Rückgängig", restore: "Wiederherstellung", conflict: "Konflikt", external: "von Hand", security: "Sicherheit", task: "Aufgabe", pipeline: "Pipeline", agent: "Agent" }
const ACTORS = ["user-web", "user-command", "reviewer", "curator", "doctor", "agent", "system", "pipeline"]
const RESULTS = [["ok", "ok"], ["rejected", "abgelehnt"], ["staged", "vorgemerkt"], ["proposed", "Vorschlag"], ["error", "Fehler"]]

export default async function audit(ctx) {
  ctx.title("Audit-Log")
  const q = ctx.query
  const f = { from: q.get("from") || "", to: q.get("to") || "", actor: q.get("actor") || "", smith: q.get("smith") || "", category: q.get("category") || "", result: q.get("result") || "", text: q.get("text") || "", target: q.get("target") || "", run: q.get("run") || "", session: q.get("session") || "", project: q.get("project") || "" }
  let grouped = q.get("gruppiert") === "1"
  const page = h("div", { class: "page" })
  const listEl = h("div")
  const chainEl = h("span")
  const rejectedEl = h("div")
  let events = []
  let more = false
  const sel = (key, options, label) => h("select", { class: "input sm", onchange: (e) => set(key, e.target.value) }, h("option", { value: "", text: label }), options.map(([v, l]) => h("option", { value: v, text: l, selected: f[key] === v })))
  const set = (key, v) => {
    f[key] = v
    ctx.setQuery({ [key]: v })
    load()
  }
  const text = h("input", { class: "input sm", type: "search", placeholder: "Grund, Meldung …", value: f.text, style: { width: "180px" } })
  text.addEventListener("change", () => set("text", text.value.trim()))
  const date = (key) => h("input", { class: "input sm", type: "date", value: f[key] ? f[key].slice(0, 10) : "", onchange: (e) => set(key, e.target.value ? (key === "to" ? `${e.target.value}T23:59:59` : `${e.target.value}T00:00:00`) : "") })
  put(
    page,
    h("div", { class: "page-head" }, h("div", { class: "grow" }, h("h1", { text: "Audit-Log" }), h("div", { class: "muted" }, "Jedes Ereignis, das etwas geändert hat oder ändern wollte – von Ihnen, den Agenten, dem Curator, dem Doktor und dem System. ", chainEl))),
    h(
      "div",
      { class: "toolbar" },
      date("from"),
      h("span", { class: "faint", text: "bis" }),
      date("to"),
      sel("actor", ACTORS.map((a) => [a, ACTOR_LABEL[a] || a]), "alle Akteure"),
      sel("smith", ["skillsmith", "docsmith", "errorsmith", "toolsmith", "memorysmith", "doctor"].map((x) => [x, x]), "alle Smiths"),
      sel("category", CATEGORIES.map((c) => [c, CAT_LABEL[c]]), "alle Arten"),
      sel("result", RESULTS, "jedes Ergebnis"),
      text,
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: grouped, onchange: (e) => ((grouped = e.target.checked), ctx.setQuery({ gruppiert: grouped ? "1" : undefined }), draw()) }), "nach Lauf gruppieren"),
      h("span", { class: "grow" }),
      h("button", { class: "btn sm", type: "button", text: "CSV", onclick: () => exportAs("csv") }),
      h("button", { class: "btn sm", type: "button", text: "JSONL", onclick: () => exportAs("jsonl") }),
    ),
    [f.target, f.run, f.session, f.project].some(Boolean)
      ? h(
          "div",
          { class: "chips", style: { marginBottom: "10px" } },
          [
            ["target", "Eintrag"],
            ["run", "Lauf"],
            ["session", "Session"],
            ["project", "Projekt"],
          ]
            .filter(([k]) => f[k])
            .map(([k, l]) => h("span", { class: "chip accent" }, `${l}: ${f[k]}`, h("span", { class: "x", text: "×", onclick: () => set(k, "") }))),
        )
      : null,
    listEl,
    h("h2", { text: "Abgelehnte Agent-Aktionen nach Grund (30 Tage)" }),
    h("p", { class: "muted", text: "Zeigt, wo Gates greifen und wo Prompts nachgeschärft werden sollten." }),
    rejectedEl,
  )
  ctx.el.replaceChildren(page)

  const draw = () => {
    if (!events.length) return swap(listEl, h("div", { class: "card empty", text: "Keine Ereignisse für diese Filter." }))
    let body
    if (grouped) {
      const runs = new Map()
      for (const e of events) {
        const k = e.run || `seq-${e.seq}`
        ;(runs.get(k) ?? runs.set(k, []).get(k)).push(e)
      }
      body = h(
        "div",
        null,
        [...runs.entries()].map(([k, list]) => {
          const first = list[list.length - 1]
          const bad = list.some((e) => e.result === "rejected" || e.result === "error")
          return h("details", { class: "audit-run" }, h("summary", null, h("strong", { text: first.smith || ACTOR_LABEL[first.actor] || first.actor }), h("span", { class: "faint", text: fmtDate(first.at) }), h("span", { text: `${list.length} Ereignis${list.length === 1 ? "" : "se"}` }), bad ? h("span", { class: "chip danger", text: "mit Ablehnungen" }) : null, list.find((e) => e.commit) ? h("a", { class: "mono", href: `#/commit/${list.find((e) => e.commit).commit}`, text: list.find((e) => e.commit).commit.slice(0, 8) }) : null, k.startsWith("seq-") ? null : h("span", { class: "faint mono", text: k })), h("div", { style: { padding: "0 10px 10px" } }, auditTable(list)))
        }),
      )
    } else body = auditTable(events)
    swap(listEl, body, more ? h("div", { class: "toolbar" }, h("button", { class: "btn", type: "button", text: "Ältere laden", onclick: () => load(true) })) : null)
  }

  async function load(append = false) {
    const before = append && events.length ? events[events.length - 1].seq : undefined
    const r = await get("audit", { ...f, before, limit: 300 })
    if (!ctx.alive()) return
    if (r.unavailable) return swap(listEl, h("div", { class: "notice", text: "Audit-Log nicht verfügbar (SQLite fehlt)." }))
    events = append ? [...events, ...r.events] : r.events
    more = r.more
    draw()
  }

  function exportAs(kind) {
    const stamp = new Date().toISOString().slice(0, 10)
    if (kind === "jsonl") return saveBlob(new Blob([events.map((e) => JSON.stringify(e)).join("\n")], { type: "application/x-ndjson" }), `audit-${stamp}.jsonl`)
    const cols = ["seq", "at", "actor", "smith", "category", "action", "result", "targets", "reason", "message", "run", "commit", "session", "project"]
    const esc = (v) => {
      const s = Array.isArray(v) ? v.join(" ") : String(v ?? "")
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    saveBlob(new Blob([`﻿${[cols.join(";"), ...events.map((e) => cols.map((c) => esc(e[c])).join(";"))].join("\n")}`], { type: "text/csv" }), `audit-${stamp}.csv`)
  }

  get("audit/verify")
    .then((v) => {
      if (!ctx.alive()) return
      swap(chainEl, v.unavailable ? null : v.ok ? h("span", { class: "chip ok", title: "Hash-Kette geprüft", text: `Kette intakt · ${v.count} Ereignisse` }) : h("span", { class: "chip danger", title: v.reason || "", text: `Kette gebrochen bei Ereignis ${v.firstBad}` }))
    })
    .catch(() => {})
  fill(rejectedEl, async () => {
    const list = await get("audit/rejected", { days: 30 })
    return list.length
      ? h(
          "div",
          { class: "table-wrap" },
          h("table", { class: "table" }, h("thead", null, h("tr", null, h("th", { text: "Grund" }), h("th", { class: "num", text: "Anzahl" }), h("th", { text: "Smiths" }), h("th", { text: "zuletzt" }), h("th", { text: "Beispiel" }))), h("tbody", null, list.map((r) => h("tr", { class: "clickable", onclick: () => set("text", r.reason) }, h("td", { text: r.reason }), h("td", { class: "num", text: r.count }), h("td", { text: r.smiths.join(", ") }), h("td", { class: "nowrap", text: fmtDate(r.last) }), h("td", { class: "faint", text: r.example.slice(0, 200) }))))),
        )
      : card(null, h("div", { class: "faint", text: "Keine abgelehnten Aktionen im Zeitraum." }))
  })
  await load()
}
