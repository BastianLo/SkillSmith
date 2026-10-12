import { get } from "../api.js"
import { createEditor } from "../cm.js"
import { AI_ACCESS, MEMORY_TYPES, field, h, icon, put, select } from "../dom.js"
import { act, toast } from "../ui.js"

const SKILL_BODY = "## When to use\n\n\n## Steps\n1. \n\n## Pitfalls\n- \n\n## Verification\n- "
const ERROR_BODY = "## Symptom\n```\n\n```\n\n## Ursache\n\n\n## Lösung\n1. \n\n## Prüfung\n"
const MEMORY_BODY = { entscheidung: "## Entscheidung\n\n\n## Begründung\n\n\n## Alternativen\n- ", vorgabe: "", erfahrung: "" }

const TITLES = { dokument: "Neues Dokument", skill: "Neuer Skill", fehler: "Neuer Fehler", glossar: "Neuer Glossar-Begriff", erinnerung: "Neue Erinnerung" }

async function bodyEditor(doc, opts = {}) {
  const box = h("div", { class: "cm-mini" })
  const ed = await createEditor(box, { doc, noCreate: true, ...opts })
  return { box, ed }
}

export default async function create(ctx) {
  const what = ctx.params.what
  ctx.title(TITLES[what] || "Neu")
  const page = h("div", { class: "page narrow" }, h("h1", { text: TITLES[what] || "Neu" }))
  ctx.el.replaceChildren(page)
  const title = h("input", { class: "input wide", placeholder: "Titel", autofocus: true, value: ctx.query.get("titel") || "" })
  const desc = h("input", { class: "input wide", placeholder: "Eine Zeile mit den Wörtern, mit denen man es später sucht" })
  const tags = h("input", { class: "input wide", placeholder: "Tags, durch Komma" })
  const tagList = () => tags.value.split(/[,\s]+/).map((t) => t.trim().replace(/^#/, "")).filter(Boolean)
  const card = h("div", { class: "card" })
  put(page, card)

  if (what === "dokument") {
    const [folders, templates] = await Promise.all([get("folders"), get("templates")])
    if (!ctx.alive()) return
    const folder = h("input", { class: "input wide", list: "folder-list", placeholder: "Hauptordner", value: ctx.query.get("ordner") || "" })
    const dl = h("datalist", { id: "folder-list" }, folders.folders.map((f) => h("option", { value: f })))
    const tpl = select([["", "ohne Vorlage"], ...templates.map((t) => [t.id, `${t.title}${t.own ? " (eigene)" : ""}`])], ctx.query.get("vorlage") || "", null)
    const accessOf = () => folders.defaults[folder.value] || folders.global
    const ai = select([["", `Standard (${AI_ACCESS[accessOf()]?.label ?? accessOf()})`], ...Object.entries(AI_ACCESS).map(([k, v]) => [k, `${v.label} – ${v.desc}`])], "", null)
    folder.addEventListener("input", () => (ai.options[0].textContent = `Standard (${AI_ACCESS[accessOf()]?.label ?? accessOf()})`))
    const { box, ed } = await bodyEditor("", { placeholder: "Optional: Text. Leer lassen und die Vorlage übernimmt." })
    tpl.addEventListener("change", () => {
      const t = templates.find((x) => x.id === tpl.value)
      if (t && !ed.value.trim()) ed.set(t.body.replace(/\{\{\s*titel\s*\}\}/gi, title.value || "…"))
    })
    // draft from a session or a work state (docsmith writes, you check)
    const sessionSel = h("select", { class: "input" }, h("option", { value: "", text: "– Session wählen –" }))
    get("sessions", { limit: 50 }).then((list) => {
      for (const s of list) sessionSel.append(h("option", { value: s.id, text: `${s.title.slice(0, 80)} · ${new Date(s.at).toLocaleDateString("de-DE")}` }))
      if (ctx.query.get("session")) sessionSel.value = ctx.query.get("session")
    })
    const topic = h("input", { class: "input wide", placeholder: "oder ein Thema, zu dem docsmith aus dem Wissen schreibt" })
    const draftBtn = h("button", {
      class: "btn",
      type: "button",
      onclick: async () => {
        if (!sessionSel.value && !topic.value.trim() && !ctx.query.get("stand")) return toast("Session, Arbeitsstand oder Thema angeben.", { variant: "warning" })
        draftBtn.disabled = true
        draftBtn.textContent = "docsmith schreibt …"
        const r = await act("doc.draft", { session: sessionSel.value || undefined, state: ctx.query.get("stand") || undefined, template: tpl.value || undefined, title: title.value.trim() || undefined, topic: topic.value.trim() || undefined }, { quiet: true })
        draftBtn.disabled = false
        draftBtn.textContent = "Entwurf schreiben lassen"
        if (!r?.data) return
        if (!title.value.trim()) title.value = r.data.title
        ed.set(r.data.body)
        toast("Entwurf eingefügt – prüfen, anpassen, dann anlegen.", { variant: "success" })
      },
    }, icon("bolt", 14), "Entwurf schreiben lassen")
    put(
      card,
      field("Titel", title),
      h("div", { class: "fields" }, field("Ordner", h("div", null, folder, dl)), field("Vorlage", tpl), field("KI-Recht", ai)),
      field("Beschreibung", desc),
      field("Tags", tags),
      field("Text", box, "[[ verlinkt Einträge · Bilder einfügen oder hineinziehen"),
      h("details", { open: !!(ctx.query.get("session") || ctx.query.get("stand")) }, h("summary", { class: "muted", text: "Mit KI ausfüllen (aus einer Session, einem Arbeitsstand oder zu einem Thema)" }), h("div", { class: "stack", style: { marginTop: "8px" } }, ctx.query.get("stand") ? h("div", { class: "chip accent", text: `Arbeitsstand ${ctx.query.get("stand")}` }) : null, sessionSel, topic, h("div", null, draftBtn))),
      h(
        "div",
        { class: "toolbar" },
        h("button", {
          class: "btn primary",
          type: "button",
          onclick: async () => {
            if (!title.value.trim()) return title.focus()
            const r = await act("doc.create", { title: title.value.trim(), folder: folder.value.trim() || undefined, template: tpl.value || undefined, body: ed.value.trim() ? ed.value : undefined, description: desc.value.trim() || undefined, tags: tagList(), ai: ai.value || undefined })
            if (r?.open) location.hash = r.open
          },
        }, icon("check", 14), "Anlegen und bearbeiten"),
        h("a", { class: "btn", href: "#/dokumente", text: "Abbrechen" }),
      ),
    )
    return
  }

  if (what === "skill" || what === "fehler") {
    const kind = what === "skill" ? "skill" : "error"
    const { box, ed } = await bodyEditor(kind === "skill" ? SKILL_BODY : ERROR_BODY)
    const signatures = h("textarea", { class: "input mono", rows: 2, placeholder: "Fehlermeldung(en), eine je Zeile" })
    const status = select([["solved", "gelöst"], ["open", "offen"]], "solved", null)
    put(
      card,
      field("Titel", title),
      field("Beschreibung", desc),
      field("Tags", tags),
      kind === "error" ? h("div", { class: "fields" }, field("Status", status), field("Signaturen", signatures)) : null,
      field("Text", box, kind === "skill" ? "Abschnitte: When to use, Steps, Pitfalls, Verification" : "Abschnitte: Symptom, Ursache, Lösung, Prüfung"),
      h(
        "div",
        { class: "toolbar" },
        h("button", {
          class: "btn primary",
          type: "button",
          onclick: async () => {
            if (!title.value.trim()) return title.focus()
            const fields = kind === "error" ? { status: status.value, signatures: signatures.value.split("\n").map((s) => s.trim()).filter(Boolean) } : undefined
            const r = await act("entry.create", { kind, title: title.value.trim(), description: desc.value.trim() || undefined, body: ed.value, tags: tagList(), fields })
            if (r?.open) location.hash = r.open
          },
        }, icon("check", 14), "Anlegen"),
      ),
    )
    return
  }

  if (what === "glossar") {
    const rows = h("div", { class: "stack" })
    const addRow = () =>
      rows.append(
        h("div", { class: "fields", "data-row": "1" }, h("input", { class: "input", placeholder: "Bedeutung (Ausschreibung)", "data-k": "expansion" }), h("input", { class: "input", placeholder: "Kontext (optional, z. B. Projekt)", "data-k": "context" }), h("input", { class: "input", placeholder: "Erklärung (optional)", "data-k": "description" })),
      )
    addRow()
    const aliases = h("input", { class: "input wide", placeholder: "weitere Schreibweisen, durch Komma" })
    put(
      card,
      field("Begriff / Abkürzung", title),
      field("Bedeutungen", h("div", null, rows, h("button", { class: "btn sm", type: "button", text: "+ Bedeutung", onclick: addRow, style: { marginTop: "6px" } }))),
      field("Auch geschrieben", aliases),
      h(
        "div",
        { class: "toolbar" },
        h("button", {
          class: "btn primary",
          type: "button",
          text: "Speichern",
          onclick: async () => {
            const meanings = [...rows.querySelectorAll("[data-row]")].map((r) => Object.fromEntries([...r.querySelectorAll("input")].map((i) => [i.dataset.k, i.value.trim()]))).filter((m) => m.expansion)
            if (!title.value.trim() || !meanings.length) return toast("Begriff und mindestens eine Bedeutung angeben.", { variant: "warning" })
            const r = await act("entry.create", { kind: "glossary", title: title.value.trim(), fields: { meanings, aliases: aliases.value.split(",").map((a) => a.trim()).filter(Boolean) } })
            if (r?.open) location.hash = r.open
          },
        }),
      ),
    )
    return
  }

  if (what === "erinnerung") {
    const type = select(Object.entries(MEMORY_TYPES), ctx.query.get("typ") || "entscheidung", null)
    const scope = select([["projekt", "dieses Projekt"], ["global", "global (alle Projekte)"]], "projekt", null)
    const topic = h("input", { class: "input wide", placeholder: "Thema (kurz, z. B. token-speicherung) – gleiches Thema aktualisiert die Erinnerung" })
    const { box, ed } = await bodyEditor(MEMORY_BODY[type.value] || "")
    type.addEventListener("change", () => !ed.value.trim() || Object.values(MEMORY_BODY).includes(ed.value) ? ed.set(MEMORY_BODY[type.value] || "") : null)
    put(
      card,
      h("div", { class: "fields" }, field("Typ", type), field("Gültigkeit", scope)),
      field("Titel", title, "Die Entscheidung, Regel oder Erfahrung selbst – eine Zeile"),
      field("Zusammenfassung", desc),
      field("Thema", topic),
      field("Tags", tags),
      field("Text", box),
      h(
        "div",
        { class: "toolbar" },
        h("button", {
          class: "btn primary",
          type: "button",
          text: "Speichern",
          onclick: async () => {
            if (!title.value.trim()) return title.focus()
            const r = await act("memory.create", { type: type.value, title: title.value.trim(), summary: desc.value.trim() || title.value.trim(), body: ed.value || title.value.trim(), tags: tagList(), scope: scope.value, topic: topic.value.trim() || undefined })
            if (r?.open) location.hash = r.open
          },
        }),
      ),
    )
    return
  }
  put(card, h("div", { class: "notice warn", text: `Unbekannte Art: ${what}` }))
}
