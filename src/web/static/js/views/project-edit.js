import { get, post } from "../api.js"
import { colLabel, field, h, icon, put, swap } from "../dom.js"
import { act, app, modal, toast } from "../ui.js"

const DEFAULT_COLUMNS = ["neu", "eingeplant", "in_umsetzung", "test", "erledigt"]

export default async function projectEdit(ctx) {
  const name = ctx.params.name
  const isNew = !name
  ctx.title(isNew ? "Neues Projekt" : "Projekt bearbeiten")
  const [p, agents] = await Promise.all([isNew ? Promise.resolve(null) : get("project", { name }).then((d) => d.project), get("agents").catch(() => [])])
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
  const wip = h("input", { class: "input wide mono", value: Object.entries(p?.wip || {}).map(([k, v]) => `${k}=${v}`).join(", "), placeholder: "in_umsetzung=3, test=5" })
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
