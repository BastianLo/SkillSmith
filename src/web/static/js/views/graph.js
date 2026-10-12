import { get, saveBlob } from "../api.js"
import { EDGE_COLOR, KIND_PLURAL, RELATION_TYPES, SYMMETRIC, colorOf, css, editHref, entryHref, h, icon, put, storeGet, storeSet, swap, today } from "../dom.js"
import { conflictsBlock, entryHead, factsBlock, mdBlock, relationDialog, relationsBlock, relevanceLine } from "../parts.js"
import { app, errorText, promptDialog, toast } from "../ui.js"

const GRAPH_KINDS = ["knowledge", "skill", "error", "script", "glossary", "memory", "task", "project", "arbeitsstand", "ergebnis", "session"]

function params(q) {
  return {
    center: q.get("center") || "",
    depth: Number(q.get("depth")) || 1,
    minStrength: Number(q.get("minStrength")) || 0,
    kinds: (q.get("kinds") || "").split(",").filter(Boolean),
    types: (q.get("types") || "").split(",").filter(Boolean),
    derived: q.get("derived") !== "0",
    archived: q.get("archived") === "1",
    project: q.get("project") === "all" ? "all" : "",
    sizeBy: q.get("sizeBy") || "relevance",
    window: q.get("window") === "total" ? "total" : "current",
    across: q.get("across") === "1",
    top: Number(q.get("top")) || 0,
    own: q.get("own") === "1",
    group: q.get("group") || "",
    date: q.get("datum") || "",
  }
}

function hashOf(p) {
  const q = new URLSearchParams()
  if (p.center) q.set("center", p.center)
  if (p.center && p.depth !== 1) q.set("depth", String(p.depth))
  if (p.minStrength) q.set("minStrength", String(p.minStrength))
  if (p.kinds.length) q.set("kinds", p.kinds.join(","))
  if (p.types.length) q.set("types", p.types.join(","))
  if (!p.derived) q.set("derived", "0")
  if (p.archived) q.set("archived", "1")
  if (p.project) q.set("project", p.project)
  if (p.sizeBy !== "relevance") q.set("sizeBy", p.sizeBy)
  if (p.window !== "current") q.set("window", p.window)
  if (p.across) q.set("across", "1")
  if (p.top) q.set("top", String(p.top))
  if (p.own) q.set("own", "1")
  if (p.group) q.set("group", p.group)
  if (p.date) q.set("datum", p.date)
  return `#/graph${q.toString() ? `?${q}` : ""}`
}

export default async function graph(ctx) {
  ctx.title("Graph")
  ctx.layout("full")
  const p = params(ctx.query)
  const side = h("aside", { class: "graph-side" })
  const canvas = h("div", { id: "cy" })
  const info = h("div", { class: "graph-info" })
  const tools = h("div", { class: "graph-tools" })
  const modeBox = h("div", { class: "graph-mode" })
  const detail = h("aside", { class: "graph-detail" })
  const main = h("div", { class: "graph-main" }, canvas, info, tools, modeBox)
  const layoutEl = h("div", { class: "graph-layout" }, side, main, detail)
  ctx.el.replaceChildren(layoutEl)
  const apply = (patch) => (location.hash = hashOf({ ...p, ...patch }))

  // ---------------------------------------------------------------- side panel
  const box = (checked, onChange) => {
    const cb = h("input", { type: "checkbox", checked })
    cb.addEventListener("change", () => onChange(cb.checked))
    return cb
  }
  const kindBoxes = GRAPH_KINDS.map((k) =>
    box(!p.kinds.length || p.kinds.includes(k), () => {
      const sel = GRAPH_KINDS.filter((_k, i) => kindBoxes[i].checked)
      apply({ kinds: sel.length === GRAPH_KINDS.length ? [] : sel })
    }),
  )
  const typeKeys = Object.keys(RELATION_TYPES)
  const typeBoxes = typeKeys.map((t) =>
    box(!p.types.length || p.types.includes(t), () => {
      const sel = typeKeys.filter((_t, i) => typeBoxes[i].checked)
      apply({ types: sel.length === typeKeys.length ? [] : sel })
    }),
  )
  const strength = h("input", { type: "range", min: "0", max: "1", step: "0.1", value: String(p.minStrength) })
  const strengthLabel = h("span", { text: p.minStrength.toFixed(1) })
  strength.addEventListener("input", () => (strengthLabel.textContent = Number(strength.value).toFixed(1)))
  strength.addEventListener("change", () => apply({ minStrength: Number(strength.value) }))
  const topIn = h("input", { type: "range", min: "0", max: "600", step: "10", value: String(p.top) })
  const topLabel = h("span", { text: p.top ? String(p.top) : "alle" })
  topIn.addEventListener("input", () => (topLabel.textContent = Number(topIn.value) ? topIn.value : "alle"))
  topIn.addEventListener("change", () => apply({ top: Number(topIn.value) }))
  const sizeSel = h("select", { class: "input sm" }, [["relevance", "Relevanz"], ["usage", "Nutzung"], ["network", "Vernetzung"], ["equal", "gleich groß"]].map(([v, l]) => h("option", { value: v, text: l, selected: p.sizeBy === v })))
  sizeSel.addEventListener("change", () => apply({ sizeBy: sizeSel.value }))
  const groupSel = h("select", { class: "input sm" }, [["", "keine"], ["tag", "nach Tag"], ["project", "nach Projekt"], ["kind", "nach Art"]].map(([v, l]) => h("option", { value: v, text: l, selected: p.group === v })))
  groupSel.addEventListener("change", () => apply({ group: groupSel.value }))
  const dateIn = h("input", { type: "date", class: "input sm", value: p.date, max: today() })
  dateIn.addEventListener("change", () => apply({ date: dateIn.value, center: "" }))
  const views = storeGet("graphViews", [])
  const viewSel = h("select", { class: "input sm" }, h("option", { value: "", text: views.length ? "Gespeicherte Ansicht …" : "keine gespeicherten Ansichten" }), views.map((v, i) => h("option", { value: String(i), text: v.name })))
  viewSel.addEventListener("change", () => {
    const v = views[Number(viewSel.value)]
    if (v) location.hash = v.hash
  })
  put(
    side,
    h("h3", { text: "Ansicht" }),
    p.center
      ? h(
          "div",
          null,
          h("div", { class: "muted", text: "Umgebung von" }),
          h("a", { href: entryHref(p.center), class: "mono", text: p.center }),
          h("div", { class: "toolbar" }, [1, 2, 3].map((d) => h("a", { class: `btn sm${d === p.depth ? " on" : ""}`, href: hashOf({ ...p, depth: d }), text: `${d} Schritt${d > 1 ? "e" : ""}` }))),
          h("a", { class: "btn sm", href: hashOf({ ...p, center: "", depth: 1 }), text: "Ganzer Graph" }),
        )
      : h("div", { class: "muted", text: "Ganzer Graph. Doppelklick zeigt die Umgebung eines Knotens." }),
    h("div", { class: "toolbar", style: { margin: "8px 0" } }, viewSel),
    h("h3", { text: "Größe" }),
    h("label", null, "nach ", sizeSel),
    h("label", null, box(p.window === "total", (v) => apply({ window: v ? "total" : "current" })), "Nutzung gesamt statt aktuell"),
    h("label", null, box(p.across, (v) => apply({ across: v })), "über alle Arten vergleichen"),
    h("div", { class: "muted", style: { marginTop: "4px" } }, "nur die relevantesten ", topLabel),
    topIn,
    h("div", { class: "legend", style: { marginTop: "6px" } }, h("span", null, h("i", { class: "swatch", style: { background: "var(--ring-good)" } }), "gesund"), h("span", null, h("i", { class: "swatch", style: { background: "var(--ring-warn)" } }), "auffällig"), h("span", null, h("i", { class: "swatch", style: { background: "var(--ring-critical)" } }), "Konflikt"), h("span", { text: "◎ von mir" })),
    h("h3", { text: "Gruppierung" }),
    groupSel,
    h("h3", { text: "Zeitreise" }),
    h("div", { class: "row-flex" }, dateIn, p.date ? h("a", { class: "btn sm", href: hashOf({ ...p, date: "" }), text: "Heute" }) : null),
    h("h3", { text: "Arten" }),
    GRAPH_KINDS.map((k, i) => {
      const sw = h("span", { class: "swatch" })
      sw.style.background = colorOf(k)
      return h("label", null, kindBoxes[i], sw, KIND_PLURAL[k])
    }),
    h("h3", { text: "Beziehungen" }),
    typeKeys.map((t, i) => {
      const sw = h("span", { class: "swatch" })
      sw.style.background = EDGE_COLOR[t]
      return h("label", null, typeBoxes[i], sw, RELATION_TYPES[t])
    }),
    h("h3", null, "Mindeststärke ", strengthLabel),
    strength,
    h("h3", { text: "Weitere" }),
    h("label", null, box(p.derived, (v) => apply({ derived: v })), "abgeleitete Bezüge und Links"),
    h("label", null, box(p.archived, (v) => apply({ archived: v })), "archivierte Einträge"),
    h("label", null, box(p.project === "all", (v) => apply({ project: v ? "all" : "" })), "Erinnerungen aller Projekte"),
    h("label", null, box(p.own, (v) => apply({ own: v })), "nur meine Dokumente"),
  )
  swap(detail, h("div", { class: "faint", text: "Knoten anklicken: Eintrag mit allen Verknüpfungen. Doppelklick: Umgebung. Überfahren: warum der Knoten so groß ist." }))

  // ---------------------------------------------------------------- data
  let data
  try {
    if (p.date) {
      const at = await get("graph/at", { date: p.date })
      data = { center: null, truncated: false, nodes: at.nodes.map((n) => ({ ...n, size: 10, ring: null, degree: 0, summary: "", tags: [] })), edges: at.edges.map((e, i) => ({ ...e, id: `e${i}`, derived: false, label: RELATION_TYPES[e.type] || e.type })), commit: at.commit, past: true }
    } else data = await get("graph", { center: p.center, depth: p.depth, minStrength: p.minStrength || "", kinds: p.kinds.join(","), types: p.types.join(","), derived: p.derived ? "" : "0", archived: p.archived ? "1" : "", project: p.project, sizeBy: p.sizeBy, window: p.window, across: p.across ? "1" : "", top: p.top || "", own: p.own ? "1" : "" })
  } catch (err) {
    put(canvas, h("div", { class: "notice error", style: { margin: "20px" }, text: errorText(err) }))
    return
  }
  if (!ctx.alive()) return
  info.textContent = `${data.nodes.length} Knoten · ${data.edges.length} Verknüpfungen${data.truncated ? " · gekürzt auf die relevantesten" : ""}${data.past ? ` · Stand ${p.date} (Commit ${data.commit || "–"}), nur lesend` : ""}`
  if (!data.nodes.length) {
    put(canvas, h("div", { class: "empty", style: { padding: "40px" }, text: p.date ? "An diesem Datum gab es noch keinen Store-Stand." : "Keine Knoten für diese Filter." }))
    return
  }
  if (typeof window.cytoscape !== "function") {
    put(canvas, h("div", { class: "empty", text: "Graph-Bibliothek nicht geladen." }))
    return
  }
  const textColor = css("--text")
  const bg = css("--bg")
  const accent = css("--accent")
  const ringColor = { good: css("--ring-good"), warn: css("--ring-warn"), critical: css("--ring-critical") }
  const short = (s) => (s.length > 48 ? `${s.slice(0, 46)}…` : s)
  const groups = new Map()
  const groupOf = (n) => {
    if (!p.group) return undefined
    const key = p.group === "tag" ? n.tags?.[0] : p.group === "project" ? n.project : n.kind
    if (!key) return undefined
    const id = `grp:${key}`
    if (!groups.has(id)) groups.set(id, { data: { id, label: p.group === "kind" ? KIND_PLURAL[key] || key : p.group === "tag" ? `#${key}` : key, group: 1 } })
    return id
  }
  const nodes = data.nodes.map((n) => ({
    data: {
      id: n.id,
      parent: groupOf(n),
      label: `${n.isNew ? "• " : ""}${short(n.title || n.id)}`,
      color: n.faded ? css("--faint") : colorOf(n.kind, n.type),
      size: Math.max(12, (n.size || 10) * 2),
      big: ((n.size || 10) >= 13 || data.nodes.length < 60 || n.id === data.center) ? 1 : 0,
      ring: n.ring ? ringColor[n.ring] : n.own ? accent : css("--border-strong"),
      ringW: n.ring ? 3 : n.own ? 3 : 0,
      own: n.own ? 1 : 0,
      faded: n.faded ? 1 : 0,
      center: n.id === data.center ? 1 : 0,
      archived: n.tier === "archive" ? 1 : 0,
    },
  }))
  const edges = data.edges.map((e) => ({
    data: { id: e.id, source: e.from, target: e.to, type: e.type, color: EDGE_COLOR[e.type] || "#999", width: 0.8 + (e.strength || 0.5) * 3.5, derived: e.derived ? 1 : 0, arrow: SYMMETRIC.has(e.type) ? "none" : "triangle", label: RELATION_TYPES[e.type] || e.type, description: e.description || "", strength: e.strength, src: e.source || "" },
  }))
  const cy = window.cytoscape({
    container: canvas,
    elements: [...groups.values(), ...nodes, ...edges],
    style: [
      { selector: "node", style: { "background-color": "data(color)", width: "data(size)", height: "data(size)", "border-width": "data(ringW)", "border-color": "data(ring)", color: textColor, "font-size": 11, "text-valign": "bottom", "text-margin-y": 3, "text-wrap": "wrap", "text-max-width": 130, "text-outline-color": bg, "text-outline-width": 2, "min-zoomed-font-size": 5 } },
      { selector: "node[big = 1]", style: { label: "data(label)" } },
      { selector: "node[own = 1]", style: { "border-style": "double", "border-width": 4 } },
      { selector: "node[faded = 1]", style: { opacity: 0.45 } },
      { selector: "node[archived = 1]", style: { opacity: 0.4 } },
      { selector: "node[center = 1]", style: { "border-width": 5, "border-color": accent, "font-weight": "bold" } },
      { selector: "node[group = 1]", style: { "background-color": css("--panel-2"), "background-opacity": 0.6, "border-width": 1, "border-color": css("--border"), label: "data(label)", "text-valign": "top", "font-size": 12, "font-weight": "bold", color: css("--muted"), shape: "round-rectangle", padding: 14 } },
      { selector: "node.hover, node:selected", style: { label: "data(label)", "z-index": 10 } },
      { selector: "node:selected", style: { "border-width": 4, "border-color": accent } },
      { selector: "edge", style: { width: "data(width)", "line-color": "data(color)", "target-arrow-color": "data(color)", "target-arrow-shape": "data(arrow)", "curve-style": "bezier", opacity: 0.7, "arrow-scale": 0.8 } },
      { selector: "edge[derived = 1]", style: { "line-style": "dashed", opacity: 0.4 } },
      { selector: "edge:selected", style: { opacity: 1, label: "data(label)", "font-size": 9, color: textColor, "text-outline-color": bg, "text-outline-width": 2 } },
      { selector: ".faded", style: { opacity: 0.1 } },
      { selector: ".path", style: { "line-color": accent, "target-arrow-color": accent, width: 5, opacity: 1, "border-color": accent, "border-width": 4, label: "data(label)" } },
      { selector: ".hidden", style: { display: "none" } },
      { selector: ".linksrc", style: { "border-color": accent, "border-width": 5, "border-style": "dashed" } },
    ],
    layout: { name: "preset" },
    minZoom: 0.08,
    maxZoom: 3,
  })
  ctx.cleanup(() => cy.destroy())
  // layout: connected part with cose, unconnected nodes in a compact grid below it
  const cose = { name: "cose", animate: false, randomize: true, numIter: 2500, padding: 40, nodeRepulsion: () => 42000, nodeOverlap: 40, idealEdgeLength: () => 120, edgeElasticity: () => 80, componentSpacing: 100, gravity: 0.8, nestingFactor: 0.9 }
  if (data.center) cy.layout({ name: "concentric", concentric: (n) => (n.data("center") ? 10 : 10 - Math.min(9, n.degree())), levelWidth: () => 1, minNodeSpacing: 60, padding: 40, animate: false }).run()
  else if (p.group) cy.layout(cose).run()
  else {
    const isolated = cy.nodes().filter((n) => n.degree(false) === 0)
    const main = cy.elements().not(isolated)
    if (main.nodes().length) main.layout(cose).run()
    if (isolated.length) {
      const bb = main.nodes().length ? main.boundingBox() : { x1: 0, y2: 0, w: 600 }
      // one cell per node, wide enough for the label (text-max-width 130)
      const colW = 150
      const rowH = 80
      const cols = Math.max(1, Math.min(isolated.length, Math.floor(Math.max(bb.w, Math.min(1800, Math.sqrt(isolated.length) * colW * 1.6)) / colW)))
      const rows = Math.ceil(isolated.length / cols)
      isolated.layout({ name: "grid", animate: false, avoidOverlap: true, cols, rows, boundingBox: { x1: bb.x1, y1: (bb.y2 ?? 0) + 90, w: cols * colW, h: rows * rowH } }).run()
    }
  }
  cy.fit(undefined, 40)
  if (cy.zoom() > 1.1) {
    cy.zoom(1.1)
    cy.center()
  }

  // ---------------------------------------------------------------- tooltip
  const tip = h("div", { class: "graph-tip hidden" })
  document.body.append(tip)
  ctx.cleanup(() => tip.remove())
  const byId = new Map(data.nodes.map((n) => [n.id, n]))
  cy.on("mouseover", "node", (e) => {
    const n = byId.get(e.target.id())
    e.target.addClass("hover")
    if (!n) return
    swap(tip, h("strong", { text: n.title }), h("div", { class: "faint", text: `${n.label || n.kind}${n.project ? ` · ${n.project}` : ""}` }), n.explain ? h("div", { text: n.explain }) : null, n.ringReason ? h("div", { class: `ring-${n.ring}`, text: n.ringReason }) : null, n.relevance !== undefined && !data.past ? h("div", { class: "faint", text: `Relevanz ${Math.round((n.relevance || 0) * 100)} / 100${n.isNew ? " · neu" : ""}` }) : null)
    tip.classList.remove("hidden")
  })
  cy.on("mousemove", "node", (e) => {
    const ev = e.originalEvent
    tip.style.left = `${ev.clientX + 14}px`
    tip.style.top = `${ev.clientY + 12}px`
  })
  cy.on("mouseout", "node", (e) => {
    e.target.removeClass("hover")
    tip.classList.add("hidden")
  })

  // ---------------------------------------------------------------- modes
  let mode = "" // "" | "path" | "link"
  let focus = false
  let pathA = null
  const setMode = (m) => {
    mode = mode === m ? "" : m
    pathA = null
    cy.elements().removeClass("path faded linksrc")
    drawTools()
    swap(modeBox, mode === "path" ? h("span", { class: "chip accent", text: "Pfad: ersten Knoten wählen" }) : mode === "link" ? h("span", { class: "chip accent", text: "Verknüpfen: Knoten auf einen anderen ziehen" }) : null)
    cy.autoungrabify(false)
  }
  const highlight = (node) => {
    cy.elements().removeClass("faded hidden")
    if (!node) return
    const hood = node.closedNeighborhood()
    if (focus) cy.elements().not(hood).not("[group = 1]").addClass("hidden")
    else cy.elements().not(hood).addClass("faded")
  }
  const drawTools = () =>
    swap(
      tools,
      h("button", { class: `btn sm ${mode === "path" ? "on" : ""}`, type: "button", title: "Kürzesten Pfad zwischen zwei Knoten zeigen", onclick: () => setMode("path") }, "Pfad"),
      !data.past && !app.readOnly ? h("button", { class: `btn sm ${mode === "link" ? "on" : ""}`, type: "button", title: "Knoten auf einen anderen ziehen, um sie zu verknüpfen", onclick: () => setMode("link") }, icon("link", 12), "Verknüpfen") : null,
      h("button", { class: `btn sm ${focus ? "on" : ""}`, type: "button", title: "Nur die Umgebung des gewählten Knotens zeigen", onclick: () => {
        focus = !focus
        drawTools()
        highlight(cy.$("node:selected").first().nonempty() ? cy.$("node:selected").first() : null)
      } }, "Fokus"),
      h("button", { class: "btn sm", type: "button", title: "Ansicht speichern (Filter in diesem Browser)", onclick: async () => {
        const name = await promptDialog("Ansicht speichern", { label: "Name" })
        if (!name) return
        const list = storeGet("graphViews", [])
        list.push({ name, hash: location.hash })
        storeSet("graphViews", list.slice(-20))
        toast("Ansicht gespeichert.", { variant: "success" })
      } }, "Speichern"),
      h("button", { class: "btn sm", type: "button", title: "Als PNG exportieren", onclick: () => {
        const blob = cy.png({ output: "blob", full: true, scale: 2, bg })
        saveBlob(blob, `graph-${today()}.png`)
      } }, icon("export", 12), "PNG"),
      h("button", { class: "btn sm", type: "button", title: "Alles einpassen", onclick: () => cy.fit(undefined, 40) }, "Einpassen"),
    )
  drawTools()

  // drag a node onto another one → relation dialog
  let grabPos = null
  cy.on("grab", "node", (e) => {
    if (mode !== "link") return
    grabPos = { ...e.target.position() }
    e.target.addClass("linksrc")
  })
  cy.on("free", "node", async (e) => {
    if (mode !== "link" || !grabPos) return
    const src = e.target
    src.removeClass("linksrc")
    const pos = src.position()
    const hit = cy.nodes().filter((n) => n.id() !== src.id() && !n.data("group") && (() => {
      const b = n.boundingBox()
      return pos.x >= b.x1 && pos.x <= b.x2 && pos.y >= b.y1 && pos.y <= b.y2
    })()).first()
    src.position(grabPos)
    grabPos = null
    if (!hit.nonempty()) return
    const r = await relationDialog(src.id(), { to: hit.id() })
    if (r) ctx.reload()
  })

  const openInPanel = async (id) => {
    const node = cy.getElementById(id)
    if (node.nonempty()) {
      cy.elements().unselect()
      node.select()
      highlight(node)
      cy.animate({ center: { eles: node }, duration: 250 })
    }
    swap(detail, h("div", { class: "loading" }, h("span", { class: "spinner" }), "Lade …"))
    try {
      const d = await get("entry", { id })
      if (!ctx.alive()) return
      swap(
        detail,
        entryHead(d),
        relevanceLine(d.relevance),
        h(
          "div",
          { class: "toolbar" },
          h("a", { class: "btn primary sm", href: entryHref(id), text: "Vollansicht" }),
          d.owned !== false && /^(skill|knowledge|glossary|error|script|memory):/.test(id) && !app.readOnly ? h("a", { class: "btn sm", href: editHref(id), text: "Bearbeiten" }) : null,
          id !== data.center ? h("a", { class: "btn sm", href: hashOf({ ...p, center: id, depth: 1, date: "" }), text: "Umgebung" }) : null,
        ),
        h("div", { class: "card" }, mdBlock(d.body)),
        conflictsBlock(d),
        relationsBlock(d, {
          onOpen: (other) => (cy.getElementById(other).nonempty() ? openInPanel(other) : (location.hash = hashOf({ ...p, center: other, depth: 1 }))),
          onChange: data.past ? undefined : () => openInPanel(id),
        }),
        factsBlock(d),
      )
      detail.scrollTop = 0
    } catch (err) {
      swap(detail, h("div", { class: "notice error", text: errorText(err) }))
    }
  }

  cy.on("tap", "node", async (e) => {
    const id = e.target.id()
    if (e.target.data("group")) return
    if (mode === "path") {
      if (!pathA) {
        pathA = id
        e.target.addClass("path")
        swap(modeBox, h("span", { class: "chip accent", text: "Pfad: zweiten Knoten wählen" }))
        return
      }
      const r = await get("graph/path", { a: pathA, b: id })
      cy.elements().removeClass("path faded")
      if (!r.found) {
        swap(modeBox, h("span", { class: "chip warn", text: "Kein Pfad zwischen den beiden Knoten." }))
        pathA = null
        return
      }
      const ids = new Set([pathA, id])
      for (const ed of r.edges) {
        ids.add(ed.from)
        ids.add(ed.to)
      }
      cy.elements().addClass("faded")
      for (const nid of ids) cy.getElementById(nid).removeClass("faded").addClass("path")
      cy.edges().forEach((ed) => {
        if (r.edges.some((x) => (x.from === ed.source().id() && x.to === ed.target().id()) || (x.to === ed.source().id() && x.from === ed.target().id()))) ed.removeClass("faded").addClass("path")
      })
      swap(modeBox, h("span", { class: "chip accent", text: `Pfad: ${r.edges.length} Schritt${r.edges.length === 1 ? "" : "e"} – ${r.edges.map((x) => x.label).join(" → ")}` }))
      pathA = null
      return
    }
    if (mode === "link") return
    openInPanel(id)
  })
  cy.on("dbltap", "node", (e) => {
    if (e.target.data("group")) return
    location.hash = hashOf({ ...p, center: e.target.id(), depth: 1, date: "" })
  })
  cy.on("tap", "edge", (e) => {
    const d = e.target.data()
    highlight(null)
    const a = cy.getElementById(d.source).data("label")
    const b = cy.getElementById(d.target).data("label")
    swap(
      detail,
      h("h3", { text: "Verknüpfung" }),
      h("h1", { text: d.label }),
      h("p", { class: "muted", text: `Stärke ${Number(d.strength).toFixed(2)}${d.derived ? " · abgeleitet" : ""}${d.src ? ` · ${d.src}` : ""}` }),
      d.description ? h("p", { text: d.description }) : null,
      h("div", { class: "list" }, h("a", { class: "rel", href: entryHref(d.source), onclick: (ev) => (ev.preventDefault(), openInPanel(d.source)) }, h("div", { class: "rel-top", text: "von" }), h("div", { class: "rel-title", text: a })), h("a", { class: "rel", href: entryHref(d.target), onclick: (ev) => (ev.preventDefault(), openInPanel(d.target)) }, h("div", { class: "rel-top", text: "zu" }), h("div", { class: "rel-title", text: b }))),
    )
  })
  cy.on("tap", (e) => {
    if (e.target === cy) {
      cy.elements().unselect()
      highlight(null)
    }
  })
  if (data.center) openInPanel(data.center)
}
