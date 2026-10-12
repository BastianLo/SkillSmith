import { get } from "../api.js"
import { entryHref, fmtDate, fmtDur, h, icon, put, swap } from "../dom.js"
import { act, app } from "../ui.js"

const STATUS = { queued: "wartet", running: "läuft", success: "grün", failed: "rot", aborted: "abgebrochen", timeout: "Zeitlimit", error: "Fehler", interrupted: "unterbrochen", pending: "wartet", skipped: "übersprungen" }

export default async function pipeline(ctx) {
  const { project, run: runId } = ctx.params
  ctx.title(`Pipeline ${project}`)
  const page = h("div", { class: "page" })
  const head = h("div")
  const stagesEl = h("div")
  const testsEl = h("div")
  const logEl = h("pre", { class: "log", "aria-live": "off" })
  let follow = true
  logEl.addEventListener("scroll", () => (follow = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 30))
  put(page, head, stagesEl, testsEl, h("div", { class: "card-head", style: { marginTop: "14px" } }, h("h3", { class: "grow", text: "Log" }), h("span", { class: "faint", text: "Geheimnisse sind geschwärzt." })), logEl)
  ctx.el.replaceChildren(page)
  let offset = 0
  let run = null

  const draw = () => {
    const r = run
    const active = r.status === "running" || r.status === "queued"
    swap(
      head,
      h(
        "div",
        { class: "page-head" },
        h(
          "div",
          { class: "grow" },
          h("div", { class: "entry-head" }, h("a", { class: "chip outline", href: `#/projekt/${encodeURIComponent(r.project)}`, text: r.project }), r.task ? h("a", { class: "chip", href: entryHref(`task:${r.task}`), text: r.task.toUpperCase() }) : null, h("span", { class: "faint", text: `${r.trigger} · ${r.by}` })),
          h("h1", null, `Lauf vom ${fmtDate(r.queuedAt)} – `, h("span", { class: r.status === "success" ? "st-ok" : ["failed", "timeout", "error"].includes(r.status) ? "st-bad" : "st-run", text: STATUS[r.status] || r.status })),
          h("div", { class: "muted", text: `${fmtDate(r.queuedAt)} · ${fmtDur(r.ms)} · Quelle ${r.source}${r.branch ? ` (${r.branch})` : ""} · ${r.workdir}` }),
          r.error ? h("div", { class: "notice error", text: r.error }) : null,
        ),
        app.readOnly
          ? null
          : h(
              "div",
              { class: "toolbar" },
              active ? h("button", { class: "btn danger", type: "button", onclick: async () => (await act("pipeline.abort", { project: r.project, run: r.id })) && reload() }, icon("stop", 14), "Abbrechen") : h("button", { class: "btn", type: "button", onclick: async () => {
                const x = await act("pipeline.start", { project: r.project, task: r.task })
                if (x?.data?.run) location.hash = `#/pipeline/${encodeURIComponent(r.project)}/${encodeURIComponent(x.data.run)}`
              } }, icon("refresh", 14), "Erneut starten"),
            ),
      ),
    )
    swap(
      stagesEl,
      h(
        "div",
        { class: "stages" },
        r.stages.map((s, i) =>
          h(
            "div",
            { class: `stage-box ${s.status}` },
            h("div", { class: "s-name" }, `${i + 1}. ${s.name}`, s.allowFailure ? h("span", { class: "chip", style: { marginLeft: "4px" }, text: "darf scheitern" }) : null),
            h("div", { class: "faint", text: `${STATUS[s.status] || s.status}${s.ms !== undefined ? ` · ${fmtDur(s.ms)}` : ""}${s.exitCode !== undefined && s.exitCode !== null ? ` · Exit ${s.exitCode}` : ""}` }),
            h("code", { class: "faint", style: { fontSize: "11px" }, text: s.run.length > 60 ? `${s.run.slice(0, 58)}…` : s.run }),
            s.tests ? h("div", { class: s.tests.failures + s.tests.errors ? "st-bad" : "st-ok", text: `${s.tests.total} Tests · ${s.tests.failures + s.tests.errors} rot` }) : null,
          ),
        ),
      ),
    )
    const t = r.tests
    swap(
      testsEl,
      t
        ? h(
            "div",
            { class: "card" },
            h("h3", { text: `Tests: ${t.total} · rot ${t.failures + t.errors} · übersprungen ${t.skipped}` }),
            t.failed.length ? h("div", { class: "list" }, t.failed.map((f) => h("div", { class: "row" }, h("span", { class: "st-bad", text: "✗" }), h("div", { class: "main" }, h("div", { class: "title mono", text: `${f.suite} › ${f.name}` }), f.message ? h("div", { class: "desc mono", text: f.message }) : null)))) : h("div", { class: "st-ok", text: "Alle Tests grün." }),
          )
        : null,
    )
  }

  const appendLog = (text) => {
    logEl.append(document.createTextNode(text))
    if (follow) logEl.scrollTop = logEl.scrollHeight
  }

  async function reload() {
    const d = await get("pipeline/run", { project, id: runId, from: offset })
    if (!ctx.alive()) return
    run = d.run
    if (d.log?.text) {
      appendLog(d.log.text)
      offset = d.log.size ?? offset + d.log.text.length
    }
    draw()
  }
  await reload()
  ctx.on("pipeline.log", (d) => d.run === runId && appendLog(d.text))
  ctx.on("pipeline.run", (d) => {
    if (d.run !== runId) return
    // the log stream is live; refresh status and stages only
    get("pipeline/run", { project, id: runId, from: 1e9 })
      .then((x) => {
        if (!ctx.alive()) return
        run = x.run
        draw()
      })
      .catch(() => {})
  })
}
