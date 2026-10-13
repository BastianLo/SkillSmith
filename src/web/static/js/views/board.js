import { get } from "../api.js"
import { PRIORITIES, colLabel, debounce, entryHref, fmtDate, h, icon, put, storeGet, storeSet, swap, today } from "../dom.js"
import { act, announce, app } from "../ui.js"

const PRIO_LABEL = { niedrig: "niedrig", normal: "normal", hoch: "hoch", kritisch: "kritisch" }

export function pipelineBadge(pl) {
  if (!pl) return null
  const st = pl.status
  const mark = st === "success" ? h("span", { class: "st-ok", text: "✓" }) : st === "failed" || st === "timeout" || st === "error" ? h("span", { class: "st-bad", text: "✗" }) : st === "running" || st === "queued" ? h("span", { class: "spinner", style: { width: "10px", height: "10px" } }) : h("span", { class: "faint", text: "–" })
  return h("span", { class: "pipe", title: `Pipeline: ${st}${pl.at ? ` · ${fmtDate(pl.at)}` : ""}` }, mark, (pl.stages || []).map((s) => h("i", { class: `stage ${s.status}`, title: `${s.name}: ${s.status}` })))
}

export function agentChip(a) {
  if (!a) return null
  const cls = a.status === "permission" || a.status === "waiting" ? "warn" : a.status === "error" || a.status === "halted" ? "danger" : a.status === "accepted" ? "ok" : a.status === "discarded" || a.status === "aborted" ? "" : "accent"
  return h("a", { class: `chip ${cls}`, href: a.job ? `#/agenten/${encodeURIComponent(a.job)}` : "#/agenten", title: "Agenten-Auftrag" }, icon("agent", 11), a.label)
}

const STEP_SHORT = { plan: "Planung", implement: "Umsetzung", test: "Test", verify: "Verifikation" }

/** Small line under a column title: which agent does what here, and the gate. */
export function flowHint(f) {
  if (!f || !f.step) return null
  const parts = [`${STEP_SHORT[f.step] || f.step}${f.agent ? ` · ${f.agent}` : ""}`]
  if (f.gate) parts.push("Freigabe")
  return h("div", { class: "col-flow", title: `Schritt ${STEP_SHORT[f.step] || f.step}${f.agent ? ` mit Agent ${f.agent}` : " mit dem Agenten der Aufgabe"}${f.checks?.length ? ` · Prüfungen: ${f.checks.join(", ")}` : ""}${f.gate ? " · wartet danach auf Ihre Freigabe" : ""}` }, icon("agent", 11), parts.join(" · "))
}

function dueClass(due) {
  if (!due) return ""
  const t = today()
  if (due < t) return "due-over"
  const soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10)
  return due <= soon ? "due-soon" : ""
}

export function taskCard(t, { showProject, children = [], onAccept, onDismiss } = {}) {
  const card = h(
    "div",
    { class: `tcard prio-${t.priority}${t.suggested ? " suggested" : ""}`, draggable: app.readOnly ? "false" : "true", tabindex: "0", "data-name": t.name, "aria-roledescription": "Karte", "aria-label": `${t.id} ${t.title}` },
    h(
      "div",
      { class: "t-top" },
      h("span", { class: "t-id", text: t.id }),
      showProject && t.project ? h("span", { class: "chip outline", text: t.project }) : null,
      t.priority !== "normal" ? h("span", { class: `chip ${t.priority === "kritisch" ? "danger" : t.priority === "hoch" ? "warn" : ""}`, text: PRIO_LABEL[t.priority] || t.priority }) : null,
      t.suggested ? h("span", { class: "chip accent", title: "Vorschlag von memorysmith", text: "Vorschlag" }) : null,
      h("span", { class: "grow" }),
      pipelineBadge(t.pipeline),
    ),
    h("a", { class: "t-title", href: entryHref(`task:${t.name}`), text: t.title, draggable: "false" }),
    t.labels.length ? h("div", { class: "chips", style: { marginBottom: "4px" } }, t.labels.slice(0, 5).map((l) => h("span", { class: "chip", text: l }))) : null,
    h(
      "div",
      { class: "t-foot" },
      t.due ? h("span", { class: dueClass(t.due), title: "fällig", text: `⏱ ${t.due}` }) : null,
      t.progress.total ? h("span", { title: "Unteraufgaben erledigt", text: `☑ ${t.progress.done}/${t.progress.total}` }) : null,
      t.checklist.total ? h("span", { title: "Checkliste", text: `✓ ${t.checklist.done}/${t.checklist.total}` }) : null,
      t.links ? h("span", { title: "Verknüpfungen", text: `🔗 ${t.links}` }) : null,
      t.attachments.length ? h("span", { title: "Anhänge", text: `📎 ${t.attachments.length}` }) : null,
      t.assignee === "agent" && !t.agentStatus ? h("span", { class: "chip", text: `Agent ${t.agent || ""}`.trim() }) : null,
      agentChip(t.agentStatus),
    ),
    t.suggested && !app.readOnly
      ? h("div", { class: "toolbar", style: { margin: "6px 0 0" } }, h("button", { class: "btn sm primary", type: "button", text: "Einplanen", onclick: onAccept }), h("button", { class: "btn sm", type: "button", text: "Verwerfen", onclick: onDismiss }))
      : null,
    children.length ? h("div", { class: "t-sub" }, children.map((c) => h("div", { class: "row-flex", style: { gap: "6px" } }, h("span", { class: c.status === "erledigt" ? "st-ok" : "faint", text: c.status === "erledigt" ? "✓" : "○" }), h("a", { href: entryHref(`task:${c.name}`), text: `${c.id} ${c.title}` }), h("span", { class: "faint", text: colLabel(c.status) })))) : null,
  )
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !card.classList.contains("grabbed") && e.target === card) location.hash = entryHref(`task:${t.name}`)
  })
  return card
}

export default async function board(ctx) {
  ctx.title("Board")
  const q = ctx.query
  let project = q.get("projekt") || "*"
  const f = { text: q.get("q") || "", label: q.get("label") || "", prio: q.get("prio") || "", due: q.get("faellig") || "", who: q.get("wer") || "", mine: q.get("meine") === "1" }
  let subCards = storeGet("boardSubCards", true)
  const page = h("div", { class: "page", style: { maxWidth: "none" } })
  const headEl = h("div", { class: "board-head" })
  const boardEl = h("div", { class: "board", role: "list" })
  const looseEl = h("div", { class: "loose" })
  put(page, headEl, boardEl, looseEl)
  ctx.el.replaceChildren(page)
  let data = null
  let dragging = false

  const filtered = () =>
    data.tasks.filter((t) => {
      if (f.text) {
        const s = `${t.id} ${t.title} ${t.description} ${t.labels.join(" ")} ${t.ticket || ""} ${t.branch || ""}`.toLowerCase()
        if (!f.text.toLowerCase().split(/\s+/).every((w) => s.includes(w))) return false
      }
      if (f.label && !t.labels.includes(f.label)) return false
      if (f.prio && t.priority !== f.prio) return false
      if (f.who === "agent" && t.assignee !== "agent") return false
      if (f.who === "ich" && t.assignee === "agent") return false
      if (f.mine && !t.own) return false
      if (f.due === "ueberfaellig" && !(t.due && t.due < today())) return false
      if (f.due === "woche" && !(t.due && t.due <= new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10))) return false
      if (f.due === "mit" && !t.due) return false
      return true
    })

  function drawHead() {
    const labels = [...new Set(data.tasks.flatMap((t) => t.labels))].sort()
    const setF = (k, v, qk) => {
      f[k] = v
      ctx.setQuery({ [qk]: v })
      drawBoard()
    }
    const text = h("input", { class: "input", type: "search", placeholder: "Filtern …", value: f.text, style: { width: "180px" } })
    text.addEventListener("input", debounce(() => setF("text", text.value.trim(), "q"), 200))
    swap(
      headEl,
      h("h1", { style: { margin: 0 }, text: data.project ? data.project.title : project === "-" ? "Ohne Projekt" : "Alle Projekte" }),
      h(
        "select",
        {
          class: "input",
          onchange: (e) => {
            project = e.target.value
            ctx.setQuery({ projekt: project === "*" ? undefined : project })
            load()
          },
        },
        h("option", { value: "*", text: "Alle Projekte", selected: project === "*" }),
        h("option", { value: "-", text: "Ohne Projekt", selected: project === "-" }),
        data.projects.map((p) => h("option", { value: p.name, text: p.title, selected: project === p.name })),
      ),
      data.project ? h("a", { class: "btn sm", href: `#/projekt/${encodeURIComponent(data.project.name)}`, text: "Projektseite" }) : null,
      h("span", { class: "grow" }),
      h("span", { class: "faint", style: { fontSize: "12.5px" }, text: "Karten ziehen oder mit Leertaste aufnehmen · Reihenfolge nur lokal" }),
      h("div", { style: { flexBasis: "100%", height: 0 } }),
      text,
      h("select", { class: "input", onchange: (e) => setF("label", e.target.value, "label") }, h("option", { value: "", text: "alle Labels" }), labels.map((l) => h("option", { value: l, text: l, selected: f.label === l }))),
      h("select", { class: "input", onchange: (e) => setF("prio", e.target.value, "prio") }, h("option", { value: "", text: "jede Priorität" }), PRIORITIES.map((p) => h("option", { value: p, text: p, selected: f.prio === p }))),
      h("select", { class: "input", onchange: (e) => setF("due", e.target.value, "faellig") }, [["", "jede Fälligkeit"], ["ueberfaellig", "überfällig"], ["woche", "fällig in 7 Tagen"], ["mit", "mit Fälligkeit"]].map(([v, l]) => h("option", { value: v, text: l, selected: f.due === v }))),
      h("select", { class: "input", onchange: (e) => setF("who", e.target.value, "wer") }, [["", "alle"], ["ich", "für mich"], ["agent", "an Agenten"]].map(([v, l]) => h("option", { value: v, text: l, selected: f.who === v }))),
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: f.mine, onchange: (e) => setF("mine", e.target.checked, "meine") }), "von mir"),
      h("label", { class: "check", title: "Unteraufgaben als eigene Karten oder nur in der Elternkarte" }, h("input", { type: "checkbox", checked: subCards, onchange: (e) => ((subCards = e.target.checked), storeSet("boardSubCards", subCards), drawBoard()) }), "Unteraufgaben als Karten"),
    )
  }

  function drawBoard() {
    const tasks = filtered()
    const byParent = new Map()
    for (const t of data.tasks) if (t.parent) (byParent.get(t.parent) ?? byParent.set(t.parent, []).get(t.parent)).push(t)
    swap(
      boardEl,
      data.columns.map((col, ci) => {
        const inCol = tasks.filter((t) => t.status === col && (subCards || !t.parent))
        const limit = data.wip?.[col]
        const bodyEl = h("div", { class: "col-body", "data-col": col, role: "list" })
        for (const t of inCol)
          bodyEl.append(
            taskCard(t, {
              showProject: project === "*",
              children: subCards ? [] : byParent.get(t.id) ?? [],
              onAccept: async () => (await act("task.acceptSuggestion", { target: `task:${t.name}` })) && load(),
              onDismiss: async () => (await act("task.dismissSuggestion", { target: `task:${t.name}` })) && load(),
            }),
          )
        if (!inCol.length) bodyEl.append(h("div", { class: "faint", style: { padding: "8px", fontSize: "12px", textAlign: "center" }, text: "leer" }))
        const colEl = h(
          "section",
          { class: "col", "data-col": col, "aria-label": colLabel(col) },
          h("div", { class: "col-head" }, h("span", { class: "grow", text: colLabel(col) }), h("span", { class: `count${limit && inCol.length > limit ? " over" : ""}`, title: limit ? `WIP-Limit ${limit}` : "", text: limit ? `${inCol.length}/${limit}` : String(inCol.length) })),
          flowHint(data.flows?.[col]),
          ci === 0 && !app.readOnly ? h("div", { class: "col-add", style: { paddingTop: "8px" } }, newTaskInput()) : null,
          bodyEl,
        )
        wireDrop(colEl, bodyEl, col)
        return colEl
      }),
    )
    for (const card of boardEl.querySelectorAll(".tcard")) wireCard(card)
    if (q.get("neu") === "1") {
      boardEl.querySelector(".col-add input")?.focus()
      ctx.setQuery({ neu: undefined })
      q.delete("neu")
    }
  }

  function newTaskInput() {
    const input = h("input", { class: "input sm", placeholder: "+ Neue Aufgabe (Enter)", "aria-label": "Neue Aufgabe" })
    input.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter" || !input.value.trim()) return
      const title = input.value.trim()
      input.disabled = true
      const r = await act("task.create", { title, project: project !== "*" && project !== "-" ? project : undefined }, { quiet: true })
      input.disabled = false
      if (r) {
        input.value = ""
        await load()
        boardEl.querySelector(".col-add input")?.focus()
      }
    })
    return input
  }

  // ---------------------------------------------------------------- drag and drop
  let marker = h("div", { class: "drop-marker" })
  const indexAt = (bodyEl, y) => {
    const cards = [...bodyEl.querySelectorAll(".tcard:not(.dragging)")]
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect()
      if (y < r.top + r.height / 2) return i
    }
    return cards.length
  }
  function wireCard(card) {
    card.addEventListener("dragstart", (e) => {
      dragging = true
      e.dataTransfer.setData("text/plain", card.dataset.name)
      e.dataTransfer.effectAllowed = "move"
      setTimeout(() => card.classList.add("dragging"), 0)
    })
    card.addEventListener("dragend", () => {
      dragging = false
      card.classList.remove("dragging")
      marker.remove()
      for (const c of boardEl.querySelectorAll(".col")) c.classList.remove("drop")
    })
    card.addEventListener("keydown", (e) => keyMove(e, card))
  }
  function wireDrop(colEl, bodyEl, col) {
    colEl.addEventListener("dragover", (e) => {
      if (!dragging) return
      e.preventDefault()
      colEl.classList.add("drop")
      const i = indexAt(bodyEl, e.clientY)
      const cards = [...bodyEl.querySelectorAll(".tcard:not(.dragging)")]
      if (cards[i]) bodyEl.insertBefore(marker, cards[i])
      else bodyEl.append(marker)
    })
    colEl.addEventListener("dragleave", (e) => {
      if (!colEl.contains(e.relatedTarget)) {
        colEl.classList.remove("drop")
        marker.remove()
      }
    })
    colEl.addEventListener("drop", async (e) => {
      e.preventDefault()
      colEl.classList.remove("drop")
      const name = e.dataTransfer.getData("text/plain")
      const position = indexAt(bodyEl, e.clientY)
      marker.remove()
      await moveTo(name, col, position)
    })
  }
  async function moveTo(name, col, position) {
    const t = data.tasks.find((x) => x.name === name)
    if (!t) return
    if (t.status === col) await act("task.reorder", { target: `task:${name}`, position }, { quiet: true })
    else {
      const r = await act("task.move", { target: `task:${name}`, to: col, position })
      if (r) announce(`${t.id} nach ${colLabel(col)} verschoben`)
    }
    await load()
  }

  // keyboard: Space picks a card up, arrows move it, Space drops, Escape cancels
  let grabbed = null
  function keyMove(e, card) {
    if (app.readOnly) return
    const name = card.dataset.name
    if (e.key === " " && !grabbed && e.target === card) {
      e.preventDefault()
      grabbed = { name, from: card.closest(".col").dataset.col }
      card.classList.add("grabbed")
      card.setAttribute("aria-grabbed", "true")
      announce(`${name.toUpperCase()} aufgenommen. Pfeiltasten verschieben, Leertaste legt ab, Escape bricht ab.`)
      return
    }
    if (!grabbed || grabbed.name !== name) return
    const cols = [...boardEl.querySelectorAll(".col")]
    const colEl = card.closest(".col")
    const ci = cols.indexOf(colEl)
    const bodyEl = colEl.querySelector(".col-body")
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault()
      const next = cols[ci + (e.key === "ArrowRight" ? 1 : -1)]
      if (!next) return
      const nb = next.querySelector(".col-body")
      nb.querySelector(".faint")?.remove()
      nb.prepend(card)
      card.focus()
      announce(`Spalte ${colLabel(next.dataset.col)}`)
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault()
      const sib = e.key === "ArrowUp" ? card.previousElementSibling : card.nextElementSibling
      if (!sib || !sib.classList.contains("tcard")) return
      if (e.key === "ArrowUp") bodyEl.insertBefore(card, sib)
      else bodyEl.insertBefore(sib, card)
      card.focus()
      announce(`Position ${[...bodyEl.querySelectorAll(".tcard")].indexOf(card) + 1}`)
    } else if (e.key === " " || e.key === "Enter") {
      e.preventDefault()
      const col = card.closest(".col").dataset.col
      const position = [...card.closest(".col-body").querySelectorAll(".tcard")].indexOf(card)
      grabbed = null
      card.classList.remove("grabbed")
      moveTo(name, col, position).then(() => boardEl.querySelector(`.tcard[data-name="${CSS.escape(name)}"]`)?.focus())
    } else if (e.key === "Escape") {
      e.preventDefault()
      grabbed = null
      announce("Abgebrochen")
      load()
    }
  }

  // ---------------------------------------------------------------- loose items
  function drawLoose() {
    const items = data.loose || []
    swap(
      looseEl,
      items.length
        ? h(
            "details",
            { class: "card", open: storeGet("boardLooseOpen", false) },
            h("summary", { style: { cursor: "pointer", fontWeight: 600 }, text: `Lose Punkte (${items.length}) – Checkboxen aus Dokumenten und offene Punkte der Arbeitsstände` }),
            h(
              "div",
              { class: "list", style: { marginTop: "10px" } },
              items.slice(0, 150).map((it) =>
                h(
                  "div",
                  { class: "row" },
                  app.readOnly ? null : h("input", { type: "checkbox", title: "erledigt", onchange: async () => (await act("checklist.toggle", { target: it.source, line: it.line ?? it.index, done: true })) && load() }),
                  h("div", { class: "main" }, h("div", { text: it.text }), h("div", { class: "desc" }, h("a", { href: entryHref(it.source), text: it.title }), it.branch ? ` · ${it.branch}` : "", it.due ? h("span", { class: dueClass(it.due), text: ` · fällig ${it.due}` }) : null)),
                  app.readOnly ? null : h("button", { class: "btn sm", type: "button", text: "Als Aufgabe", onclick: async () => (await act("task.fromLoose", { source: it.source, ref: it.line ?? it.index, project: project !== "*" && project !== "-" ? project : undefined })) && load() }),
                ),
              ),
            ),
          )
        : null,
    )
    looseEl.querySelector("details")?.addEventListener("toggle", (e) => storeSet("boardLooseOpen", e.target.open))
  }

  async function load() {
    data = await get("board", { project })
    if (!ctx.alive()) return
    for (const t of data.tasks) t.own = t.own ?? false
    drawHead()
    drawBoard()
    drawLoose()
  }
  await load()
  const later = debounce(() => ctx.alive() && !dragging && !grabbed && load(), 800)
  ctx.on("task.changed", later)
  ctx.on("pipeline.run", later)
  ctx.on("agent.job", later)
}
