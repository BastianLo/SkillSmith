import { get } from "../api.js"
import { css, debounce, entryHref, fmtCost, fmtDate, fmtDur, fmtNum, h, icon, put, s, swap } from "../dom.js"
import { mdBlock } from "../parts.js"
import { act, app, card, fill, modal, promptDialog } from "../ui.js"
import { criteriaEditor, testcaseEditor } from "../fields.js"
import { FINAL, jobChip, jobLabel, STEP_LABEL } from "./agents.js"

const RUNNING = new Set(["starting", "working", "checking"])
function proposalCard(job, onDone) {
  const p = job.proposals[job.proposals.length - 1]
  if (!p) return null
  const waiting = job.phase === "waiting" && job.waitingFor === "plan"
  const answers = (p.questions || []).map((q) => ({ q, input: h("textarea", { class: "input", rows: 2, placeholder: "Antwort" }) }))
  const comments = h("textarea", { class: "input", rows: 3, placeholder: "Kommentare zum Plan (bei „Überarbeiten“ Pflicht – der Grund wird zum Regel-Kandidaten)" })
  const list = (title, items) => (items?.length ? [h("h4", { text: title }), h("ul", null, items.map((x) => h("li", { text: x })))] : null)
  const crit = waiting && !app.readOnly ? criteriaEditor(p.criteria) : null
  const tests = waiting && !app.readOnly ? testcaseEditor(p.testcases) : null
  return h(
    "div",
    { class: `card proposal ${waiting ? "warn" : ""}` },
    h("div", { class: "card-head" }, h("h3", { class: "grow", text: `Plan${job.proposals.length > 1 ? ` (Runde ${p.round})` : ""}${waiting ? " – Tor 1: Ihre Freigabe" : ""}` }), h("span", { class: "faint", text: fmtDate(p.at) })),
    p.approach ? [h("h4", { text: "Ansatz" }), mdBlock(p.approach)] : mdBlock(p.text),
    list("Betroffene Dateien", p.files),
    list("Schritte (werden zur Checkliste der Aufgabe)", p.steps),
    list("Risiken", p.risks),
    crit ? [h("h4", { text: "Akzeptanzkriterien – bitte prüfen und ergänzen" }), crit.el] : list("Akzeptanzkriterien", (p.criteria || []).map((c) => `${c.id}: ${c.text}`)),
    tests ? [h("h4", { text: "Testfälle" }), tests.el] : list("Testfälle", (p.testcases || []).map((t) => `${t.id} (${t.mode}) ${t.title}${t.command ? ` – ${t.command}` : ""}`)),
    answers.length ? [h("h4", { text: "Offene Fragen" }), answers.map((a) => h("div", { class: "question" }, h("div", { style: { fontWeight: 600 }, text: a.q }), waiting && !app.readOnly ? a.input : null))] : null,
    p.approach ? h("details", null, h("summary", { class: "faint", text: "Volle Antwort des Agenten" }), mdBlock(p.text)) : null,
    waiting && !app.readOnly
      ? [
          h("h4", { text: "Ihre Rückmeldung" }),
          comments,
          h(
            "div",
            { class: "toolbar" },
            h("button", { class: "btn primary", type: "button", onclick: async () => {
              const ans = answers.filter((a) => a.input.value.trim()).map((a) => `${a.q}\n→ ${a.input.value.trim()}`).join("\n\n")
              ;(await act("agent.approve", { job: job.id, comments: comments.value.trim() || undefined, answers: ans || undefined, criteria: crit.value(), testcases: tests.value() })) && onDone()
            } }, icon("check", 14), "Freigeben – umsetzen"),
            h("button", { class: "btn", type: "button", onclick: async () => {
              if (!comments.value.trim()) return comments.focus()
              ;(await act("agent.revise", { job: job.id, comments: comments.value.trim() })) && onDone()
            } }, "Überarbeiten lassen"),
          ),
        ]
      : p.verdict
        ? h("div", { class: "faint", text: `Entscheidung: ${p.verdict === "approved" ? "freigegeben" : p.verdict === "revise" ? "überarbeiten" : p.verdict}${p.comments ? ` – ${p.comments}` : ""}` })
        : null,
    job.proposals.length > 1 ? h("details", null, h("summary", { class: "faint", text: `Frühere Runden (${job.proposals.length - 1})` }), job.proposals.slice(0, -1).map((x) => h("div", { class: "card flat tight", style: { marginTop: "6px" } }, h("div", { class: "faint", text: `Runde ${x.round} · ${fmtDate(x.at)} · ${x.verdict || ""}${x.comments ? ` – ${x.comments}` : ""}` }), mdBlock(x.approach || x.text)))) : null,
  )
}

/** The columns of the workflow with the card's position, loops and the agent per column. */
function flowStrip(j, flows) {
  const cols = Object.values(flows || {})
  if (!cols.length) return null
  const visited = new Map()
  for (const r of j.stepRuns || []) visited.set(r.column, r.result || (r.endedAt ? "ok" : "running"))
  return h(
    "div",
    { class: "flow-strip" },
    cols.map((f, i) => {
      const state = f.column === j.column ? (j.phase === "halted" ? "halted" : j.phase === "waiting" ? "waiting" : FINAL.has(j.phase) ? "done" : "current") : visited.get(f.column) || ""
      return [
        i ? h("span", { class: "flow-arrow", text: "→" }) : null,
        h(
          "div",
          { class: `flow-col ${state}`, title: [f.step ? STEP_LABEL[f.step] : "ohne Agent", f.agent ? `Agent ${f.agent}` : "", f.checks?.length ? `Prüfungen: ${f.checks.join(", ")}` : "", f.gate ? "Tor: Ihre Freigabe" : ""].filter(Boolean).join(" · ") },
          h("div", { class: "fc-name", text: f.column }),
          h("div", { class: "fc-step", text: f.step ? `${STEP_LABEL[f.step]}${f.agent ? ` · ${f.agent}` : ""}` : "manuell" }),
          f.gate ? h("span", { class: "fc-gate", title: "Tor: Ihre Freigabe", text: "Tor" }) : null,
        ),
      ]
    }),
    j.loops ? h("span", { class: "chip warn", style: { marginLeft: "10px" }, text: `${j.loops} Rücksprung/Rücksprünge` }) : null,
  )
}

function stepsCard(j) {
  const runs = j.stepRuns || []
  if (!runs.length) return null
  return card(
    "Verlauf der Schritte",
    h(
      "table",
      { class: "facts", style: { width: "100%" } },
      h(
        "tbody",
        null,
        runs.map((r) =>
          h(
            "tr",
            null,
            h("td", { class: "nowrap faint", text: fmtDate(r.at) }),
            h("td", { class: "nowrap" }, h("strong", { text: r.column }), r.step ? h("span", { class: "faint", text: ` ${STEP_LABEL[r.step]}` }) : null),
            h("td", { class: "nowrap", text: r.agent ? `${r.agent}${r.version ? ` · v${r.version.slice(0, 6)}` : ""}` : "" }),
            h("td", { class: "nowrap" }, r.result ? h("span", { class: `chip ${r.result === "ok" ? "ok" : r.result === "failed" ? "danger" : r.result === "waiting" ? "warn" : ""}`, text: { ok: "bestanden", failed: "zurück", waiting: "wartet", aborted: "abgebrochen" }[r.result] }) : h("span", { class: "chip accent", text: "läuft" })),
            h("td", { text: r.note || "" }),
          ),
        ),
      ),
    ),
    h("div", { style: { marginTop: "6px" } }, h("a", { href: `#/logs?job=${encodeURIComponent(j.id)}&stufe=debug`, text: "Logzeilen dieses Auftrags →" })),
  )
}

function testsCard(j) {
  const run = (j.testRuns || [])[j.testRuns.length - 1]
  if (!run || !run.results.length) return null
  return card(
    `Testdurchführung ${fmtDate(run.at)}`,
    h("ul", { class: "meta-lines" }, run.results.map((r) => h("li", null, h("span", { class: r.result === "bestanden" ? "st-ok" : r.result === "fehlgeschlagen" ? "st-bad" : "faint", text: r.result }), ` ${r.id} (${r.by})`, r.protocol ? h("details", null, h("summary", { class: "faint", text: "Protokoll" }), h("pre", { class: "mono", style: { whiteSpace: "pre-wrap", fontSize: "12px" }, text: r.protocol })) : null))),
    run.pipelineRun ? h("a", { href: `#/pipeline/${encodeURIComponent(j.project || "")}/${encodeURIComponent(run.pipelineRun)}`, text: "Log der Befehls-Tests →" }) : null,
  )
}

function timeline(job, sessions) {
  if (!sessions.length) return null
  const start = Math.min(...sessions.map((x) => x.startedAt))
  const end = Math.max(...sessions.map((x) => x.endedAt || (x.status === "busy" ? Date.now() : x.updatedAt)))
  const span = Math.max(1000, end - start)
  const W = 800
  const rowH = 18
  const H = 24 + sessions.length * rowH
  const svg = s("svg", { class: "timeline-svg", viewBox: `0 0 ${W} ${H}`, height: H })
  sessions.forEach((x, i) => {
    const x1 = 120 + ((x.startedAt - start) / span) * (W - 130)
    const x2 = 120 + (((x.endedAt || (x.status === "busy" ? Date.now() : x.updatedAt)) - start) / span) * (W - 130)
    svg.append(s("text", { x: 4, y: 18 + i * rowH + 10, "font-size": 10, text: (x.agent || x.id).slice(0, 18) }))
    svg.append(s("rect", { x: x1, y: 14 + i * rowH, width: Math.max(3, x2 - x1), height: rowH - 6, rx: 3, fill: x.status === "error" ? css("--danger") : x.status === "busy" ? css("--accent") : css("--ok"), opacity: 0.8 }, s("title", { text: `${x.agent || x.id}: ${fmtDur((x.endedAt || x.updatedAt) - x.startedAt)}${x.tool ? ` · ${x.tool}` : ""}` })))
  })
  svg.append(s("text", { x: 120, y: 10, "font-size": 9, text: fmtDate(start) }), s("text", { x: W - 4, y: 10, "font-size": 9, "text-anchor": "end", text: `${fmtDur(span)}` }))
  return card("Zeitleiste", svg)
}

function sessionTree(sessions, selected, onSelect) {
  const byParent = new Map()
  for (const x of sessions) (byParent.get(x.parent || "") ?? byParent.set(x.parent || "", []).get(x.parent || "")).push(x)
  const ids = new Set(sessions.map((x) => x.id))
  const roots = sessions.filter((x) => !x.parent || !ids.has(x.parent))
  const node = (x) =>
    h(
      "div",
      null,
      h(
        "div",
        { class: `node${x.id === selected ? " on" : ""}`, onclick: () => onSelect(x.id), title: x.id },
        h("span", { class: `dot ${x.status}` }),
        h("span", { class: "grow ellipsis" }, h("strong", { text: x.agent || "Agent" }), x.title ? h("span", { class: "faint", text: ` ${x.title.slice(0, 40)}` }) : null),
        x.tool ? h("span", { class: "chip", text: x.tool }) : null,
        h("span", { class: "faint", style: { fontSize: "11px" }, text: `${fmtNum(x.tokens)} · ${fmtCost(x.cost)}` }),
      ),
      (byParent.get(x.id) || []).length ? h("div", { class: "children" }, byParent.get(x.id).map(node)) : null,
    )
  return h("div", { class: "tree" }, roots.map(node))
}

function sessionPanel(view, job, onAction) {
  const msgInput = h("textarea", { class: "input", rows: 2, placeholder: "Nachricht an diese Session nachschieben …" })
  const running = view.session.status === "busy"
  return h(
    "div",
    { class: "stack" },
    h(
      "div",
      { class: "card" },
      h("div", { class: "card-head" }, h("h3", { class: "grow", text: `${view.session.agent || "Agent"} · ${view.session.model || ""}` }), h("span", { class: "faint", text: `${fmtNum(view.session.tokens)} Tokens · ${fmtCost(view.session.cost)}` }), running && !app.readOnly ? h("button", { class: "btn sm danger", type: "button", text: "Session abbrechen", onclick: () => onAction("agent.abort", { job: job.id, session: view.session.id }) }) : null),
      view.session.error ? h("div", { class: "notice error", text: view.session.error }) : null,
      view.todos?.length ? h("div", null, h("h4", { text: "Todos" }), h("ul", { class: "meta-lines" }, view.todos.map((t) => h("li", { class: t.status === "completed" ? "faint" : "", text: `${t.status === "completed" ? "✓" : t.status === "in_progress" ? "▶" : "○"} ${t.content}` })))) : null,
      h(
        "div",
        null,
        view.messages.length
          ? view.messages.map((m) =>
              h(
                "div",
                { class: `msg ${m.role}` },
                h("div", { class: "m-head" }, h("strong", { text: m.role === "user" ? "Auftrag / Nachricht" : m.agent || "Agent" }), h("span", { text: m.at ? fmtDate(m.at) : "" }), m.tokens ? h("span", { text: `${fmtNum(m.tokens)} Tokens` }) : null),
                m.parts.map((p) =>
                  p.type === "tool"
                    ? h("details", { class: "tool-call" }, h("summary", null, h("strong", { text: p.tool }), h("span", { class: p.status === "error" ? "st-bad" : p.status === "completed" ? "st-ok" : "st-run", text: p.status }), h("span", { class: "faint ellipsis", text: p.title || "" }), p.end && p.start ? h("span", { class: "faint", text: fmtDur(p.end - p.start) }) : null), h("pre", { text: `${p.input}\n\n${p.output || ""}` }))
                    : p.type === "reasoning"
                      ? h("details", null, h("summary", { class: "faint", text: "Überlegung" }), h("div", { class: "faint", style: { whiteSpace: "pre-wrap", fontSize: "12.5px" }, text: p.text }))
                      : m.role === "user" && p.text.length > 700
                        ? h("details", null, h("summary", { class: "muted", text: `${p.text.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").slice(0, 120) || "Auftrag"} … (${Math.round(p.text.length / 100) / 10}k Zeichen)` }), mdBlock(p.text))
                        : mdBlock(p.text),
                ),
              ),
            )
          : h("div", { class: "faint", text: "Noch keine Nachrichten." }),
      ),
      !FINAL.has(job.phase) && !app.readOnly
        ? h(
            "div",
            { class: "toolbar" },
            msgInput,
            h("button", { class: "btn", type: "button", text: "Senden", onclick: async () => msgInput.value.trim() && (await onAction("agent.message", { job: job.id, text: msgInput.value.trim(), session: view.session.id })) && (msgInput.value = "") }),
          )
        : null,
    ),
  )
}

async function acceptDialog(job) {
  const mode = await modal((close) => ({
    title: "Abnehmen (Tor 2)",
    body: [
      h("p", { text: "Die Aufgabe kommt nach „erledigt“. Was passiert mit den Änderungen?" }),
      job.phase === "halted" ? h("div", { class: "notice warn", text: "Der Auftrag ist angehalten – Tests oder Kriterien sind nicht bestanden. Abnehmen geht trotzdem." }) : null,
      job.workplace === "worktree"
        ? h("div", { class: "stack" }, h("button", { class: "btn primary", type: "button", text: `Branch ${job.branch || ""} in den aktuellen Branch mergen`, onclick: () => close("merge") }), h("button", { class: "btn", type: "button", text: "Als Pull Request vorbereiten (Branch bleibt, Hinweis mit Befehlen)", onclick: () => close("pr") }), h("button", { class: "btn", type: "button", text: "Branch behalten, nichts mergen", onclick: () => close("keep") }), h("button", { class: "btn danger", type: "button", text: "Änderungen verwerfen", onclick: () => close("discard") }))
        : h("div", { class: "stack" }, h("button", { class: "btn primary", type: "button", text: "Änderungen behalten (sie liegen schon im Projektverzeichnis)", onclick: () => close("keep") })),
    ],
    foot: [h("button", { class: "btn", type: "button", text: "Abbrechen", onclick: () => close(undefined) })],
  }))
  if (!mode) return null
  return act("agent.accept", { job: job.id, mode })
}

export default async function job(ctx) {
  const id = ctx.params.job
  let selected = null
  const page = h("div", { class: "page", style: { maxWidth: "1500px" } })
  ctx.el.replaceChildren(page)
  const headEl = h("div")
  const flowEl = h("div")
  const permEl = h("div")
  const phaseEl = h("div")
  const treeEl = h("div", { class: "card" })
  const sessEl = h("div")
  const timeEl = h("div")
  put(page, headEl, flowEl, permEl, phaseEl, h("div", { style: { marginTop: "14px" } }, timeEl), h("div", { class: "job-layout", style: { marginTop: "14px" } }, h("div", { class: "stack" }, treeEl), sessEl))
  let data

  const run = async (action, args, opts) => {
    const r = await act(action, args, opts)
    if (r) await load()
    return r
  }

  const load = async () => {
    data = await get("job", { id })
    if (!ctx.alive()) return
    const j = data.job
    ctx.title(`${j.task.toUpperCase()} · ${j.agent}`)
    const dur = (j.endedAt ? Date.parse(j.endedAt) : Date.now()) - Date.parse(j.startedAt)
    const accept = (j.phase === "waiting" && j.waitingFor === "accept") || j.phase === "halted"
    const improve = async () => {
      const text = await promptDialog("Nachbessern", { label: "Ihr Hinweis an den Agenten (die Begründung wird zum Regel-Kandidaten)", multiline: true })
      if (text) run("agent.improve", { job: j.id, text })
    }
    swap(
      headEl,
      h(
        "div",
        { class: "page-head" },
        h(
          "div",
          { class: "grow" },
          h("div", { class: "entry-head" }, jobChip(j), h("a", { class: "chip", href: entryHref(`task:${j.task}`), text: j.task.toUpperCase() }), j.project ? h("a", { class: "chip outline", href: `#/projekt/${encodeURIComponent(j.project)}`, text: j.project }) : null, j.prepared ? h("span", { class: "chip", text: "vorab erstellt" }) : null),
          h("h1", { text: `${j.agent}${j.model ? ` · ${j.model}` : ""}` }),
          h("div", { class: "muted", text: `${j.workplace === "worktree" ? `Worktree ${j.workdir}${j.branch ? ` · Branch ${j.branch}` : ""}` : `direkt in ${j.workdir}`} · ${fmtDur(dur)} · ${fmtNum(j.tokens)} Tokens · ${fmtCost(j.cost)}${j.diffStat ? ` · ${j.diffStat.files} Datei(en) +${j.diffStat.additions} −${j.diffStat.deletions}` : ""}` }),
          j.modelNote ? h("div", { class: "faint", style: { fontSize: "12.5px" }, text: `Modell: ${j.modelNote}` }) : null,
          j.error ? h("div", { class: "notice error", text: j.error }) : null,
        ),
        app.readOnly || FINAL.has(j.phase)
          ? null
          : h(
              "div",
              { class: "toolbar" },
              accept ? h("button", { class: "btn primary", type: "button", onclick: async () => (await acceptDialog(j)) && load() }, icon("check", 14), "Abnehmen") : null,
              j.phase === "halted" ? h("button", { class: "btn", type: "button", text: "Eine weitere Runde …", title: "Noch einmal zurück in die Umsetzung, optional mit Ihrem Hinweis", onclick: async () => {
                const text = await promptDialog("Eine weitere Runde", { label: "Hinweis an den Agenten (optional)", multiline: true, required: false })
                if (text !== null && text !== undefined) run("agent.continue", { job: j.id, text: text || undefined })
              } }) : null,
              j.phase === "waiting" && ["gate", "manual", "tests"].includes(j.waitingFor) ? h("button", { class: "btn primary", type: "button", onclick: () => run("agent.continue", { job: j.id }) }, icon("play", 14), j.waitingFor === "tests" ? "Testergebnisse auswerten" : "Weiter") : null,
              accept ? h("button", { class: "btn", type: "button", text: "Nachbessern …", onclick: improve }) : null,
              accept && j.pipelineRuns.length ? h("button", { class: "btn", type: "button", text: "Agent bessert nach (Pipeline)", title: "Fehlerausgabe der letzten roten Pipeline in die Umsetzung", onclick: () => run("agent.fixFromPipeline", { job: j.id }) }) : null,
              accept ? h("button", { class: "btn danger", type: "button", text: "Verwerfen", onclick: () => run("agent.discard", { job: j.id }, { label: "Änderungen verwerfen" }) }) : null,
              h("button", { class: "btn danger", type: "button", text: "Auftrag abbrechen", onclick: () => run("agent.abort", { job: j.id }) }),
            ),
      ),
    )
    swap(flowEl, flowStrip(j, data.flows))
    swap(
      permEl,
      j.permissions.length
        ? h(
            "div",
            { class: "card warn" },
            h("h3", { text: "Rückfragen von opencode" }),
            j.permissions.map((p) =>
              h(
                "div",
                { class: "row-flex", style: { margin: "6px 0" } },
                h("div", { class: "grow" }, h("strong", { text: p.title }), h("div", { class: "faint mono", text: `${p.type}${p.pattern ? ` · ${p.pattern}` : ""} · ${fmtDate(p.at)}` })),
                app.readOnly ? null : [h("button", { class: "btn sm primary", type: "button", text: "Einmal", onclick: () => run("agent.permission", { job: j.id, permission: p.id, response: "once" }) }), h("button", { class: "btn sm", type: "button", text: "Immer", onclick: () => run("agent.permission", { job: j.id, permission: p.id, response: "always" }) }), h("button", { class: "btn sm danger", type: "button", text: "Ablehnen", onclick: () => run("agent.permission", { job: j.id, permission: p.id, response: "reject" }) })],
              ),
            ),
          )
        : null,
    )
    const parts = []
    if (RUNNING.has(j.phase)) parts.push(h("div", { class: "notice" }, h("span", { class: "spinner" }), ` ${jobLabel(j)} … ${j.step === "plan" ? "(ohne Schreibrechte – auch Subagenten können nichts ändern)" : j.step === "test" ? "(ohne Schreibrechte, Befehle erlaubt)" : j.step === "verify" ? "(nur lesend)" : ""}`))
    if (j.phase === "halted") parts.push(h("div", { class: "card danger" }, h("h3", { text: `Angehalten nach ${j.loops} Rücksprüngen` }), mdBlock(j.halted?.reason || ""), h("p", { class: "muted", style: { fontSize: "13px" }, text: "Weiter mit „Eine weitere Runde“, „Nachbessern“ mit Ihrem Hinweis, Abnehmen trotz offener Punkte oder Verwerfen." })))
    if (j.phase === "waiting" && j.waitingFor === "tests") parts.push(h("div", { class: "notice warn" }, "Manuelle Testfälle warten auf Ihr Ergebnis – ", h("a", { href: `${entryHref(`task:${j.task}`)}?tab=tests`, text: "in der Aufgabe eintragen" }), "."))
    if (j.proposals.length) parts.push(proposalCard(j, load))
    if (j.summary) parts.push(card("Zusammenfassung der Umsetzung", mdBlock(j.summary)))
    parts.push(testsCard(j))
    if (j.review) {
      parts.push(
        h(
          "div",
          { class: `card ${j.review.findings.some((f) => f.severity === "error") ? "danger" : j.review.findings.length ? "warn" : ""}` },
          h("h3", { text: `Verifikation · ${j.review.status === "running" ? "läuft" : `${(j.review.verdicts || []).filter((v) => v.verdict === "erfuellt").length}/${(j.review.verdicts || []).length} Kriterien erfüllt, ${j.review.findings.length} Befund(e)`}` }),
          j.review.summary ? mdBlock(j.review.summary) : null,
          j.review.verdicts?.length ? h("ul", { class: "meta-lines" }, j.review.verdicts.map((v) => h("li", null, h("span", { class: v.verdict === "erfuellt" ? "st-ok" : v.verdict === "nicht_erfuellt" ? "st-bad" : "ring-warn", text: v.verdict === "erfuellt" ? "erfüllt" : v.verdict === "nicht_erfuellt" ? "nicht erfüllt" : "unklar" }), ` ${v.criterion}${v.evidence ? ` – ${v.evidence}` : ""}`))) : null,
          j.review.findings.length ? h("ul", { class: "meta-lines" }, j.review.findings.map((f) => h("li", null, h("span", { class: f.severity === "error" ? "st-bad" : f.severity === "warn" ? "ring-warn" : "faint", text: f.severity === "error" ? "Fehler" : f.severity === "warn" ? "Warnung" : "Info" }), ` ${f.source === "ai" ? "(Verifikation)" : "(Prüfung)"} ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""} – ` : ""}${f.text}`))) : null,
        ),
      )
    }
    parts.push(stepsCard(j))
    if (j.pipelineRuns.length) parts.push(card("Pipeline", h("ul", { class: "meta-lines" }, j.pipelineRuns.map((rid) => h("li", null, h("a", { href: `#/pipeline/${encodeURIComponent(j.project || "")}/${encodeURIComponent(rid)}`, class: "mono", text: rid })))), j.pipelineFirstGreen !== undefined ? h("div", { class: "faint", text: j.pipelineFirstGreen ? "beim ersten Mal grün" : `nach ${j.fixRounds} Nachbesserung(en)` }) : null))
    if (j.diffStat || ["implement", "test", "verify"].includes(j.step)) {
      const diffEl = h("div")
      parts.push(h("div", { class: "card" }, h("h3", { text: "Änderungen" }), diffEl))
      fill(diffEl, async () => {
        const { renderFileDiffs } = await import("../diff.js")
        return renderFileDiffs(await get("job/diff", { id }), j.review?.findings || [])
      })
    }
    if (j.messages.length) parts.push(card("Ihre Nachrichten", h("ul", { class: "meta-lines" }, j.messages.map((m) => h("li", { text: `${fmtDate(m.at)} · ${m.from === "user" ? "Sie" : "System"}: ${m.text}` })))))
    // do not wipe what the user is typing (comments, criteria, answers) on live updates
    const typing = phaseEl.contains(document.activeElement) && /^(TEXTAREA|INPUT|SELECT)$/.test(document.activeElement.tagName)
    if (!typing) swap(phaseEl, h("div", { class: "stack" }, parts.filter(Boolean)))
    const sessions = data.sessions
    if (!selected || !sessions.some((x) => x.id === selected)) selected = j.session || sessions[0]?.id
    swap(treeEl, h("h3", { style: { marginTop: 0 }, text: `Sessions (${sessions.length})` }), sessions.length ? sessionTree(sessions, selected, (sid) => ((selected = sid), load())) : h("div", { class: "faint", text: "Noch keine Session." }))
    swap(timeEl, timeline(j, sessions))
    if (selected) {
      try {
        const v = await get("job/session", { id, session: selected })
        const typingMsg = sessEl.contains(document.activeElement) && document.activeElement.tagName === "TEXTAREA"
        if (ctx.alive() && !typingMsg) swap(sessEl, sessionPanel(v, j, run))
      } catch (err) {
        swap(sessEl, h("div", { class: "notice error", text: String(err.message) }))
      }
    } else swap(sessEl, h("div", { class: "card faint", text: FINAL.has(j.phase) ? "Keine Session." : "Session wird gestartet …" }))
  }
  await load()
  const later = debounce(() => ctx.alive() && load(), 1200)
  ctx.on("agent.job", (d) => d.job === id && later())
  ctx.on("agent.event", (d) => d.job === id && later())
  ctx.on("agent.tool", (d) => d.job === id && later())
}
