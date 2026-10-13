// Shell of the web view: navigation, router, live updates, command palette, quick note.
import { get, onLive, onLiveState, startLive, takeToken, token } from "./api.js"
import { debounce, h, icon, storeGet, storeSet, swap } from "./dom.js"
import { AREAS, areaOf, isActive, match, pages } from "./nav.js"
import { act, app, closeModals, errorText, modal, toast } from "./ui.js"

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
// navigation: feature areas (collapsible) and the tabs of the current area
// ---------------------------------------------------------------------------
const badges = {}
const areaBadges = {}
const badgeValues = {}
let openAreas = new Set(storeGet("nav.open", ["start"]))
let currentArea = null

function saveOpen() {
  storeSet("nav.open", [...openAreas])
}

function buildSide() {
  const side = document.getElementById("side")
  swap(
    side,
    AREAS.map((a) => {
      const sum = h("span", { class: "badge muted hidden" })
      areaBadges[a.id] = sum
      const head = h("button", { class: "area-head", type: "button", "data-area": a.id, "aria-expanded": "false", title: a.label }, icon("chevron", 12), h("span", { class: "grow", text: a.label }), sum)
      const list = h(
        "div",
        { class: "area-items", id: `area-${a.id}` },
        a.items.map((it) => {
          const b = it.badge ? h("span", { class: "badge hidden" }) : null
          if (it.badge) badges[it.badge] = b
          return h("a", { href: `#/${it.path}`, "data-path": it.path, "data-area": a.id }, icon(it.icon), h("span", { text: it.label }), b)
        }),
      )
      head.addEventListener("click", () => {
        if (openAreas.has(a.id)) openAreas.delete(a.id)
        else openAreas.add(a.id)
        saveOpen()
        drawAreas()
      })
      return h("div", { class: "area", "data-area": a.id }, head, list)
    }),
  )
  side.addEventListener("click", (e) => {
    if (e.target.closest("a")) document.body.classList.remove("side-open")
  })
  drawAreas()
}

function drawAreas() {
  for (const el of document.querySelectorAll("#side .area")) {
    const id = el.dataset.area
    const open = openAreas.has(id) || id === currentArea
    el.classList.toggle("open", open)
    el.classList.toggle("current", id === currentArea)
    el.querySelector(".area-head").setAttribute("aria-expanded", String(open))
    // collapsed: the area shows the sum of its badges
    const sum = AREAS.find((a) => a.id === id).items.reduce((n, it) => n + (it.badge ? badgeValues[it.badge] || 0 : 0), 0)
    const b = areaBadges[id]
    b.textContent = String(sum)
    b.classList.toggle("hidden", open || !sum)
  }
}

function markNav(path, area) {
  currentArea = area
  for (const a of document.querySelectorAll("#side a")) a.classList.toggle("active", isActive(a.dataset.path, path))
  drawAreas()
  drawTabs(path, area)
}

/** Tabs of the current feature area above the page. */
function drawTabs(path, area) {
  const bar = document.getElementById("subnav")
  const a = AREAS.find((x) => x.id === area)
  document.body.classList.toggle("has-subnav", !!a)
  if (!a) return swap(bar)
  swap(
    bar,
    h("span", { class: "subnav-title" }, icon(a.icon, 14), a.label),
    a.items.map((it) => {
      const b = it.badge && badgeValues[it.badge] ? h("span", { class: "badge muted", text: String(badgeValues[it.badge]) }) : null
      return h("a", { href: `#/${it.path}`, class: isActive(it.path, path) ? "on" : "" }, h("span", { text: it.label }), b)
    }),
  )
}

function setBadge(name, n, cls = "") {
  badgeValues[name] = n
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
    setBadge("jobs", st.jobs ? st.jobs.failed : 0, "danger")
    const staged = st.myDocs ? st.myDocs.proposals : 0
    setBadge("staged", staged, "accent")
    drawAreas()
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
    i && i.pendingRestart && i.pendingRestart.length ? h("a", { class: "chip warn", href: "#/einstellungen", title: `Wirkt nach einem Neustart von opencode: ${i.pendingRestart.join(", ")}` }, icon("refresh", 12), "Neustart nötig") : null,
  )
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------
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

let lastPath = null
async function route() {
  const my = ++seq
  const raw = location.hash.replace(/^#/, "") || "/"
  const qi = raw.indexOf("?")
  const path = (qi >= 0 ? raw.slice(0, qi) : raw).replace(/^\/+|\/+$/g, "")
  const query = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : "")
  // dialogs belong to the page they were opened on
  if (path !== lastPath) closeModals()
  lastPath = path
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
  markNav(m ? m.path : path, areaOf(m))
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
  openPalette(pages())
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
    const to = { h: "", i: "eingang", b: "board", g: "graph", s: "statistik", a: "audit", d: "dokumente", t: "tagesnotiz", p: "projekte", e: "einstellungen", j: "jobs", l: "logs" }[e.key]
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
  for (const t of ["run.finished", "commit", "task.changed", "agent.job", "inbox.changed", "pipeline.run", "job.changed", "settings.changed"]) onLive(t, () => refreshBadges())
  onLive("settings.changed", async () => {
    try {
      app.info = await get("info")
      flags()
    } catch (_) {
      // ignore
    }
  })
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
