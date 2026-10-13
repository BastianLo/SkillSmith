// Quality parts of the entry view (5c): score with reasons, code anchors with their status
// and the code diff, provenance per paragraph (margin marks, source on hover, filter).
import { fmtDate, h, icon, put, swap } from "./dom.js"
import { act, app, card, modal, promptDialog } from "./ui.js"

const STATUS = {
  unchanged: ["unverändert", "ok"],
  changed: ["geändert", "warn"],
  moved: ["verschoben", "warn"],
  deleted: ["gelöscht", "danger"],
  unresolved: ["nicht auflösbar", ""],
}

const SOURCE_LABEL = {
  transcript: "Transkript",
  user: "Ihre Eingabe",
  session: "Session",
  commit: "Commit",
  ticket: "Ticket",
  confluence: "Confluence",
  code: "Code",
  doc: "Dokument",
  file: "Datei",
  comment: "Review-Kommentar",
  url: "Link",
}

/** Colored chip for a quality score (0–100). */
export function qualityChip(score) {
  if (score === null || score === undefined) return null
  const cls = score >= 75 ? "ok" : score >= 45 ? "warn" : "danger"
  return h("span", { class: `chip ${cls}`, title: "Qualitätswert" }, `Q ${score}`)
}

export function qualityBlock(data) {
  const q = data.quality
  if (!q) return null
  return card(
    "Qualität",
    h("div", { class: "row-flex" }, h("strong", { class: "big-number", text: String(q.score) }), h("span", { class: "faint", text: "von 100" }), qualityChip(q.score)),
    h(
      "table",
      { class: "facts" },
      h(
        "tbody",
        null,
        q.parts.map((p) => h("tr", null, h("td", { text: p.label }), h("td", null, h("div", { class: "qbar", title: `${Math.round(p.value * 100)} %` }, h("span", { style: { width: `${Math.round(p.value * 100)}%` } })), h("div", { class: "faint", text: p.reason })))),
      ),
    ),
  )
}

function anchorDiff(a) {
  const box = h("div", { class: "stack" }, h("div", { class: "faint", text: "Lade Diff …" }))
  import("./diff.js").then(({ diffBox, lineDiff }) => {
    swap(box, diffBox(`${a.path}${a.newPath ? ` → ${a.newPath}` : ""}`, lineDiff(a.before || "", a.after || ""), { empty: "Keine Änderung im verankerten Code." }))
  })
  return box
}

/** Code anchors of an entry with status, diff and the actions of the inbox. */
export function anchorsBlock(data, id, reload) {
  if (!data.anchors?.length) return null
  return card(
    "Code-Anker",
    data.anchors.map((a) => {
      const [label, cls] = STATUS[a.status] || ["noch nicht geprüft", ""]
      const row = h(
        "div",
        { class: "anchor-row" },
        h(
          "div",
          { class: "row-flex" },
          icon("code", 14),
          h("a", { class: "mono grow", href: `#/code?pfad=${encodeURIComponent(a.path)}${a.project ? `&projekt=${encodeURIComponent(a.project)}` : ""}`, text: a.ref }),
          h("span", { class: `chip ${cls}`, text: label }),
        ),
        h("div", { class: "faint mono", text: `${a.project ? `${a.project}: ` : ""}${a.path}${a.lines ? ` · Zeilen ${a.lines[0]}–${a.lines[1]}` : ""}` }),
        a.signature ? h("div", { class: "faint mono", text: a.signature }) : null,
        a.note ? h("div", { class: "faint", text: a.note }) : null,
      )
      if (a.status && a.status !== "unchanged" && a.status !== "unresolved") {
        const diff = h("details", null, h("summary", { text: "Code-Diff anzeigen" }))
        diff.addEventListener("toggle", () => diff.open && diff.children.length === 1 && diff.append(anchorDiff(a)))
        row.append(diff)
        if (!app.readOnly)
          row.append(
            h(
              "div",
              { class: "toolbar" },
              a.status !== "deleted" ? h("button", { class: "btn sm", type: "button", text: "Passt noch", onclick: async () => (await act("anchor.accept", { target: id, ref: a.ref })) && reload() }) : null,
              h("button", { class: "btn sm", type: "button", text: "Vom Agenten beheben lassen", onclick: async () => (await act("anchor.fix", { target: id, ref: a.ref })) && reload() }),
            ),
          )
      }
      return row
    }),
  )
}

function sourceText(s) {
  const what = SOURCE_LABEL[s.type] || s.type
  return `${what}${s.ref ? ` ${s.ref}` : ""}${s.quote ? `: „${s.quote}“` : ""}${s.scope === "change" ? " (Beleg der Änderung)" : ""} · ${fmtDate(s.at, false)}`
}

/** Text with a margin mark per paragraph: belegt, unbelegt, veraltet. */
export function provenanceTab(data, id, reload) {
  const p = data.provenance
  if (!p) return h("p", { class: "muted", text: "Für diese Art wird keine Herkunft geführt." })
  let onlyMissing = false
  const list = h("div", { class: "prov-list" })
  const draw = () => {
    put(
      list,
      p.paragraphs
        .filter((x) => !onlyMissing || x.status === "unbelegt" || x.status === "veraltet")
        .map((x) =>
          h(
            "div",
            { class: `prov-par prov-${x.status}${x.status === "belegt" && x.sources.every((s) => s.scope === "change") ? " prov-shared" : ""}`, title: x.sources.length ? x.sources.map(sourceText).join("\n") : x.status === "neutral" ? "" : "keine Quelle" },
            h("div", { class: "prov-text", text: x.text }),
            x.status === "neutral"
              ? null
              : h(
                  "div",
                  { class: "prov-src" },
                  x.sources.length ? x.sources.slice(0, 3).map((s) => h("div", { class: "faint", text: sourceText(s) })) : h("span", { class: "faint", text: p.own ? "eigener Text" : "unbelegt" }),
                  x.fromHistory ? h("span", { class: "chip", text: "aus älteren Belegen" }) : null,
                  x.reason ? h("span", { class: "chip warn", text: x.reason }) : null,
                  !app.readOnly ? h("button", { class: "btn sm ghost", type: "button", text: "Quelle angeben …", onclick: () => addSource(id, x, reload) }) : null,
                ),
          ),
        ),
    )
  }
  draw()
  const c = p.counts
  return h(
    "div",
    { class: "stack" },
    h(
      "div",
      { class: "row-flex" },
      h("span", { class: "chip ok", text: `${c.belegt} belegt` }),
      h("span", { class: "chip", text: `${c.unbelegt} unbelegt` }),
      c.veraltet ? h("span", { class: "chip warn", text: `${c.veraltet} Quelle veraltet` }) : null,
      h("span", { class: "grow" }),
      h("label", { class: "check" }, h("input", { type: "checkbox", onchange: (e) => ((onlyMissing = e.target.checked), draw()) }), " nur unbelegte Absätze"),
    ),
    p.own ? h("p", { class: "muted", text: "Eigenes Dokument: Quellen sind freiwillig." }) : null,
    list,
  )
}

async function addSource(id, par, reload) {
  const res = await modal((close) => {
    const type = h("select", { class: "input" }, Object.entries(SOURCE_LABEL).map(([k, v]) => h("option", { value: k, text: v })))
    const ref = h("input", { class: "input wide", placeholder: "Commit, Ticket, URL, kind:name …" })
    const quote = h("textarea", { class: "input", rows: 3, placeholder: "Zitat (optional)" })
    return {
      title: "Quelle für diesen Absatz",
      body: [h("blockquote", { class: "faint", text: par.text.slice(0, 300) }), h("div", { class: "field" }, h("label", { text: "Art" }), type), h("div", { class: "field" }, h("label", { text: "Referenz" }), ref), h("div", { class: "field" }, h("label", { text: "Zitat" }), quote)],
      foot: [h("button", { class: "btn", type: "button", text: "Abbrechen", onclick: () => close(undefined) }), h("button", { class: "btn primary", type: "button", text: "Speichern", onclick: () => close({ type: type.value, ref: ref.value.trim() || undefined, quote: quote.value.trim() || undefined }) })],
    }
  })
  if (!res) return
  const paragraph = par.text.slice(0, 200)
  ;(await act("provenance.set", { target: id, paragraph, ...res })) && reload()
}

export { promptDialog }
