// Structured fields of a task (5b): acceptance criteria, test cases, approved plan, verification.
// Editors (plan approval, task page) and read views (task page, job page) share this module.
import { fmtDate, h, icon, swap } from "./dom.js"
import { mdBlock } from "./parts.js"

export const TEST_MODES = [["befehl", "Befehl"], ["agent", "Test-Agent"], ["manuell", "von Hand"]]
const MODE_LABEL = Object.fromEntries(TEST_MODES)
const CRIT_LABEL = { offen: "offen", erfuellt: "erfüllt", nicht_erfuellt: "nicht erfüllt" }
const RESULT_CLASS = { bestanden: "ok", fehlgeschlagen: "danger", offen: "" }
const VERDICT_LABEL = { erfuellt: "erfüllt", nicht_erfuellt: "nicht erfüllt", unklar: "unklar" }

/** Editable list of acceptance criteria (gate 1: the planner proposes, the user confirms). */
export function criteriaEditor(initial) {
  const items = (initial || []).map((c) => ({ ...c }))
  const box = h("div", { class: "stack" })
  const nextId = () => `K${Math.max(0, ...items.map((c) => Number(/^K(\d+)$/.exec(c.id || "")?.[1] || 0))) + 1}`
  const draw = () =>
    swap(
      box,
      items.map((c, i) => {
        const inp = h("input", { class: "input", value: c.text, placeholder: "prüfbares Kriterium", "aria-label": `Kriterium ${c.id}` })
        inp.addEventListener("input", () => (c.text = inp.value))
        return h("div", { class: "row-flex" }, h("span", { class: "chip mono", text: c.id || `K${i + 1}` }), h("div", { class: "grow" }, inp), h("button", { class: "btn sm ghost icon", type: "button", title: "entfernen", onclick: () => (items.splice(i, 1), draw()) }, icon("x", 12)))
      }),
      h("button", { class: "btn sm ghost", type: "button", onclick: () => (items.push({ id: nextId(), text: "", status: "offen" }), draw()) }, icon("plus", 12), "Kriterium"),
    )
  draw()
  return { el: box, value: () => items.filter((c) => c.text.trim()).map((c) => ({ id: c.id, text: c.text.trim(), status: c.status || "offen", ...(c.evidence ? { evidence: c.evidence } : {}) })) }
}

/** Editable list of test cases (title, mode, command, expected, steps, precondition). */
export function testcaseEditor(initial) {
  const items = (initial || []).map((t) => ({ ...t, steps: [...(t.steps || [])] }))
  const box = h("div", { class: "stack" })
  const nextId = () => `TF${Math.max(0, ...items.map((t) => Number(/^TF(\d+)$/.exec(t.id || "")?.[1] || 0))) + 1}`
  const draw = () =>
    swap(
      box,
      items.map((t, i) => {
        const title = h("input", { class: "input", value: t.title, placeholder: "Testfall", "aria-label": `Testfall ${t.id}` })
        title.addEventListener("input", () => (t.title = title.value))
        const mode = h("select", { class: "input", "aria-label": "Art" }, TEST_MODES.map(([v, l]) => h("option", { value: v, text: l, selected: t.mode === v })))
        const cmd = h("input", { class: "input mono", value: t.command || "", placeholder: "Befehl (Exit 0 = bestanden)" })
        cmd.addEventListener("input", () => (t.command = cmd.value))
        const pre = h("input", { class: "input", value: t.pre || "", placeholder: "Vorbedingung (optional)" })
        pre.addEventListener("input", () => (t.pre = pre.value))
        const exp = h("input", { class: "input", value: t.expected || "", placeholder: "erwartetes Ergebnis" })
        exp.addEventListener("input", () => (t.expected = exp.value))
        const steps = h("textarea", { class: "input", rows: 2, placeholder: "Schritte (je Zeile)" })
        steps.value = (t.steps || []).join("\n")
        steps.addEventListener("input", () => (t.steps = steps.value.split("\n").map((x) => x.trim()).filter(Boolean)))
        const cmdWrap = h("div", { class: t.mode === "befehl" ? "" : "hidden" }, cmd)
        mode.addEventListener("change", () => ((t.mode = mode.value), cmdWrap.classList.toggle("hidden", t.mode !== "befehl")))
        return h(
          "div",
          { class: "card flat tight" },
          h("div", { class: "row-flex" }, h("span", { class: "chip mono", text: t.id || `TF${i + 1}` }), h("div", { class: "grow" }, title), mode, h("button", { class: "btn sm ghost icon", type: "button", title: "entfernen", onclick: () => (items.splice(i, 1), draw()) }, icon("x", 12))),
          h("div", { class: "fields", style: { marginTop: "6px" } }, cmdWrap, pre, exp),
          steps,
        )
      }),
      h("button", { class: "btn sm ghost", type: "button", onclick: () => (items.push({ id: nextId(), title: "", mode: "befehl", steps: [], expected: "" }), draw()) }, icon("plus", 12), "Testfall"),
    )
  draw()
  return {
    el: box,
    value: () =>
      items
        .filter((t) => t.title.trim())
        .map((t) => ({ id: t.id, title: t.title.trim(), mode: t.mode || "agent", ...(t.mode === "befehl" && t.command?.trim() ? { command: t.command.trim() } : {}), expected: t.expected?.trim() || "wie beschrieben", steps: t.steps || [], ...(t.pre?.trim() ? { pre: t.pre.trim() } : {}), ...(t.last ? { last: t.last } : {}) })),
  }
}

const listOf = (title, items) => (items?.length ? [h("h4", { text: title }), h("ul", null, items.map((x) => h("li", { text: x })))] : null)

/** The approved plan (read only). */
export function planView(plan) {
  if (!plan) return h("div", { class: "faint", text: "Noch kein freigegebener Plan." })
  return h(
    "div",
    { class: "plan-view" },
    plan.approach ? mdBlock(plan.approach) : null,
    listOf("Betroffene Dateien", plan.files),
    listOf("Schritte", plan.steps),
    listOf("Risiken", plan.risks),
    listOf("Offene Fragen", plan.questions),
    plan.answers ? [h("h4", { text: "Ihre Antworten" }), h("p", { class: "pre-line", text: plan.answers })] : null,
    plan.comments ? [h("h4", { text: "Ihre Kommentare" }), h("p", { class: "pre-line", text: plan.comments })] : null,
    h("div", { class: "faint", style: { fontSize: "12px", marginTop: "6px" }, text: [plan.by ? `von ${plan.by}` : "", plan.round ? `Runde ${plan.round}` : "", plan.approvedAt ? `freigegeben ${fmtDate(plan.approvedAt)}` : "noch nicht freigegeben"].filter(Boolean).join(" · ") }),
  )
}

/** Acceptance criteria with their status and evidence. */
export function criteriaView(criteria) {
  if (!criteria?.length) return h("div", { class: "faint", text: "Keine Akzeptanzkriterien. Der Planer schlägt welche vor, Sie bestätigen sie bei der Freigabe – oder Sie tragen sie hier ein." })
  return h(
    "ul",
    { class: "crit-list" },
    criteria.map((c) =>
      h(
        "li",
        { class: `crit ${c.status}` },
        h("span", { class: "chip mono", text: c.id }),
        h("div", { class: "grow" }, h("div", { text: c.text }), c.evidence ? h("div", { class: "faint", style: { fontSize: "12.5px" }, text: c.evidence }) : null),
        h("span", { class: `chip ${c.status === "erfuellt" ? "ok" : c.status === "nicht_erfuellt" ? "danger" : ""}`, text: CRIT_LABEL[c.status] || c.status }),
        c.confirmed ? h("span", { class: "faint", title: "von Ihnen bestätigt", text: "✓" }) : null,
      ),
    ),
  )
}

/** Test cases with the last result; `onResult(id, result)` enables manual entry. */
export function testcasesView(cases, { onResult, project } = {}) {
  if (!cases?.length) return h("div", { class: "faint", text: "Keine Testfälle." })
  return h(
    "div",
    { class: "stack" },
    cases.map((t) =>
      h(
        "div",
        { class: "card flat tight tcase" },
        h(
          "div",
          { class: "row-flex" },
          h("span", { class: "chip mono", text: t.id }),
          h("strong", { class: "grow", text: t.title }),
          h("span", { class: "chip outline", text: MODE_LABEL[t.mode] || t.mode }),
          t.last ? h("span", { class: `chip ${RESULT_CLASS[t.last.result] || ""}`, title: `${fmtDate(t.last.at)} · ${t.last.by === "user" ? "von Ihnen" : t.last.by === "befehl" ? "per Befehl" : "Test-Agent"}`, text: t.last.result }) : h("span", { class: "chip", text: "nicht gelaufen" }),
        ),
        t.pre ? h("div", { class: "faint", style: { fontSize: "12.5px" }, text: `Vorbedingung: ${t.pre}` }) : null,
        t.steps?.length ? h("ol", { class: "tc-steps" }, t.steps.map((s) => h("li", { text: s }))) : null,
        h("div", { style: { fontSize: "13px" } }, h("span", { class: "muted", text: "Erwartet: " }), t.expected),
        t.command ? h("div", { class: "mono", style: { fontSize: "12.5px" }, text: `$ ${t.command}` }) : null,
        t.last?.protocol ? h("details", null, h("summary", { class: "faint", text: "Protokoll" }), h("pre", { class: "mono", style: { whiteSpace: "pre-wrap", fontSize: "12px" }, text: t.last.protocol })) : null,
        t.last?.run && project ? h("a", { href: `#/pipeline/${encodeURIComponent(project)}/${encodeURIComponent(t.last.run)}`, style: { fontSize: "12.5px" }, text: "Log des Laufs →" }) : null,
        onResult
          ? h(
              "div",
              { class: "toolbar", style: { margin: "6px 0 0" } },
              h("button", { class: "btn sm", type: "button", onclick: () => onResult(t.id, "bestanden") }, icon("check", 12), "bestanden"),
              h("button", { class: "btn sm", type: "button", onclick: () => onResult(t.id, "fehlgeschlagen") }, icon("x", 12), "fehlgeschlagen"),
            )
          : null,
      ),
    ),
  )
}

/** Verification report (gate 2). */
export function verificationView(v, criteria = []) {
  if (!v) return h("div", { class: "faint", text: "Noch nicht verifiziert." })
  const text = (id) => criteria.find((c) => c.id === id)?.text || ""
  return h(
    "div",
    null,
    h("div", { class: "row-flex", style: { marginBottom: "6px" } }, h("span", { class: `chip ${v.ok ? "ok" : "danger"}`, text: v.ok ? "alle Kriterien erfüllt" : "nicht erfüllt" }), h("span", { class: "faint", text: `${v.by} · ${fmtDate(v.at)}${typeof v.findings === "number" ? ` · ${v.findings} Befund(e)` : ""}` })),
    v.summary ? h("p", { text: v.summary }) : null,
    v.verdicts?.length
      ? h(
          "table",
          { class: "facts", style: { width: "100%" } },
          h("tbody", null, v.verdicts.map((x) => h("tr", null, h("td", { class: "nowrap mono", text: x.criterion }), h("td", { text: text(x.criterion) }), h("td", { class: "nowrap" }, h("span", { class: `chip ${x.verdict === "erfuellt" ? "ok" : x.verdict === "nicht_erfuellt" ? "danger" : "warn"}`, text: VERDICT_LABEL[x.verdict] || x.verdict })), h("td", { class: "faint", text: x.evidence || "" })))),
        )
      : null,
  )
}

/** Short summary for the task overview: criteria met, test cases passed. */
export function fieldsSummary(f) {
  const crit = f?.criteria || []
  const tc = f?.testcases || []
  if (!crit.length && !tc.length && !f?.plan) return null
  const met = crit.filter((c) => c.status === "erfuellt").length
  const passed = tc.filter((t) => t.last?.result === "bestanden").length
  const red = tc.filter((t) => t.last?.result === "fehlgeschlagen").length
  return h(
    "div",
    { class: "chips" },
    f.plan ? h("span", { class: `chip ${f.plan.approvedAt ? "ok" : "warn"}`, text: f.plan.approvedAt ? "Plan freigegeben" : "Plan offen" }) : null,
    crit.length ? h("span", { class: `chip ${met === crit.length ? "ok" : ""}`, text: `Kriterien ${met}/${crit.length}` }) : null,
    tc.length ? h("span", { class: `chip ${red ? "danger" : passed === tc.length ? "ok" : ""}`, text: `Tests ${passed}/${tc.length}${red ? ` · ${red} rot` : ""}` }) : null,
    f.verification ? h("span", { class: `chip ${f.verification.ok ? "ok" : "danger"}`, text: f.verification.ok ? "verifiziert" : "Verifikation: nicht erfüllt" }) : null,
  )
}
