// Command palette (Ctrl+K): jump to any view or entry, run any action of the catalog.
import { get } from "./api.js"
import { debounce, entryHref, h, icon, kindChip, swap } from "./dom.js"
import { act, app, modal } from "./ui.js"

const AREA_LABEL = { eintrag: "Eintrag", neu: "Neu", dokument: "Dokument", aufgabe: "Aufgabe", agent: "Agent", projekt: "Projekt", erinnerung: "Erinnerung", verknuepfung: "Verknüpfung", doktor: "Doktor", glossar: "Glossar", freigabe: "Freigabe", system: "System" }

const QUICK = [
  ["Neues Dokument", "doc", () => (location.hash = "#/neu/dokument")],
  ["Neue Aufgabe", "task", () => (location.hash = "#/board?neu=1")],
  ["Neues Projekt", "project", () => (location.hash = "#/projekt-neu")],
  ["Neue Erinnerung", "memory", () => (location.hash = "#/neu/erinnerung")],
  ["Neuer Skill", "skill", () => (location.hash = "#/neu/skill")],
  ["Neuer Fehler", "error", () => (location.hash = "#/neu/fehler")],
  ["Tagesnotiz öffnen", "journal", () => (location.hash = "#/tagesnotiz")],
  ["Schnellnotiz", "note", async () => (await import("./main.js")).quickNote()],
  ["Hell / dunkel umschalten", "moon", async () => {
    const { storeGet, storeSet } = await import("./dom.js")
    const { applyTheme } = await import("./main.js")
    const cur = storeGet("theme", "auto")
    const dark = cur === "dark" || (cur === "auto" && matchMedia("(prefers-color-scheme: dark)").matches)
    storeSet("theme", dark ? "light" : "dark")
    applyTheme(dark ? "light" : "dark")
  }],
]

export function openPalette(nav) {
  modal((close) => {
    const input = h("input", { placeholder: "Ansicht, Eintrag, Aufgabe oder Aktion …", "aria-label": "Befehlspalette", autocomplete: "off", autofocus: true })
    const list = h("div", { class: "items", role: "listbox" })
    let items = []
    let sel = 0
    let entries = []
    const views = nav.flatMap(([group, xs]) => xs.map(([path, label, ic]) => ({ label, group: `Ansicht · ${group}`, icon: ic, run: () => (location.hash = `#/${path}`) })))
    const quick = QUICK.map(([label, ic, run]) => ({ label, group: "Schnell", icon: ic, run }))
    const actions = [...app.catalog.values()].map((a) => ({ label: a.label, group: `Aktion · ${AREA_LABEL[a.area] || a.area}`, icon: "bolt", sub: a.name, run: () => actionForm(a) }))
    const draw = () => {
      const q = input.value.trim().toLowerCase()
      const score = (it) => {
        const t = `${it.label} ${it.sub || ""} ${it.group}`.toLowerCase()
        if (!q) return 1
        if (it.label.toLowerCase().startsWith(q)) return 3
        return q.split(/\s+/).every((w) => t.includes(w)) ? 2 : 0
      }
      const local = [...quick, ...views, ...actions].map((it) => ({ it, s: score(it) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.it)
      items = q ? [...entries, ...local].slice(0, 60) : [...quick, ...views].slice(0, 40)
      sel = Math.min(sel, Math.max(0, items.length - 1))
      swap(
        list,
        items.length
          ? items.map((it, i) =>
              h(
                "div",
                {
                  class: `item${i === sel ? " on" : ""}`,
                  role: "option",
                  onmousemove: () => {
                    if (sel !== i) {
                      sel = i
                      draw()
                    }
                  },
                  onclick: () => {
                    close()
                    it.run()
                  },
                },
                it.node ? kindChip(it.node, false) : icon(it.icon || "doc", 15),
                h("span", { class: "ellipsis", text: it.label }),
                it.sub ? h("span", { class: "faint mono", text: it.sub }) : null,
                h("span", { class: "grp", text: it.group }),
              ),
            )
          : h("div", { class: "faint", style: { padding: "10px" }, text: "Nichts gefunden." }),
      )
      list.querySelector(".on")?.scrollIntoView({ block: "nearest" })
    }
    const searchEntries = debounce(async () => {
      const q = input.value.trim()
      if (q.length < 2) {
        entries = []
        return draw()
      }
      try {
        const hits = await get("search", { q })
        const ql = q.toLowerCase()
        const rank = (n) => (n.title.toLowerCase() === ql ? 0 : n.title.toLowerCase().startsWith(ql) ? 1 : n.title.toLowerCase().includes(ql) ? 2 : 3)
        entries = hits
          .slice(0, 20)
          .map((n, i) => ({ n, i }))
          .sort((a, b) => rank(a.n) - rank(b.n) || a.i - b.i)
          .slice(0, 12)
          .map(({ n }) => ({ label: n.title, group: "Eintrag", node: n, run: () => (location.hash = entryHref(n.id)) }))
        const t = /^t-?(\d+)$/i.exec(q)
        if (t) entries.unshift({ label: `Aufgabe T-${t[1]}`, group: "Aufgabe", icon: "task", run: () => (location.hash = `#/aufgabe/t-${t[1]}`) })
      } catch (_) {
        entries = []
      }
      draw()
    }, 180)
    input.addEventListener("input", () => {
      sel = 0
      draw()
      searchEntries()
    })
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        sel = Math.min(items.length - 1, sel + 1)
        draw()
        e.preventDefault()
      } else if (e.key === "ArrowUp") {
        sel = Math.max(0, sel - 1)
        draw()
        e.preventDefault()
      } else if (e.key === "Enter") {
        const it = items[sel]
        if (it) {
          close()
          it.run()
        }
      }
    })
    draw()
    return { raw: h("div", null, input, list, h("div", { class: "hint" }, h("kbd", { text: "↑↓" }), " wählen · ", h("kbd", { text: "Enter" }), " öffnen · ", h("kbd", { text: "Esc" }), " schließen · Tastenkürzel: g i Eingang, g b Board, g g Graph, n Notiz, / Suche")), class: "palette" }
  })
}

/** Generic form for any action of the catalog (built from its argument schema). */
export async function actionForm(def, preset = {}) {
  const entries = Object.entries(def.args || {})
  if (!entries.length) {
    await act(def.name, {})
    return
  }
  const values = await modal((close) => {
    const controls = {}
    const fields = entries.map(([key, a]) => {
      let c
      if (a.type === "enum") c = h("select", { class: "input" }, a.optional ? h("option", { value: "", text: "–" }) : null, (a.values || []).map((v) => h("option", { value: v, text: v, selected: preset[key] === v })))
      else if (a.type === "boolean") c = h("input", { type: "checkbox", checked: !!preset[key] })
      else if (a.type === "object") c = h("textarea", { class: "input mono", rows: 4, placeholder: "JSON", value: preset[key] ? JSON.stringify(preset[key], null, 2) : "" })
      else if (a.type === "list") c = h("input", { class: "input wide", placeholder: "durch Komma getrennt", value: Array.isArray(preset[key]) ? preset[key].join(", ") : "" })
      else if (a.type === "number") c = h("input", { class: "input", type: "number", value: preset[key] ?? "" })
      else if (key === "body" || key === "text" || key === "question" || key === "comments") c = h("textarea", { class: "input", rows: 5, value: preset[key] ?? "" })
      else c = h("input", { class: "input wide", placeholder: a.type === "id" ? "art:name, z. B. knowledge:auth" : a.type === "hash" ? "Commit-Hash" : "", value: preset[key] ?? "" })
      controls[key] = { c, a }
      return h("div", { class: "field" }, h("label", { text: `${key}${a.optional ? " (optional)" : ""}` }), c)
    })
    const submit = () => {
      const out = {}
      for (const [key, { c, a }] of Object.entries(controls)) {
        if (a.type === "boolean") {
          if (c.checked) out[key] = true
          continue
        }
        const v = c.value.trim()
        if (!v) continue
        if (a.type === "number") out[key] = Number(v)
        else if (a.type === "list") out[key] = v.split(",").map((x) => x.trim()).filter(Boolean)
        else if (a.type === "object") {
          try {
            out[key] = JSON.parse(v)
          } catch (_) {
            c.focus()
            return
          }
        } else out[key] = v
      }
      close(out)
    }
    return { title: def.label, body: [h("p", { class: "faint mono", text: def.name }), fields], foot: [h("button", { class: "btn", type: "button", text: "Abbrechen", onclick: () => close(undefined) }), h("button", { class: "btn primary", type: "button", text: "Ausführen", onclick: submit })] }
  })
  if (!values) return
  const r = await act(def.name, values, { offerOpen: true })
  if (r && r.open) location.hash = r.open
}
