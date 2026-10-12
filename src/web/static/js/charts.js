// Charts: time series with uPlot (vendored, loaded lazily), bars, heatmap, calendar,
// stacked areas and sparklines as own SVGs. Every chart can export its data as CSV.
import { saveBlob } from "./api.js"
import { css, fmtNum, h, icon, s } from "./dom.js"

let uplotP = null
export function loadUplot() {
  uplotP ??= new Promise((resolve, reject) => {
    if (window.uPlot) return resolve(window.uPlot)
    const el = document.createElement("script")
    el.src = "vendor/uplot.min.js"
    el.onload = () => resolve(window.uPlot)
    el.onerror = () => reject(new Error("uPlot nicht geladen"))
    document.head.append(el)
  })
  return uplotP
}

export const PALETTE = ["--accent", "--k-knowledge", "--k-script", "--k-memory", "--k-error", "--k-arbeitsstand", "--k-vorgabe", "--k-ergebnis", "--k-glossary", "--k-task"]
export const colorAt = (i) => css(PALETTE[i % PALETTE.length]) || "#3563e9"

const shortDay = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d)
  return m ? `${Number(m[3])}.${Number(m[2])}.` : d
}

/** CSV export button for a chart. rows: () => [[header…], [values…]…] */
export function csvButton(name, rows) {
  return h(
    "button",
    {
      class: "btn sm ghost csv",
      type: "button",
      title: "Als CSV exportieren",
      onclick: () => {
        const data = rows()
        const text = data.map((r) => r.map((c) => (/[",;\n]/.test(String(c ?? "")) ? `"${String(c).replace(/"/g, '""')}"` : String(c ?? ""))).join(";")).join("\n")
        saveBlob(new Blob([`﻿${text}`], { type: "text/csv;charset=utf-8" }), `${name}.csv`)
      },
    },
    icon("export", 13),
    "CSV",
  )
}

/** Chart card: title, optional legend, chart, CSV export. */
export function chartCard(title, chart, csvName, csvRows, legend) {
  return h("div", { class: "card chart-card" }, h("h3", { text: title }), csvName ? csvButton(csvName, csvRows) : null, chart, legend || null)
}

export function legendOf(series) {
  return h(
    "div",
    { class: "legend" },
    series.map((sr, i) => {
      const sw = h("i", { class: "swatch" })
      sw.style.background = sr.color || colorAt(i)
      return h("span", null, sw, sr.name)
    }),
  )
}

/**
 * Line chart over buckets (days or weeks) with uPlot.
 * series: [{name, values, color?}]; onClick(index)
 */
export function lineChart(labels, series, { height = 220, onClick, fmt = (v) => fmtNum(v, 1) } = {}) {
  const el = h("div", { class: "chart" })
  loadUplot()
    .then((uPlot) => {
      const width = Math.max(260, el.clientWidth || el.parentElement?.clientWidth || 600)
      const axis = { stroke: css("--muted"), grid: { stroke: css("--border"), width: 1 }, ticks: { stroke: css("--border") } }
      const opts = {
        width,
        height,
        scales: { x: { time: false } },
        legend: { show: true },
        cursor: { points: { size: 6 } },
        axes: [
          { ...axis, values: (_u, splits) => splits.map((i) => (Number.isInteger(i) && labels[i] ? shortDay(labels[i]) : "")) },
          { ...axis, values: (_u, splits) => splits.map((v) => fmt(v)), size: 50 },
        ],
        series: [{ label: "Tag", value: (_u, i) => (i === null || i === undefined ? "" : labels[Math.round(i)] ?? "") }, ...series.map((sr, i) => ({ label: sr.name, stroke: sr.color || colorAt(i), width: 2, fill: series.length === 1 ? `${sr.color || colorAt(i)}22` : undefined, points: { show: labels.length < 40 }, value: (_u, v) => (v === null ? "–" : fmt(v)) }))],
      }
      const data = [labels.map((_l, i) => i), ...series.map((sr) => sr.values.map((v) => (v === null || v === undefined ? null : Number(v))))]
      const plot = new uPlot(opts, data, el)
      if (onClick) {
        plot.over.style.cursor = "pointer"
        plot.over.addEventListener("click", () => {
          const i = plot.cursor.idx
          if (i !== null && i !== undefined) onClick(i)
        })
      }
      const ro = new ResizeObserver(() => {
        const w = el.clientWidth
        if (w && Math.abs(w - plot.width) > 4) plot.setSize({ width: w, height })
      })
      ro.observe(el)
    })
    .catch(() => el.append(h("div", { class: "faint", text: "Diagramm-Bibliothek nicht geladen." })))
  return el
}

/** Stacked bars (SVG). series: [{name, values, color?}] */
export function barChart(labels, series, { height = 200, onClick, stacked = true } = {}) {
  const W = Math.max(labels.length * 14, 300)
  const H = height
  const pad = { l: 36, r: 6, t: 8, b: 22 }
  const totals = labels.map((_l, i) => (stacked ? series.reduce((n, sr) => n + (Number(sr.values[i]) || 0), 0) : Math.max(...series.map((sr) => Number(sr.values[i]) || 0))))
  const max = Math.max(1, ...totals)
  const bw = (W - pad.l - pad.r) / Math.max(1, labels.length)
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max)
  const svg = s("svg", { class: "bars", viewBox: `0 0 ${W} ${H}`, width: "100%", height: H, preserveAspectRatio: "none" })
  for (const t of [0, 0.5, 1]) {
    const v = max * t
    svg.append(s("line", { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), stroke: css("--border"), "stroke-width": 1 }))
    svg.append(s("text", { x: pad.l - 4, y: y(v) + 3, "text-anchor": "end", "font-size": 9, text: fmtNum(v, v < 10 ? 1 : 0) }))
  }
  labels.forEach((label, i) => {
    let acc = 0
    series.forEach((sr, k) => {
      const v = Number(sr.values[i]) || 0
      if (!v) return
      const x = pad.l + i * bw + (stacked ? 0 : (k * bw) / series.length)
      const w = stacked ? bw : bw / series.length
      const top = y(stacked ? acc + v : v)
      const bottom = y(stacked ? acc : 0)
      const r = s("rect", { x: x + 0.5, y: top, width: Math.max(1, w - 1.5), height: Math.max(0.5, bottom - top), fill: sr.color || colorAt(k), rx: 1.5 }, s("title", { text: `${label}: ${sr.name} ${fmtNum(v, 2)}` }))
      if (onClick) r.addEventListener("click", () => onClick(i, k))
      svg.append(r)
      if (stacked) acc += v
    })
    const every = Math.ceil(labels.length / 10)
    if (i % every === 0) svg.append(s("text", { x: pad.l + i * bw + bw / 2, y: H - 6, "text-anchor": "middle", "font-size": 9, text: shortDay(label) }))
  })
  return svg
}

/** Weekday × hour heatmap. grid[7][24], Monday first. */
export function heatmap(grid, { onClick } = {}) {
  const days = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]
  const cell = 18
  const W = 30 + 24 * cell
  const H = 18 + 7 * cell
  const max = Math.max(1, ...grid.flat())
  const svg = s("svg", { class: "heat", viewBox: `0 0 ${W} ${H}`, width: "100%", style: `max-width:${W * 1.6}px` })
  const accent = css("--accent")
  for (let hr = 0; hr < 24; hr += 3) svg.append(s("text", { x: 30 + hr * cell + cell / 2, y: 11, "text-anchor": "middle", "font-size": 9, text: String(hr) }))
  grid.forEach((row, d) => {
    svg.append(s("text", { x: 24, y: 18 + d * cell + cell / 2 + 3, "text-anchor": "end", "font-size": 9, text: days[d] }))
    row.forEach((v, hr) => {
      const r = s("rect", { x: 30 + hr * cell + 1, y: 18 + d * cell + 1, width: cell - 2, height: cell - 2, rx: 3, fill: v ? accent : css("--panel-3"), "fill-opacity": v ? 0.15 + 0.85 * (v / max) : 1 }, s("title", { text: `${days[d]} ${hr}–${hr + 1} Uhr: ${fmtNum(v)}` }))
      if (onClick) r.addEventListener("click", () => onClick(d, hr))
      svg.append(r)
    })
  })
  return svg
}

/** Activity calendar like on GitHub. days: [{day, n}] (oldest first). */
export function calendar(days, { onClick } = {}) {
  if (!days.length) return h("div", { class: "faint", text: "Keine Daten." })
  const cell = 12
  const first = new Date(`${days[0].day}T12:00:00`)
  const offset = (first.getDay() + 6) % 7
  const weeks = Math.ceil((days.length + offset) / 7)
  const W = 26 + weeks * cell
  const H = 16 + 7 * cell
  const max = Math.max(1, ...days.map((d) => d.n))
  const accent = css("--ok")
  const svg = s("svg", { class: "cal", viewBox: `0 0 ${W} ${H}`, width: "100%" })
  let lastMonth = -1
  days.forEach((d, i) => {
    const pos = i + offset
    const wk = Math.floor(pos / 7)
    const wd = pos % 7
    const dt = new Date(`${d.day}T12:00:00`)
    if (wd === 0 && dt.getMonth() !== lastMonth) {
      lastMonth = dt.getMonth()
      svg.append(s("text", { x: 26 + wk * cell, y: 10, "font-size": 9, text: dt.toLocaleString("de-DE", { month: "short" }) }))
    }
    const r = s("rect", { x: 26 + wk * cell + 1, y: 16 + wd * cell + 1, width: cell - 2, height: cell - 2, rx: 2, fill: d.n ? accent : css("--panel-3"), "fill-opacity": d.n ? 0.25 + 0.75 * Math.sqrt(d.n / max) : 1 }, s("title", { text: `${d.day}: ${fmtNum(d.n)} Ereignisse` }))
    if (onClick) r.addEventListener("click", () => onClick(d.day))
    svg.append(r)
  })
  for (const [i, l] of [
    [0, "Mo"],
    [2, "Mi"],
    [4, "Fr"],
  ])
    svg.append(s("text", { x: 20, y: 16 + i * cell + 9, "text-anchor": "end", "font-size": 8, text: l }))
  return svg
}

/** Stacked area (cumulative flow). series: [{name, values}] stacked bottom-up. */
export function areaChart(labels, series, { height = 220 } = {}) {
  const W = 640
  const H = height
  const pad = { l: 34, r: 6, t: 8, b: 22 }
  const n = labels.length
  const sums = labels.map((_l, i) => series.reduce((a, sr) => a + (Number(sr.values[i]) || 0), 0))
  const max = Math.max(1, ...sums)
  const x = (i) => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - pad.l - pad.r))
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max)
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", preserveAspectRatio: "none", height: H })
  const base = new Array(n).fill(0)
  series.forEach((sr, k) => {
    const top = base.map((b, i) => b + (Number(sr.values[i]) || 0))
    const pts = [...top.map((v, i) => `${x(i)},${y(v)}`), ...base.map((v, i) => `${x(i)},${y(v)}`).reverse()].join(" ")
    svg.append(s("polygon", { points: pts, fill: sr.color || colorAt(k), "fill-opacity": 0.75 }, s("title", { text: sr.name })))
    for (let i = 0; i < n; i++) base[i] = top[i]
  })
  const every = Math.ceil(n / 8)
  labels.forEach((l, i) => i % every === 0 && svg.append(s("text", { x: x(i), y: H - 6, "text-anchor": "middle", "font-size": 9, text: shortDay(l) })))
  svg.append(s("text", { x: pad.l - 4, y: y(max) + 3, "text-anchor": "end", "font-size": 9, text: fmtNum(max) }))
  return svg
}

/** Small inline curve (lists, relevance). */
export function sparkline(values, { w = 80, h: H = 22, color } = {}) {
  const vals = values.map((v) => Number(v) || 0)
  const max = Math.max(...vals, 0.0001)
  const pts = vals.map((v, i) => `${(i / Math.max(1, vals.length - 1)) * (w - 2) + 1},${H - 2 - (v / max) * (H - 4)}`).join(" ")
  return s("svg", { class: "spark", width: w, height: H, viewBox: `0 0 ${w} ${H}` }, s("polyline", { points: pts, fill: "none", stroke: color || css("--accent"), "stroke-width": 1.5, "stroke-linejoin": "round" }))
}

/** Horizontal bars as rows. rows: [{label, value, href?, title?}] */
export function hbars(rows, { fmt = (v) => fmtNum(v), alt = false } = {}) {
  const max = Math.max(1, ...rows.map((r) => Number(r.value) || 0))
  if (!rows.length) return h("div", { class: "faint", text: "Keine Daten im Zeitraum." })
  return h(
    "div",
    null,
    rows.map((r) => {
      const bar = h("div", { class: `bar${alt ? " alt" : ""}` })
      bar.style.width = `${Math.max(1, ((Number(r.value) || 0) / max) * 100)}%`
      return h("div", { class: "bar-row", title: r.title || "" }, r.href ? h("a", { class: "ellipsis", href: r.href, text: r.label }) : h("span", { class: "ellipsis", text: r.label }), h("div", null, bar), h("span", { class: "right mono", text: fmt(r.value) }))
    }),
  )
}
