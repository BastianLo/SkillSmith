// Jobs (5a): every recurring run with schedule, state, history and the log lines of each run.
import { get } from "../api.js"
import { debounce, fmtDate, fmtDur, fmtRel, h, icon, put, swap } from "../dom.js"
import { act, app, confirmDialog, modal } from "../ui.js"

const STATUS = { running: ["läuft", "accent"], ok: ["ok", "ok"], warn: ["mit Hinweis", "warn"], skipped: ["übersprungen", ""], error: ["Fehler", "danger"], aborted: ["abgebrochen", "warn"] }
const WEEKDAYS = [["1", "Mo"], ["2", "Di"], ["3", "Mi"], ["4", "Do"], ["5", "Fr"], ["6", "Sa"], ["7", "So"]]

const statusChip = (s) => {
  const [label, cls] = STATUS[s] || [s, ""]
  return h("span", { class: `chip ${cls}`, text: label })
}

export default async function jobs(ctx) {
  ctx.title("Jobs")
  const page = h("div", { class: "page" })
  const list = h("div")
  const open = new Set((ctx.query.get("job") || "").split(",").filter(Boolean))
  put(
    page,
    h(
      "div",
      { class: "page-head" },
      h("div", { class: "grow" }, h("h1", { text: "Jobs" }), h("div", { class: "muted", text: "Alles Wiederkehrende an einem Ort: Zeitplan, manueller Start, Pause, Verlauf mit Ergebnis, Commit und Log. Verpasste Läufe (Rechner aus) werden je Job einmal nachgeholt oder verworfen." })),
    ),
    list,
  )
  ctx.el.replaceChildren(page)

  let data
  const load = async () => {
    data = await get("scheduled")
    if (!ctx.alive()) return
    draw()
  }

  const runsBox = async (j, box) => {
    const runs = await get("scheduled/history", { id: j.id })
    if (!ctx.alive()) return
    swap(
      box,
      runs.length
        ? h(
            "table",
            { class: "facts", style: { width: "100%" } },
            h(
              "tbody",
              null,
              runs.map((r) =>
                h(
                  "tr",
                  null,
                  h("td", { class: "nowrap" }, statusChip(r.status)),
                  h("td", { class: "nowrap", text: fmtDate(r.startedAt), title: r.trigger }),
                  h("td", { class: "nowrap faint", text: r.endedAt ? fmtDur(Date.parse(r.endedAt) - Date.parse(r.startedAt)) : "…" }),
                  h("td", { class: "faint", text: r.trigger }),
                  h(
                    "td",
                    null,
                    h("div", { text: r.error || r.summary || r.progress || "" }),
                    r.commits?.length ? h("div", { class: "chips" }, r.commits.map((c) => h("a", { class: "chip mono", href: `#/commit/${c}`, text: c.slice(0, 8) }))) : null,
                    r.tokens ? h("span", { class: "faint", text: ` · ${r.tokens} Tokens` }) : null,
                  ),
                  h("td", { class: "nowrap" }, h("a", { class: "btn sm ghost", href: `#/logs?cid=${encodeURIComponent(r.id)}&stufe=debug` }, icon("list", 12), "Log")),
                ),
              ),
            ),
          )
        : h("p", { class: "faint", text: "Noch keine Läufe." }),
    )
  }

  const row = (j) => {
    const runs = h("div", { class: "job-runs" })
    const last = j.last
    const running = j.running
    const acts = []
    if (!app.readOnly) {
      if (running) acts.push(h("button", { class: "btn sm danger", type: "button", onclick: () => act("job.abort", { id: j.id }).then(load) }, icon("stop", 12), "Abbrechen"))
      else
        acts.push(
          h("button", {
            class: "btn sm primary",
            type: "button",
            disabled: !!j.unavailable,
            title: j.unavailable || "jetzt ausführen",
            onclick: async () => {
              let params = {}
              if (j.params.length) {
                params = await paramsDialog(j)
                if (!params) return
              }
              await act("job.run", { id: j.id, params })
              setTimeout(load, 600)
            },
          }, icon("play", 12), "Jetzt"),
        )
      acts.push(h("button", { class: "btn sm", type: "button", onclick: () => act("job.pause", { id: j.id, paused: !j.paused }).then(load) }, icon(j.paused ? "play" : "pause", 12), j.paused ? "Fortsetzen" : "Pausieren"))
      acts.push(h("button", { class: "btn sm", type: "button", onclick: () => scheduleDialog(j).then((ok) => ok && load()) }, icon("calendar", 12), "Zeitplan"))
      if (j.id === "lifecycle" || j.id === "consolidate")
        acts.push(
          h("button", {
            class: "btn sm ghost",
            type: "button",
            title: "Was der Curator jetzt tun würde",
            onclick: async () => {
              const r = await act("curator.run", { dry: true }, { quiet: true })
              if (r?.data) modal((close) => ({ title: "Vorschau des Curators", wide: true, body: h("pre", { class: "mono", style: { whiteSpace: "pre-wrap" }, text: String(r.data.report) }), foot: [h("button", { class: "btn", type: "button", text: "Schließen", onclick: () => close() })] }))
            },
          }, icon("eye", 12), "Vorschau"),
        )
    }
    const toggle = h("button", { class: "btn sm ghost", type: "button" }, icon("history", 12), "Verlauf")
    const wrap = h(
      "div",
      { class: "card", style: { padding: 0 }, id: `job-${j.id}` },
      h(
        "div",
        { class: "job-row" },
        h(
          "div",
          null,
          h("div", { class: "j-title" }, j.label, j.paused ? h("span", { class: "chip warn", text: "pausiert" }) : null, !j.schedule.enabled ? h("span", { class: "chip", text: "aus" }) : null, j.unavailable ? h("span", { class: "chip", title: j.unavailable, text: "nicht verfügbar" }) : null, Object.keys(j.configured || {}).length ? h("span", { class: "chip accent", title: "Zeitplan in den Einstellungen angepasst", text: "angepasst" }) : null),
          h("div", { class: "j-desc", text: j.description }),
        ),
        h("div", { class: "j-meta" }, h("div", null, icon("calendar", 12), " ", j.text), j.next ? h("div", { class: "faint", text: `nächster Lauf ${fmtRel(j.next)} (${fmtDate(j.next)})` }) : null, j.schedule.catchUp === "skip" ? h("div", { class: "faint", text: "verpasste Läufe verwerfen" }) : h("div", { class: "faint", text: "verpasste Läufe einmal nachholen" })),
        h(
          "div",
          { class: "j-meta" },
          running ? h("div", null, statusChip("running"), " ", running.progress || `seit ${fmtRel(running.startedAt)}`) : last ? h("div", null, statusChip(last.status), " ", fmtRel(last.endedAt || last.startedAt)) : h("div", { class: "faint", text: "noch nie gelaufen" }),
          last && !running ? h("div", { class: "faint", text: (last.error || last.summary || "").slice(0, 160) }) : null,
          j.failures > 1 ? h("div", { class: "chip danger", text: `${j.failures} Fehler in den letzten 5 Läufen` }) : null,
        ),
        h("div", { class: "acts" }, acts, toggle),
      ),
      runs,
    )
    const show = () => runsBox(j, runs)
    toggle.addEventListener("click", () => {
      if (open.has(j.id)) {
        open.delete(j.id)
        swap(runs)
      } else {
        open.add(j.id)
        show()
      }
      ctx.setQuery({ job: [...open].join(",") || undefined })
    })
    if (open.has(j.id)) show()
    return wrap
  }

  const draw = () => {
    if (!data.available) return swap(list, h("div", { class: "notice warn", text: "In diesem opencode-Prozess laufen keine Jobs (Agenten-Worktree). Öffnen Sie die Weboberfläche des Hauptprozesses." }))
    swap(list, data.jobs.map(row))
    const first = [...open][0]
    if (first) document.getElementById(`job-${first}`)?.scrollIntoView({ block: "nearest" })
  }

  await load()
  const later = debounce(() => ctx.alive() && load(), 800)
  ctx.on("job.changed", later)
  ctx.on("settings.changed", later)
}

async function paramsDialog(j) {
  const values = {}
  return modal((close) => ({
    title: `${j.label} – Parameter`,
    body: j.params.map((p) => {
      const cur = new Set((j.schedule.params?.[p.name] || "").split(",").filter(Boolean))
      if (p.values) {
        return h(
          "div",
          { class: "field" },
          h("label", { text: p.label }),
          h(
            "div",
            { class: "chips" },
            p.values.map((v) => {
              const cb = h("input", { type: "checkbox", checked: cur.has(v) })
              cb.addEventListener("change", () => {
                if (cb.checked) cur.add(v)
                else cur.delete(v)
                values[p.name] = [...cur].join(",")
              })
              return h("label", { class: "chip outline" }, cb, v)
            }),
          ),
          h("div", { class: "hint", text: "keine Auswahl = alle" }),
        )
      }
      const inp = h("input", { class: "input", value: j.schedule.params?.[p.name] || "" })
      inp.addEventListener("input", () => (values[p.name] = inp.value))
      return h("div", { class: "field" }, h("label", { text: p.label }), inp)
    }),
    foot: [h("button", { class: "btn", type: "button", text: "Abbrechen", onclick: () => close(null) }), h("button", { class: "btn primary", type: "button", text: "Ausführen", onclick: () => close(values) })],
  }))
}

/** Edit the schedule: start, after review, daily times + weekdays, interval, idle, cron, catch-up. */
async function scheduleDialog(j) {
  const s = { ...j.schedule }
  const cb = (key, label) => {
    const el = h("input", { type: "checkbox", checked: !!s[key] })
    el.addEventListener("change", () => (s[key] = el.checked))
    return h("label", { class: "row-flex" }, el, label)
  }
  const daily = h("input", { class: "input", value: (s.daily || []).join(", "), placeholder: "08:30, 13:00" })
  const interval = h("input", { class: "input", type: "number", min: 0, value: s.intervalMin || 0 })
  const idle = h("input", { class: "input", type: "number", min: 0, value: s.idleMin || 0 })
  const cron = h("input", { class: "input mono", value: s.cron || "", placeholder: "0 */2 * * 1-5" })
  const wd = new Set(s.weekdays || [])
  const days = h(
    "div",
    { class: "chips" },
    WEEKDAYS.map(([v, l]) => {
      const el = h("input", { type: "checkbox", checked: wd.has(v) })
      el.addEventListener("change", () => (el.checked ? wd.add(v) : wd.delete(v)))
      return h("label", { class: "chip outline" }, el, l)
    }),
  )
  const catchUp = h("select", { class: "input" }, [["once", "einmal nachholen"], ["skip", "verwerfen"]].map(([v, l]) => h("option", { value: v, text: l, selected: s.catchUp === v })))
  const result = await modal((close) => ({
    title: `Zeitplan: ${j.label}`,
    body: [
      h("p", { class: "muted", style: { fontSize: "13px" }, text: j.description }),
      cb("enabled", "Job ist an"),
      h("div", { class: "fields", style: { marginTop: "10px" } }, cb("start", "beim Start von opencode"), cb("afterReview", "nach jedem Review")),
      h("div", { class: "field", style: { marginTop: "10px" } }, h("label", { text: "Täglich um (Uhrzeiten, kommagetrennt)" }), daily),
      h("div", { class: "field" }, h("label", { text: "nur an Wochentagen (keine Auswahl = jeden Tag)" }), days),
      h("div", { class: "fields" }, h("div", { class: "field" }, h("label", { text: "alle … Minuten (0 = aus)" }), interval, h("div", { class: "hint", text: "1440 = täglich, 10080 = wöchentlich" })), h("div", { class: "field" }, h("label", { text: "bei … Minuten Leerlauf (0 = aus)" }), idle)),
      h("div", { class: "field" }, h("label", { text: "Cron-Ausdruck (optional, lokale Zeit)" }), cron, h("div", { class: "hint", text: "Minute Stunde Tag Monat Wochentag, z. B. „0 */2 * * 1-5“ = werktags alle 2 Stunden" })),
      h("div", { class: "field" }, h("label", { text: "Verpasste Läufe (Rechner war aus)" }), catchUp),
    ],
    foot: [
      h("button", { class: "btn ghost", type: "button", text: "Auf Standard zurücksetzen", onclick: () => close("reset") }),
      h("span", { class: "grow" }),
      h("button", { class: "btn", type: "button", text: "Abbrechen", onclick: () => close(null) }),
      h("button", { class: "btn primary", type: "button", text: "Speichern", onclick: () => close("save") }),
    ],
  }))
  if (!result) return false
  if (result === "reset") {
    if (!(await confirmDialog(`Zeitplan von „${j.label}“ auf den Standard zurücksetzen?`))) return false
    return !!(await act("job.schedule", { id: j.id, reset: true }))
  }
  const schedule = {
    enabled: !!s.enabled,
    start: !!s.start,
    afterReview: !!s.afterReview,
    daily: daily.value.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean),
    weekdays: [...wd].sort(),
    intervalMin: Number(interval.value) || 0,
    idleMin: Number(idle.value) || 0,
    cron: cron.value.trim(),
    catchUp: catchUp.value,
  }
  // only what differs from the job's default goes to the settings
  const diff = Object.fromEntries(Object.entries(schedule).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(j.defaults[k] ?? (Array.isArray(v) ? [] : k === "cron" ? "" : v === false ? false : 0))))
  return !!(await act("job.schedule", { id: j.id, schedule: diff, ...(Object.keys(diff).length ? {} : { reset: true }) }))
}
