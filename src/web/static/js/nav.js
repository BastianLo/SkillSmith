// One register for navigation, routes and the feature tabs: every page belongs to a feature
// area. The sidebar shows the areas (collapsible), the page shows the tabs of its area, the
// command palette lists the same pages. New pages are added here and nowhere else.

const V = (name) => () => import(`./views/${name}.js`)

/** Feature areas with their pages (path, label, icon, badge key). */
export const AREAS = [
  {
    id: "start",
    label: "Start",
    icon: "home",
    items: [
      { path: "", label: "Übersicht", icon: "home" },
      { path: "eingang", label: "Eingang", icon: "inbox", badge: "inbox" },
      { path: "tagesnotiz", label: "Tagesnotiz", icon: "journal" },
    ],
  },
  {
    id: "aufgaben",
    label: "Aufgaben",
    icon: "board",
    items: [
      { path: "board", label: "Board", icon: "board", badge: "tasks" },
      { path: "projekte", label: "Projekte", icon: "project" },
      { path: "agenten", label: "Aufträge", icon: "agent", badge: "agents" },
      { path: "liste/agent", label: "Agenten", icon: "agent" },
    ],
  },
  {
    id: "wissen",
    label: "Wissen",
    icon: "doc",
    items: [
      { path: "dokumente", label: "Dokumente", icon: "doc" },
      { path: "suche", label: "Suche", icon: "search" },
      { path: "graph", label: "Graph", icon: "graph" },
      { path: "landkarte", label: "Landkarte", icon: "map" },
      { path: "chat", label: "Wissens-Chat", icon: "chat" },
      { path: "glossar", label: "Glossar", icon: "book" },
      { path: "tags", label: "Tags", icon: "tag" },
    ],
  },
  {
    id: "bibliothek",
    label: "Bibliothek",
    icon: "skill",
    items: [
      { path: "liste/skill", label: "Skills", icon: "skill" },
      { path: "liste/error", label: "Fehler", icon: "error" },
      { path: "werkstatt", label: "Skripte", icon: "script" },
      { path: "liste/memory", label: "Erinnerungen", icon: "memory" },
      { path: "liste/arbeitsstand", label: "Arbeitsstände", icon: "state" },
      { path: "liste/ergebnis", label: "Ergebnisse", icon: "result" },
    ],
  },
  {
    id: "qualitaet",
    label: "Qualität",
    icon: "audit",
    items: [
      { path: "kandidaten", label: "Kandidaten", icon: "candidate" },
      { path: "konflikte", label: "Konflikte", icon: "conflict", badge: "conflicts" },
      { path: "freigaben", label: "Freigaben", icon: "staged", badge: "staged" },
      { path: "code", label: "Wissen zum Code", icon: "code" },
      { path: "gym", label: "Gym", icon: "gym" },
    ],
  },
  {
    id: "einblick",
    label: "Einblick",
    icon: "chart",
    items: [
      { path: "statistik", label: "Statistik", icon: "chart" },
      { path: "audit", label: "Audit-Log", icon: "audit" },
      { path: "historie", label: "Versionen", icon: "history" },
      { path: "sessions", label: "Sessions", icon: "chat" },
      { path: "simulator", label: "Hinweis-Simulator", icon: "flask" },
      { path: "logs", label: "Log", icon: "list" },
    ],
  },
  {
    id: "system",
    label: "System",
    icon: "settings",
    items: [
      { path: "einstellungen", label: "Einstellungen", icon: "settings" },
      { path: "jobs", label: "Jobs", icon: "calendar", badge: "jobs" },
      { path: "export", label: "Export", icon: "export" },
    ],
  },
]

/** Routes: pattern → view module, feature area (for the tabs). */
export const ROUTES = [
  ["", V("overview"), "start"],
  ["eingang", V("inbox"), "start"],
  ["tagesnotiz", V("journal"), "start"],
  ["dokumente", V("docs"), "wissen"],
  ["liste/:kind", V("lists"), "bibliothek"],
  ["suche", V("search"), "wissen"],
  ["eintrag/*id", V("entry"), null],
  ["editor/*id", V("editor"), null],
  ["neu/:what", V("create"), null],
  ["graph", V("graph"), "wissen"],
  ["landkarte", V("map"), "wissen"],
  ["konflikte", V("conflicts"), "qualitaet"],
  ["board", V("board"), "aufgaben"],
  ["aufgabe/:id", V("task"), "aufgaben"],
  ["projekte", V("projects"), "aufgaben"],
  ["projekt-neu", V("project-edit"), "aufgaben"],
  ["projekt/:name/bearbeiten", V("project-edit"), "aufgaben"],
  ["projekt/:name", V("project"), "aufgaben"],
  ["pipeline/:project/:run", V("pipeline"), "aufgaben"],
  ["agenten", V("agents"), "aufgaben"],
  ["agenten/:job", V("job"), "aufgaben"],
  ["statistik", V("stats"), "einblick"],
  ["audit", V("audit"), "einblick"],
  ["historie", V("history"), "einblick"],
  ["commit/:hash", V("commit"), "einblick"],
  ["simulator", V("simulator"), "einblick"],
  ["ticket/:id", V("ticket"), null],
  ["session/:id", V("session"), "einblick"],
  ["sessions", V("sessions"), "einblick"],
  ["logs", V("logs"), "einblick"],
  ["glossar", V("glossary"), "wissen"],
  ["tags", V("tags"), "wissen"],
  ["kandidaten", V("candidates"), "qualitaet"],
  ["freigaben", V("staged"), "qualitaet"],
  ["code", V("code"), "qualitaet"],
  ["gym", V("gym"), "qualitaet"],
  ["werkstatt", V("workshop"), "bibliothek"],
  ["werkstatt/:name", V("workshop"), "bibliothek"],
  ["export", V("export"), "system"],
  ["chat", V("chat"), "wissen"],
  ["einstellungen", V("settings"), "system"],
  ["jobs", V("jobs"), "system"],
  ["verlauf", V("timeline"), "einblick"],
]

// links of the read-only view of v2 keep working
export const LEGACY = { entry: "eintrag", list: "liste", search: "suche", conflicts: "konflikte", timeline: "verlauf" }

export function match(path) {
  const parts = path.split("/").filter(Boolean)
  if (parts[0] && LEGACY[parts[0]]) parts[0] = LEGACY[parts[0]]
  for (const [pattern, load, area] of ROUTES) {
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
    if (ok && (pp.some((p) => p.startsWith("*")) || pp.length === parts.length)) return { pattern, load, area, params, path: parts.join("/") }
  }
  return null
}

/** Area of a path (list kinds belong to the library, except knowledge → Wissen). */
export function areaOf(m) {
  if (!m) return null
  if (m.pattern === "liste/:kind") {
    const k = m.params.kind
    return ["knowledge", "glossary"].includes(k) ? "wissen" : ["task", "project", "agent"].includes(k) ? "aufgaben" : "bibliothek"
  }
  if (m.pattern === "eintrag/*id" || m.pattern === "editor/*id") {
    const kind = String(m.params.id).split(":")[0]
    return { knowledge: "wissen", glossary: "wissen", task: "aufgaben", project: "aufgaben", agent: "aufgaben" }[kind] || "bibliothek"
  }
  return m.area
}

/** Is a nav item the current page? */
export function isActive(itemPath, path) {
  if (itemPath === "") return path === ""
  return path === itemPath || path.startsWith(`${itemPath}/`) || (itemPath === "werkstatt" && path.startsWith("werkstatt"))
}

/** Flat list of pages (command palette). */
export function pages() {
  return AREAS.flatMap((a) => a.items.map((it) => ({ ...it, area: a.label })))
}
