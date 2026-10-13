import { download, get, upload } from "../api.js"
import { createEditor } from "../cm.js"
import { AI_ACCESS, PRIORITIES, colLabel, debounce, entryHref, fmtDate, fmtDur, graphHref, h, icon, put, swap } from "../dom.js"
import { auditTab, linksBlock, mdBlock, relationsBlock, versionsTab } from "../parts.js"
import { act, app, card, confirmDialog, fill, modal, moreButton, promptDialog, tabBar, toast, toastError } from "../ui.js"
import { criteriaEditor, criteriaView, fieldsSummary, planView, testcaseEditor, testcasesView, verificationView } from "../fields.js"
import { jobChip } from "./agents.js"
import { agentChip, pipelineBadge } from "./board.js"

/** Dialog "An Agent übergeben": agent, model, workplace, extra instructions, brief preview. */
export async function assignDialog(taskName, project) {
  const [agents, models] = await Promise.all([get("agents").catch(() => []), get("models").catch(() => ({ models: [] }))])
  const target = `task:${taskName}`
  const res = await modal((close) => {
    const agentSel = h("select", { class: "input" }, agents.length ? agents.map((a) => h("option", { value: a.name, text: `${a.name}${a.model ? ` · ${a.model}` : ""}${a.description ? ` – ${a.description.slice(0, 60)}` : ""}`, selected: project?.agent === a.name })) : h("option", { value: "build", text: "build" }))
    // the offered models of opencode as suggestions; empty = the agent's model (checked by skillsmith)
    const listId = `models-${Math.random().toString(36).slice(2, 8)}`
    const datalist = h("datalist", { id: listId }, (models.models || []).map((m) => h("option", { value: m })))
    const model = h("input", { class: "input wide", list: listId, autocomplete: "off", value: project?.model || "" })
    const modelHint = h("div", { class: "faint", style: { fontSize: "12.5px", marginTop: "4px" } })
    const updateHint = () => {
      const a = agents.find((x) => x.name === agentSel.value)
      const fallback = models.last || models.defaults?.[0] || models.models?.[0]
      model.placeholder = a?.model && a.modelValid !== false ? `leer = Modell des Agenten (${a.model})` : a?.modelFix ? `leer = ${a.modelFix}` : fallback ? `leer = ${fallback}` : "provider/modell"
      modelHint.classList.toggle("warn-text", !!(a?.model && a.modelValid === false))
      modelHint.textContent =
        a?.model && a.modelValid === false
          ? a.modelFix
            ? `Der Agent ist mit „${a.model}“ konfiguriert – opencode braucht provider/modell. skillsmith nimmt ${a.modelFix}; dauerhaft beheben: model: ${a.modelFix} im Agenten.`
            : `Der Agent ist mit „${a.model}“ konfiguriert – das bietet opencode nicht an. Bitte ein Modell wählen${fallback ? ` (leer = ${fallback})` : ""}.`
          : models.models?.length
            ? `${models.models.length} Modelle in opencode verfügbar.`
            : ""
    }
    agentSel.addEventListener("change", updateHint)
    updateHint()
    const workplace = h("select", { class: "input" }, h("option", { value: "worktree", text: "eigener git-Worktree (empfohlen)", selected: app.info?.config?.tasks?.worktree !== false }), h("option", { value: "home", text: "direkt im Projektverzeichnis (home_path)", selected: app.info?.config?.tasks?.worktree === false }))
    const instr = h("textarea", { class: "input", rows: 4, placeholder: "Zusätzliche Anweisungen (optional)" })
    const briefBox = h("div", { class: "card flat", style: { maxHeight: "40vh", overflow: "auto", display: "none" } })
    const preview = async () => {
      const r = await act("agent.brief", { target, instructions: instr.value.trim() || undefined }, { quiet: true })
      if (!r?.data) return
      briefBox.style.display = ""
      swap(
        briefBox,
        r.data.included?.length ? h("div", { class: "chips", style: { marginBottom: "8px" } }, h("span", { class: "faint", text: "Mitgegeben: " }), r.data.included.map((id) => h("a", { class: "chip", href: entryHref(id), target: "_blank", text: id }))) : null,
        r.data.similar?.length ? h("div", { class: "faint", style: { marginBottom: "6px" }, text: `So wurde Ähnliches gelöst: ${r.data.similar.map((s) => s.id || s).join(", ")}` }) : null,
        mdBlock(r.data.brief),
      )
    }
    return {
      title: "An Agent übergeben",
      wide: true,
      body: [
        h("p", { class: "muted", text: "Der Agent liest und plant zuerst – ohne Schreibrechte, auch für seine Subagenten. Code ändert er erst, wenn Sie seinen Vorschlag freigeben." }),
        h("div", { class: "fields" }, h("div", { class: "field" }, h("label", { text: "Agent" }), agentSel), h("div", { class: "field" }, h("label", { text: "Arbeitsort" }), workplace)),
        h("div", { class: "field" }, h("label", { text: "Modell" }), model, datalist, modelHint),
        h("div", { class: "field" }, h("label", { text: "Anweisungen" }), instr),
        h("button", { class: "btn sm", type: "button", text: "Auftrag ansehen", onclick: preview }),
        briefBox,
      ],
      foot: [h("button", { class: "btn", type: "button", text: "Abbrechen", onclick: () => close(undefined) }), h("button", { class: "btn primary", type: "button", text: "Übergeben", onclick: () => close({ agent: agentSel.value, model: model.value.trim() || undefined, workplace: workplace.value, instructions: instr.value.trim() || undefined }) })],
    }
  })
  if (!res) return null
  const r = await act("agent.assign", { target, ...res })
  if (r?.open) location.hash = r.open
  return r
}

export default async function task(ctx) {
  const idRaw = ctx.params.id
  let tab = ctx.query.get("tab") || ""
  let editing = ctx.query.get("bearbeiten") === "1"
  const page = h("div", { class: "page" })
  ctx.el.replaceChildren(page)
  let data
  let ed = null
  ctx.cleanup(() => ed?.destroy())

  const load = async () => {
    data = await get("task", { id: idRaw })
    if (!ctx.alive()) return
    ctx.title(`${data.task.id} ${data.task.title}`)
    draw()
  }

  const update = async (patch, opts = {}) => {
    const r = await act("task.update", { target: `task:${data.task.name}`, ...patch }, { base: data.entry.version, quiet: opts.quiet, onReload: load })
    if (r) await load()
    return r
  }

  const draw = async () => {
    const t = data.task
    const target = `task:${t.name}`
    const projects = await get("projects").catch(() => [])
    const project = projects.find((p) => p.name === t.project)
    const columns = project?.columns?.length ? project.columns : app.info?.columns || ["neu", "planung", "umsetzung", "test", "verifikation", "erledigt"]
    ed?.destroy()
    ed = null
    // ---------------------------------------------------------------- header
    const statusSel = h("select", { class: "input", disabled: app.readOnly }, columns.map((c) => h("option", { value: c, text: colLabel(c), selected: t.status === c })))
    statusSel.addEventListener("change", async () => {
      const r = await act("task.move", { target, to: statusSel.value })
      if (r) load()
      else statusSel.value = t.status
    })
    const titleEl = h("h1", { text: t.title, title: app.readOnly ? "" : "Klicken zum Umbenennen", style: { cursor: app.readOnly ? "default" : "text" } })
    if (!app.readOnly)
      titleEl.addEventListener("click", async () => {
        const v = await promptDialog("Titel", { value: t.title })
        if (v && v !== t.title) update({ title: v })
      })
    const head = h(
      "div",
      { class: "page-head" },
      h(
        "div",
        { class: "grow" },
        h("div", { class: "entry-head" }, h("span", { class: "chip kind", style: { background: "var(--k-task)" }, text: t.id }), t.project ? h("a", { class: "chip outline", href: `#/board?projekt=${encodeURIComponent(t.project)}`, text: t.project }) : null, data.parent ? h("a", { class: "chip", href: entryHref(`task:${data.parent.name}`), text: `↑ ${data.parent.id} ${data.parent.title}` }) : null, t.suggested ? h("span", { class: "chip accent", text: "Vorschlag von memorysmith" }) : null, agentChip(t.agentStatus), pipelineBadge(t.pipeline)),
        titleEl,
        t.description ? h("p", { class: "entry-sub", text: t.description }) : null,
      ),
      h(
        "div",
        { class: "toolbar" },
        statusSel,
        t.suggested && !app.readOnly ? [h("button", { class: "btn primary", type: "button", text: "Einplanen", onclick: async () => (await act("task.acceptSuggestion", { target })) && load() }), h("button", { class: "btn", type: "button", text: "Verwerfen", onclick: async () => (await act("task.dismissSuggestion", { target })) && load() })] : null,
        !app.readOnly && app.info?.agents !== false ? h("button", { class: "btn", type: "button", onclick: () => assignDialog(t.name, project) }, icon("agent", 14), "An Agent übergeben") : null,
        project?.pipeline && !app.readOnly ? h("button", { class: "btn", type: "button", onclick: async () => (await act("pipeline.start", { project: project.name, task: t.name })) && load() }, icon("play", 14), "Pipeline") : null,
        h("a", { class: "btn", href: graphHref(target) }, icon("graph", 14), "Graph"),
        app.readOnly
          ? null
          : moreButton(() => [
              { label: "Archivieren", icon: "archive", run: async () => (await act("entry.archive", { target })) && load() },
              { label: "Wiederherstellen", run: async () => (await act("entry.restore", { target })) && load() },
              { label: "KI-Recht: Vorschlag", run: async () => (await act("entry.setAi", { target, ai: "vorschlag" })) && load() },
              { label: "KI-Recht: frei", run: async () => (await act("entry.setAi", { target, ai: "frei" })) && load() },
              { label: "KI-Recht: nur lesen", run: async () => (await act("entry.setAi", { target, ai: "lesen" })) && load() },
              { label: "KI-Recht: privat", run: async () => (await act("entry.setAi", { target, ai: "privat" })) && load() },
            ]),
      ),
    )
    // ---------------------------------------------------------------- description
    const descBody = h("div")
    const descCard = h("div", { class: "card dropzone" }, h("div", { class: "card-head" }, h("h3", { class: "grow", text: "Beschreibung" }), app.readOnly ? null : h("button", { class: "btn sm", type: "button", text: editing ? "Vorschau" : "Bearbeiten", onclick: () => ((editing = !editing), draw()) })), descBody)
    if (editing && !app.readOnly) {
      const box = h("div", { class: "cm-mini" })
      const saveBtn = h("button", { class: "btn primary sm", type: "button", text: "Speichern" })
      put(descBody, box, h("div", { class: "toolbar" }, saveBtn, h("button", { class: "btn sm", type: "button", text: "Abbrechen", onclick: () => ((editing = false), draw()) }), h("span", { class: "faint", text: "[[ verlinkt · Dateien hineinziehen oder einfügen hängt sie an und verlinkt sie" })))
      ed = await createEditor(box, { doc: data.body, uploadTarget: target, onSave: () => saveBtn.click(), placeholder: "Was ist zu tun, warum, Akzeptanzkriterien … – [[Links]] auf Doku, Skills, Erinnerungen" })
      saveBtn.addEventListener("click", async () => {
        const r = await update({ body: ed.value })
        if (r) editing = false
      })
      ed.focus()
    } else {
      put(
        descBody,
        data.body.trim()
          ? mdBlock(data.body, {
              checkboxes: !app.readOnly,
              subtasks: !app.readOnly,
              onToggle: async (line, done) => (await act("checklist.toggle", { target, line, done }, { quiet: true })) && load(),
              onToSubtask: async (line) => (await act("task.fromChecklist", { target, line })) && load(),
            })
          : h("div", { class: "faint", text: "Noch keine Beschreibung." }),
      )
    }
    // drop files onto the description: attach and reference them in the text
    if (!app.readOnly && !editing) wireDrop(descCard, async (files) => {
      const refs = []
      for (const f of files) {
        try {
          const r = await upload(f, target)
          if (r.data?.markdown) refs.push(r.data.markdown)
        } catch (err) {
          toastError(err)
        }
      }
      if (refs.length) {
        await load()
        await update({ body: `${data.body.replace(/\s*$/, "")}\n\n${refs.join("\n")}\n` }, { quiet: true })
        toast(`${refs.length} Anhang/Anhänge gespeichert und im Text verlinkt.`, { variant: "success" })
      }
    })
    // ---------------------------------------------------------------- attachments
    const fileIn = h("input", { type: "file", multiple: true, class: "hidden" })
    const attCard = h(
      "div",
      { class: "card dropzone" },
      h("div", { class: "card-head" }, h("h3", { class: "grow", text: `Anhänge (${t.attachments.length})` }), app.readOnly ? null : h("button", { class: "btn sm", type: "button", onclick: () => fileIn.click() }, icon("upload", 12), "Hochladen"), fileIn),
      t.attachments.length
        ? h(
            "div",
            { class: "list" },
            t.attachments.map((p) =>
              h(
                "div",
                { class: "row" },
                icon(/\.(png|jpe?g|gif|webp|svg)$/i.test(p) ? "eye" : "doc", 15),
                h("div", { class: "main mono ellipsis", text: p }),
                h("button", { class: "btn sm ghost", type: "button", text: "Laden", onclick: () => download(`/api/attachment?path=${encodeURIComponent(p)}`, p.split("/").pop()).catch(toastError) }),
                app.readOnly || data.body.includes(`anhang:${p}`) ? null : h("button", { class: "btn sm", type: "button", text: "Im Text verlinken", onclick: () => update({ body: `${data.body.replace(/\s*$/, "")}\n\n${/\.(png|jpe?g|gif|webp|svg)$/i.test(p) ? "!" : ""}[${p.split("/").pop()}](anhang:${p})\n` }) }),
              ),
            ),
          )
        : h("div", { class: "faint", text: "Dateien hierher ziehen oder hochladen (Bilder, PDFs, Logs – höchstens " + (app.info?.config?.docs?.attachmentMaxMB ?? 5) + " MB je Datei)." }),
    )
    const attach = async (files) => {
      for (const f of files) {
        try {
          await upload(f, target)
        } catch (err) {
          toastError(err)
        }
      }
      await load()
    }
    fileIn.addEventListener("change", () => attach([...fileIn.files]))
    if (!app.readOnly) wireDrop(attCard, attach)
    // ---------------------------------------------------------------- subtasks
    const subIn = h("input", { class: "input sm", placeholder: "+ Unteraufgabe (Enter)", style: { width: "100%" } })
    subIn.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter" || !subIn.value.trim()) return
      ;(await act("task.subtask", { target, title: subIn.value.trim() })) && load()
    })
    const subCard = h(
      "div",
      { class: "card" },
      h("h3", { text: `Unteraufgaben (${t.progress.done}/${t.progress.total})` }),
      data.children.length ? h("div", { class: "list", style: { marginBottom: "8px" } }, data.children.map((c) => h("a", { class: "row", href: entryHref(`task:${c.name}`) }, h("span", { class: c.status === columns[columns.length - 1] ? "st-ok" : "faint", text: c.status === columns[columns.length - 1] ? "✓" : "○" }), h("div", { class: "main" }, h("div", { class: "title", text: `${c.id} ${c.title}` })), h("div", { class: "meta" }, h("span", { text: colLabel(c.status) }), pipelineBadge(c.pipeline))))) : null,
      app.readOnly ? null : subIn,
    )
    // ---------------------------------------------------------------- agents and pipeline
    const jobsCard = data.jobs.length
      ? h(
          "div",
          { class: "card" },
          h("h3", { text: "Agenten-Aufträge" }),
          h("div", { class: "list" }, data.jobs.map((j) => h("a", { class: "row", href: `#/agenten/${encodeURIComponent(j.id)}` }, icon("agent", 15), h("div", { class: "main" }, h("div", { class: "title", text: `${j.stepAgent && j.stepAgent !== j.agent ? `${j.agent} → ${j.stepAgent}` : j.agent}${j.model ? ` · ${j.model}` : ""}` }), h("div", { class: "desc", text: `${fmtDate(j.startedAt)}${j.column ? ` · Spalte ${colLabel(j.column)}` : ""}${j.loops ? ` · ${j.loops} Rücksprung/Rücksprünge` : ""}` })), h("div", { class: "meta" }, jobChip({ ...j, permissions: 0 }))))),
        )
      : null
    const runsCard = data.runs.length
      ? h(
          "div",
          { class: "card" },
          h("h3", { text: "Pipeline-Läufe" }),
          h("div", { class: "list" }, data.runs.map((r) => h("a", { class: "row", href: `#/pipeline/${encodeURIComponent(r.project)}/${encodeURIComponent(r.id)}` }, pipelineBadge({ status: r.status, stages: r.stages }), h("div", { class: "main" }, h("div", { class: "title", text: `${r.status}${r.tests ? ` · Tests ${r.tests.total}, rot ${r.tests.failures + r.tests.errors}` : ""}` }), h("div", { class: "desc", text: `${fmtDate(r.queuedAt)} · ${r.trigger}` })), h("div", { class: "meta", text: fmtDur(r.ms) })))),
        )
      : null
    // ---------------------------------------------------------------- fields
    const fieldsCard = h(
      "div",
      { class: "card" },
      h("h3", { text: "Felder" }),
      fieldRow("Priorität", h("select", { class: "input sm", disabled: app.readOnly, onchange: (e) => update({ priority: e.target.value }) }, PRIORITIES.map((p) => h("option", { value: p, text: p, selected: t.priority === p })))),
      fieldRow("Fällig", h("input", { class: "input sm", type: "date", value: t.due || "", disabled: app.readOnly, onchange: (e) => update({ due: e.target.value }) })),
      fieldRow("Labels", textField(t.labels.join(", "), (v) => update({ labels: v.split(",").map((x) => x.trim()).filter(Boolean) }))),
      fieldRow("Zuständig", h("select", { class: "input sm", disabled: app.readOnly, onchange: (e) => update({ assignee: e.target.value }) }, [["", "–"], ["ich", "ich"], ["agent", "Agent"]].map(([v, l]) => h("option", { value: v, text: l, selected: (t.assignee || "") === v })))),
      fieldRow("Projekt", h("select", { class: "input sm", disabled: app.readOnly, onchange: (e) => update({ project: e.target.value }) }, h("option", { value: "", text: "– ohne –" }), projects.map((p) => h("option", { value: p.name, text: p.title, selected: t.project === p.name })))),
      fieldRow("Branch", textField(t.branch || "", (v) => update({ branch: v }))),
      fieldRow("Ticket", textField(t.ticket || "", (v) => update({ ticket: v })), t.ticket ? h("a", { href: `#/ticket/${encodeURIComponent(t.ticket)}`, text: "Ticket-Seite" }) : null),
      fieldRow("Elternaufgabe", textField(t.parent || "", (v) => update({ parent: v.toUpperCase() }))),
      h("div", { class: "faint", style: { fontSize: "12px", marginTop: "8px" }, text: `${data.entry.own ? "von Ihnen" : "von der KI"} · KI-Recht ${AI_ACCESS[data.entry.ai]?.label ?? data.entry.ai} · erstellt ${fmtDate(t.createdAt)} · geändert ${fmtDate(t.updatedAt)}` }),
    )
    const summary = fieldsSummary(data.fields)
    const acceptCard = h(
      "div",
      { class: "card" },
      h("div", { class: "card-head" }, h("h3", { class: "grow", text: "Abnahme" }), h("a", { class: "btn sm ghost", href: "#", onclick: (e) => (e.preventDefault(), selectTab("tests")), text: "Kriterien & Tests →" })),
      summary || h("div", { class: "faint", style: { fontSize: "13px" }, text: "Noch keine Kriterien oder Testfälle – der Planer schlägt sie vor, oder Sie legen sie an." }),
    )
    // ---------------------------------------------------------------- tabs
    const TABS = [
      ["", "Übersicht"],
      ["tests", "Kriterien & Tests"],
      ["verknuepfungen", "Verknüpfungen"],
      ["versionen", "Versionen"],
      ["audit", "Aktivität"],
    ]
    const tabBody = h("div")
    const selectTab = (k) => {
      tab = k
      ctx.setQuery({ tab: k || undefined })
      drawTab()
    }
    const tabs = tabBar(
      TABS,
      tab,
      selectTab,
    )
    const drawTab = () => {
      tabs.querySelectorAll("button").forEach((b, i) => {
        const on = TABS[i][0] === tab
        b.classList.toggle("on", on)
        b.setAttribute("aria-selected", on ? "true" : "false")
      })
      if (tab === "") swap(tabBody, h("div", { class: "cols" }, h("div", { class: "stack" }, descCard, subCard, attCard, jobsCard, runsCard), h("div", { class: "stack" }, fieldsCard, acceptCard, data.entry.backlinks?.length ? linksBlock({ ...data.entry, links: [], mentions: [] }) : null)))
      else if (tab === "tests") swap(tabBody, testsTab(t, project))
      else if (tab === "verknuepfungen") swap(tabBody, h("div", { class: "grid two" }, relationsBlock(data.entry, { onChange: load }), linksBlock(data.entry, { onChange: load })))
      else if (tab === "versionen") fill(tabBody, () => versionsTab(target, { onRestored: load }))
      else fill(tabBody, () => auditTab(target))
    }
    swap(page, head, tabs, tabBody)
    drawTab()
  }

  // ---------------------------------------------------------------- criteria, test cases, plan, verification
  function testsTab(t, project) {
    const f = data.fields || {}
    const target = `task:${t.name}`
    const saveFields = async (patch) => {
      const r = await act("task.fields", { target, ...patch }, { base: data.entry.version, onReload: load })
      if (r) await load()
      return r
    }
    const editable = (title, view, editorOf, key) => {
      const body = h("div", null, view)
      const btn = app.readOnly
        ? null
        : h("button", {
            class: "btn sm",
            type: "button",
            text: "Bearbeiten",
            onclick: () => {
              const ed = editorOf()
              btn.classList.add("hidden")
              swap(body, ed.el, h("div", { class: "toolbar" }, h("button", { class: "btn sm primary", type: "button", text: "Speichern", onclick: () => saveFields({ [key]: ed.value() }) }), h("button", { class: "btn sm", type: "button", text: "Abbrechen", onclick: () => (btn.classList.remove("hidden"), swap(body, view)) })))
            },
          })
      return h("div", { class: "card" }, h("div", { class: "card-head" }, h("h3", { class: "grow", text: title }), btn), body)
    }
    const onResult = app.readOnly
      ? undefined
      : async (id, result) => {
          const protocol = result === "fehlgeschlagen" ? await promptDialog(`${id} fehlgeschlagen`, { label: "Was ist passiert? (geht an den Agenten)", multiline: true, required: false }) : ""
          if (protocol === null || protocol === undefined) return
          ;(await act("task.testResult", { target, case: id, result, protocol: protocol || undefined })) && load()
        }
    const commands = (f.testcases || []).filter((x) => x.mode === "befehl" && x.command)
    const testsCard = editable("Testfälle", testcasesView(f.testcases, { onResult, project: t.project }), () => testcaseEditor(f.testcases), "testcases")
    if (commands.length && t.project && !app.readOnly)
      testsCard.querySelector(".card-head").append(h("button", { class: "btn sm", type: "button", title: "Alle Testfälle mit Befehl als Pipeline-Lauf im Arbeitsverzeichnis der Aufgabe ausführen", onclick: async () => (await act("task.runTests", { target })) && setTimeout(load, 1500) }, icon("play", 12), `Befehle ausführen (${commands.length})`))
    return h(
      "div",
      { class: "cols" },
      h("div", { class: "stack" }, editable("Akzeptanzkriterien", criteriaView(f.criteria), () => criteriaEditor(f.criteria), "criteria"), testsCard),
      h("div", { class: "stack" }, card("Freigegebener Plan", planView(f.plan)), card("Verifikation", verificationView(f.verification, f.criteria))),
    )
  }

  function fieldRow(label, control, extra) {
    return h("div", { class: "row-flex", style: { margin: "6px 0", flexWrap: "nowrap" } }, h("span", { class: "muted", style: { width: "110px", flex: "none", fontSize: "13px" }, text: label }), h("div", { class: "grow" }, control), extra || null)
  }
  function textField(value, onSave) {
    const input = h("input", { class: "input sm", value, disabled: app.readOnly, style: { width: "100%" } })
    input.addEventListener("change", () => input.value.trim() !== value && onSave(input.value.trim()))
    return input
  }
  function wireDrop(el, onFiles) {
    el.addEventListener("dragover", (e) => {
      if (![...(e.dataTransfer?.types || [])].includes("Files")) return
      e.preventDefault()
      el.classList.add("drag")
    })
    el.addEventListener("dragleave", (e) => !el.contains(e.relatedTarget) && el.classList.remove("drag"))
    el.addEventListener("drop", (e) => {
      const files = [...(e.dataTransfer?.files || [])]
      el.classList.remove("drag")
      if (!files.length) return
      e.preventDefault()
      onFiles(files)
    })
  }

  await load()
  const later = debounce(() => ctx.alive() && !ed && load(), 800)
  ctx.on("task.changed", (d) => d.task === data?.task?.name && later())
  ctx.on("pipeline.run", (d) => d.task === data?.task?.name && later())
  ctx.on("agent.job", (d) => d.task === data?.task?.name && later())
}

export { confirmDialog }
