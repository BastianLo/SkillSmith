import { get, post } from "../api.js"
import { colLabel, field, h, icon, put, swap } from "../dom.js"
import { act, app, modal, toast } from "../ui.js"

const DEFAULT_COLUMNS = ["neu", "planung", "umsetzung", "test", "verifikation", "erledigt"]
const STEPS = [["plan", "Planung"], ["implement", "Umsetzung"], ["test", "Test"], ["verify", "Verifikation"]]
const CHECKS = [["pipeline", "Pipeline grün"], ["tests", "Testfälle"], ["criteria", "Kriterien"], ["review", "Review"], ["pr-check", "Vor-PR-Prüfung"]]

/** Workflow per column: shows the effective flow, saves only what differs from the defaults. */
function flowEditor(flows, defaults, agents) {
  const cols = Object.keys(flows || {})
  const rows = cols.map((col) => {
    const f = flows[col]
    const step = h("select", { class: "input sm", "aria-label": `Schritt ${col}` }, h("option", { value: "keiner", text: "– manuell –", selected: !f.step }), STEPS.map(([v, l]) => h("option", { value: v, text: l, selected: f.step === v })))
    const agent = h("select", { class: "input sm", "aria-label": `Agent ${col}` }, h("option", { value: "", text: "Agent der Aufgabe" }), agents.map((a) => h("option", { value: a.name, text: a.name, selected: f.agent === a.name })), f.agent && !agents.some((a) => a.name === f.agent) ? h("option", { value: f.agent, text: f.agent, selected: true }) : null)
    const checks = CHECKS.map(([v, l]) => h("label", { class: "check", style: { fontSize: "12.5px" } }, h("input", { type: "checkbox", value: v, checked: f.checks.includes(v) }), l))
    const gate = h("input", { type: "checkbox", checked: f.gate })
    const back = h("select", { class: "input sm", "aria-label": `Bei Fehler ${col}` }, h("option", { value: "", text: "–" }), cols.map((c) => h("option", { value: c, text: colLabel(c), selected: f.onFailure === c })))
    const next = h("select", { class: "input sm", "aria-label": `Danach ${col}` }, h("option", { value: "", text: "–" }), cols.map((c) => h("option", { value: c, text: colLabel(c), selected: f.onSuccess === c })))
    const sync = () => {
      const on = step.value !== "keiner"
      for (const el of [agent, back, next, gate, ...checks.map((c) => c.querySelector("input"))]) el.disabled = !on || app.readOnly
    }
    step.addEventListener("change", sync)
    sync()
    const value = () => ({ step: step.value === "keiner" ? undefined : step.value, agent: agent.value || undefined, checks: checks.map((c) => c.querySelector("input")).filter((i) => i.checked).map((i) => i.value), gate: gate.checked, onFailure: back.value || undefined, onSuccess: next.value || undefined })
    return {
      col,
      value,
      el: h("tr", null, h("td", { class: "nowrap", text: colLabel(col) }), h("td", null, step), h("td", null, agent), h("td", null, h("div", { class: "chips" }, checks)), h("td", { class: "nowrap" }, h("label", { class: "check" }, gate, "Tor")), h("td", null, next), h("td", null, back)),
    }
  })
  const el = h(
    "div",
    { class: "table-wrap" },
    h("table", { class: "table flow-table" }, h("thead", null, h("tr", null, ["Spalte", "Schritt", "Agent", "Prüfungen", "Freigabe", "Danach", "Bei Fehler"].map((x) => h("th", { text: x })))), h("tbody", null, rows.map((r) => r.el))),
  )
  /** Only the differences to the defaults (options/settings page) go into the project. */
  const value = () => {
    const out = {}
    for (const r of rows) {
      const v = r.value()
      const d = defaults[r.col] || { checks: [], gate: false }
      const diff = {}
      if ((v.step || undefined) !== (d.step || undefined)) diff.step = v.step || "keiner"
      if (v.step) {
        if ((v.agent || "") !== (d.agent || "")) diff.agent = v.agent || ""
        if ([...v.checks].sort().join() !== [...(d.checks || [])].sort().join()) diff.checks = v.checks
        if (v.gate !== !!d.gate) diff.gate = v.gate
        if ((v.onSuccess || "") !== (d.onSuccess || "")) diff.onSuccess = v.onSuccess || ""
        if ((v.onFailure || "") !== (d.onFailure || "")) diff.onFailure = v.onFailure || ""
      }
      for (const k of Object.keys(diff)) if (diff[k] === "") delete diff[k]
      if (Object.keys(diff).length) out[r.col] = diff
    }
    return out
  }
  return { el, value }
}

export default async function projectEdit(ctx) {
  const name = ctx.params.name
  const isNew = !name
  ctx.title(isNew ? "Neues Projekt" : "Projekt bearbeiten")
  const [pd, agents] = await Promise.all([isNew ? Promise.resolve(null) : get("project", { name }), get("agents").catch(() => [])])
  const p = pd?.project ?? null
  if (!ctx.alive()) return
  if (!isNew && !p) {
    ctx.el.replaceChildren(h("div", { class: "page narrow" }, h("div", { class: "notice error", text: "Projekt nicht gefunden." })))
    return
  }
  const page = h("div", { class: "page narrow" })
  const title = h("input", { class: "input wide", value: p?.title || "", placeholder: "z. B. Kundenportal" })
  const nameIn = h("input", { class: "input wide mono", value: p?.name || "", placeholder: "kurzname (wird aus dem Titel gebildet)", disabled: !isNew })
  const desc = h("input", { class: "input wide", value: p?.description || "" })
  const home = h("input", { class: "input wide mono", value: p?.homePath || "", placeholder: "~/dev/kundenportal" })
  const agent = h("select", { class: "input" }, h("option", { value: "", text: "– Vorgabe –" }), agents.map((a) => h("option", { value: a.name, text: a.name, selected: p?.agent === a.name })))
  const model = h("input", { class: "input wide", value: p?.model || "", placeholder: "Modell für Agenten-Aufträge (optional)" })
  const color = h("input", { class: "input", type: "color", value: p?.color || "#47566b" })
  const columns = h("input", { class: "input wide mono", value: (p?.columns || DEFAULT_COLUMNS).join(", ") })
  const wip = h("input", { class: "input wide mono", value: Object.entries(p?.wip || {}).map(([k, v]) => `${k}=${v}`).join(", "), placeholder: "umsetzung=3, test=5" })
  const flow = pd?.flows ? flowEditor(pd.flows, pd.flowDefaults || {}, agents) : null
  const pl = p?.pipeline
  const pipelineOn = h("input", { type: "checkbox", checked: !!pl })
  const source = h("select", { class: "input" }, h("option", { value: "arbeitsverzeichnis", text: "Arbeitsverzeichnis (mit nicht committeten Änderungen)", selected: pl?.source !== "branch" }), h("option", { value: "branch", text: "Branch der Aufgabe (sauberer Checkout im Worktree)", selected: pl?.source === "branch" }))
  const triggerBox = h("div", { class: "chips" })
  const drawTriggers = () => {
    const cols = columns.value.split(",").map((c) => c.trim()).filter(Boolean)
    const current = new Set([...triggerBox.querySelectorAll("input:checked")].map((i) => i.value))
    const initial = !triggerBox.children.length ? new Set(pl?.trigger || ["test"]) : current
    swap(triggerBox, cols.map((c) => h("label", { class: "check" }, h("input", { type: "checkbox", value: c, checked: initial.has(c) }), colLabel(c))))
  }
  columns.addEventListener("change", drawTriggers)
  drawTriggers()
  const stages = h("div", { class: "stack" })
  const addStage = (s = {}) => {
    const row = h(
      "div",
      { class: "card flat tight" },
      h(
        "div",
        { class: "row-flex", style: { alignItems: "flex-start" } },
        h("input", { class: "input", style: { width: "130px" }, placeholder: "Name", value: s.name || "", "data-k": "name" }),
        h("textarea", { class: "input mono grow", rows: 1, placeholder: "Befehl, z. B. mvn -B verify", "data-k": "run", value: s.run || "", style: { minHeight: "34px" } }),
        h("button", { class: "btn sm ghost", type: "button", title: "nach oben", text: "↑", onclick: () => row.previousElementSibling && stages.insertBefore(row, row.previousElementSibling) }),
        h("button", { class: "btn sm ghost", type: "button", title: "entfernen", onclick: () => row.remove() }, icon("x", 12)),
      ),
      h(
        "div",
        { class: "row-flex", style: { marginTop: "6px" } },
        h("input", { class: "input sm", style: { width: "110px" }, placeholder: "Zeitlimit 20m", "data-k": "timeout", value: s.timeoutMin ? `${s.timeoutMin}m` : s.timeout || "" }),
        h("input", { class: "input sm mono grow", placeholder: "JUnit-Berichte, z. B. target/surefire-reports/*.xml", "data-k": "reports", value: s.reports || "" }),
        h("label", { class: "check" }, h("input", { type: "checkbox", "data-k": "allowFailure", checked: !!s.allowFailure }), "darf scheitern"),
      ),
    )
    stages.append(row)
  }
  for (const s of pl?.stages || []) addStage(s)
  if (!pl?.stages?.length) addStage({ name: "build", run: "" })
  const presets = h(
    "div",
    { class: "row-flex" },
    h("span", { class: "faint", text: "Vorlagen:" }),
    [
      ["Maven", [{ name: "build", run: "mvn -B -q -DskipTests package" }, { name: "verify", run: "mvn -B verify", timeoutMin: 20, reports: "target/surefire-reports/*.xml" }]],
      ["Gradle", [{ name: "build", run: "./gradlew assemble" }, { name: "test", run: "./gradlew test", reports: "build/test-results/test/*.xml" }]],
      ["npm", [{ name: "install", run: "npm ci" }, { name: "test", run: "npm test" }, { name: "lint", run: "npm run lint", allowFailure: true }]],
    ].map(([label, list]) =>
      h("button", {
        class: "btn sm",
        type: "button",
        text: label,
        onclick: () => {
          stages.replaceChildren()
          for (const s of list) addStage(s)
          pipelineOn.checked = true
        },
      }),
    ),
  )
  const pipelineDef = () => {
    if (!pipelineOn.checked) return undefined
    const list = [...stages.children]
      .map((row) => {
        const get = (k) => row.querySelector(`[data-k="${k}"]`)
        return { name: get("name").value.trim(), run: get("run").value.trim(), ...(get("timeout").value.trim() ? { timeout: get("timeout").value.trim() } : {}), ...(get("reports").value.trim() ? { reports: get("reports").value.trim() } : {}), ...(get("allowFailure").checked ? { allowFailure: true } : {}) }
      })
      .filter((s) => s.run)
    return { trigger: [...triggerBox.querySelectorAll("input:checked")].map((i) => i.value), source: source.value, stages: list }
  }
  put(
    page,
    h("h1", { text: isNew ? "Neues Projekt" : `${p.title} bearbeiten` }),
    h(
      "div",
      { class: "card" },
      field("Titel", title),
      isNew ? field("Kurzname", nameIn, "Kleinbuchstaben und Bindestriche; Aufgaben-IDs laufen über alle Projekte fort.") : null,
      field("Beschreibung", desc),
      field("Verzeichnis (home_path)", home, "Sessions in diesem Verzeichnis gehören zum Projekt; Agenten-Aufträge arbeiten in einem Worktree davon."),
      h("div", { class: "fields" }, field("Standard-Agent", agent), field("Farbe", color)),
      field("Standard-Modell", model),
      h("h3", { text: "Board" }),
      field("Spalten", columns, "Ids durch Komma; die letzte Spalte gilt als erledigt."),
      field("WIP-Limits", wip),
      h("h3", { text: "Workflow" }),
      h("p", { class: "muted", style: { fontSize: "13px" }, text: "Je Spalte ein Schritt mit Agent. Eine Karte läuft von der Planung über Umsetzung und Test zur Verifikation; ein roter Test oder ein nicht erfülltes Kriterium schickt sie zurück („Bei Fehler“). „Tor“ heißt: Ihre Freigabe, bevor die Karte weiterwandert – vor „erledigt“ immer. Gespeichert wird nur, was vom Standard (Einstellungen → Aufgaben) abweicht." }),
      flow ? flow.el : h("div", { class: "faint", text: "Nach dem Anlegen einstellbar." }),
      h("h3", null, h("label", { class: "check" }, pipelineOn, "Pipeline")),
      h("p", { class: "muted", style: { fontSize: "13px" }, text: "Die Stufen laufen der Reihe nach in Ihrer Login-Shell; nach der ersten roten wird abgebrochen. Ändern der Befehle braucht immer den Zugangsschlüssel und zeigt vorher die Änderung." }),
      field("Auslöser (Spalten)", triggerBox),
      field("Quelle", source),
      presets,
      h("div", { style: { height: "8px" } }),
      stages,
      h("button", { class: "btn sm", type: "button", style: { marginTop: "8px" }, onclick: () => addStage() }, icon("plus", 12), "Stufe"),
      h(
        "div",
        { class: "toolbar", style: { marginTop: "16px" } },
        h("button", { class: "btn primary", type: "button", disabled: app.readOnly, onclick: save }, icon("check", 14), "Speichern"),
        h("a", { class: "btn", href: isNew ? "#/projekte" : `#/projekt/${encodeURIComponent(name)}`, text: "Abbrechen" }),
      ),
    ),
  )
  ctx.el.replaceChildren(page)
  title.focus()

  // columns changed in the form: drop what refers to removed columns
  function flowFor(v, cols) {
    for (const [col, f] of Object.entries(v)) {
      if (!cols.includes(col)) delete v[col]
      else for (const k of ["onSuccess", "onFailure"]) if (f[k] && !cols.includes(f[k])) delete f[k]
    }
    return v
  }

  async function save() {
    if (!title.value.trim()) return title.focus()
    const wipObj = {}
    for (const part of wip.value.split(",")) {
      const m = /^\s*([a-z0-9_]+)\s*=\s*(\d+)\s*$/.exec(part)
      if (m) wipObj[m[1]] = Number(m[2])
    }
    const args = {
      name: isNew ? nameIn.value.trim() || undefined : name,
      title: title.value.trim(),
      description: desc.value.trim() || undefined,
      home_path: home.value.trim() || undefined,
      agent: agent.value || undefined,
      model: model.value.trim() || undefined,
      color: color.value,
      columns: columns.value.split(",").map((c) => c.trim()).filter(Boolean),
      wip: wipObj,
      pipeline: pipelineDef(),
      ...(flow ? { flow: flowFor(flow.value(), columns.value.split(",").map((c) => c.trim()).filter(Boolean)) } : {}),
    }
    // pipeline commands: show the change before saving
    let pv
    try {
      pv = (await post("project.save", args, { preview: true })).preview
    } catch (err) {
      return toast(err.message, { variant: "error", title: "Ungültig" })
    }
    const before = pv?.data?.before ?? []
    const after = pv?.data?.after ?? []
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      const { diffBox, lineDiff } = await import("../diff.js")
      const ok = await modal((close) => ({
        title: "Pipeline-Befehle ändern",
        wide: true,
        body: [h("p", { text: "Diese Befehle führt die Pipeline in Ihrer Shell aus. Bitte prüfen:" }), pv?.data?.home ? h("p", { class: "mono faint", text: `Verzeichnis: ${pv.data.home}` }) : null, diffBox("Stufen", lineDiff(before.join("\n"), after.join("\n")))],
        foot: [h("button", { class: "btn", type: "button", text: "Abbrechen", onclick: () => close(false) }), h("button", { class: "btn primary", type: "button", text: "Speichern", onclick: () => close(true) })],
      }))
      if (!ok) return
    }
    const r = await act("project.save", args)
    if (r) location.hash = r.open || `#/projekt/${encodeURIComponent(args.name || "")}`
  }
}
