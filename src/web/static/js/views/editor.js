import { get, post } from "../api.js"
import { createEditor } from "../cm.js"
import { AI_ACCESS, debounce, entryHref, fmtRel, h, icon, kindChip, kindOf, storeGet, storeSet, swap } from "../dom.js"
import { outline } from "../markdown.js"
import { renderMarkdown } from "../parts.js"
import { act, app, conflictDialog, modal, toast } from "../ui.js"
import { proposalsBanner } from "./entry.js"

const splitTags = (s) => s.split(/[,\s]+/).map((t) => t.trim().replace(/^#/, "")).filter(Boolean)

export default async function editor(ctx) {
  const id = ctx.params.id
  const kind = kindOf(id)
  if (kind === "task") {
    location.hash = `#/aufgabe/${encodeURIComponent(id.slice(5))}?bearbeiten=1`
    return
  }
  if (kind === "project") {
    location.hash = `#/projekt/${encodeURIComponent(id.slice(8))}/bearbeiten`
    return
  }
  const proposalId = ctx.query.get("vorschlag")
  const data = await get("entry", { id })
  if (!ctx.alive()) return
  ctx.title(`Bearbeiten: ${data.title}`)
  ctx.layout("full")
  let base = data.version
  let saved = { title: data.title, description: data.description || "", tags: (data.tags || []).join(", "), body: data.body }
  let proposal = null
  if (proposalId) {
    try {
      const p = await post("proposal.accept", { id: proposalId }, { preview: true })
      proposal = { id: proposalId, body: p.preview?.data?.proposed, reason: p.preview?.message }
    } catch (err) {
      toast(`Vorschlag nicht verfügbar: ${err.message}`, { variant: "warning" })
    }
  }
  const draftKey = `draft:${id}`
  const draft = storeGet(draftKey, null)

  // ---- header
  const titleIn = h("input", { class: "title-input", value: data.title, placeholder: "Titel", "aria-label": "Titel" })
  const descIn = h("input", { class: "desc-input", value: data.description || "", placeholder: "Kurzbeschreibung (eine Zeile – die Wörter, mit denen man es später sucht)", "aria-label": "Beschreibung" })
  const tagsIn = h("input", { class: "input sm", style: { width: "240px" }, value: saved.tags, placeholder: "Tags, durch Komma", "aria-label": "Tags" })
  const status = h("span", { class: "grow" })
  const aiSel = h(
    "select",
    { class: "input sm", title: "KI-Recht dieses Eintrags" },
    Object.entries(AI_ACCESS).map(([k, v]) => h("option", { value: k, text: `KI: ${v.label}`, selected: data.ai === k })),
  )
  aiSel.addEventListener("change", async () => {
    const r = await act("entry.setAi", { target: id, ai: aiSel.value })
    if (r?.version) base = r.version
    else if (!r) aiSel.value = data.ai
  })
  let mode = storeGet("editorMode", "split")
  let showOutline = storeGet("editorOutline", true)
  const diffFirst = h("input", { type: "checkbox", checked: storeGet("diffBeforeSave", false) })
  diffFirst.addEventListener("change", () => storeSet("diffBeforeSave", diffFirst.checked))
  const modeSeg = h(
    "div",
    { class: "seg" },
    [
      ["edit", "Editor"],
      ["split", "Geteilt"],
      ["preview", "Vorschau"],
    ].map(([m, l]) => h("button", { type: "button", class: m === mode ? "on" : "", text: l, onclick: (e) => setMode(m, e.currentTarget) })),
  )
  const fileIn = h("input", { type: "file", multiple: true, class: "hidden", accept: "image/*,.pdf,.txt,.md,.csv,.json,.log,.zip" })
  const saveBtn = h("button", { class: "btn primary", type: "button", onclick: () => save() }, icon("check", 14), proposal ? "Fassung übernehmen" : "Speichern")
  const top = h(
    "div",
    { class: "editor-top" },
    proposal ? h("div", { class: "notice warn", style: { marginTop: 0 } }, h("strong", { text: "KI-Vorschlag anpassen. " }), proposal.reason || "", " – Speichern übernimmt Ihre Fassung; der Vorschlag gilt dann als übernommen.") : null,
    !proposal ? proposalsBanner(data, () => ctx.reload()) : null,
    titleIn,
    descIn,
    h(
      "div",
      { class: "editor-meta" },
      kindChip(data.node),
      data.folder ? h("span", { class: "chip outline" }, icon("folder", 11), data.folder) : null,
      tagsIn,
      aiSel,
      modeSeg,
      h("button", { class: `btn sm ${showOutline ? "on" : ""}`, type: "button", text: "Gliederung", onclick: (e) => toggleOutline(e.currentTarget) }),
      h("button", { class: "btn sm", type: "button", title: "Link einfügen (Strg+L)", onclick: () => ed.link() }, icon("link", 13), "Link"),
      h("button", { class: "btn sm", type: "button", title: "Anhang hochladen (oder ins Textfeld ziehen / einfügen)", onclick: () => fileIn.click() }, icon("upload", 13), "Anhang"),
      fileIn,
      h("label", { class: "check", title: "Vor dem Speichern den Diff zeigen" }, diffFirst, "Diff vor dem Speichern"),
      h("span", { class: "grow" }),
      h("a", { class: "btn", href: entryHref(id), text: "Schließen" }),
      saveBtn,
    ),
  )
  const outlineEl = h("nav", { class: "editor-outline", "aria-label": "Gliederung" })
  const cmEl = h("div", { class: "editor-cm" })
  const preview = h("div", { class: "editor-preview" })
  const previewInner = h("div", { class: "md page", style: { maxWidth: "860px" } })
  preview.append(previewInner)
  const body = h("div", { class: "editor-body" }, outlineEl, cmEl, preview)
  const words = h("span")
  const statusBar = h("div", { class: "editor-status" }, status, words, h("span", { class: "mono faint", title: "Version, auf der Sie arbeiten", text: `Version ${String(base || "").slice(0, 8)}` }), h("span", { class: "faint", text: "Strg+S speichern · Strg+L Link · [[ verlinkt · Strg+F suchen" }))
  const wrap = h("div", { class: "editor-wrap" }, top, body, statusBar)
  ctx.el.replaceChildren(wrap)
  const applyLayout = () => {
    body.className = `editor-body mode-${mode}${showOutline ? "" : " no-outline"}`
  }
  const setMode = (m, btn) => {
    mode = m
    storeSet("editorMode", m)
    for (const b of modeSeg.children) b.classList.toggle("on", b === btn)
    applyLayout()
    if (m !== "edit") renderPreview()
  }
  const toggleOutline = (btn) => {
    showOutline = !showOutline
    storeSet("editorOutline", showOutline)
    btn.classList.toggle("on", showOutline)
    applyLayout()
  }
  applyLayout()

  // ---- editor
  const current = () => ({ title: titleIn.value.trim(), description: descIn.value.trim(), tags: tagsIn.value, body: ed.value })
  const dirty = () => {
    const c = current()
    return c.title !== saved.title || c.description !== saved.description || c.tags.trim() !== saved.tags.trim() || c.body !== saved.body
  }
  const updateStatus = () => {
    const d = dirty()
    status.textContent = d ? "● Ungespeicherte Änderungen (Entwurf lokal gesichert)" : "Gespeichert"
    status.style.color = d ? "var(--warn)" : "var(--muted)"
    const text = ed.value
    words.textContent = `${text.trim() ? text.trim().split(/\s+/).length : 0} Wörter`
  }
  const saveDraft = debounce(() => {
    if (!ctx.alive() && !ed) return
    if (dirty()) storeSet(draftKey, { ...current(), base, at: Date.now() })
    else storeSet(draftKey, undefined)
  }, 600)
  const renderPreview = debounce(async () => {
    if (mode === "edit") return
    await renderMarkdown(previewInner, ed.value)
  }, 250)
  const renderOutline = debounce(() => {
    const items = outline(ed.value)
    swap(
      outlineEl,
      h("h3", { style: { marginTop: "4px" }, text: "Gliederung" }),
      items.length
        ? items.map((it) => {
            const a = h("a", { text: it.text, title: it.text, onclick: () => {
              ed.gotoLine(it.line)
              const target = previewInner.querySelector(`#${CSS.escape(it.id)}`)
              if (target) target.scrollIntoView({ block: "start" })
            } })
            a.style.paddingLeft = `${6 + (it.level - 1) * 10}px`
            return a
          })
        : h("div", { class: "faint", text: "Keine Überschriften." }),
    )
  }, 300)
  const ed = await createEditor(cmEl, {
    doc: proposal?.body ?? data.body,
    uploadTarget: kind === "task" ? id : undefined,
    folder: data.folder || undefined,
    placeholder: "Markdown schreiben … [[ verlinkt Einträge, Bilder per Einfügen oder Ziehen",
    onChange: () => {
      updateStatus()
      saveDraft()
      renderPreview()
      renderOutline()
    },
    onSave: () => save(),
    onScroll: () => {
      if (mode !== "split") return
      const r = ed.scrollRatio()
      preview.scrollTop = r * (preview.scrollHeight - preview.clientHeight)
    },
  })
  ctx.cleanup(() => {
    if (dirty()) storeSet(draftKey, { ...current(), base, at: Date.now() })
    ed.destroy()
  })
  fileIn.addEventListener("change", () => {
    ed.upload([...fileIn.files])
    fileIn.value = ""
  })
  for (const el of [titleIn, descIn, tagsIn])
    el.addEventListener("input", () => {
      updateStatus()
      saveDraft()
    })
  const onBeforeUnload = (e) => {
    if (dirty()) {
      e.preventDefault()
      e.returnValue = ""
    }
  }
  window.addEventListener("beforeunload", onBeforeUnload)
  ctx.cleanup(() => window.removeEventListener("beforeunload", onBeforeUnload))
  renderPreview()
  renderOutline()
  updateStatus()

  // ---- local draft
  if (draft && !proposal && (draft.body !== data.body || draft.title !== data.title || (draft.description || "") !== (data.description || ""))) {
    const note = h(
      "div",
      { class: "notice warn" },
      h("strong", { text: "Ungespeicherter Entwurf " }),
      `von ${fmtRel(draft.at)}`,
      draft.base && draft.base !== base ? " – der Eintrag wurde inzwischen geändert; nach dem Wiederherstellen prüft das Speichern die Version." : "",
      h(
        "div",
        { class: "actions" },
        h("button", {
          class: "btn sm primary",
          type: "button",
          text: "Entwurf wiederherstellen",
          onclick: () => {
            titleIn.value = draft.title
            descIn.value = draft.description || ""
            tagsIn.value = draft.tags || ""
            ed.set(draft.body)
            if (draft.base) base = draft.base
            note.remove()
            updateStatus()
          },
        }),
        h("button", {
          class: "btn sm",
          type: "button",
          text: "Verwerfen",
          onclick: () => {
            storeSet(draftKey, undefined)
            note.remove()
          },
        }),
      ),
    )
    top.insertBefore(note, titleIn)
  }

  // ---- save
  async function save() {
    if (app.readOnly) return toast("Schreiben ist gesperrt.", { variant: "warning" })
    const c = current()
    if (!c.title) return titleIn.focus()
    if (!dirty() && !proposal) return toast("Keine Änderungen.")
    if (diffFirst.checked) {
      const { lineDiff, diffBox } = await import("../diff.js")
      const ok = await modal((close) => ({
        title: "Änderungen prüfen",
        wide: true,
        body: [
          c.title !== saved.title ? h("p", null, "Titel: ", h("del", { text: saved.title }), " → ", h("strong", { text: c.title })) : null,
          c.description !== saved.description ? h("p", null, "Beschreibung: ", h("del", { text: saved.description }), " → ", h("strong", { text: c.description })) : null,
          c.tags.trim() !== saved.tags.trim() ? h("p", null, "Tags: ", h("del", { text: saved.tags }), " → ", h("strong", { text: c.tags })) : null,
          diffBox("Inhalt", lineDiff(saved.body, c.body)),
        ],
        foot: [h("button", { class: "btn", type: "button", text: "Weiter bearbeiten", onclick: () => close(false) }), h("button", { class: "btn primary", type: "button", text: "Speichern", onclick: () => close(true) })],
      }))
      if (!ok) return
    }
    saveBtn.disabled = true
    try {
      let r
      if (proposal) r = await act("proposal.accept", { id: proposal.id, body: c.body, title: c.title !== data.title ? c.title : undefined, description: c.description !== (data.description || "") ? c.description : undefined })
      else
        r = await act(
          "entry.save",
          { target: id, title: c.title, description: c.description, tags: splitTags(c.tags), body: c.body },
          {
            base,
            onConflict: async (body) => {
              const choice = await conflictDialog(body, { mine: true })
              if (choice === "overwrite") return act("entry.save", { target: id, title: c.title, description: c.description, tags: splitTags(c.tags), body: c.body }, { base, force: true })
              if (choice === "reload") {
                // keep the user's text, adopt the current version as new base
                base = body.current
                saved = { title: body.entry?.title ?? saved.title, description: body.entry?.description ?? "", tags: (body.entry?.tags || []).join(", "), body: body.entry?.body ?? saved.body }
                toast("Ihre Änderung bleibt im Editor – sie basiert jetzt auf dem aktuellen Stand. Prüfen und erneut speichern.", { variant: "warning", duration: 9000 })
                updateStatus()
              }
              return null
            },
          },
        )
      if (!r) return
      if (r.version) base = r.version
      saved = { ...c, tags: c.tags }
      storeSet(draftKey, undefined)
      updateStatus()
      if (proposal) location.hash = entryHref(id)
    } finally {
      saveBtn.disabled = false
    }
  }

  // ---- another run changed this entry while editing
  ctx.on("run.finished", (d) => {
    if (!(d.targets || []).includes(id) || d.actor === "web") return
    toast(`${d.smith} hat diesen Eintrag geändert. Beim Speichern sehen Sie den Unterschied und entscheiden.`, { title: "Inzwischen geändert", variant: "warning", duration: 12000 })
  })
}
