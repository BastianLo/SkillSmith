// Gym and cross-check (5d): tasks per entry (A/B runs), rounds with verdicts, proposals from
// sessions, and the cross-check rate per smith and model.
import { get } from "../api.js"
import { entryHref, fmtRel, h, icon, put, swap } from "../dom.js"
import { act, app, card, modal } from "../ui.js"
import { targetPicker } from "../parts.js"

const VERDICT = { hilft: "ok", neutral: "", schadet: "danger", ungenutzt: "warn" }
const CHECKS = { contains: "Antwort enthält", order: "Reihenfolge", executed: "Befehl ausgeführt", exit0: "Befehl mit Exit 0", output_equals: "Ausgabe gleich" }

async function taskDialog(onDone) {
  const res = await modal((close) => {
    let entry = null
    const chosen = h("div", { class: "faint", text: "kein Eintrag gewählt" })
    const picker = targetPicker((x) => ((entry = x.id), (chosen.textContent = `${x.title} (${x.id})`)))
    const prompt = h("textarea", { class: "input", rows: 4, placeholder: "Die Aufgabe, wie ein Nutzer sie stellen würde – ohne die Lösung zu verraten" })
    const mode = h("select", { class: "input" }, ["fragen", "lesen", "arbeiten"].map((m) => h("option", { value: m, text: m })))
    const project = h("input", { class: "input", placeholder: "Projekt (nur arbeiten)" })
    const checks = h("textarea", { class: "input mono", rows: 4, placeholder: "eine Prüfung je Zeile:\ncontains: REVOKED_AT\nexecuted: mvn -U\norder: stop consumer | reset offsets\nexit0: ./gradlew test\noutput_equals: cat VERSION => 1.2.0" })
    return {
      title: "Neue Gym-Aufgabe",
      wide: true,
      body: [h("div", { class: "field" }, h("label", { text: "Eintrag" }), picker.el, chosen), h("div", { class: "field" }, h("label", { text: "Aufgabe" }), prompt), h("div", { class: "grid two" }, h("div", { class: "field" }, h("label", { text: "Modus" }), mode), h("div", { class: "field" }, h("label", { text: "Projekt" }), project)), h("div", { class: "field" }, h("label", { text: "Prüfungen" }), checks)],
      foot: [h("button", { class: "btn", type: "button", text: "Abbrechen", onclick: () => close(undefined) }), h("button", { class: "btn primary", type: "button", text: "Speichern", onclick: () => close({ entry, prompt: prompt.value.trim(), mode: mode.value, project: project.value.trim() || undefined, checks: checks.value }) })],
    }
  })
  if (!res?.entry) return
  const checks = res.checks
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(":")
      const type = l.slice(0, i).trim()
      const rest = l.slice(i + 1).trim()
      if (type === "order") return { type, items: rest.split("|").map((x) => x.trim()).filter(Boolean) }
      if (type === "output_equals") {
        const [cmd, exp] = rest.split("=>")
        return { type, text: (cmd || "").trim(), expected: (exp || "").trim() }
      }
      return { type, text: rest }
    })
  ;(await act("gym.task.save", { entry: res.entry, prompt: res.prompt, mode: res.mode, project: res.project, checks })) && onDone()
}

export default async function gym(ctx) {
  ctx.title("Gym")
  const page = h("div", { class: "page" })
  const body = h("div", { class: "stack" })
  ctx.el.replaceChildren(page)
  const load = async () => {
    const [g, cc] = await Promise.all([get("gym", ctx.query.get("entry") ? { entry: ctx.query.get("entry") } : {}), get("crosscheck")])
    if (!ctx.alive()) return
    const last = (id) => g.rounds.find((r) => r.task === id)
    swap(
      body,
      card(
        "Gym-Aufgaben",
        g.tasks.length
          ? h(
              "div",
              { class: "list" },
              g.tasks.map((t) => {
                const r = last(t.id)
                return h(
                  "div",
                  { class: "row" },
                  icon("gym", 16),
                  h(
                    "div",
                    { class: "main" },
                    h("div", { class: "title", text: t.title }),
                    h("div", { class: "desc" }, h("a", { href: entryHref(t.entry), text: t.entry }), ` · ${t.mode} · ${t.checks.map((c) => CHECKS[c.type] || c.type).join(", ")}${t.sessions.length ? ` · ${t.sessions.length} Session(s), Gewicht ${t.weight}` : ""}`),
                  ),
                  t.status !== "aktiv" ? h("span", { class: "chip", text: t.status }) : null,
                  r ? h("span", { class: `chip ${VERDICT[r.verdict]}`, title: r.details.join("\n"), text: `${r.verdict} · A ${r.a.passed}/${r.a.runs} · B ${r.b.passed}/${r.b.runs}` }) : null,
                  app.readOnly
                    ? null
                    : h(
                        "div",
                        { class: "acts", style: { display: "flex", gap: "6px" } },
                        t.status === "vorgeschlagen" ? h("button", { class: "btn sm primary", type: "button", text: "Bestätigen", onclick: async () => (await act("gym.task.status", { id: t.id, status: "aktiv" })) && load() }) : null,
                        t.status === "aktiv" ? h("button", { class: "btn sm", type: "button", text: "Runde starten", onclick: async () => (await act("gym.run", { id: t.id })) && load() }) : null,
                        t.status !== "verworfen" ? h("button", { class: "btn sm ghost", type: "button", text: "Verwerfen", onclick: async () => (await act("gym.task.status", { id: t.id, status: "verworfen" })) && load() }) : null,
                      ),
                )
              }),
            )
          : h("p", { class: "muted", text: "Noch keine Gym-Aufgaben. Legen Sie eine an oder lassen Sie sich Aufgaben aus früheren Sessions vorschlagen." }),
      ),
      card(
        "Runden",
        g.rounds.length
          ? h("table", { class: "table" }, h("thead", null, h("tr", null, ["Zeit", "Eintrag", "ohne", "mit", "Urteil"].map((x) => h("th", { text: x })))), h("tbody", null, g.rounds.slice(0, 50).map((r) => h("tr", { title: r.details.join("\n") }, h("td", { text: fmtRel(r.at) }), h("td", null, h("a", { href: entryHref(r.entry), text: r.entry })), h("td", { text: `${r.a.passed}/${r.a.runs}` }), h("td", { text: `${r.b.passed}/${r.b.runs}` }), h("td", null, h("span", { class: `chip ${VERDICT[r.verdict]}`, text: r.verdict }))))))
          : h("p", { class: "muted", text: `Noch keine Runden. Folge eines „schadet“: ${g.consequence === "archivieren" ? "archivieren nach 2 Runden an verschiedenen Tagen" : "nur Bericht"}.` }),
      ),
      card(
        "Kreuzprüfung",
        cc.enabled ? h("p", { class: "faint", text: `Prüfmodell ${cc.model}` }) : h("p", { class: "muted", text: "Aus – Prüfmodell unter Einstellungen → Qualität setzen (crosscheck.model)." }),
        cc.stats.length
          ? h("table", { class: "table" }, h("thead", null, h("tr", null, ["Smith", "Schreiber", "gestützt", "nicht gestützt", "widersprochen", "Fehler", "Quote"].map((x) => h("th", { text: x })))), h("tbody", null, cc.stats.map((s) => h("tr", null, h("td", { text: s.smith }), h("td", { class: "mono", text: s.writer }), h("td", { text: s.gestuetzt }), h("td", { text: s.nicht_gestuetzt }), h("td", { text: s.widersprochen }), h("td", { text: s.fehler }), h("td", { text: `${Math.round(s.rate * 100)} %` })))))
          : null,
      ),
    )
  }
  put(
    page,
    h("div", { class: "page-head" }, h("div", { class: "grow" }, h("h1", { text: "Gym und Kreuzprüfung" }), h("p", { class: "page-sub", text: "Hilft ein Eintrag den Agenten wirklich? Dieselbe Aufgabe ohne und mit Eintrag, mehrere Läufe je Arm, nur deterministisch prüfbar." })), app.readOnly ? null : h("div", { class: "toolbar" }, h("button", { class: "btn", type: "button", text: "Aus Sessions vorschlagen", onclick: async () => (await act("gym.propose", {})) && load() }), h("button", { class: "btn primary", type: "button", onclick: () => taskDialog(load) }, icon("plus", 14), "Neue Aufgabe"))),
    body,
  )
  await load()
}
