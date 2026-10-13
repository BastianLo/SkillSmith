// Skill packages: upload dialog (folder with SKILL.md + references/, .zip/.skill, a SKILL.md),
// the file list of a skill (reference files) and the skill selection of the office agents.
import { ApiError, get, skillUpload } from "./api.js"
import { fmtBytes, h, icon, put, swap } from "./dom.js"
import { mdBlock } from "./parts.js"
import { act, app, confirmDialog, errorText, modal, toast } from "./ui.js"

const SKIP = /(^|\/)(\.|__MACOSX\/|node_modules\/)/

function b64(bytes) {
  let s = ""
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** Folder (webkitdirectory / dropped directory) → JSON body {files: [{path, data}]} */
async function folderBody(files) {
  const out = []
  for (const f of files) {
    const path = f.webkitRelativePath || f.relPath || f.name
    if (SKIP.test(path)) continue
    out.push({ path, data: b64(new Uint8Array(await f.arrayBuffer())) })
  }
  return new Blob([JSON.stringify({ files: out })], { type: "application/octet-stream" })
}

/** Upload with "replace?" confirmation (428 → force). Returns the action result or null. */
async function send(body, name) {
  try {
    return await skillUpload(body, name)
  } catch (err) {
    if (err instanceof ApiError && err.status === 428) {
      if (!(await confirmDialog(err.message, { title: "Skill ersetzen?", ok: "Ersetzen", danger: true }))) return null
      return skillUpload(body, name, { force: 1 })
    }
    throw err
  }
}

/** Entries of a dropped folder (DataTransferItem.webkitGetAsEntry) as File objects with relPath. */
async function droppedFiles(items) {
  const out = []
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const f = await new Promise((res, rej) => entry.file(res, rej))
      f.relPath = prefix + f.name
      out.push(f)
    } else if (entry.isDirectory) {
      const reader = entry.createReader()
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej))
        if (!batch.length) break
        for (const e of batch) await walk(e, `${prefix}${entry.name}/`)
      }
    }
  }
  const entries = [...items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean)
  for (const e of entries) await walk(e, "")
  return { files: out, folder: entries.some((e) => e.isDirectory) }
}

/**
 * Dialog: pick a folder, an archive or a SKILL.md. `replace` = name of the skill that the
 * upload replaces (its page). Resolves with the result (or null when cancelled).
 */
export async function skillUploadDialog({ replace } = {}) {
  const r = await modal((close) => {
    const status = h("div", { class: "hint" })
    const run = async (body, name) => {
      status.textContent = "Lade hoch …"
      try {
        const res = await send(body, name)
        if (!res) return (status.textContent = "")
        if (replace && res.data?.name && res.data.name !== replace) toast(`Hinweis: das Paket heißt „${res.data.name}“, nicht „${replace}“ – es wurde als eigener Skill gespeichert.`, { variant: "warning" })
        toast(res.message, { variant: "success", title: res.commit ? `Gespeichert · ${res.commit.slice(0, 8)}` : undefined })
        for (const w of res.warnings ?? []) toast(w, { variant: "warning" })
        close(res)
      } catch (err) {
        status.textContent = ""
        toast(errorText(err), { variant: "error", title: "Upload abgelehnt" })
      }
    }
    const folder = h("input", { type: "file", webkitdirectory: true, style: { display: "none" } })
    folder.setAttribute("webkitdirectory", "")
    folder.addEventListener("change", async () => {
      const files = [...folder.files]
      if (!files.length) return
      const top = (files[0].webkitRelativePath || "skill").split("/")[0]
      run(await folderBody(files), `${top}.skilldir.json`)
    })
    const single = h("input", { type: "file", accept: ".zip,.skill,.md,.markdown", style: { display: "none" } })
    single.addEventListener("change", () => single.files[0] && run(single.files[0], single.files[0].name))
    const drop = h("div", { class: "dropzone" }, icon("import", 28), h("div", { text: "Skill-Ordner, .zip/.skill oder SKILL.md hierher ziehen" }), h("div", { class: "faint", text: "SKILL.md mit name/description im Frontmatter, dazu z. B. references/styleguide.md" }))
    drop.addEventListener("dragover", (e) => (e.preventDefault(), drop.classList.add("over")))
    drop.addEventListener("dragleave", () => drop.classList.remove("over"))
    drop.addEventListener("drop", async (e) => {
      e.preventDefault()
      drop.classList.remove("over")
      const { files, folder: isFolder } = await droppedFiles(e.dataTransfer.items)
      if (isFolder) {
        const top = (files[0]?.relPath || "skill").split("/")[0]
        return run(await folderBody(files), `${top}.skilldir.json`)
      }
      const f = e.dataTransfer.files[0]
      if (f) run(f, f.name)
    })
    return {
      title: replace ? `Neue Version von „${replace}“` : "Skill hochladen",
      body: [
        h("p", { class: "muted", text: "Ein Skill-Paket besteht aus einer SKILL.md und beliebigen Zusatzdateien (references/*.md, Beispiele, Vorlagen). Alles wird als ein Skill gespeichert – eine Version in Git. Ein bestehender Skill gleichen Namens wird nach Rückfrage ersetzt; Dateien, die im neuen Paket fehlen, werden entfernt." }),
        drop,
        h("div", { class: "toolbar" }, h("button", { class: "btn primary", type: "button", onclick: () => folder.click() }, icon("folder", 14), "Ordner wählen"), h("button", { class: "btn", type: "button", onclick: () => single.click() }, icon("doc", 14), ".zip / .skill / SKILL.md wählen")),
        folder,
        single,
        status,
      ],
      foot: [h("button", { class: "btn", type: "button", text: "Schließen", onclick: () => close(null) })],
    }
  })
  if (r?.open && !replace) location.hash = r.open
  return r
}

/** Card with the files of a skill (reference files); text files open in a dialog. */
export function skillFilesBlock(name) {
  const box = h("div", { class: "card" })
  get("skill/files", { name })
    .then((r) => {
      if (!r.files?.length) return box.remove()
      put(
        box,
        h("h3", { text: `Dateien des Skills (${r.files.length})` }),
        h("p", { class: "faint", text: "Die Agenten lesen sie mit skill_read(name, file); Office-Agenten bekommen sie komplett mitgeliefert." }),
        h(
          "div",
          { class: "list" },
          r.files.map((f) =>
            h("a", { class: "row", href: "#", onclick: (e) => (e.preventDefault(), showFile(name, f.path)) }, icon("doc", 14), h("div", { class: "main" }, h("div", { class: "title mono", text: f.path })), h("span", { class: "faint", text: fmtBytes(f.size) })),
          ),
        ),
      )
    })
    .catch(() => box.remove())
  return box
}

async function showFile(name, path) {
  const r = await get("skill/file", { name, path }).catch((err) => ({ error: errorText(err) }))
  await modal((close) => ({
    title: path,
    body: [r.text !== undefined ? (/\.(md|markdown)$/i.test(path) ? mdBlock(r.text) : h("pre", { class: "code", text: r.text })) : h("p", { class: "muted", text: r.binary ? "Binärdatei – keine Vorschau." : r.error || "Datei nicht gefunden." })],
    foot: [h("button", { class: "btn", type: "button", text: "Schließen", onclick: () => close() })],
    wide: true,
  }))
}

const FAMILY_LABEL = { pptx: "PowerPoint-Agent", docx: "Word-Agent" }

/** Office list page: which skills the PowerPoint and the Word agent load (completely, every edit). */
export function officeSkillsCard(ctx) {
  const box = h("div", { class: "card", style: { marginTop: "24px" } })
  const draw = (r) => {
    const col = (family) => {
      const chosen = new Set(r[family])
      const missing = r[family].filter((n) => !r.skills.some((s) => s.name === n))
      return h(
        "div",
        { class: "stack" },
        h("h4", { text: FAMILY_LABEL[family] }),
        r.skills.length
          ? h(
              "div",
              { class: "stack tight" },
              r.skills.map((s) =>
                h(
                  "label",
                  { class: "check", title: s.description },
                  h("input", {
                    type: "checkbox",
                    checked: chosen.has(s.name),
                    disabled: app.readOnly,
                    onchange: async (e) => {
                      const next = e.target.checked ? [...r[family], s.name] : r[family].filter((n) => n !== s.name)
                      const ok = await act("settings.set", { values: { [`office.skills.${family}`]: next } }, { quiet: true })
                      if (ok) toast(`${FAMILY_LABEL[family]}: ${next.length ? next.join(", ") : "keine Skills"}`, { variant: "success" })
                      reload()
                    },
                  }),
                  h("span", { class: "mono", text: s.name }),
                  s.files ? h("span", { class: "faint", text: ` · ${s.files} Datei(en)` }) : null,
                ),
              ),
            )
          : h("p", { class: "muted", text: "Noch keine Skills – laden Sie einen hoch." }),
        missing.length ? h("p", { class: "hint", text: `Nicht gefunden: ${missing.join(", ")}` }) : null,
      )
    }
    swap(
      box,
      h("div", { class: "card-head" }, h("h3", { class: "grow", text: "Skills der Office-Agenten" }), app.readOnly ? null : h("button", { class: "btn", type: "button", onclick: async () => (await skillUploadDialog()) && reload() }, icon("import", 14), "Skill hochladen")),
      h("p", { class: "faint", text: `Ausgewählte Skills werden bei jeder KI-Bearbeitung vollständig geladen – SKILL.md und alle Text-Referenzdateien (bis ${Math.round(r.maxChars / 1000)}k Zeichen) – und sind für den Agenten verbindlich.` }),
      h("div", { class: "grid two" }, col("pptx"), col("docx")),
    )
  }
  const reload = () =>
    get("office/skills")
      .then((r) => ctx.alive() && draw(r))
      .catch(() => box.remove())
  reload()
  return box
}
