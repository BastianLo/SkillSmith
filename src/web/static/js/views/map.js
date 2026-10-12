import { get } from "../api.js"
import { KIND_PLURAL, colorOf, entryHref, h, kindChip, put, s, swap } from "../dom.js"
import { act, app } from "../ui.js"

export default async function semanticMap(ctx) {
  ctx.title("Landkarte")
  const page = h("div", { class: "page wide", style: { maxWidth: "none" } })
  const wrapEl = h("div", { class: "map-wrap" })
  const side = h("div", { class: "stack" })
  put(page, h("div", { class: "page-head" }, h("div", { class: "grow" }, h("h1", { text: "Semantische Landkarte" }), h("div", { class: "muted", text: "Jeder Punkt ist ein Eintrag; nahe Punkte sind inhaltlich ähnlich. Themeninseln, Duplikate (gestrichelt verbunden) und Lücken werden sichtbar. Ziehen verschiebt, Mausrad zoomt." }))), h("div", { class: "cols" }, wrapEl, side))
  ctx.el.replaceChildren(page)
  swap(wrapEl, h("div", { class: "loading", style: { padding: "20px" } }, h("span", { class: "spinner" }), "Projektion wird berechnet …"))
  const data = await get("map")
  if (!ctx.alive()) return
  if (!data.points.length) {
    swap(wrapEl, h("div", { class: "empty", style: { padding: "30px" }, text: "Zu wenige Einträge für eine Landkarte (mindestens drei mit gemeinsamen Begriffen)." }))
    return
  }
  const W = 1000
  const H = 700
  const pad = 30
  // half linear, half rank: clusters spread out, outliers do not squeeze the rest
  const rankOf = (key) => {
    const sorted = [...data.points].sort((a, b) => a[key] - b[key])
    const m = new Map(sorted.map((pt, i) => [pt.id, sorted.length > 1 ? i / (sorted.length - 1) : 0.5]))
    return (pt) => m.get(pt.id)
  }
  const rx = rankOf("x")
  const ry = rankOf("y")
  for (const pt of data.points) {
    pt.sx = 0.5 * pt.x + 0.5 * rx(pt)
    pt.sy = 0.5 * pt.y + 0.5 * ry(pt)
  }
  const X = (pt) => pad + pt.sx * (W - 2 * pad)
  const Y = (pt) => pad + (1 - pt.sy) * (H - 2 * pad)
  let vb = { x: 0, y: 0, w: W, h: H }
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Semantische Landkarte" })
  const byId = new Map(data.points.map((pt) => [pt.id, pt]))
  const kinds = [...new Set(data.points.map((pt) => pt.kind))]
  const hidden = new Set()
  const gLines = s("g")
  const gDots = s("g")
  const gLabels = s("g")
  svg.append(gLines, gDots, gLabels)
  let labels = data.points.length <= 120
  const draw = () => {
    swap(gLines)
    swap(gDots)
    swap(gLabels)
    for (const n of data.neighbours) {
      const a = byId.get(n.a)
      const b = byId.get(n.b)
      if (!a || !b || hidden.has(a.kind) || hidden.has(b.kind)) continue
      gLines.append(s("line", { x1: X(a), y1: Y(a), x2: X(b), y2: Y(b), stroke: "var(--danger)", "stroke-width": 1.2, "stroke-dasharray": "4 3", opacity: 0.7 }, s("title", { text: `Ähnlichkeit ${n.similarity}` })))
    }
    for (const pt of data.points) {
      if (hidden.has(pt.kind)) continue
      const c = s("circle", { cx: X(pt), cy: Y(pt), r: 6, fill: colorOf(pt.kind), stroke: "var(--panel)", "stroke-width": 1.5, opacity: pt.tier === "archive" ? 0.4 : 0.9 }, s("title", { text: `${pt.title} (${KIND_PLURAL[pt.kind] || pt.kind})` }))
      c.addEventListener("click", () => (location.hash = entryHref(pt.id)))
      gDots.append(c)
      if (labels) gLabels.append(s("text", { x: X(pt) + 8, y: Y(pt) + 3, text: pt.title.length > 32 ? `${pt.title.slice(0, 30)}…` : pt.title }))
    }
  }
  draw()
  // pan and zoom via the viewBox
  let drag = null
  svg.addEventListener("mousedown", (e) => {
    if (e.target.tagName === "circle") return
    drag = { x: e.clientX, y: e.clientY, vb: { ...vb } }
    svg.style.cursor = "grabbing"
  })
  const onMove = (e) => {
    if (!drag) return
    const r = svg.getBoundingClientRect()
    vb.x = drag.vb.x - ((e.clientX - drag.x) * vb.w) / r.width
    vb.y = drag.vb.y - ((e.clientY - drag.y) * vb.h) / r.height
    svg.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`)
  }
  const onUp = () => {
    drag = null
    svg.style.cursor = ""
  }
  window.addEventListener("mousemove", onMove)
  window.addEventListener("mouseup", onUp)
  ctx.cleanup(() => {
    window.removeEventListener("mousemove", onMove)
    window.removeEventListener("mouseup", onUp)
  })
  svg.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault()
      const r = svg.getBoundingClientRect()
      const k = e.deltaY > 0 ? 1.15 : 1 / 1.15
      const mx = vb.x + ((e.clientX - r.left) / r.width) * vb.w
      const my = vb.y + ((e.clientY - r.top) / r.height) * vb.h
      vb = { x: mx - (mx - vb.x) * k, y: my - (my - vb.y) * k, w: vb.w * k, h: vb.h * k }
      svg.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`)
    },
    { passive: false },
  )
  swap(wrapEl, svg)
  put(
    side,
    h(
      "div",
      { class: "card" },
      h("h3", { text: "Darstellung" }),
      h("div", { class: "muted", style: { marginBottom: "8px" }, text: data.mode === "embeddings" ? "Grundlage: Embeddings (Bedeutung)." : "Grundlage: Begriffe (TF-IDF) – ohne Embeddings gröber." }),
      kinds.map((k) => {
        const cb = h("input", { type: "checkbox", checked: true })
        cb.addEventListener("change", () => {
          if (cb.checked) hidden.delete(k)
          else hidden.add(k)
          draw()
        })
        const sw = h("span", { class: "swatch" })
        sw.style.background = colorOf(k)
        return h("label", { class: "check", style: { display: "flex" } }, cb, sw, `${KIND_PLURAL[k] || k} (${data.points.filter((x) => x.kind === k).length})`)
      }),
      h("label", { class: "check", style: { display: "flex", marginTop: "6px" } }, h("input", { type: "checkbox", checked: labels, onchange: (e) => ((labels = e.target.checked), draw()) }), "Beschriftungen"),
      h("button", { class: "btn sm", type: "button", text: "Ansicht zurücksetzen", style: { marginTop: "8px" }, onclick: () => ((vb = { x: 0, y: 0, w: W, h: H }), svg.setAttribute("viewBox", `0 0 ${W} ${H}`)) }),
    ),
    h(
      "div",
      { class: "card" },
      h("h3", { text: `Mögliche Duplikate (${data.neighbours.length})` }),
      data.neighbours.length
        ? h(
            "div",
            { class: "stack", style: { gap: "8px" } },
            data.neighbours.slice(0, 30).map((n) => {
              const a = byId.get(n.a)
              const b = byId.get(n.b)
              return h(
                "div",
                { style: { fontSize: "13px" } },
                h("div", null, kindChip(a, true), " ", h("a", { href: entryHref(a.id), text: a.title })),
                h("div", null, kindChip(b, true), " ", h("a", { href: entryHref(b.id), text: b.title })),
                h("div", { class: "row-flex" }, h("span", { class: "faint", text: `Ähnlichkeit ${n.similarity}` }), app.readOnly ? null : h("button", { class: "btn sm", type: "button", text: "Doktor prüfen lassen", onclick: () => act("doctor.checkPair", { a: a.id, b: b.id }) })),
              )
            }),
          )
        : h("div", { class: "faint", text: "Keine auffällig ähnlichen Paare." }),
    ),
  )
}
