import { get } from "../api.js"
import { emptyState, fmtRel, h, icon, put } from "../dom.js"
import { app } from "../ui.js"
import { pipelineBadge } from "./board.js"

export default async function projects(ctx) {
  ctx.title("Projekte")
  const [list, status, runs] = await Promise.all([get("projects", { archived: ctx.query.get("archiv") === "1" ? "1" : undefined }), get("pipeline/status"), get("pipeline/runs", { limit: 200 })])
  if (!ctx.alive()) return
  const board = await get("board", { project: "*" })
  if (!ctx.alive()) return
  const page = h("div", { class: "page" })
  put(
    page,
    h(
      "div",
      { class: "page-head" },
      h("div", { class: "grow" }, h("h1", { text: "Projekte" }), h("div", { class: "muted", text: "Ein Projekt bündelt ein Board, ein Verzeichnis (home_path) und eine Pipeline aus Prüfbefehlen – wie eine lokale CI." })),
      h("div", { class: "toolbar" }, app.readOnly ? null : h("a", { class: "btn primary", href: "#/projekt-neu" }, icon("plus", 14), "Neues Projekt"), h("a", { class: "btn", href: "#/board" }, icon("board", 14), "Alle Boards")),
    ),
  )
  if (!list.length) {
    put(page, emptyState("Noch keine Projekte", "Legen Sie ein Projekt für eine Ihrer Anwendungen an – mit home_path und z. B. „mvn verify“ als Prüfbefehl.", app.readOnly ? null : h("a", { class: "btn primary", href: "#/projekt-neu", text: "Projekt anlegen" })))
    ctx.el.replaceChildren(page)
    return
  }
  put(
    page,
    h(
      "div",
      { class: "grid wide" },
      list.map((p) => {
        const tasks = board.tasks.filter((t) => t.project === p.name)
        const open = tasks.filter((t) => t.status !== (p.columns[p.columns.length - 1] || "erledigt")).length
        const last = runs.find((r) => r.project === p.name)
        const running = status.running.some((r) => r.project === p.name)
        const sw = h("span", { class: "swatch" })
        sw.style.background = p.color || "var(--k-project)"
        return h(
          "a",
          { class: "card", href: `#/projekt/${encodeURIComponent(p.name)}` },
          h("div", { class: "label" }, sw, p.name, p.tier !== "active" ? h("span", { class: "chip", text: "archiviert" }) : null),
          h("div", { style: { fontWeight: 650, fontSize: "16px", margin: "2px 0" }, text: p.title }),
          p.description ? h("div", { class: "muted", style: { fontSize: "13px" }, text: p.description }) : null,
          h("div", { class: "mono faint", style: { margin: "6px 0" } }, p.homePath || "kein home_path", p.homePath && !p.homeExists ? h("span", { class: "chip danger", text: "fehlt" }) : null),
          h(
            "div",
            { class: "row-flex", style: { fontSize: "12.5px", color: "var(--muted)" } },
            h("span", { text: `${open} offen · ${tasks.length} gesamt` }),
            p.pipeline ? h("span", null, "Pipeline: ", running ? h("span", { class: "st-run", text: "läuft" }) : last ? pipelineBadge({ status: last.status, stages: last.stages }) : "noch kein Lauf", last ? h("span", { class: "faint", text: ` ${fmtRel(last.queuedAt)}` }) : null) : h("span", { class: "faint", text: "keine Pipeline" }),
          ),
        )
      }),
    ),
    h("div", { class: "toolbar" }, h("a", { class: "btn sm ghost", href: ctx.query.get("archiv") === "1" ? "#/projekte" : "#/projekte?archiv=1", text: ctx.query.get("archiv") === "1" ? "Nur aktive" : "Auch archivierte" })),
  )
  ctx.el.replaceChildren(page)
}
