// Shell of the web view: navigation, router, live updates, command palette, quick note.
import { get, onLive, onLiveState, startLive, takeToken, token } from "./api.js"
import { debounce, h, icon, storeGet, swap } from "./dom.js"
import { act, app, errorText, modal, toast } from "./ui.js"

const view = document.getElementById("view")

// ---------------------------------------------------------------------------
// theme
// ---------------------------------------------------------------------------
export function applyTheme(t) {
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t
  else delete document.documentElement.dataset.theme
}
applyTheme(storeGet("theme", "auto"))

// ---------------------------------------------------------------------------
// navigation
// ---------------------------------------------------------------------------
const NAV = [
  ["Arbeiten", [
    ["eingang", "Eingang", "inbox", "inbox"],
    ["board", "Board", "board", "tasks"],
    ["projekte", "Projekte", "project"],
    ["agenten", "Agenten", "agent", "agents"],
    ["tagesnotiz", "Tagesnotiz", "journal"],
  ]],
  ["Wissen", [
    ["", "Übersicht", "home"],
    ["dokumente", "Dokumente", "doc"],
    ["suche", "Suche", "search"],
    ["graph", "Graph", "graph"],
    ["landkarte", "Landkarte", "map"],
    ["chat", "Wissens-Chat", "chat"],
    ["glossar", "Glossar", "book"],
    ["tags", "Tags", "tag"],
  ]],
  ["Einträge", [
    ["liste/skill", "Skills", "skill"],
    ["liste/error", "Fehler", "error"],
    ["werkstatt", "Skripte", "script"],
    ["liste/memory", "Erinnerungen", "memory"],
    ["liste/arbeitsstand", "Arbeitsstände", "state"],
    ["liste/ergebnis", "Ergebnisse", "result"],
    ["kandidaten", "Kandidaten", "candidate"],
  ]],
  ["Einblick", [
    ["statistik", "Statistik", "chart"],
    ["audit", "Audit-Log", "audit"],
    ["historie", "Versionen", "history"],
    ["konflikte", "Konflikte", "conflict", "conflicts"],
    ["freigaben", "Freigaben", "staged", "staged"],
    ["simulator", "Hinweis-Simulator", "flask"],
    ["sessions", "Sessions", "chat"],
  ]],
  ["System", [
    ["export", "Export", "export"],
    ["einstellungen", "Einstellungen", "settings"],
  ]],
]

const badges = {}
function buildSide() {
  const side = document.getElementById("side")
  swap(
    side,
    NAV.map(([group, items]) => [
      h("h4", { text: group }),
      items.map(([path, label, ic, badge]) => {
        const b = badge ? h("span", { class: "badge hidden" }) : null
        if (badge) badges[badge] = b
        return h("a", { href: `#/${path}`, "data-path": path }, icon(ic), h("span", { text: label }), b)
      }),
    ]),
  )
  side.addEventListener("click", (e) => {
    if (e.target.closest("a")) document.body.classList.remove("side-open")
  })
}

function markNav(path) {
  for (const a of document.querySelectorAll("#side a")) {
    const p = a.dataset.path
    a.classList.toggle("active", p === "" ? path === "" : path === p || path.startsWith(`${p}/`) || (p === "werkstatt" && path.startsWith("werkstatt")))
  }
}

function setBadge(name, n, cls = "") {
  const b = badges[name]
  if (!b) return
  b.textContent = String(n)
  b.className = `badge ${cls}`
  b.classList.toggle("hidden", !n)
}

const refreshBadges = debounce(async () => {
  try {
    const st = await get("stats")
    setBadge("inbox", st.inbox || 0, "accent")
    setBadge("conflicts", st.doctor ? st.doctor.needsUser : 0)
    setBadge("agents", st.tasks ? st.tasks.agents : 0, "accent")
    setBadge("tasks", st.tasks ? st.tasks.open : 0, "muted")
    const staged = st.myDocs ? st.myDocs.proposals : 0
    setBadge("staged", staged, "accent")
    document.getElementById("scope").textContent = [st.project, st.branch].filter(Boolean).join(" · ")
  } catch (_) {
    // header badges are best effort
  }
}, 600)

function flags() {
  const i = app.info
  const box = document.getElementById("flags")
  swap(
    box,
    app.readOnly ? h("span", { class: "chip warn", title: i.readOnlyConfig ? "web.readOnly ist gesetzt" : "Schreiben ist für diese Sitzung gesperrt (Einstellungen)" }, icon("lock", 12), "nur lesend") : null,
    i && !i.token ? h("span", { class: "chip danger", title: "web.token: false – jeder Prozess auf diesem Rechner kann lesen und schreiben" }, "ohne Token") : null,
  )
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------
const V = (name) => () => import(`./views/${name}.js`)
const ROUTES = [
  ["", V("overview")],
  ["eingang", V("inbox")],
  ["dokumente", V("docs")],
  ["liste/:kind", V("lists")],
  ["suche", V("search")],
  ["eintrag/*id", V("entry")],
  ["editor/*id", V("editor")],
  ["neu/:what", V("create")],
  ["graph", V("graph")],
  ["landkarte", V("map")],
  ["konflikte", V("conflicts")],
  ["board", V("board")],
  ["aufgabe/:id", V("task")],
  ["projekte", V("projects")],
  ["projekt-neu", V("project-edit")],
  ["projekt/:name/bearbeiten", V("project-edit")],
  ["projekt/:name", V("project")],
  ["pipeline/:project/:run", V("pipeline")],
  ["agenten", V("agents")],
  ["agenten/:job", V("job")],
  ["statistik", V("stats")],
  ["audit", V("audit")],
  ["historie", V("history")],
  ["commit/:hash", V("commit")],
  ["simulator", V("simulator")],
  ["tagesnotiz", V("journal")],
  ["ticket/:id", V("ticket")],
  ["session/:id", V("session")],
  ["sessions", V("sessions")],
  ["glossar", V("glossary")],
  ["tags", V("tags")],
  ["kandidaten", V("candidates")],
  ["freigaben", V("staged")],
  ["werkstatt", V("workshop")],
  ["werkstatt/:name", V("workshop")],
  ["export", V("export")],
  ["chat", V("chat")],
  ["einstellungen", V("settings")],
  ["verlauf", V("timeline")],
]
// links of the read-only view of v2 keep working
const LEGACY = { entry: "eintrag", list: "liste", search: "suche", conflicts: "konflikte", timeline: "verlauf" }

function match(path) {
  const parts = path.split("/").filter(Boolean)
  if (parts[0] && LEGACY[parts[0]]) parts[0] = LEGACY[parts[0]]
  for (const [pattern, load] of ROUTES) {
    const pp = pattern.split("/").filter(Boolean)
    const params = {}
    let ok = true
    for (let i = 0; i < pp.length; i++) {
      const p = pp[i]
      if (p.startsWith("*")) {
        params[p.slice(1)] = decodeURIComponent(parts.slice(i).join("/"))
        if (!params[p.slice(1)]) ok = false
        i = pp.length
        break
      }
      if (parts[i] === undefined) {
        ok = false
        break
      }
      if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(parts[i])
      else if (p !== parts[i]) {
        ok = false
        break
      }
    }
    if (ok && (pp.some((p) => p.startsWith("*")) || pp.length === parts.length)) return { pattern, load, params, path: parts.join("/") }
  }
  return null
}

let current = null
let seq = 0

export function setQuery(patch, replace = true) {
  const raw = location.hash.replace(/^#/, "") || "/"
  const qi = raw.indexOf("?")
  const path = qi >= 0 ? raw.slice(0, qi) : raw
  const q = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : "")
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null || v === "" || v === false) q.delete(k)
    else q.set(k, String(v))
  }
  const next = `#${path}${q.toString() ? `?${q}` : ""}`
  if (replace) history.replaceState(null, "", next)
  else history.pushState(null, "", next)
  return q
}

async function route() {
  const my = ++seq
  const raw = location.hash.replace(/^#/, "") || "/"
  const qi = raw.indexOf("?")
  const path = (qi >= 0 ? raw.slice(0, qi) : raw).replace(/^\/+|\/+$/g, "")
  const query = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : "")
  if (current) {
    for (const fn of current.cleanups.splice(0)) {
      try {
        fn()
      } catch (_) {
        // ignore
      }
    }
  }
  const m = match(path)
  markNav(m ? m.path : path)
  const ctx = {
    el: view,
    params: m ? m.params : {},
    query,
    path,
    cleanups: [],
    alive: () => my === seq,
    on(type, fn) {
      const off = onLive(type, (d, t) => my === seq && fn(d, t))
      this.cleanups.push(off)
      return off
    },
    cleanup(fn) {
      this.cleanups.push(fn)
    },
    title(t) {
      document.title = t ? `${t} – skillsmith` : "skillsmith"
    },
    layout(mode) {
      view.className = mode || ""
    },
    setQuery,
    reload: () => route(),
  }
  current = ctx
  view.className = ""
  document.title = "skillsmith"
  swap(view, h("div", { class: "page" }, h("div", { class: "loading" }, h("span", { class: "spinner" }), "Lade …")))
  if (!token() && app.info?.token !== false) {
    swap(view, h("div", { class: "page narrow" }, h("div", { class: "notice error" }, h("strong", { text: "Kein Zugriff. " }), "Bitte den Link aus /smith-web in opencode öffnen – er enthält den Zugangsschlüssel.")))
    return
  }
  if (!m) {
    swap(view, h("div", { class: "page narrow" }, h("div", { class: "notice warn", text: `Unbekannte Seite: ${path}` }), h("a", { class: "btn", href: "#/", text: "Zur Übersicht" })))
    return
  }
  try {
    const mod = await m.load()
    if (my !== seq) return
    await mod.default(ctx)
  } catch (err) {
    if (my !== seq) return
    console.error(err)
    view.className = ""
    swap(view, h("div", { class: "page narrow" }, h("div", { class: "notice error" }, h("strong", { text: err && err.status === 401 ? "Kein Zugriff. " : "Fehler: " }), errorText(err))))
  }
  if (my === seq) view.focus({ preventScroll: true })
}

// ---------------------------------------------------------------------------
// command palette (Ctrl+K)
// ---------------------------------------------------------------------------
async function palette() {
  const { openPalette } = await import("./palette.js")
  openPalette(NAV)
}

export async function quickNote() {
  const text = await modal((close) => {
    const ta = h("textarea", { class: "input", rows: 5, placeholder: "Gedanke, Link, offener Punkt … – landet mit Zeitstempel im Dokument „Eingang“." })
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) close(ta.value.trim())
    })
    return {
      title: "Schnellnotiz",
      body: [ta, h("div", { class: "hint faint", style: { marginTop: "6px" }, text: "Strg+Enter speichert." })],
      foot: [h("button", { class: "btn", type: "button", text: "Abbrechen", onclick: () => close(undefined) }), h("button", { class: "btn primary", type: "button", text: "Speichern", onclick: () => close(ta.value.trim()) })],
    }
  })
  if (text) await act("note.quick", { text }, { noUndo: false })
}

function typing(e) {
  const t = e.target
  return t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName) || t.closest?.(".cm-editor"))
}

let gPrefix = 0
function keys(e) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault()
    palette()
    return
  }
  if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return
  if (e.key === "/") {
    e.preventDefault()
    document.getElementById("quicksearch-input").focus()
  } else if (e.key === "n") {
    e.preventDefault()
    quickNote()
  } else if (e.key === "g") {
    gPrefix = Date.now()
  } else if (Date.now() - gPrefix < 1200) {
    const to = { h: "", i: "eingang", b: "board", g: "graph", s: "statistik", a: "audit", d: "dokumente", t: "tagesnotiz", p: "projekte" }[e.key]
    if (to !== undefined) location.hash = `#/${to}`
    gPrefix = 0
  }
}

// ---------------------------------------------------------------------------
// live updates and notifications
// ---------------------------------------------------------------------------
function live() {
  const dot = document.getElementById("live-dot")
  onLiveState((s) => {
    dot.className = `live-dot ${s === "on" ? "on" : s === "off" ? "off" : ""}`
    dot.title = s === "on" ? "Live-Aktualisierung aktiv" : s === "disabled" ? "Live-Aktualisierung aus (web.liveUpdates)" : "Live-Aktualisierung getrennt – verbinde neu …"
  })
  for (const t of ["run.finished", "commit", "task.changed", "agent.job", "inbox.changed", "pipeline.run"]) onLive(t, () => refreshBadges())
  const loadedAt = Date.now()
  onLive("notify", (d) => {
    if (d.at && Number(d.at) < loadedAt - 5000) return
    toast(d.message || "", { title: d.title, variant: d.variant === "warning" ? "warning" : d.variant || "info", actions: d.link ? [{ label: "Öffnen", run: () => (location.hash = d.link) }] : [] })
    if (app.info?.notify?.browser && "Notification" in window && Notification.permission === "granted" && document.hidden) {
      try {
        const n = new Notification(d.title || "skillsmith", { body: d.message || "", tag: d.event })
        n.onclick = () => {
          window.focus()
          if (d.link) location.hash = d.link
        }
      } catch (_) {
        // ignore
      }
    }
  })
  if (app.info?.liveUpdates !== false) startLive()
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
async function boot() {
  takeToken()
  document.getElementById("brand").prepend(icon("logo", 18))
  document.getElementById("menu-btn").append(icon("menu"))
  document.getElementById("menu-btn").addEventListener("click", () => document.body.classList.toggle("side-open"))
  buildSide()
  document.getElementById("quicksearch").addEventListener("submit", (e) => {
    e.preventDefault()
    const v = document.getElementById("quicksearch-input").value.trim()
    location.hash = v ? `#/suche?q=${encodeURIComponent(v)}` : "#/suche"
  })
  document.getElementById("palette-btn").addEventListener("click", palette)
  document.getElementById("note-btn").addEventListener("click", quickNote)
  document.addEventListener("keydown", keys)
  try {
    const [info, catalog] = await Promise.all([get("info"), get("catalog")])
    app.info = info
    app.readOnly = !!info.readOnly
    for (const a of catalog) app.catalog.set(a.name, a)
    flags()
    live()
    refreshBadges()
  } catch (err) {
    if (err.status !== 401) toast(errorText(err), { variant: "error" })
  }
  window.addEventListener("hashchange", route)
  route()
}

export function setReadOnly(v) {
  app.readOnly = v
  flags()
}

boot()
