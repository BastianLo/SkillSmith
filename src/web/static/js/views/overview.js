import { get } from "../api.js"
import { MEMORY_PLURAL, MEMORY_TYPES, colorOf, debounce, entryHref, fmtDate, fmtRel, h, icon, put } from "../dom.js"
import { app } from "../ui.js"
import { timelineList } from "./timeline.js"

function stat(href, label, num, sub, color) {
  const sw = h("span", { class: "swatch" })
  if (color) sw.style.background = color
  return h("a", { class: "card", href }, h("div", { class: "label" }, color ? sw : null, label), h("div", { class: "num", text: String(num) }), sub ? h("div", { class: "sub", text: sub }) : null)
}

export default async function overview(ctx) {
  ctx.title("Übersicht")
  const [st, timeline] = await Promise.all([get("stats"), get("timeline", { limit: 8 })])
  if (!ctx.alive()) return
  const page = h("div", { class: "page" })
  const kinds = Object.fromEntries(st.kinds.map((k) => [k.kind, k]))
  put(
    page,
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        { class: "grow" },
        h("h1", { text: st.project }),
        h("div", { class: "muted", text: [st.branch ? `Branch ${st.branch}` : "", st.ticket ? `Ticket ${st.ticket}` : "", st.embeddings ? "semantische Suche aktiv" : "Stichwortsuche (keine Embeddings)", st.readOnly ? "nur lesend" : ""].filter(Boolean).join(" · ") }),
      ),
      h(
        "div",
        { class: "toolbar" },
        app.readOnly ? null : h("a", { class: "btn primary", href: "#/neu/dokument" }, icon("plus", 14), "Dokument"),
        app.readOnly ? null : h("a", { class: "btn", href: "#/board?neu=1" }, icon("plus", 14), "Aufgabe"),
        h("a", { class: "btn", href: "#/tagesnotiz" }, icon("journal", 14), "Tagesnotiz"),
        h("a", { class: "btn", href: "#/chat" }, icon("chat", 14), "Fragen"),
      ),
    ),
    h(
      "div",
      { class: "grid" },
      stat("#/eingang", "Zu prüfen", st.inbox, "Eingang seit Ihrem letzten Besuch"),
      stat("#/board", "Offene Aufgaben", st.tasks?.open ?? 0, `${st.tasks?.agents ?? 0} Agenten-Aufträge aktiv`, colorOf("task")),
      st.doctor ? stat("#/konflikte", "Konflikte", st.doctor.needsUser, `Entscheidung nötig · ${st.doctor.open} offen · ${st.doctor.queued} in Warteschlange`, colorOf("error")) : null,
      stat("#/graph", "Verknüpfungen", st.relations.stored, `+ ${st.relations.derived} abgeleitet`),
    ),
  )
  if (st.currentState)
    put(page, h("a", { class: "card", href: entryHref(st.currentState.id), style: { marginTop: "12px", display: "block" } }, h("div", { class: "label" }, icon("state", 13), "Aktueller Arbeitsstand"), h("div", { style: { fontWeight: 600, marginTop: "2px" }, text: st.currentState.summary || "(ohne Zusammenfassung)" }), h("div", { class: "sub", text: `Stand ${fmtDate(st.currentState.updatedAt)}` })))
  const my = st.myDocs || { total: 0, proposals: 0, recent: [] }
  put(
    page,
    h(
      "div",
      { class: "grid two", style: { marginTop: "14px" } },
      h(
        "div",
        { class: "card" },
        h("div", { class: "card-head" }, h("h3", { class: "grow", text: "Meine Dokumente" }), h("a", { class: "btn sm", href: "#/dokumente?autor=ich", text: "Alle" })),
        h("div", { class: "row-flex" }, h("div", { class: "kpi" }, h("div", { class: "num", text: String(my.total) }), h("div", { class: "sub", text: "Dokumente von Ihnen" })), my.proposals ? h("a", { class: "chip accent", href: "#/freigaben", text: `${my.proposals} KI-Vorschläge offen` }) : null),
        my.recent.length ? h("div", { class: "list", style: { marginTop: "10px" } }, my.recent.map((d) => h("a", { class: "row", href: entryHref(d.id), "data-id": d.id }, icon("doc", 15), h("div", { class: "main" }, h("div", { class: "title", text: d.title })), h("div", { class: "meta", text: fmtRel(d.updatedAt) })))) : h("div", { class: "faint", style: { marginTop: "8px" }, text: "Noch keine eigenen Dokumente – „Dokument“ legt eines an." }),
      ),
      h(
        "div",
        { class: "card" },
        h("h3", { text: "Erinnerungen dieses Projekts" }),
        h(
          "div",
          { class: "grid", style: { gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))" } },
          Object.keys(MEMORY_TYPES).map((t) => stat(`#/liste/memory?type=${t}`, MEMORY_PLURAL[t], st.memoryTypes[t] || 0, null, colorOf("memory", t))),
          stat("#/liste/arbeitsstand", "Arbeitsstände", st.states, null, colorOf("arbeitsstand")),
          stat("#/liste/ergebnis", "Ergebnisse", st.results, null, colorOf("ergebnis")),
        ),
      ),
    ),
  )
  const order = ["knowledge", "skill", "error", "script", "glossary", "task", "project"]
  put(
    page,
    h("h2", { text: "Wissen und Werkzeuge" }),
    h(
      "div",
      { class: "grid" },
      order
        .map((k) => kinds[k])
        .filter(Boolean)
        .map((k) =>
          stat(
            k.kind === "knowledge" ? "#/dokumente" : k.kind === "script" ? "#/werkstatt" : k.kind === "task" ? "#/board" : k.kind === "project" ? "#/projekte" : k.kind === "glossary" ? "#/glossar" : `#/liste/${k.kind}`,
            k.label,
            k.active,
            [k.own ? `${k.own} von Ihnen` : "", k.dormant ? `${k.dormant} ruhend` : "", k.archive ? `${k.archive} archiviert` : ""].filter(Boolean).join(" · ") || "aktiv",
            colorOf(k.kind),
          ),
        ),
    ),
    h("h2", null, "Zuletzt ", h("a", { class: "btn sm ghost", href: "#/verlauf", text: "alle Läufe" })),
    timelineList(timeline),
  )
  ctx.el.replaceChildren(page)
  const later = debounce(() => ctx.alive() && ctx.reload(), 2000)
  ctx.on("run.finished", later)
}
