import { get, saveBlob } from "../api.js"
import { EDGE_COLOR, KIND_PLURAL, RELATION_TYPES, SYMMETRIC, colorOf, css, editHref, entryHref, h, icon, put, s, storeGet, storeSet, swap, today } from "../dom.js"
import { conflictsBlock, entryHead, factsBlock, mdBlock, relationDialog, relationsBlock, relevanceLine } from "../parts.js"
import { app, errorText, promptDialog, toast } from "../ui.js"

const GRAPH_KINDS = ["knowledge", "skill", "error", "script", "glossary", "memory", "task", "project", "arbeitsstand", "ergebnis", "session", "code"]

// Physics defaults. Chosen by the user as the optimal feel for a continuously
// running layout: much stronger base repulsion (180 -> 600), a stronger
// repulsion-per-size and a wide repulsion range (distanceMax 800 -> 1990) give
// the nodes plenty of air, while looser links (base 0.10 / strength share 0.15)
// and a larger link distance (base 100 / share 140) let clusters breathe. Higher
// damping (0.60) and a stronger continuous-run intensity (alphaTarget 0.10) keep
// the motion calm but alive. Every value is live-tunable in the side panel and
// only written to the URL hash when it differs from these defaults.
const PHYS_DEFAULTS = {
  repBase: 600, // base strength of forceManyBody
  repFactor: 30, // repulsion per node size
  linkBase: 0.1, // link strength, constant part
  linkStrength: 0.15, // link strength, part scaled by edge strength
  distBase: 100, // link distance, constant part
  distStrength: 140, // link distance, part scaled by (1 - edge strength)
  collide: 15, // padding added to the collide radius
  clusterStrength: 0.1, // similarity-link strength per shared tag
  clusterDist: 170, // similarity-link distance
  distMax: 1990, // range of the repulsion (0 = unlimited)
  velocityDecay: 0.6, // damping
  alphaTarget: 0.1, // continuous-run intensity
}

// Slider specification for the side panel (key -> PHYS_DEFAULTS).
const PHYS_SPEC = [
  { key: "repBase", label: "Abstoßung (Basis)", min: 0, max: 1000, step: 10 },
  { key: "repFactor", label: "Abstoßung ∝ Größe", min: 0, max: 40, step: 1 },
  { key: "linkBase", label: "Anziehung (Basis)", min: 0, max: 1, step: 0.05, dec: 2 },
  { key: "linkStrength", label: "Anziehung ∝ Stärke", min: 0, max: 1, step: 0.05, dec: 2 },
  { key: "distBase", label: "Kantenlänge (Basis)", min: 20, max: 300, step: 10 },
  { key: "distStrength", label: "Kantenlänge ∝ (1−Stärke)", min: 0, max: 300, step: 10 },
  { key: "collide", label: "Kollision (Radius-Zuschlag)", min: 0, max: 40, step: 1 },
  { key: "clusterStrength", label: "Clustering (Stärke je Tag)", min: 0, max: 0.2, step: 0.01, dec: 2 },
  { key: "clusterDist", label: "Clustering (Distanz)", min: 50, max: 400, step: 10 },
  { key: "distMax", label: "Reichweite der Abstoßung", min: 0, max: 3000, step: 10, unlimited: true },
  { key: "velocityDecay", label: "Dämpfung (velocityDecay)", min: 0, max: 0.9, step: 0.05, dec: 2 },
  { key: "alphaTarget", label: "Dauerlauf (alphaTarget)", min: 0, max: 0.3, step: 0.01, dec: 2 },
]

const physFmt = (spec, v) => (spec.unlimited && !v ? "∞" : spec.dec ? Number(v).toFixed(spec.dec) : String(Math.round(v)))
// Numbers may legitimately be 0, so plain `Number(x) || default` is wrong here.
const numOr = (v, d) => (v === null || v === "" || Number.isNaN(Number(v)) ? d : Number(v))

function params(q) {
  return {
    center: q.get("center") || "",
    depth: Number(q.get("depth")) || 1,
    minStrength: Number(q.get("minStrength")) || 0,
    ...Object.fromEntries(Object.entries(PHYS_DEFAULTS).map(([k, d]) => [k, numOr(q.get(k), d)])),
    kinds: (q.get("kinds") || "").split(",").filter(Boolean),
    types: (q.get("types") || "").split(",").filter(Boolean),
    derived: q.get("derived") !== "0",
    archived: q.get("archived") === "1",
    project: q.get("project") === "all" ? "all" : "",
    sizeBy: q.get("sizeBy") || "relevance",
    window: q.get("window") === "total" ? "total" : "current",
    across: q.get("across") === "1",
    freeze: q.get("freeze") === "1",
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
  if (p.freeze) q.set("freeze", "1")
  if (p.top) q.set("top", String(p.top))
  if (p.own) q.set("own", "1")
  if (p.group) q.set("group", p.group)
  if (p.date) q.set("datum", p.date)
  for (const [k, d] of Object.entries(PHYS_DEFAULTS)) if (numOr(p[k], d) !== d) q.set(k, String(p[k]))
  return `#/graph${q.toString() ? `?${q}` : ""}`
}

export default async function graph(ctx) {
  ctx.title("Graph")
  ctx.layout("full")
  const p = params(ctx.query)
  const side = h("aside", { class: "graph-side" })
  const canvas = h("div", { class: "graph-canvas" })
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

  // Physics controls. They act on the running simulation directly (no view
  // rebuild) and only update the URL hash via replaceState, so dragging a
  // slider never restarts the route.
  const physInputs = []
  const physPanel = () => {
    const rows = PHYS_SPEC.map((spec) => {
      const input = h("input", { type: "range", min: String(spec.min), max: String(spec.max), step: String(spec.step), value: String(p[spec.key]), style: { width: "100%" } })
      const valueLabel = h("span", { class: "muted mono", text: physFmt(spec, p[spec.key]) })
      input.addEventListener("input", () => {
        const v = Number(input.value)
        valueLabel.textContent = physFmt(spec, v)
        applyPhys(spec.key, v)
      })
      input.addEventListener("change", () => applyPhys(spec.key, Number(input.value)))
      physInputs.push({ spec, input, valueLabel })
      return h("label", { style: { display: "flex", flexDirection: "column", alignItems: "stretch", gap: "2px" } }, h("span", { style: { display: "flex", justifyContent: "space-between", gap: "8px" } }, h("span", { text: spec.label }), valueLabel), input)
    })
    const reset = h("button", { class: "btn sm", type: "button", text: "Zurücksetzen", onclick: () => {
      for (const { spec, input, valueLabel } of physInputs) {
        p[spec.key] = PHYS_DEFAULTS[spec.key]
        input.value = String(PHYS_DEFAULTS[spec.key])
        valueLabel.textContent = physFmt(spec, PHYS_DEFAULTS[spec.key])
      }
      applyForces(p)
      refreshAlphaTarget()
      wakeSim(true)
      history.replaceState(null, "", hashOf(p))
    } })
    return h("details", { class: "phys", style: { marginTop: "10px" } }, h("summary", { text: "Physik" }), ...rows, h("div", { class: "toolbar", style: { marginTop: "6px" } }, reset))
  }
  side.append(physPanel())
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
  if (typeof window.d3?.forceSimulation !== "function") {
    put(canvas, h("div", { class: "empty", text: "Graph-Bibliothek nicht geladen." }))
    return
  }

  // ---------------------------------------------------------------- model
  const d3 = window.d3
  const bg = css("--bg")
  const accent = css("--accent")
  const ringColor = { good: css("--ring-good"), warn: css("--ring-warn"), critical: css("--ring-critical") }
  const short = (str) => (str.length > 48 ? `${str.slice(0, 46)}…` : str)
  const groupLabels = new Map()
  const groupOf = (n) => {
    if (!p.group) return undefined
    const key = p.group === "tag" ? n.tags?.[0] : p.group === "project" ? n.project : n.kind
    if (!key) return undefined
    const id = `grp:${key}`
    if (!groupLabels.has(id)) groupLabels.set(id, p.group === "kind" ? KIND_PLURAL[key] || key : p.group === "tag" ? `#${key}` : key)
    return id
  }
  const simNodes = data.nodes.map((n) => ({
    id: n.id,
    label: `${n.isNew ? "• " : ""}${short(n.title || n.id)}`,
    color: n.faded ? css("--faint") : colorOf(n.kind, n.type),
    size: Math.max(12, (n.size || 10) * 2),
    big: (n.size || 10) >= 13 || data.nodes.length < 60 || n.id === data.center,
    ring: n.id === data.center ? accent : n.ring ? ringColor[n.ring] : n.own ? accent : css("--border-strong"),
    ringW: n.id === data.center ? 5 : n.ring || n.own ? 3 : 0,
    own: !!n.own,
    faded: !!n.faded,
    center: n.id === data.center,
    archived: n.tier === "archive",
    tags: n.tags || [],
    project: n.project || "",
    kind: n.kind,
    group: groupOf(n),
  }))
  const simLinks = data.edges.map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    type: e.type,
    color: EDGE_COLOR[e.type] || "#999",
    width: 0.8 + (e.strength || 0.5) * 3.5,
    derived: !!e.derived,
    arrow: SYMMETRIC.has(e.type) ? "none" : "triangle",
    label: RELATION_TYPES[e.type] || e.type,
    description: e.description || "",
    strength: e.strength,
    src: e.source || "",
  }))
  const endId = (v) => (v && typeof v === "object" ? v.id : v)
  const rawById = new Map(data.nodes.map((n) => [n.id, n]))

  // deterministic seed: golden-angle spiral around the origin (no jumping)
  const seedR = Math.max(140, Math.sqrt(simNodes.length) * 46)
  simNodes.forEach((d, i) => {
    const a = i * 2.399963229728653
    const r = seedR * Math.sqrt((i + 0.5) / Math.max(1, simNodes.length))
    d.x = Math.cos(a) * r
    d.y = Math.sin(a) * r
  })

  // weak similarity links (common tags / group) – simulation only, never rendered.
  // Bounded to the top-3 neighbours per node so this stays O(n·k).
  const weakLinks = []
  {
    const tagIndex = new Map()
    const affinity = new Map()
    for (const d of simNodes) {
      const tags = [...d.tags]
      if (d.group) tags.push(d.group)
      affinity.set(d.id, tags)
      for (const t of tags) {
        if (!tagIndex.has(t)) tagIndex.set(t, [])
        tagIndex.get(t).push(d)
      }
    }
    const seen = new Set()
    for (const d of simNodes) {
      const counts = new Map()
      for (const t of affinity.get(d.id)) {
        let c = 0
        for (const o of tagIndex.get(t)) {
          if (o !== d) counts.set(o, (counts.get(o) || 0) + 1)
          if (++c >= 40) break
        }
      }
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0].id < b[0].id ? -1 : 1)).slice(0, 3)
      for (const [o, shared] of top) {
        const key = d.id < o.id ? `${d.id}|${o.id}` : `${o.id}|${d.id}`
        if (seen.has(key)) continue
        seen.add(key)
        weakLinks.push({ source: d.id, target: o.id, weak: true, shared: Math.min(shared, 3) })
      }
    }
  }

  // static group centroids (from the seed) for a weak forceX/forceY pull
  const groupCentroids = new Map()
  const groupMembers = new Map()
  if (p.group) {
    const acc = new Map()
    for (const d of simNodes) {
      if (!d.group) continue
      const a = acc.get(d.group) || { x: 0, y: 0, n: 0 }
      a.x += d.x
      a.y += d.y
      a.n++
      acc.set(d.group, a)
      if (!groupMembers.has(d.group)) groupMembers.set(d.group, [])
      groupMembers.get(d.group).push(d)
    }
    for (const [gid, a] of acc) groupCentroids.set(gid, { x: a.x / a.n, y: a.y / a.n })
  }

  let vw = main.clientWidth || 800
  let vh = main.clientHeight || 600
  // ---------------------------------------------------------------- SVG scaffold
  const svg = s("svg", { id: "graph-svg" })
  const defs = s("defs")
  const viewport = s("g", { class: "viewport" })
  const gHulls = s("g", { class: "hulls" })
  const gEdges = s("g", { class: "gedges" })
  const gNodes = s("g", { class: "gnodes" })
  viewport.append(gHulls, gEdges, gNodes)
  svg.append(defs, viewport)
  put(canvas, svg)

  const markerId = (c) => `arrow-${c.replace(/[^a-z0-9]/gi, "")}`
  for (const c of new Set(simLinks.filter((l) => l.arrow !== "none").map((l) => l.color))) {
    defs.append(s("marker", { id: markerId(c), viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse" }, s("path", { d: "M0,0 L10,5 L0,10 z", fill: c })))
  }

  // ---------------------------------------------------------------- interaction state
  let mode = "" // "" | "path" | "link"
  let focus = false
  let pathA = null
  let hoverId = null
  let selectedId = null
  let pathIds = new Set()
  let linkSrcId = null
  let grabPos = null
  let curT = null

  const nodeEls = new Map()
  const nodeCircle = new Map()
  const nodeLabel = new Map()
  const edgeEls = new Map()
  const edgeGs = new Map()
  const hullEls = new Map()
  const hullTexts = new Map()

  const restyle = (d) => {
    const c = nodeCircle.get(d.id)
    if (!c) return
    let stroke = d.ring
    let width = d.ringW
    let dash = ""
    if (pathIds.has(d.id)) {
      stroke = accent
      width = Math.max(width, 4)
    }
    if (d.id === hoverId) {
      stroke = accent
      width = Math.max(width, 2.5)
    }
    if (d.id === selectedId) {
      stroke = accent
      width = Math.max(width, 3.5)
    }
    if (d.id === linkSrcId) {
      stroke = accent
      width = Math.max(width, 3)
      dash = "6 3"
    }
    c.setAttribute("style", `stroke:${stroke};stroke-width:${width}${dash ? `;stroke-dasharray:${dash}` : ""}`)
    const t = nodeLabel.get(d.id)
    if (t) t.classList.toggle("hidden", !(d.big || d.id === hoverId || d.id === selectedId || pathIds.has(d.id)))
  }

  const baseOpacity = (d) => (d.faded ? "0.45" : d.archived ? "0.4" : "1")
  for (const d of simNodes) {
    const g = s("g", { class: `gnode${d.center ? " center" : ""}`, "data-id": d.id })
    g.style.opacity = baseOpacity(d)
    const c = s("circle", { class: d.own ? "own" : null, r: d.size / 2, fill: d.color })
    const t = s("text", { class: "glabel", "text-anchor": "middle", y: d.size / 2 + 12 })
    t.textContent = d.label
    g.append(c, t)
    gNodes.append(g)
    nodeEls.set(d.id, g)
    nodeCircle.set(d.id, c)
    nodeLabel.set(d.id, t)
    restyle(d)
  }

  for (const l of simLinks) {
    const vis = s("line", { class: `gedge${l.derived ? " derived" : ""}`, stroke: l.color, "stroke-width": l.width, "marker-end": l.arrow !== "none" ? `url(#${markerId(l.color)})` : null })
    const hit = s("line", { stroke: "transparent", "stroke-width": 12, "pointer-events": "stroke" })
    const g = s("g", { class: "edge", "data-id": l.id }, hit, vis)
    gEdges.append(g)
    edgeEls.set(l.id, vis)
    edgeGs.set(l.id, g)
  }

  for (const [gid, members] of groupMembers) {
    const rect = s("rect", { class: "hull", rx: 10, "pointer-events": "none" })
    gHulls.append(rect)
    hullEls.set(gid, rect)
    const t = s("text", { class: "glabel", "pointer-events": "none" })
    t.textContent = groupLabels.get(gid) || gid
    gHulls.append(t)
    hullTexts.set(gid, t)
  }

  // ---------------------------------------------------------------- simulation
  const MANY = simNodes.length > 300
  const NO_EDGES = data.edges.length === 0
  let frozen = p.freeze
  let alphaTargetValue = MANY || NO_EDGES ? 0 : p.alphaTarget

  // Recompute the continuous-run intensity from the current alphaTarget value.
  // `MANY`/`NO_EDGES` still force it to 0 so huge or edgeless graphs settle.
  const refreshAlphaTarget = () => {
    alphaTargetValue = MANY || NO_EDGES ? 0 : p.alphaTarget
  }
  // Restart the live loop with a visible bump, unless the user froze it.
  const wakeSim = (bump) => {
    if (frozen) return
    if (bump) sim.alpha(Math.max(sim.alpha(), 0.5))
    sim.alphaTarget(alphaTargetValue).restart()
  }

  const sim = d3.forceSimulation(simNodes)

  // Force configuration in one place. `cfg` carries the current physics values
  // (initially `p`, afterwards the live slider values). Called once here and on
  // every slider change, so a drag updates the running simulation in place.
  const applyForces = (cfg) => {
    if (!NO_EDGES) {
      sim.force(
        "link",
        d3
          .forceLink([...simLinks, ...weakLinks])
          .id((d) => d.id)
          .distance((d) => (d.weak ? cfg.clusterDist : cfg.distBase + cfg.distStrength * (1 - (d.strength ?? 0.5))))
          .strength((d) => (d.weak ? (d.shared ?? 1) * cfg.clusterStrength : cfg.linkBase + cfg.linkStrength * (d.strength ?? 0.5))),
      )
    }
    sim.force("charge", d3.forceManyBody().strength((d) => -(cfg.repBase + cfg.repFactor * d.size)).distanceMax(cfg.distMax > 0 ? cfg.distMax : Infinity))
    sim.force("collide", d3.forceCollide((d) => d.size / 2 + cfg.collide).iterations(1))
    sim.force("center", d3.forceCenter(vw / 2, vh / 2))
    if (p.group) {
      sim.force("groupX", d3.forceX((d) => groupCentroids.get(d.group)?.x ?? 0).strength((d) => (d.group ? 0.05 : 0)))
      sim.force("groupY", d3.forceY((d) => groupCentroids.get(d.group)?.y ?? 0).strength((d) => (d.group ? 0.05 : 0)))
    }
    if (data.center) {
      const cn = simNodes.find((d) => d.center)
      if (cn) {
        cn.fx = vw / 2
        cn.fy = vh / 2
      }
      sim.force("radial", d3.forceRadial(Math.max(150, seedR * 0.6), vw / 2, vh / 2).strength((d) => (d.center ? 0 : 0.03)))
    }
    sim.velocityDecay(cfg.velocityDecay)
  }
  applyForces(p)

  // Live slider handler: update the value, re-apply the forces on the running
  // simulation (alpha bump + restart so the change is visible immediately) and
  // refresh the hash without triggering a route reload.
  const applyPhys = (key, v) => {
    p[key] = v
    applyForces(p)
    if (key === "alphaTarget") refreshAlphaTarget()
    wakeSim(true)
    history.replaceState(null, "", hashOf(p))
  }

  // ---------------------------------------------------------------- renderer
  const render = () => {
    for (const d of simNodes) {
      const g = nodeEls.get(d.id)
      if (g) g.setAttribute("transform", `translate(${d.x ?? 0},${d.y ?? 0})`)
    }
    for (const l of simLinks) {
      const a = l.source
      const b = l.target
      if (a == null || b == null || a.x == null || b.x == null) continue
      const line = edgeEls.get(l.id)
      if (line) {
        line.setAttribute("x1", a.x)
        line.setAttribute("y1", a.y)
        line.setAttribute("x2", b.x)
        line.setAttribute("y2", b.y)
      }
      if (l._label) {
        l._label.setAttribute("x", (a.x + b.x) / 2)
        l._label.setAttribute("y", (a.y + b.y) / 2 - 3)
      }
    }
    for (const [gid, members] of groupMembers) {
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (const d of members) {
        const r = d.size / 2 + 10
        x0 = Math.min(x0, d.x - r)
        y0 = Math.min(y0, d.y - r)
        x1 = Math.max(x1, d.x + r)
        y1 = Math.max(y1, d.y + r)
      }
      const rect = hullEls.get(gid)
      if (rect) {
        rect.setAttribute("x", x0)
        rect.setAttribute("y", y0)
        rect.setAttribute("width", Math.max(1, x1 - x0))
        rect.setAttribute("height", Math.max(1, y1 - y0))
      }
      const t = hullTexts.get(gid)
      if (t) {
        t.setAttribute("x", (x0 + x1) / 2)
        t.setAttribute("y", y0 - 6)
      }
    }
  }

  // ---------------------------------------------------------------- zoom / fit
  const zoomBehavior = d3
    .zoom()
    .scaleExtent([0.08, 3])
    .filter((ev) => {
      if (ev.type === "wheel") return true
      if (ev.button) return false
      return !(ev.target && ev.target.closest && ev.target.closest(".gnode, .edge"))
    })
    .on("zoom", (ev) => {
      curT = ev.transform
      viewport.setAttribute("transform", ev.transform)
    })
  d3.select(svg).call(zoomBehavior).on("dblclick.zoom", null)

  const fit = () => {
    if (!simNodes.length) return
    const pad = 40
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const d of simNodes) {
      const r = d.size / 2
      x0 = Math.min(x0, (d.x ?? 0) - r)
      y0 = Math.min(y0, (d.y ?? 0) - r)
      x1 = Math.max(x1, (d.x ?? 0) + r)
      y1 = Math.max(y1, (d.y ?? 0) + r)
    }
    const bw = Math.max(1, x1 - x0)
    const bh = Math.max(1, y1 - y0)
    const k = Math.max(0.08, Math.min(3, (vw - 2 * pad) / bw, (vh - 2 * pad) / bh, 1.1))
    const tx = vw / 2 - (k * (x0 + x1)) / 2
    const ty = vh / 2 - (k * (y0 + y1)) / 2
    d3.select(svg).call(zoomBehavior.transform, d3.zoomIdentity.translate(tx, ty).scale(k))
  }

  const centerOn = (d) => {
    const k = curT ? curT.k : 1
    d3.select(svg).call(zoomBehavior.transform, d3.zoomIdentity.translate(vw / 2 - k * d.x, vh / 2 - k * d.y).scale(k))
  }

  // ---------------------------------------------------------------- drag
  const dragBehavior = d3
    .drag()
    .on("start", (ev, d) => {
      if (mode === "link") {
        grabPos = { x: d.x, y: d.y }
        linkSrcId = d.id
        d.x = ev.x
        d.y = ev.y
        d.fx = ev.x
        d.fy = ev.y
        restyle(d)
        render()
        return
      }
      if (!ev.active && !frozen) sim.alphaTarget(0.3).restart()
      d.fx = d.x
      d.fy = d.y
    })
    .on("drag", (ev, d) => {
      if (mode === "link") {
        d.x = ev.x
        d.y = ev.y
        d.fx = ev.x
        d.fy = ev.y
        render()
        return
      }
      d.fx = ev.x
      d.fy = ev.y
      if (frozen) render()
    })
    .on("end", async (ev, d) => {
      if (mode === "link") {
        linkSrcId = null
        restyle(d)
        const rad = Math.max(20, d.size / 2 + 16)
        let hit = null
        let best = rad
        for (const n of simNodes) {
          if (n.id === d.id) continue
          const dist = Math.hypot((n.x ?? 0) - ev.x, (n.y ?? 0) - ev.y)
          if (dist <= best) {
            best = dist
            hit = n
          }
        }
        if (grabPos) {
          d.x = grabPos.x
          d.y = grabPos.y
        }
        grabPos = null
        d.fx = null
        d.fy = null
        render()
        if (!hit) return
        const r = await relationDialog(d.id, { to: hit.id })
        if (r) ctx.reload()
        return
      }
      sim.alphaTarget(alphaTargetValue)
      if (frozen) sim.stop()
      if (!d.pinned) {
        d.fx = null
        d.fy = null
      }
    })
  for (const d of simNodes) d3.select(nodeEls.get(d.id)).datum(d).call(dragBehavior)

  // ---------------------------------------------------------------- decoration helpers
  const allEdgeLines = () => simLinks.map((l) => edgeEls.get(l.id))
  const clearDecor = () => {
    for (const d of simNodes) {
      const g = nodeEls.get(d.id)
      g.classList.remove("faded", "hidden")
      g.style.opacity = baseOpacity(d)
    }
    for (const e of allEdgeLines()) {
      if (!e) continue
      e.classList.remove("faded", "hidden", "path", "linksrc", "hover")
      e.style.opacity = ""
    }
    for (const l of simLinks) if (l._label) l._label.classList.add("hidden")
  }
  const highlight = (node) => {
    clearDecor()
    for (const d of simNodes) restyle(d)
    if (!node) return
    const keep = new Set([node.id])
    for (const l of simLinks) {
      const a = endId(l.source)
      const b = endId(l.target)
      if (a === node.id) keep.add(b)
      if (b === node.id) keep.add(a)
    }
    for (const d of simNodes) {
      if (keep.has(d.id)) continue
      const g = nodeEls.get(d.id)
      if (focus) g.classList.add("hidden")
      else {
        g.classList.add("faded")
        g.style.opacity = "0.1"
      }
    }
    for (const l of simLinks) {
      const a = endId(l.source)
      const b = endId(l.target)
      if (a === node.id || b === node.id) continue
      const e = edgeEls.get(l.id)
      if (e) {
        if (focus) e.classList.add("hidden")
        else e.style.opacity = "0.1"
      }
    }
  }
  const ensureEdgeLabel = (l) => {
    if (l._label) return l._label
    const t = s("text", { class: "glabel hidden" })
    t.textContent = l.label
    gEdges.append(t)
    l._label = t
    return t
  }

  // ---------------------------------------------------------------- tooltip
  const tip = h("div", { class: "graph-tip hidden" })
  document.body.append(tip)
  const showTip = (n) => {
    swap(tip, h("strong", { text: n.title }), h("div", { class: "faint", text: `${n.label || n.kind}${n.project ? ` · ${n.project}` : ""}` }), n.explain ? h("div", { text: n.explain }) : null, n.ringReason ? h("div", { class: `ring-${n.ring}`, text: n.ringReason }) : null, n.relevance !== undefined && !data.past ? h("div", { class: "faint", text: `Relevanz ${Math.round((n.relevance || 0) * 100)} / 100${n.isNew ? " · neu" : ""}` }) : null)
    tip.classList.remove("hidden")
  }

  // ---------------------------------------------------------------- modes / tools
  const setMode = (m) => {
    mode = mode === m ? "" : m
    pathA = null
    pathIds = new Set()
    clearDecor()
    for (const d of simNodes) restyle(d)
    drawTools()
    swap(modeBox, mode === "path" ? h("span", { class: "chip accent", text: "Pfad: ersten Knoten wählen" }) : mode === "link" ? h("span", { class: "chip accent", text: "Verknüpfen: Knoten auf einen anderen ziehen" }) : null)
    if (mode === "link") sim.alphaTarget(0).stop()
    else if (!frozen) sim.alphaTarget(alphaTargetValue).restart()
  }
  // Freeze / resume the automatic physics. Drag, modes, zoom and the detail
  // panel keep working while frozen – only the auto-layout pauses. Persisted as
  // `freeze=1` in the URL hash (replaceState, so the route is not rebuilt).
  const setFreeze = (v) => {
    frozen = v
    p.freeze = v
    if (frozen) sim.alphaTarget(0).stop()
    else wakeSim(false)
    drawTools()
    history.replaceState(null, "", hashOf(p))
  }
  const drawTools = () =>
    swap(
      tools,
      h("button", { class: `btn sm ${mode === "path" ? "on" : ""}`, type: "button", title: "Kürzesten Pfad zwischen zwei Knoten zeigen", onclick: () => setMode("path") }, "Pfad"),
      !data.past && !app.readOnly ? h("button", { class: `btn sm ${mode === "link" ? "on" : ""}`, type: "button", title: "Knoten auf einen anderen ziehen, um sie zu verknüpfen", onclick: () => setMode("link") }, icon("link", 12), "Verknüpfen") : null,
      h("button", { class: `btn sm ${focus ? "on" : ""}`, type: "button", title: "Nur die Umgebung des gewählten Knotens zeigen", onclick: () => {
        focus = !focus
        drawTools()
        highlight(selectedId ? byId(selectedId) : null)
      } }, "Fokus"),
      h("button", { class: `btn sm ${frozen ? "on" : ""}`, type: "button", title: frozen ? "Physik wieder in Bewegung setzen" : "Physik anhalten (Knoten bleiben stehen)", onclick: () => setFreeze(!frozen) }, frozen ? "Fortsetzen" : "Einfrieren"),
      h("button", { class: "btn sm", type: "button", title: "Ansicht speichern (Filter in diesem Browser)", onclick: async () => {
        const name = await promptDialog("Ansicht speichern", { label: "Name" })
        if (!name) return
        const list = storeGet("graphViews", [])
        list.push({ name, hash: location.hash })
        storeSet("graphViews", list.slice(-20))
        toast("Ansicht gespeichert.", { variant: "success" })
      } }, "Speichern"),
      h("button", { class: "btn sm", type: "button", title: "Als PNG exportieren", onclick: exportPng }, icon("export", 12), "PNG"),
      h("button", { class: "btn sm", type: "button", title: "Alles einpassen", onclick: fit }, "Einpassen"),
    )
  const byId = (id) => simNodes.find((d) => d.id === id) || null
  drawTools()

  const openInPanel = async (id) => {
    selectedId = id
    for (const d of simNodes) restyle(d)
    const d = byId(id)
    if (d) {
      highlight(d)
      centerOn(d)
    }
    swap(detail, h("div", { class: "loading" }, h("span", { class: "spinner" }), "Lade …"))
    try {
      const entry = await get("entry", { id })
      if (!ctx.alive()) return
      swap(
        detail,
        entryHead(entry),
        relevanceLine(entry.relevance),
        h(
          "div",
          { class: "toolbar" },
          h("a", { class: "btn primary sm", href: entryHref(id), text: "Vollansicht" }),
          entry.owned !== false && /^(skill|knowledge|glossary|error|script|memory):/.test(id) && !app.readOnly ? h("a", { class: "btn sm", href: editHref(id), text: "Bearbeiten" }) : null,
          id !== data.center ? h("a", { class: "btn sm", href: hashOf({ ...p, center: id, depth: 1, date: "" }), text: "Umgebung" }) : null,
        ),
        h("div", { class: "card" }, mdBlock(entry.body)),
        conflictsBlock(entry),
        relationsBlock(entry, {
          onOpen: (other) => (byId(other) ? openInPanel(other) : (location.hash = hashOf({ ...p, center: other, depth: 1 }))),
          onChange: data.past ? undefined : () => openInPanel(id),
        }),
        factsBlock(entry),
      )
      detail.scrollTop = 0
    } catch (err) {
      swap(detail, h("div", { class: "notice error", text: errorText(err) }))
    }
  }

  // ---------------------------------------------------------------- PNG export
  function exportPng() {
    try {
      const clone = svg.cloneNode(true)
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg")
      clone.setAttribute("width", String(vw))
      clone.setAttribute("height", String(vh))
      clone.setAttribute("viewBox", `0 0 ${vw} ${vh}`)
      const rect = s("rect", { x: 0, y: 0, width: vw, height: vh, fill: bg })
      clone.insertBefore(rect, clone.firstChild)
      for (const el of clone.querySelectorAll(".glabel")) {
        el.setAttribute("font-size", "11")
        el.setAttribute("text-anchor", "middle")
        el.setAttribute("fill", css("--text"))
        el.setAttribute("stroke", bg)
        el.setAttribute("stroke-width", "2")
        el.setAttribute("paint-order", "stroke")
      }
      for (const el of clone.querySelectorAll(".gnode circle")) el.setAttribute("stroke", css("--border-strong"))
      for (const el of clone.querySelectorAll(".gnode.center circle")) el.setAttribute("stroke", accent)
      for (const el of clone.querySelectorAll(".hulls rect")) {
        el.setAttribute("fill", "none")
        el.setAttribute("stroke", css("--border-strong"))
        el.setAttribute("stroke-dasharray", "5 4")
      }
      const src = new XMLSerializer().serializeToString(clone)
      const url = URL.createObjectURL(new Blob([src], { type: "image/svg+xml;charset=utf-8" }))
      const img = new Image()
      img.onload = () => {
        const c = document.createElement("canvas")
        c.width = vw * 2
        c.height = vh * 2
        const g = c.getContext("2d")
        g.scale(2, 2)
        g.drawImage(img, 0, 0)
        URL.revokeObjectURL(url)
        c.toBlob((blob) => blob && saveBlob(blob, `graph-${today()}.png`), "image/png")
      }
      img.onerror = () => URL.revokeObjectURL(url)
      img.src = url
    } catch (_) {
      toast("PNG-Export nicht möglich.", { variant: "warning" })
    }
  }

  // ---------------------------------------------------------------- node events
  for (const d of simNodes) {
    const g = nodeEls.get(d.id)
    const raw = rawById.get(d.id)
    g.addEventListener("mouseenter", () => {
      hoverId = d.id
      restyle(d)
      if (raw) showTip(raw)
    })
    g.addEventListener("mousemove", (ev) => {
      tip.style.left = `${ev.clientX + 14}px`
      tip.style.top = `${ev.clientY + 12}px`
    })
    g.addEventListener("mouseleave", () => {
      hoverId = null
      restyle(d)
      tip.classList.add("hidden")
    })
    g.addEventListener("click", async (ev) => {
      if (ev.altKey) {
        d.pinned = !d.pinned
        d.fx = d.pinned ? d.x : null
        d.fy = d.pinned ? d.y : null
        if (d.pinned) {
          if (!frozen) sim.alphaTarget(0.3).restart()
        } else if (!frozen) sim.alphaTarget(alphaTargetValue)
        return
      }
      if (mode === "link") return
      if (mode === "path") {
        if (!pathA) {
          pathA = d.id
          pathIds = new Set([d.id])
          clearDecor()
          for (const n of simNodes) restyle(n)
          swap(modeBox, h("span", { class: "chip accent", text: "Pfad: zweiten Knoten wählen" }))
          return
        }
        const r = await get("graph/path", { a: pathA, b: d.id })
        if (!r.found) {
          swap(modeBox, h("span", { class: "chip warn", text: "Kein Pfad zwischen den beiden Knoten." }))
          pathA = null
          pathIds = new Set()
          clearDecor()
          for (const n of simNodes) restyle(n)
          return
        }
        const ids = new Set([pathA, d.id])
        for (const ed of r.edges) {
          ids.add(ed.from)
          ids.add(ed.to)
        }
        pathIds = ids
        clearDecor()
        for (const n of simNodes) {
          restyle(n)
          if (!ids.has(n.id)) nodeEls.get(n.id).style.opacity = "0.1"
        }
        for (const l of simLinks) {
          const a = endId(l.source)
          const b = endId(l.target)
          const onPath = r.edges.some((x) => (x.from === a && x.to === b) || (x.to === a && x.from === b))
          const e = edgeEls.get(l.id)
          if (!e) continue
          if (onPath) {
            e.classList.add("path")
            e.style.opacity = "1"
          } else {
            e.style.opacity = "0.1"
          }
        }
        swap(modeBox, h("span", { class: "chip accent", text: `Pfad: ${r.edges.length} Schritt${r.edges.length === 1 ? "" : "e"} – ${r.edges.map((x) => x.label).join(" → ")}` }))
        pathA = null
        return
      }
      openInPanel(d.id)
    })
    g.addEventListener("dblclick", (ev) => {
      ev.preventDefault()
      location.hash = hashOf({ ...p, center: d.id, depth: 1, date: "" })
    })
  }

  for (const l of simLinks) {
    const g = edgeGs.get(l.id)
    const vis = edgeEls.get(l.id)
    g.addEventListener("click", (ev) => {
      ev.stopPropagation()
      const a = endId(l.source)
      const b = endId(l.target)
      const an = byId(a)
      const bn = byId(b)
      highlight(null)
      const lbl = ensureEdgeLabel(l)
      lbl.classList.remove("hidden")
      if (an && bn) {
        lbl.setAttribute("x", (an.x + bn.x) / 2)
        lbl.setAttribute("y", (an.y + bn.y) / 2 - 3)
      }
      swap(
        detail,
        h("h3", { text: "Verknüpfung" }),
        h("h1", { text: l.label }),
        h("p", { class: "muted", text: `Stärke ${Number(l.strength).toFixed(2)}${l.derived ? " · abgeleitet" : ""}${l.src ? ` · ${l.src}` : ""}` }),
        l.description ? h("p", { text: l.description }) : null,
        h("div", { class: "list" }, h("a", { class: "rel", href: entryHref(a), onclick: (e2) => (e2.preventDefault(), openInPanel(a)) }, h("div", { class: "rel-top", text: "von" }), h("div", { class: "rel-title", text: an?.label || a })), h("a", { class: "rel", href: entryHref(b), onclick: (e2) => (e2.preventDefault(), openInPanel(b)) }, h("div", { class: "rel-top", text: "zu" }), h("div", { class: "rel-title", text: bn?.label || b }))),
      )
    })
    g.addEventListener("mouseenter", () => vis && vis.classList.add("hover"))
    g.addEventListener("mouseleave", () => vis && vis.classList.remove("hover"))
  }

  svg.addEventListener("click", (ev) => {
    if (ev.target === svg || ev.target.classList.contains("viewport") || ev.target.classList.contains("gedges") || ev.target.classList.contains("gnodes") || ev.target.classList.contains("hulls")) {
      selectedId = null
      for (const d of simNodes) restyle(d)
      highlight(null)
    }
  })

  // ---------------------------------------------------------------- lifecycle
  // deterministic warmup without per-tick DOM writes, then start the live loop
  const warm = Math.min(200, Math.max(20, simNodes.length * 2))
  for (let i = 0; i < warm; i++) sim.tick()
  sim.alpha(0.9)
  render()
  fit()
  requestAnimationFrame(fit)

  sim.on("tick", render)
  if (frozen) sim.stop()
  else sim.alphaTarget(alphaTargetValue).restart()

  const ro = new ResizeObserver(() => {
    vw = main.clientWidth || vw
    vh = main.clientHeight || vh
    applyForces(p)
    if (!frozen) sim.alpha(Math.max(sim.alpha(), 0.3)).restart()
  })
  ro.observe(main)

  ctx.cleanup(() => {
    sim.stop()
    ro.disconnect()
    tip.remove()
    delete window.__smithGraph
  })

  if (data.center) openInPanel(data.center)

  // ---------------------------------------------------------------- test hook
  window.__smithGraph = { nodes: () => simNodes, links: () => simLinks, simulation: () => sim, params: () => p, config: () => ({ ...p }), applyForces }
}
