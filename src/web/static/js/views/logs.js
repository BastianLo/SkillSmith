// Log tab (5a): the structured log (state/log/<day>.jsonl) with filters, live tail, grouping
// by run and export. Links from audit events, job runs and agent tasks open it filtered by
// their id (?run=, ?cid=, ?job=, ?session=).
import { get, saveBlob } from "../api.js"
import { debounce, fmtDate, h, icon, put, swap, today } from "../dom.js"
import { tabBar } from "../ui.js"

const AREAS = ["core", "reviewer", "curator", "doctor", "docsmith", "memorysmith", "toolsmith", "web", "pipeline", "agent", "jobs", "embeddings", "store", "git", "audit", "metrics", "history", "scripts", "import", "gym", "reviews"]
const LEVEL_LABEL = { debug: "debug", info: "info", warn: "Warnung", error: "Fehler" }

export default async function logs(ctx) {
  ctx.title("Log")
  const q = ctx.query
  const f = {
    level: q.get("stufe") || "info",
    areas: (q.get("bereich") || "").split(",").filter(Boolean),
    text: q.get("text") || "",
    from: q.get("von") || today(),
    to: q.get("bis") || "",
    run: q.get("run") || "",
    cid: q.get("cid") || "",
    job: q.get("job") || "",
    session: q.get("session") || "",
  }
  const group = q.get("gruppe") === "lauf"
  let live = q.get("live") === "1"
  let cursor = ""
  let lines = []
  const page = h("div", { class: "page wide" })
  const out = h("div")
  const status = h("span", { class: "faint", style: { fontSize: "12.5px" } })
  ctx.layout("wide")
  const params = () => ({
    level: f.level,
    areas: f.areas.join(",") || undefined,
    text: f.text || undefined,
    from: f.run || f.cid || f.job || f.session ? undefined : f.from || undefined,
    to: f.to || undefined,
    run: f.run || undefined,
    cid: f.cid || undefined,
    job: f.job || undefined,
    session: f.session || undefined,
    limit: 1500,
  })
  const sync = () =>
    ctx.setQuery({ stufe: f.level === "info" ? undefined : f.level, bereich: f.areas.join(",") || undefined, text: f.text || undefined, von: f.from === today() ? undefined : f.from, bis: f.to || undefined, run: f.run || undefined, cid: f.cid || undefined, job: f.job || undefined, session: f.session || undefined })

  const load = async () => {
    const r = await get("logs", { ...params(), group: group ? "run" : undefined })
    if (!ctx.alive()) return
    cursor = r.cursor
    lines = group ? r.groups : r.lines
    swap(status, `${group ? `${r.groups.length} Läufe` : `${r.lines.length} Zeilen`}${r.truncated ? " (gekürzt – Filter enger stellen)" : ""} · ${r.days.length} Logtag(e)`)
    draw()
  }

  const idLinks = (l) =>
    h(
      "span",
      { class: "ids" },
      l.run ? h("a", { href: `#/logs?run=${encodeURIComponent(l.run)}`, title: "alle Zeilen dieses Laufs", text: `run ${l.run.slice(-8)}` }) : null,
      l.cid ? h("a", { href: `#/logs?cid=${encodeURIComponent(l.cid)}`, title: "alle Zeilen dieses Job-Laufs", text: l.cid }) : null,
      l.job ? h("a", { href: `#/agenten/${encodeURIComponent(l.job)}`, title: "Agenten-Auftrag", text: l.job }) : null,
      l.session ? h("a", { href: `#/logs?session=${encodeURIComponent(l.session)}`, title: "alle Zeilen dieser Session", text: `ses ${l.session.slice(-6)}` }) : null,
    )

  const lineRow = (l) => {
    const data = l.data !== undefined ? h("pre", { text: typeof l.data === "string" ? l.data : JSON.stringify(l.data, null, 2) }) : null
    return h(
      "tr",
      { class: l.lvl },
      h("td", { class: "t", text: fmtDate(l.t).replace(/^\d{2}\.\d{2}\.\d{4},?\s*/, "") + `.${String(new Date(l.t).getMilliseconds()).padStart(3, "0")}`, title: l.t }),
      h("td", { class: "lvl", text: LEVEL_LABEL[l.lvl] || l.lvl }),
      h("td", { class: "area", text: l.area, title: l.scope }),
      h("td", { class: "msg" }, l.msg, idLinks(l), data),
    )
  }

  const table = (rows) => h("table", { class: "log-table" }, h("colgroup", null, h("col", { class: "t" }), h("col", { class: "lvl" }), h("col", { class: "area" }), h("col")), h("tbody", null, rows.map(lineRow)))

  const draw = () => {
    if (!lines.length) return swap(out, h("div", { class: "card empty-state" }, h("p", { text: "Keine Logzeilen für diesen Filter." })))
    if (group) {
      swap(
        out,
        lines.map((g) =>
          h(
            "details",
            { class: "log-group", open: lines.length <= 3 },
            h(
              "summary",
              null,
              h("span", { class: `chip ${g.worst === "error" ? "danger" : g.worst === "warn" ? "warn" : ""}`, text: LEVEL_LABEL[g.worst] }),
              h("strong", { text: g.run ? `Lauf ${g.run}` : g.cid ? `Job-Lauf ${g.cid}` : g.job ? `Auftrag ${g.job}` : "ohne Lauf" }),
              h("span", { class: "faint", text: `${g.lines.length} Zeilen · ${fmtDate(g.first)} – ${fmtDate(g.last)}` }),
            ),
            table(g.lines),
          ),
        ),
      )
    } else swap(out, table(lines))
  }

  const tail = async () => {
    if (!live || !ctx.alive() || group) return
    try {
      const r = await get("logs/tail", { ...params(), cursor })
      if (!ctx.alive()) return
      cursor = r.cursor
      if (r.lines.length) {
        lines = [...r.lines.reverse(), ...lines].slice(0, 3000)
        draw()
      }
    } catch (_) {
      // next poll
    }
  }
  const timer = setInterval(tail, 2000)
  ctx.cleanup(() => clearInterval(timer))

  const levelSel = h("select", { class: "input sm" }, ["debug", "info", "warn", "error"].map((l) => h("option", { value: l, text: `ab ${LEVEL_LABEL[l]}`, selected: f.level === l })))
  levelSel.addEventListener("change", () => ((f.level = levelSel.value), sync(), load()))
  const text = h("input", { class: "input sm", type: "search", placeholder: "Text …", value: f.text, style: { width: "200px" } })
  text.addEventListener("input", debounce(() => ((f.text = text.value.trim()), sync(), load()), 300))
  const from = h("input", { class: "input sm", type: "date", value: f.from })
  from.addEventListener("change", () => ((f.from = from.value), sync(), load()))
  const to = h("input", { class: "input sm", type: "date", value: f.to })
  to.addEventListener("change", () => ((f.to = to.value), sync(), load()))
  const areaBox = h("div", { class: "chips" })
  const drawAreas = () =>
    swap(
      areaBox,
      AREAS.map((a) =>
        h("button", {
          type: "button",
          class: `chip ${f.areas.includes(a) ? "accent" : "outline"}`,
          text: a,
          onclick: () => {
            f.areas = f.areas.includes(a) ? f.areas.filter((x) => x !== a) : [...f.areas, a]
            drawAreas()
            sync()
            load()
          },
        }),
      ),
    )
  drawAreas()
  const liveBtn = h("button", { class: `btn sm ${live ? "on" : ""}`, type: "button", title: "neue Zeilen alle 2 s nachladen" }, icon("play", 12), "Live")
  liveBtn.addEventListener("click", () => {
    live = !live
    liveBtn.classList.toggle("on", live)
    ctx.setQuery({ live: live ? "1" : undefined })
  })
  const ids = [f.run && ["run", f.run], f.cid && ["cid", f.cid], f.job && ["job", f.job], f.session && ["session", f.session]].filter(Boolean)
  put(
    page,
    h(
      "div",
      { class: "page-head" },
      h("div", { class: "grow" }, h("h1", { text: "Log" }), h("div", { class: "muted", text: "Strukturiertes Log aller Bereiche – geschwärzt, je Tag eine Datei. Zeilen eines Laufs, Jobs oder Auftrags tragen dieselbe Kennung." })),
      h(
        "div",
        { class: "toolbar" },
        liveBtn,
        h("button", { class: "btn sm", type: "button", onclick: () => load() }, icon("refresh", 12), "Neu laden"),
        h("button", {
          class: "btn sm",
          type: "button",
          onclick: () => {
            const flat = group ? lines.flatMap((g) => g.lines) : lines
            saveBlob(new Blob([flat.map((l) => JSON.stringify(l)).join("\n") + "\n"], { type: "application/x-ndjson" }), `skillsmith-log-${f.from || today()}.jsonl`)
          },
        }, icon("export", 12), "Export"),
      ),
    ),
    tabBar(
      [
        ["zeilen", "Zeilen"],
        ["lauf", "Nach Lauf gruppiert"],
      ],
      group ? "lauf" : "zeilen",
      (k) => (ctx.setQuery({ gruppe: k === "lauf" ? "lauf" : undefined }), ctx.reload()),
    ),
    h("div", { class: "toolbar", style: { marginTop: 0 } }, levelSel, text, h("span", { class: "faint", text: "von" }), from, h("span", { class: "faint", text: "bis" }), to, status),
    areaBox,
    ids.length
      ? h("div", { class: "notice", style: { marginTop: "10px" } }, `Gefiltert nach ${ids.map(([k, v]) => `${k} ${v}`).join(", ")} `, h("a", { href: "#/logs", text: "Filter aufheben" }))
      : null,
    h("div", { style: { marginTop: "12px" } }, out),
  )
  ctx.el.replaceChildren(page)
  await load()
}
