// DOM helpers, labels, colors, formatting and icons. No innerHTML except escaped markdown.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag)
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue
      if (k === "class") el.className = v
      else if (k === "text") el.textContent = v
      else if (k === "html") el.innerHTML = v // only escaped/rendered markdown
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v)
      else if (k === "dataset") Object.assign(el.dataset, v)
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v)
      else if (k === "value" && (tag === "input" || tag === "textarea" || tag === "select")) el.value = v
      else if (k === "checked" || k === "disabled" || k === "selected" || k === "multiple") el[k] = !!v
      else el.setAttribute(k, v === true ? "" : String(v))
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue
    el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return el
}

const kids = (xs) => xs.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false)
export const put = (parent, ...xs) => {
  parent.append(...kids(xs))
  return parent
}
export const swap = (parent, ...xs) => {
  parent.replaceChildren(...kids(xs))
  return parent
}

const SVG = "http://www.w3.org/2000/svg"
export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG, tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v)
    else if (k === "text") el.textContent = v
    else el.setAttribute(k, String(v))
  }
  for (const c of children.flat(Infinity)) if (c) el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  return el
}

// ---------------------------------------------------------------------------
// icons (24px stroke icons, drawn for this app)
// ---------------------------------------------------------------------------
const ICONS = {
  menu: "M4 6h16M4 12h16M4 18h16",
  logo: "M12 2l3 6 6 1-4.5 4.3 1 6.2L12 16.6 6.5 19.5l1-6.2L3 9l6-1z",
  home: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  inbox: "M3 13h5l1.5 3h5L16 13h5M5 5h14l2 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z",
  doc: "M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 3v5h5M9 13h6M9 17h6",
  search: "M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM21 21l-5-5",
  graph: "M6 6a2 2 0 1 0 0-.01M18 6a2 2 0 1 0 0-.01M12 18a2 2 0 1 0 0-.01M7.5 7.3l3.4 9M16.5 7.3l-3.4 9M8 6h8",
  map: "M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3zM9 3v15M15 6v15",
  board: "M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z",
  folder: "M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z",
  task: "M4 5h16v14H4zM8 12l2.5 2.5L16 9",
  project: "M4 7h16v12H4zM9 7V4h6v3",
  agent: "M8 8h8a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-5a3 3 0 0 1 3-3zM12 4v4M9.5 13h.01M14.5 13h.01M2 13v2M22 13v2",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  audit: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4",
  history: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2",
  conflict: "M12 3l10 17H2zM12 10v4M12 17h.01",
  flask: "M9 3h6M10 3v6L4.5 18.5A1.5 1.5 0 0 0 5.8 21h12.4a1.5 1.5 0 0 0 1.3-2.5L14 9V3M7 15h10",
  book: "M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-6a3 3 0 0 0-3 3",
  tag: "M3 12V4h8l10 10-8 8zM7.5 7.5h.01",
  chat: "M4 5h16v11H8l-4 4z",
  export: "M12 3v12M7 10l5 5 5-5M4 21h16",
  settings: "M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z",
  skill: "M13 2L4 14h7l-1 8 9-12h-7z",
  error: "M8 8a4 4 0 0 1 8 0v6a4 4 0 0 1-8 0zM12 12v5M3 13h5M16 13h5M4 7l3 2M20 7l-3 2M4 19l3-2M20 19l-3-2",
  script: "M4 5h16v14H4zM8 10l2 2-2 2M12 14h4",
  memory: "M6 3h12v18l-6-4-6 4z",
  state: "M5 21V4h11l-2 4 2 4H5",
  result: "M4 8l8-4 8 4v8l-8 4-8-4zM4 8l8 4 8-4M12 12v8",
  plus: "M12 5v14M5 12h14",
  edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  archive: "M3 4h18v4H3zM5 8v12h14V8M10 12h4",
  pin: "M9 4h6l-1 6 3 3H7l3-3zM12 13v8",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  undo: "M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3",
  check: "M5 12l5 5L20 7",
  x: "M6 6l12 12M18 6L6 18",
  play: "M7 4l13 8-13 8z",
  stop: "M6 6h12v12H6z",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z",
  lock: "M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4",
  upload: "M12 21V9M7 14l5-5 5 5M4 3h16",
  calendar: "M4 6h16v15H4zM4 10h16M8 3v4M16 3v4",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  note: "M5 4h14v16l-4-3H5zM9 9h6M9 13h4",
  bolt: "M13 2L4 14h7l-1 8 9-12h-7z",
  check2: "M20 6L9 17l-5-5",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  copy: "M8 8h12v12H8zM4 16V4h12",
  branch: "M6 3v12M18 9a3 3 0 1 1 0-.01M6 18a3 3 0 1 1 0 .01M18 9c0 6-12 3-12 9",
  ticket: "M3 8a2 2 0 0 0 0 4v4h18v-4a2 2 0 0 1 0-4V4H3zM14 4v16",
  candidate: "M12 3v3M12 18v3M3 12h3M18 12h3M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z",
  staged: "M5 3h14v18H5zM9 8h6M9 12h6M9 16h3",
  journal: "M6 3h12v18H6zM9 3v18M12 8h4M12 12h4",
  workshop: "M14 7l3-3 3 3-3 3M3 21l9-9M8 8L4 4M10 14l-6 6",
  sun: "M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  moon: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z",
  chevron: "M9 6l6 6-6 6",
  bell: "M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0",
  belloff: "M6 16V11a6 6 0 0 1 9.5-4.9M18 11v5l2 2H8M10 20a2 2 0 0 0 4 0M3 3l18 18",
  pause: "M7 5h3v14H7zM14 5h3v14h-3z",
  filter: "M3 5h18l-7 8v6l-4 2v-8z",
  layers: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
  code: "M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16",
  gym: "M4 9v6M7 7v10M17 7v10M20 9v6M7 12h10",
  import: "M12 3v12M7 10l5 5 5-5M4 15v5h16v-5",
  snippet: "M8 7l-5 5 5 5M16 7l5 5-5 5",
  office: "M3 4h18v12H3zM8 20h8M12 16v4M7 8h6M7 11h10",
  back: "M15 18l-6-6 6-6",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  info: "M12 3a9 9 0 100 18 9 9 0 000-18zM12 11v6M12 7.5v.5",
  spark: "M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z",
  prompt: "M4 5h16v11H8l-4 4zM8 9h8M8 12h5",
  github: "M9 19c-4 1.5-4-2-6-2.5M15 21v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21",
}

export function icon(name, size = 16) {
  const d = ICONS[name] || ICONS.doc
  return s("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, s("path", { d }))
}

// ---------------------------------------------------------------------------
// labels and colors
// ---------------------------------------------------------------------------
export const KIND_LABEL = {
  skill: "Skill",
  knowledge: "Wissen",
  glossary: "Glossar",
  error: "Fehler",
  script: "Skript",
  memory: "Erinnerung",
  task: "Aufgabe",
  project: "Projekt",
  arbeitsstand: "Arbeitsstand",
  ergebnis: "Ergebnis",
  session: "Session",
  code: "Code",
  snippet: "Snippet",
  prompt: "Prompt",
  office: "Office",
  agent: "Agent",
  settings: "Einstellung",
}
export const KIND_PLURAL = {
  skill: "Skills",
  knowledge: "Wissen",
  glossary: "Glossar",
  error: "Fehler",
  script: "Skripte",
  memory: "Erinnerungen",
  task: "Aufgaben",
  project: "Projekte",
  arbeitsstand: "Arbeitsstände",
  ergebnis: "Ergebnisse",
  session: "Sessions",
  code: "Code-Dateien",
  snippet: "Snippets",
  prompt: "Prompts",
  office: "Office-Dokumente",
  agent: "Agenten",
}
export const KIND_ICON = { skill: "skill", knowledge: "doc", glossary: "book", error: "error", script: "script", memory: "memory", task: "task", project: "project", arbeitsstand: "state", ergebnis: "result", session: "chat", agent: "agent", code: "code", snippet: "snippet", prompt: "prompt", office: "office" }
export const MEMORY_TYPES = { entscheidung: "Entscheidung", vorgabe: "Vorgabe", erfahrung: "Erfahrung" }
export const MEMORY_PLURAL = { entscheidung: "Entscheidungen", vorgabe: "Vorgaben", erfahrung: "Erfahrungen" }
export const STORE_KINDS = ["skill", "knowledge", "glossary", "error", "script", "memory", "task", "project"]
export const AI_ACCESS = {
  frei: { label: "frei", desc: "KI darf ändern (mit den üblichen Prüfungen)" },
  vorschlag: { label: "Vorschlag", desc: "KI-Änderungen nur als Vorschlag mit Diff" },
  lesen: { label: "nur lesen", desc: "KI darf nichts ändern, nur Hinweise geben" },
  privat: { label: "privat", desc: "für die KI unsichtbar, keine Embeddings" },
}
export const RELATION_TYPES = {
  related: "verwandt",
  supplements: "ergänzt",
  duplicates: "Duplikat von",
  contradicts: "widerspricht",
  supersedes: "löst ab",
  depends_on: "setzt voraus",
  part_of: "gehört zu",
  solves: "löst",
  caused_by: "verursacht durch",
  derived_from: "abgeleitet aus",
  uses: "nutzt",
  example_of: "Beispiel für",
  references: "verweist auf",
}
export const SYMMETRIC = new Set(["not_related", "related", "duplicates", "contradicts"])
export const EDGE_COLOR = {
  related: "#8a94a3",
  supplements: "#0f9f8f",
  duplicates: "#7c8594",
  contradicts: "#d93f43",
  supersedes: "#c27c0e",
  depends_on: "#3b6cf6",
  part_of: "#2f9e5b",
  solves: "#2f855a",
  caused_by: "#e0686b",
  derived_from: "#94a0b2",
  uses: "#d98a0b",
  example_of: "#8b46c8",
  references: "#5b8def",
}
export const SOURCE_LABEL = { doctor: "Doktor", reviewer: "Reviewer", deterministic: "abgeleitet", user: "Sie", links: "Link" }
export const STATUS_LABEL = {
  gueltig: "gültig",
  vorgeschlagen: "vorgeschlagen",
  abgeloest: "abgelöst",
  abgelaufen: "abgelaufen",
  solved: "gelöst",
  open: "offen",
  needs_user: "Entscheidung nötig",
  resolved: "gelöst",
}
export const ACTOR_LABEL = { web: "Sie (Web)", command: "Sie (Befehl)", "user-web": "Sie (Web)", "user-command": "Sie (Befehl)", user: "Sie", reviewer: "Reviewer", curator: "Curator", doctor: "Doktor", system: "System", agent: "Agent", pipeline: "Pipeline", manual: "von Hand" }
export const PRIORITIES = ["niedrig", "normal", "hoch", "kritisch"]
export const COLUMN_LABEL = { neu: "neu", planung: "Planung", umsetzung: "Umsetzung", test: "Test", verifikation: "Verifikation", erledigt: "erledigt", eingeplant: "eingeplant", in_umsetzung: "in Umsetzung" }
export const colLabel = (c) => COLUMN_LABEL[c] || String(c).replace(/_/g, " ")

export const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
export const colorOf = (kind, type) => css(`--k-${type && MEMORY_TYPES[type] ? type : kind}`) || "#888"

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------
export function fmtDate(v, withTime = true) {
  if (v === undefined || v === null || v === "") return ""
  const d = typeof v === "number" ? new Date(v) : new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toLocaleString("de-DE", withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" })
}

export function fmtRel(v) {
  if (!v) return ""
  const t = typeof v === "number" ? v : Date.parse(v)
  if (Number.isNaN(t)) return String(v)
  const diff = (Date.now() - t) / 1000
  const abs = Math.abs(diff)
  const sfx = (n, one, many) => `${n} ${n === 1 ? one : many}`
  let out
  if (abs < 45) out = "gerade eben"
  else if (abs < 3600) out = sfx(Math.round(abs / 60), "Minute", "Minuten")
  else if (abs < 86400) out = sfx(Math.round(abs / 3600), "Stunde", "Stunden")
  else if (abs < 86400 * 30) out = sfx(Math.round(abs / 86400), "Tag", "Tagen")
  else return fmtDate(t, false)
  if (out === "gerade eben") return out
  return diff >= 0 ? `vor ${out}` : `in ${out}`
}

export const fmtNum = (n, d = 0) => (n === null || n === undefined || Number.isNaN(Number(n)) ? "–" : Number(n).toLocaleString("de-DE", { maximumFractionDigits: d, minimumFractionDigits: 0 }))
export const fmtPct = (n) => (n === null || n === undefined ? "–" : `${fmtNum(n, 1)} %`)
export const fmtCost = (n) => (n === null || n === undefined ? "–" : `${Number(n).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} $`)
export function fmtDur(ms) {
  if (ms === null || ms === undefined || Number.isNaN(Number(ms))) return "–"
  const sec = Math.round(Number(ms) / 1000)
  if (sec < 1) return `${Math.round(Number(ms))} ms`
  if (sec < 60) return `${sec} s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} min ${sec % 60 ? `${sec % 60} s` : ""}`.trim()
  return `${Math.floor(min / 60)} h ${min % 60} min`
}
export const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
export const plural = (n, one, many) => `${fmtNum(n)} ${n === 1 ? one : many}`
export const truncate = (s, n) => (String(s ?? "").length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ""))
export const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

// ---------------------------------------------------------------------------
// routes for ids
// ---------------------------------------------------------------------------
export const entryHref = (id, tab) => {
  if (/^settings:/.test(id)) return `#/einstellungen?pfad=${encodeURIComponent(id.slice(9))}`
  if (/^task:/.test(id)) return `#/aufgabe/${encodeURIComponent(id.slice(5))}`
  if (/^project:/.test(id)) return `#/projekt/${encodeURIComponent(id.slice(8))}`
  if (/^session:/.test(id)) return `#/session/${encodeURIComponent(id.slice(8))}`
  if (/^code:/.test(id)) return `#/code?knoten=${encodeURIComponent(id)}`
  if (/^office:/.test(id) && !tab) return `#/office/${encodeURIComponent(id.slice(7))}`
  return `#/eintrag/${encodeURIComponent(id)}${tab ? `?tab=${tab}` : ""}`
}
export const editHref = (id) => `#/editor/${encodeURIComponent(id)}`
export const graphHref = (id) => `#/graph?center=${encodeURIComponent(id)}`
export const kindOf = (id) => String(id).slice(0, String(id).indexOf(":"))
export const nameOf = (id) => String(id).slice(String(id).indexOf(":") + 1)
export const taskId = (name) => String(name).toUpperCase()

// ---------------------------------------------------------------------------
// small components
// ---------------------------------------------------------------------------
export function kindChip(n, short = false) {
  const kind = n.kind || kindOf(n.id || "")
  const label = n.label || KIND_LABEL[kind] || kind
  const chip = h("span", { class: "chip kind", text: short ? label.slice(0, 1) : label, title: label })
  chip.style.background = colorOf(kind, n.type)
  return chip
}

export function statusChip(status) {
  if (!status) return null
  const cls = status === "abgeloest" || status === "abgelaufen" || status === "open" || status === "vorgeschlagen" ? "warn" : status === "needs_user" ? "danger" : status === "gueltig" || status === "solved" || status === "resolved" ? "ok" : ""
  return h("span", { class: `chip ${cls}`, text: STATUS_LABEL[status] || status })
}

export function aiChip(ai) {
  if (!ai) return null
  const cls = ai === "privat" ? "danger" : ai === "lesen" ? "warn" : ai === "vorschlag" ? "accent" : ""
  return h("span", { class: `chip ${cls}`, title: `KI-Recht: ${AI_ACCESS[ai]?.desc ?? ai}`, text: `KI: ${AI_ACCESS[ai]?.label ?? ai}` })
}

export function strengthBar(v) {
  const bar = h("span", { class: "strength", title: `Stärke ${Number(v).toFixed(2)}` })
  const fill = h("i")
  fill.style.width = `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`
  bar.append(fill)
  return bar
}

export function progressBar(done, total) {
  const bar = h("div", { class: "progress", title: `${done}/${total}` })
  const fill = h("i")
  fill.style.width = `${total ? Math.round((done / total) * 100) : 0}%`
  bar.append(fill)
  return bar
}

export function tagChips(tags, max = 8) {
  if (!tags || !tags.length) return null
  return h(
    "div",
    { class: "chips" },
    tags.slice(0, max).map((t) => h("a", { class: "chip", href: `#/suche?tag=${encodeURIComponent(t)}`, text: `#${t}` })),
    tags.length > max ? h("span", { class: "chip", text: `+${tags.length - max}` }) : null,
  )
}

export function loading(text = "Lade …") {
  return h("div", { class: "loading" }, h("span", { class: "spinner" }), text)
}

export function emptyState(title, text, ...actions) {
  return h("div", { class: "card empty-state" }, h("h2", { text: title }), text ? h("p", { class: "muted", text }) : null, actions.length ? h("div", { class: "toolbar", style: { justifyContent: "center" } }, actions) : null)
}

export function debounce(fn, ms) {
  let t
  return (...a) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...a), ms)
  }
}

export function storeGet(key, def) {
  try {
    const v = localStorage.getItem(`skillsmith:${key}`)
    return v === null ? def : JSON.parse(v)
  } catch (_) {
    return def
  }
}

export function storeSet(key, value) {
  try {
    if (value === undefined) localStorage.removeItem(`skillsmith:${key}`)
    else localStorage.setItem(`skillsmith:${key}`, JSON.stringify(value))
  } catch (_) {
    // storage unavailable – conveniences only
  }
}

export function segmented(options, value, onChange) {
  const wrap = h("div", { class: "seg", role: "group" })
  for (const [v, label] of options) {
    wrap.append(
      h("button", {
        type: "button",
        class: v === value ? "on" : "",
        text: label,
        onclick: () => {
          for (const b of wrap.children) b.classList.remove("on")
          wrap.children[options.findIndex((o) => o[0] === v)].classList.add("on")
          onChange(v)
        },
      }),
    )
  }
  return wrap
}

export function select(options, value, onChange, attrs = {}) {
  const sel = h(
    "select",
    { class: "input", ...attrs },
    options.map(([v, label]) => h("option", { value: v, text: label, selected: String(v) === String(value) })),
  )
  if (onChange) sel.addEventListener("change", () => onChange(sel.value))
  return sel
}

export function field(label, control, hint) {
  return h("div", { class: "field" }, h("label", { text: label }), control, hint ? h("div", { class: "hint", text: hint }) : null)
}

export function copyText(text) {
  try {
    navigator.clipboard.writeText(text)
    return true
  } catch (_) {
    return false
  }
}
