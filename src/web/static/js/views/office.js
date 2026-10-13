// Office documents (PowerPoint, Word): list with upload and "Neu", and the document page with
// the preview/editor (ooxml, in the browser), the AI panel (prompt → draft that changes live,
// step by step; "Übernehmen" = new version, one commit) and the versions of the file.
import { get, officeFile, officeSave, officeUpload } from "../api.js"
import { fmtBytes, fmtDate, fmtRel, h, icon, put, swap, tagChips } from "../dom.js"
import { act, app, confirmDialog, errorText, modal, toast, toastError } from "../ui.js"
import { officeSkillsCard } from "../skill-upload.js"

const ACCEPT = ".pptx,.potx,.docx,.dotx"
const FORMAT = { pptx: "PowerPoint", potx: "PowerPoint-Vorlage", docx: "Word", dotx: "Word-Vorlage" }
const familyOf = (f) => (f === "pptx" || f === "potx" ? "pptx" : "docx")
const pagesLabel = (f, n) => (familyOf(f) === "pptx" ? `${n ?? 0} Folie(n)` : `${n ?? 0} Absätze`)
const QUICK = {
  pptx: ["Erstelle bitte ein Deckblatt", "Füge nach dem Deckblatt eine Agenda-Folie mit den Folientiteln ein", "Schreibe Sprechernotizen für jede Folie", "Fasse die Präsentation auf einer Abschlussfolie zusammen"],
  docx: ["Erstelle bitte ein Deckblatt mit Titel, Untertitel und Datum", "Füge nach dem Deckblatt ein kurzes Inhaltsverzeichnis der Überschriften ein", "Prüfe Rechtschreibung und Grammatik und korrigiere sie", "Schreibe eine Zusammenfassung an den Anfang"],
}

async function uploadFiles(files, ai) {
  let last
  for (const f of files) {
    try {
      const r = await officeUpload(f, { ai: ai || undefined })
      toast(r.message, { variant: "success", title: r.commit ? `Gespeichert · ${r.commit.slice(0, 8)}` : undefined })
      last = r
    } catch (err) {
      toast(`${f.name}: ${errorText(err)}`, { variant: "error" })
    }
  }
  if (files.length === 1 && last?.open) location.hash = last.open
}

async function newDialog(family) {
  const templates = await get("office/templates", { family }).catch(() => [])
  const r = await modal((close) => {
    const title = h("input", { class: "input wide", placeholder: family === "pptx" ? "z. B. Logout-Konzept" : "z. B. Konzept Logout", autofocus: true })
    const tpl = h("select", { class: "input" }, h("option", { value: "", text: templates.length ? "ohne Vorlage" : "keine Vorlagen – .potx/.dotx hochladen" }), templates.map((t) => h("option", { value: t.id, text: `${t.title} (${t.format})` })))
    if (templates.length === 1) tpl.value = templates[0].id
    const prompt = h("textarea", { class: "input", rows: 5, placeholder: family === "pptx" ? "optional: z. B. „Erstelle eine Präsentation mit Deckblatt, Agenda und je einer Folie zu Problem, Lösung, Plan“" : "optional: z. B. „Erstelle ein Konzept mit Deckblatt, Ausgangslage, Lösung und offenen Fragen“" })
    const ai = h("select", { class: "input" }, h("option", { value: "", text: "Standard" }), ["frei", "vorschlag", "lesen", "privat"].map((x) => h("option", { value: x, text: x })))
    const submit = () => {
      if (!title.value.trim()) return title.focus()
      close({ format: family, title: title.value.trim(), template: tpl.value || undefined, prompt: prompt.value.trim() || undefined, ai: ai.value || undefined })
    }
    title.addEventListener("keydown", (e) => e.key === "Enter" && submit())
    return {
      title: family === "pptx" ? "Neue Präsentation" : "Neues Word-Dokument",
      body: [
        h("div", { class: "field" }, h("label", { text: "Titel" }), title),
        h("div", { class: "field" }, h("label", { text: "Vorlage" }), tpl, h("div", { class: "hint", text: family === "pptx" ? "Folienmaster, Layouts und Design der .potx werden übernommen." : "Formatvorlagen der .dotx werden übernommen." })),
        h("div", { class: "field" }, h("label", { text: "Inhalt von der KI erstellen lassen" }), prompt, h("div", { class: "hint", text: "Die KI arbeitet als Entwurf – Sie sehen jeden Schritt in der Vorschau und übernehmen am Ende." })),
        h("div", { class: "field" }, h("label", { text: "KI-Recht" }), ai),
      ],
      foot: [h("button", { class: "btn", type: "button", text: "Abbrechen", onclick: () => close(undefined) }), h("button", { class: "btn primary", type: "button", text: "Anlegen", onclick: submit })],
    }
  })
  if (!r) return
  const out = await act("office.create", r)
  if (out?.open) location.hash = out.open
}

function listPage(ctx) {
  const page = h("div", { class: "page" })
  const listEl = h("div", { class: "stack" })
  const ai = h("select", { class: "input", title: "KI-Recht hochgeladener Dateien" }, h("option", { value: "", text: "KI-Recht: Standard" }), ["frei", "vorschlag", "lesen", "privat"].map((x) => h("option", { value: x, text: `KI-Recht: ${x}` })))
  const input = h("input", { type: "file", multiple: true, accept: ACCEPT, style: { display: "none" }, onchange: () => uploadFiles([...input.files], ai.value).then(load) })
  const drop = h("div", { class: "dropzone", onclick: () => input.click() }, icon("office", 28), h("div", { text: "PowerPoint- oder Word-Dateien hierher ziehen oder klicken" }), h("div", { class: "faint", text: ".pptx, .docx – Vorlagen als .potx, .dotx" }))
  drop.addEventListener("dragover", (e) => (e.preventDefault(), drop.classList.add("over")))
  drop.addEventListener("dragleave", () => drop.classList.remove("over"))
  drop.addEventListener("drop", (e) => {
    e.preventDefault()
    drop.classList.remove("over")
    uploadFiles([...e.dataTransfer.files], ai.value).then(load)
  })
  const row = (d) =>
    h(
      "a",
      { class: "row", href: `#/office/${encodeURIComponent(d.name)}` },
      icon("office", 16),
      h("div", { class: "main" }, h("div", { class: "title", text: d.title }), h("div", { class: "desc", text: [FORMAT[d.format] ?? d.format, d.format === "potx" || d.format === "dotx" ? null : pagesLabel(d.format, d.pages), d.size ? fmtBytes(d.size) : null, d.updatedAt ? fmtRel(d.updatedAt) : null].filter(Boolean).join(" · ") })),
      d.draft ? h("span", { class: `chip ${d.draft === "fehler" ? "danger" : "accent"}`, text: d.draft === "laeuft" ? "KI arbeitet" : "Entwurf" }) : null,
      tagChips(d.tags ?? [], 3),
    )
  const load = async () => {
    const list = await get("office/list")
    if (!ctx.alive()) return
    const groups = [
      ["Präsentationen", list.filter((d) => d.format === "pptx")],
      ["Word-Dokumente", list.filter((d) => d.format === "docx")],
      ["Vorlagen", list.filter((d) => d.format === "potx" || d.format === "dotx")],
    ].filter(([, xs]) => xs.length)
    swap(listEl, groups.length ? groups.map(([label, xs]) => h("div", {}, h("h2", { text: label }), h("div", { class: "list" }, xs.map(row)))) : h("p", { class: "muted", text: "Noch keine Office-Dokumente – hochladen oder neu anlegen." }))
  }
  put(
    page,
    h("h1", { text: "Office-Dokumente" }),
    h("p", { class: "page-sub", text: "PowerPoint und Word in der Wissensbasis: der Text wird durchsuchbar, verknüpfbar und eingebettet, jede Änderung ist eine Version in Git. Bearbeiten Sie selbst oder per Prompt mit der KI." }),
    app.readOnly
      ? null
      : h(
          "div",
          { class: "stack" },
          h("div", { class: "toolbar" }, h("button", { class: "btn primary", type: "button", onclick: () => newDialog("pptx") }, icon("plus", 14), "Neue Präsentation"), h("button", { class: "btn", type: "button", onclick: () => newDialog("docx") }, icon("plus", 14), "Neues Word-Dokument"), h("span", { class: "grow" }), ai),
          drop,
          input,
        ),
    listEl,
    officeSkillsCard(ctx),
  )
  ctx.el.replaceChildren(page)
  ctx.on("office.draft", () => load())
  ctx.on("run.finished", () => load())
  return load()
}

export default async function officeView(ctx) {
  ctx.title("Office")
  const name = ctx.params.name ? decodeURIComponent(ctx.params.name) : ""
  if (!name) return listPage(ctx)
  const id = `office:${name}`
  let doc = await get("office/one", { id })
  if (!ctx.alive()) return
  if (doc.missing) {
    ctx.el.replaceChildren(h("div", { class: "page" }, h("h1", { text: "Nicht gefunden" }), h("p", { text: `Office-Dokument „${name}“ gibt es nicht.` }), h("a", { href: "#/office", text: "Zur Übersicht" })))
    return
  }
  ctx.title(doc.title)
  const family = familyOf(doc.fields.format)
  const isTemplate = doc.fields.format === "potx" || doc.fields.format === "dotx"

  // state
  let show = doc.draft ? "entwurf" : "aktuell" // aktuell | entwurf | <commit>
  let editing = false
  let viewer = null
  let shownRev = -1
  let loadingView = Promise.resolve()

  const stage = h("div", { class: "office-stage" })
  const head = h("div", { class: "office-head" })
  const side = h("div", { class: "office-side stack" })
  const aiCard = h("div", { class: "card" })
  const versionsCard = h("div", { class: "card" })
  side.append(aiCard, versionsCard)
  const grid = h("div", { class: "office-grid" }, stage, side)
  const page = h("div", { class: "page wide office-page" }, head, grid)
  ctx.el.replaceChildren(page)
  ctx.cleanup(() => viewer?.destroy())

  const bytesFor = (what) => (what === "aktuell" ? officeFile(id) : what === "entwurf" ? officeFile(id, { draft: 1 }) : officeFile(id, { commit: what }))

  /** (re)mount the viewer: read-only for previews, editable in edit mode */
  const mount = (what, { editable = false } = {}) => {
    loadingView = loadingView.then(async () => {
      try {
        const bytes = await bytesFor(what)
        if (!ctx.alive()) return
        viewer?.destroy()
        viewer = null
        stage.replaceChildren(h("div", { class: "loading" }, h("span", { class: "spinner" }), "Dokument wird geladen …"))
        const host = h("div", { class: `office-host ${family}` })
        stage.replaceChildren(host)
        const { mountOffice } = await import("../office-viewer.js")
        viewer = await mountOffice(host, { family, bytes, editable, fileName: doc.fields.file, onDirty: () => drawHead() })
        shownRev = what === "entwurf" ? (doc.draft?.rev ?? 0) : -1
      } catch (err) {
        stage.replaceChildren(h("div", { class: "notice error", text: `Vorschau nicht möglich: ${errorText(err)}` }))
      }
    })
    return loadingView
  }

  /** live: load the newest draft bytes into the open viewer (one load at a time, newest wins) */
  let pendingLive = false
  const liveReload = () => {
    if (pendingLive) return
    pendingLive = true
    loadingView = loadingView.then(async () => {
      pendingLive = false
      if (show !== "entwurf" || editing || !viewer || !ctx.alive()) return
      const rev = doc.draft?.rev ?? 0
      if (rev === shownRev) return
      try {
        const bytes = await officeFile(id, { draft: 1 })
        if (!ctx.alive() || !viewer) return
        const before = shownRev
        await viewer.load(bytes)
        shownRev = rev
        if (family === "pptx" && doc.draft?.current?.label?.startsWith("Folie hinzufügen") && before !== rev) viewer.last()
      } catch {
        // the next event tries again
      }
    })
  }

  const download = async () => {
    try {
      const bytes = await bytesFor(show === "entwurf" && doc.draft ? "entwurf" : show === "aktuell" ? "aktuell" : show)
      const a = h("a", { href: URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" })), download: doc.fields.file || `${name}.${doc.fields.format}` })
      document.body.append(a)
      a.click()
      setTimeout(() => (URL.revokeObjectURL(a.href), a.remove()), 1000)
    } catch (err) {
      toastError(err)
    }
  }

  const saveEdit = async () => {
    if (!viewer) return
    if (!viewer.dirty && !(await confirmDialog("Keine Änderungen erkannt – trotzdem als neue Version speichern?", { ok: "Speichern" }))) return
    try {
      const bytes = await viewer.save()
      const r = await officeSave(id, bytes, doc.version)
      toast(r.message, { variant: "success", title: r.commit ? `Gespeichert · ${r.commit.slice(0, 8)}` : undefined })
      editing = false
      await reload()
      show = "aktuell"
      mount("aktuell")
      drawHead()
    } catch (err) {
      if (err?.status === 409) {
        const ok = await confirmDialog("Das Dokument wurde inzwischen geändert (z. B. ein übernommener KI-Entwurf). Trotzdem als neue Version speichern?", { ok: "Trotzdem speichern", danger: true })
        if (ok) {
          const bytes = await viewer.save()
          const r = await officeSave(id, bytes).catch((e) => (toastError(e), null))
          if (r) {
            toast(r.message, { variant: "success" })
            editing = false
            await reload()
            show = "aktuell"
            mount("aktuell")
            drawHead()
          }
        }
        return
      }
      toastError(err)
    }
  }

  const drawHead = () => {
    // the editor needs the width: the side panel is hidden while editing
    grid.classList.toggle("editing", editing)
    const modeBtn = (key, label) => h("button", { type: "button", class: show === key && !editing ? "on" : "", disabled: editing, onclick: () => ((show = key), mount(key), drawHead()) }, label)
    swap(
      head,
      h("a", { class: "btn ghost", href: "#/office", title: "Zur Übersicht" }, icon("back", 14)),
      h("div", { class: "grow" }, h("h1", { class: "office-title", text: doc.title }), h("div", { class: "faint", text: [FORMAT[doc.fields.format], isTemplate ? null : pagesLabel(doc.fields.format, doc.fields.pages), doc.fields.template ? `Vorlage: ${doc.fields.template}` : null, doc.fields.size ? fmtBytes(doc.fields.size) : null, doc.fields.ai ? `KI-Recht: ${doc.fields.ai}` : null].filter(Boolean).join(" · ") })),
      editing
        ? [h("span", { class: "chip warn", text: viewer?.dirty ? "ungespeichert" : "Bearbeiten" }), h("button", { class: "btn", type: "button", text: "Abbrechen", onclick: async () => ((!viewer?.dirty || (await confirmDialog("Änderungen verwerfen?", { ok: "Verwerfen", danger: true }))) ? ((editing = false), mount(show === "entwurf" && doc.draft ? "entwurf" : "aktuell"), drawHead()) : null) }), h("button", { class: "btn primary", type: "button", onclick: saveEdit }, icon("check", 14), "Als neue Version speichern")]
        : [
            doc.draft ? h("div", { class: "seg" }, modeBtn("aktuell", "Aktuell"), modeBtn("entwurf", "KI-Entwurf")) : null,
            /^[0-9a-f]{7,40}$/.test(show) ? h("span", { class: "chip accent", text: `Version ${show.slice(0, 8)}` }) : null,
            app.readOnly || show !== "aktuell" ? null : h("button", { class: "btn primary", type: "button", onclick: () => ((editing = true), mount("aktuell", { editable: true }), drawHead()) }, icon("edit", 14), "Selbst bearbeiten"),
            h("button", { class: "btn", type: "button", onclick: download }, icon("download", 14), "Herunterladen"),
            app.readOnly || isTemplate ? null : h("button", { class: "btn ghost", type: "button", title: "Als .potx/.dotx-Vorlage speichern", onclick: () => act("office.asTemplate", { target: id }, { offerOpen: true }) }, icon("copy", 14), "Als Vorlage"),
            h("a", { class: "btn ghost", href: `#/eintrag/${encodeURIComponent(id)}`, title: "Verknüpfungen, Tags, Verlauf" }, icon("info", 14), "Details"),
          ],
    )
  }

  const drawAi = () => {
    const d = doc.draft
    const blocked = doc.fields.ai === "lesen" || doc.fields.ai === "privat"
    const running = d?.status === "laeuft" || d?.running
    const prompt = h("textarea", { class: "input", rows: 4, placeholder: family === "pptx" ? "z. B. „Erstelle bitte ein Deckblatt“" : "z. B. „Erstelle bitte ein Deckblatt“", disabled: running || blocked || app.readOnly })
    const send = async () => {
      const text = prompt.value.trim()
      if (text.length < 3) return prompt.focus()
      const r = await act("office.edit", { target: id, prompt: text }, { quiet: true })
      if (!r) return
      toast(r.message, { variant: "info" })
      await reload()
      if (show !== "entwurf") {
        show = "entwurf"
        mount("entwurf")
      }
      drawHead()
    }
    prompt.addEventListener("keydown", (e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && send())
    const steps = (d?.steps ?? []).slice().reverse()
    swap(
      aiCard,
      h("div", { class: "card-head" }, h("h3", { class: "grow", text: "Mit der KI bearbeiten" }), d ? h("span", { class: `chip ${d.status === "fehler" ? "danger" : running ? "accent" : "ok"}`, text: running ? "arbeitet" : d.status === "fehler" ? "Fehler" : "Entwurf" }) : null),
      blocked
        ? h("p", { class: "muted", text: `KI-Recht „${doc.fields.ai}“: die KI bearbeitet dieses Dokument nicht.` })
        : !doc.aiEdit
          ? h("p", { class: "muted", text: "KI-Bearbeitung ist ausgeschaltet (office.aiEdit)." })
          : [
              prompt,
              doc.skills?.length
                ? h("div", { class: "faint", title: "Diese Skills werden bei jeder KI-Bearbeitung vollständig geladen (Office-Seite → Skills der Office-Agenten)" }, icon("skill", 12), ` Skills: ${doc.skills.join(", ")}`)
                : h("div", { class: "faint" }, "Keine Skills hinterlegt – ", h("a", { href: "#/office", text: "auf der Office-Seite auswählen" })),
              h("div", { class: "chips-wrap" }, QUICK[family].map((q) => h("button", { class: "chip", type: "button", text: q, disabled: running, onclick: () => ((prompt.value = q), prompt.focus()) }))),
              h("div", { class: "toolbar" }, h("span", { class: "faint grow", text: "Strg/⌘ + Enter" }), h("button", { class: "btn primary", type: "button", disabled: running || app.readOnly, onclick: send }, icon("spark", 14), d ? "Weiter ändern" : "Ausführen")),
            ],
      running && d?.current
        ? h("div", { class: "office-progress" }, h("span", { class: "spinner" }), h("div", { class: "grow" }, h("div", { text: d.current.phase === "plant" ? "Die KI plant die Änderungen …" : `Schritt ${d.current.index}/${d.current.total}: ${d.current.label}` }), d.current.total ? h("progress", { max: d.current.total, value: d.current.index }) : null))
        : null,
      d?.error ? h("div", { class: "notice error", text: d.error }) : null,
      d?.stale ? h("div", { class: "notice warn", text: "Das Dokument wurde seit Beginn des Entwurfs geändert." }) : null,
      steps.length
        ? h(
            "div",
            { class: "office-steps" },
            steps.map((s) =>
              h(
                "div",
                { class: "office-step" },
                h("div", { class: "faint", text: `${fmtRel(s.at)} · „${s.prompt}“` }),
                s.summary ? h("div", { text: s.summary }) : null,
                s.skills?.length ? h("div", { class: "faint", text: `mit Skills: ${s.skills.join(", ")}` }) : null,
                s.done?.length ? h("ul", {}, s.done.map((x) => h("li", { text: x }))) : null,
                s.errors?.length ? h("ul", { class: "danger" }, s.errors.map((x) => h("li", { text: x }))) : null,
              ),
            ),
          )
        : null,
      d && !running && !app.readOnly
        ? h(
            "div",
            { class: "toolbar" },
            h("button", {
              class: "btn",
              type: "button",
              onclick: async () => {
                if (!(await confirmDialog("KI-Entwurf verwerfen?", { ok: "Verwerfen", danger: true }))) return
                if (await act("office.discard", { target: id }, { quiet: true })) {
                  await reload()
                  show = "aktuell"
                  mount("aktuell")
                  drawHead()
                }
              },
            }, "Verwerfen"),
            h("span", { class: "grow" }),
            h("button", {
              class: "btn primary",
              type: "button",
              onclick: async () => {
                const r = await act("office.accept", { target: id })
                if (r) {
                  await reload()
                  show = "aktuell"
                  mount("aktuell")
                  drawHead()
                  drawVersions()
                }
              },
            }, icon("check", 14), "Übernehmen"),
          )
        : null,
    )
  }

  const drawVersions = async () => {
    const list = await get("versions", { id }).catch(() => [])
    if (!ctx.alive()) return
    swap(
      versionsCard,
      h("div", { class: "card-head" }, h("h3", { class: "grow", text: "Versionen" }), h("span", { class: "faint", text: String(list.length) })),
      list.length
        ? h(
            "div",
            { class: "office-versions" },
            list.slice(0, 30).map((v, i) =>
              h(
                "div",
                { class: `version-item ${show === v.hash || (i === 0 && show === "aktuell") ? "on" : ""}` },
                h("div", { class: "v-top" }, h("span", { text: fmtDate(v.date) }), v.markers?.map((m) => h("span", { class: "chip accent", text: m })), h("span", { class: "grow" }), i === 0 ? h("span", { class: "chip ok", text: "aktuell" }) : null),
                h("div", { class: "v-subject ellipsis", text: v.reasons?.[0] || v.subject }),
                h(
                  "div",
                  { class: "toolbar" },
                  h("button", { class: "btn small", type: "button", disabled: editing, onclick: () => ((show = i === 0 ? "aktuell" : v.hash), mount(show), drawHead(), drawVersions()) }, icon("eye", 12), "Ansehen"),
                  i === 0 || app.readOnly
                    ? null
                    : h("button", {
                        class: "btn small",
                        type: "button",
                        onclick: async () => {
                          const r = await act("entry.restoreVersion", { target: id, hash: v.hash }, { label: "Diese Version wiederherstellen" })
                          if (r) {
                            await reload()
                            show = "aktuell"
                            mount("aktuell")
                            drawHead()
                            drawVersions()
                          }
                        },
                      }, icon("undo", 12), "Wiederherstellen"),
                ),
              ),
            ),
          )
        : h("p", { class: "faint", text: "Keine Versionen in Git." }),
      doc.text ? h("details", { class: "office-text" }, h("summary", { text: "Erkannter Text (Suche, Embeddings, Links)" }), h("pre", { class: "pre-wrap", text: doc.text })) : null,
      doc.tags?.length ? h("div", {}, tagChips(doc.tags)) : null,
    )
  }

  const reload = async () => {
    doc = await get("office/one", { id })
    drawAi()
  }

  ctx.on("office.draft", async (data) => {
    if (data?.name !== name) return
    await reload()
    if (!ctx.alive()) return
    if (data.status === "verworfen") return
    if (!editing && show !== "entwurf" && doc.draft) {
      show = "entwurf"
      drawHead()
      mount("entwurf")
      return
    }
    drawHead()
    liveReload()
  })
  ctx.on("run.finished", async () => {
    const before = doc.version
    await reload()
    if (doc.version !== before && !editing && show === "aktuell") mount("aktuell")
    drawHead()
    drawVersions()
  })

  drawHead()
  drawAi()
  drawVersions()
  await mount(show)
}
