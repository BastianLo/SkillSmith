import { get } from "../api.js"
import { entryHref, fmtNum, h, kindChip, put, swap } from "../dom.js"
import { app } from "../ui.js"

export default async function simulator(ctx) {
  ctx.title("Hinweis-Simulator")
  const cfg = app.info?.config || {}
  const page = h("div", { class: "page" })
  const text = h("textarea", { class: "input", rows: 4, placeholder: "Nachricht eintippen, wie Sie sie an den Agenten schreiben würden – z. B. „Der Kafka-Consumer hängt, wie setze ich die Offsets zurück?“", value: ctx.query.get("text") || "" })
  const slider = (label, value, min, max, step) => {
    const input = h("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(value) })
    const out = h("span", { class: "mono", text: String(value) })
    input.addEventListener("input", () => (out.textContent = input.value))
    return { input, el: h("div", { class: "field" }, h("label", null, `${label} `, out), input) }
  }
  const minScore = slider("Stichwort-Sicherheit (hints.minScore)", cfg.hints?.minScore ?? 0.35, 0, 1, 0.05)
  const minSim = slider("Ähnlichkeit (embedding.hintMinSimilarity)", cfg.embedding?.hintMinSimilarity ?? 0.6, 0, 1, 0.01)
  const max = slider("Höchstens Skills (hints.max)", cfg.hints?.max ?? 2, 1, 6, 1)
  const ownBoost = slider("Vorrang eigener Dokumente (docs.ownBoost)", cfg.docs?.ownBoost ?? 0.05, 0, 0.5, 0.01)
  const result = h("div")
  const run = async () => {
    if (!text.value.trim()) return
    ctx.setQuery({ text: text.value.trim() })
    swap(result, h("div", { class: "loading" }, h("span", { class: "spinner" }), "Berechne …"))
    const r = await get("simulate", { text: text.value.trim(), minScore: minScore.input.value, minSim: minSim.input.value, max: max.input.value, ownBoost: ownBoost.input.value })
    if (!ctx.alive()) return
    swap(
      result,
      h(
        "div",
        { class: "cols" },
        h(
          "div",
          { class: "stack" },
          h("div", { class: "card" }, h("h3", { text: `Hinweis-Block (${r.ms} ms${r.semantic ? ", mit Embeddings" : ", nur Stichworte"})` }), r.block ? h("div", { class: "sim-block", text: r.block }) : h("div", { class: "faint", text: "Kein Hinweis – die Nachricht bekäme keinen Zusatz." })),
          h(
            "div",
            { class: "card" },
            h("h3", { text: `Kandidaten (${r.candidates.length})` }),
            r.candidates.length
              ? h(
                  "div",
                  { class: "table-wrap" },
                  h(
                    "table",
                    { class: "table" },
                    h("thead", null, h("tr", null, ["", "Eintrag", "Stichworte", "Ähnlichkeit", "Relevanz", "Begriffe", "Ergebnis"].map((x) => h("th", { text: x })))),
                    h(
                      "tbody",
                      null,
                      r.candidates.map((c) =>
                        h(
                          "tr",
                          null,
                          h("td", null, kindChip({ id: c.id }, true)),
                          h("td", null, h("a", { href: entryHref(c.id), "data-id": c.id, text: c.title })),
                          h("td", { class: "num", text: fmtNum(c.confidence, 2) }),
                          h("td", { class: "num", text: c.similarity === null ? "–" : fmtNum(c.similarity, 2) }),
                          h("td", { class: "num", text: c.relevance === null ? "–" : fmtNum(c.relevance * 100, 0) }),
                          h("td", { class: "faint", text: (c.matched || []).join(", ") }),
                          h("td", { class: c.shown ? "st-ok" : "faint", text: c.why }),
                        ),
                      ),
                    ),
                  ),
                )
              : h("div", { class: "faint", text: "Keine Kandidaten." }),
          ),
        ),
        h(
          "div",
          { class: "stack" },
          r.glossary.length ? h("div", { class: "card" }, h("h3", { text: "Glossar" }), r.glossary.map((g) => h("div", null, h("a", { href: entryHref(g.id), text: g.title })))) : null,
          r.memories.length ? h("div", { class: "card" }, h("h3", { text: "Erinnerungen" }), r.memories.map((m) => h("div", null, h("a", { href: entryHref(m.id), text: m.title || m.id })))) : null,
          r.sessions.length ? h("div", { class: "card" }, h("h3", { text: "Ähnliche frühere Sessions" }), r.sessions.map((s) => h("div", null, h("a", { href: `#/session/${encodeURIComponent(s.id)}`, text: s.title })))) : null,
          r.seeAlso?.length ? h("div", { class: "card" }, h("h3", { text: "Siehe auch" }), r.seeAlso.map((x) => h("div", { text: typeof x === "string" ? x : x.title || x.id }))) : null,
          h("div", { class: "card info" }, h("h3", { text: "Schwellen übernehmen" }), h("p", { class: "muted", style: { fontSize: "13px" } }, "Werte, die passen, tragen Sie in opencode.json ein:"), h("pre", { class: "mono", style: { whiteSpace: "pre-wrap" }, text: JSON.stringify({ hints: { minScore: Number(minScore.input.value), max: Number(max.input.value) }, embedding: { hintMinSimilarity: Number(minSim.input.value) }, docs: { ownBoost: Number(ownBoost.input.value) } }, null, 2) })),
        ),
      ),
    )
  }
  for (const s of [minScore, minSim, max, ownBoost]) s.input.addEventListener("change", run)
  text.addEventListener("keydown", (e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && run())
  put(
    page,
    h("h1", { text: "Hinweis-Simulator" }),
    h("p", { class: "page-sub", text: "Zeigt genau den Hinweis-Block, den der Agent zu dieser Nachricht bekäme, mit den Werten jedes Kandidaten und warum er (nicht) gezeigt würde. Schwellen lassen sich probeweise verschieben – geändert wird nichts." }),
    h("div", { class: "card" }, text, h("div", { class: "fields", style: { marginTop: "10px" } }, minScore.el, minSim.el, max.el, ownBoost.el), h("div", { class: "toolbar" }, h("button", { class: "btn primary", type: "button", text: "Simulieren (Strg+Enter)", onclick: run }))),
    result,
  )
  ctx.el.replaceChildren(page)
  if (text.value.trim()) run()
}
