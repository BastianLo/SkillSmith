import { get, post } from "../api.js"
import { AI_ACCESS, editHref, entryHref, fmtDate, graphHref, h, icon, kindOf, nameOf, put, swap } from "../dom.js"
import { auditTab, conflictsBlock, entryHead, evidenceBlock, factsBlock, historyBlock, linksBlock, mdBlock, relationsBlock, relevanceLine, targetPicker, usageTab, versionsTab } from "../parts.js"
import { act, app, confirmDialog, fill, modal, moreButton, previewDialog, promptDialog, tabBar, toast } from "../ui.js"

const STORE = new Set(["skill", "knowledge", "glossary", "error", "script", "memory", "task", "project"])

/** Banner for open AI proposals of an entry (diff, accept, adjust, reject). */
export function proposalsBanner(data, onDone) {
  if (!data.proposals?.length) return null
  return h(
    "div",
    { class: "notice warn" },
    h("strong", { text: `${data.proposals.length} Vorschlag${data.proposals.length > 1 ? "e" : ""} der KI` }),
    data.proposals.map((p) =>
      h(
        "div",
        { class: "row-flex", style: { marginTop: "6px" } },
        h("span", { class: "chip", text: p.smith }),
        h("span", { class: "grow", text: `${p.action}${p.reason ? ` – ${p.reason}` : ""}` }),
        h("span", { class: "faint", text: fmtDate(p.createdAt) }),
        h("button", { class: "btn sm", type: "button", text: "Ansehen", onclick: () => proposalDialog(p, onDone) }),
      ),
    ),
  )
}

export async function proposalDialog(p, onDone) {
  const r = await post("proposal.accept", { id: p.id }, { preview: true }).catch((err) => ({ error: err }))
  if (r.error) return toast(String(r.error.message), { variant: "error" })
  const { renderEntryDiff } = await import("../diff.js")
  const pv = r.preview || {}
  const stale = pv.data?.stale
  const choice = await modal((close) => ({
    title: "Vorschlag der KI",
    wide: true,
    body: [
      h("p", null, h("span", { class: "chip", text: p.smith }), " ", p.reason || ""),
      stale ? h("div", { class: "notice warn", text: "Der Eintrag hat sich seit dem Vorschlag geändert – der Diff zeigt den Vorschlag gegen den aktuellen Stand." }) : null,
      p.args?.evidence ? h("div", { class: "evidence" }, h("div", { text: `Beleg: „${p.args.evidence}“` }), p.sessionID ? h("a", { href: `#/session/${encodeURIComponent(p.sessionID)}`, text: "Session" }) : null) : null,
      pv.diff ? renderEntryDiff(pv.diff) : h("p", { class: "muted", text: "Keine Inhaltsänderung (z. B. Tags oder Verknüpfung)." }),
    ],
    foot: [
      h("button", { class: "btn danger", type: "button", text: "Ablehnen", onclick: () => close("reject") }),
      pv.data?.proposed !== undefined ? h("button", { class: "btn", type: "button", text: "Anpassen …", onclick: () => close("adjust") }) : null,
      h("button", { class: "btn primary", type: "button", text: "Übernehmen", onclick: () => close("accept") }),
    ],
  }))
  if (choice === "accept") (await act("proposal.accept", { id: p.id })) && onDone()
  else if (choice === "reject") {
    const reason = await promptDialog("Vorschlag ablehnen", { label: "Grund (optional – die KI wiederholt den Vorschlag nicht)", required: false, ok: "Ablehnen" })
    if (reason === undefined) return
    ;(await act("proposal.reject", { id: p.id, reason: reason || undefined })) && onDone()
  } else if (choice === "adjust") {
    location.hash = `${editHref(`${p.target}:${p.name}`)}?vorschlag=${encodeURIComponent(p.id)}`
  }
}

function lifecycleItems(data, id, reload) {
  const kind = kindOf(id)
  const tier = data.node.tier
  const items = []
  const run = (action, args, opts) => async () => (await act(action, args, opts)) && reload()
  if (STORE.has(kind)) {
    items.push({ label: data.pinned ? "Lösen" : "Anpinnen", icon: "pin", run: run("entry.pin", { target: id, pinned: !data.pinned }) })
    if (tier === "active") {
      if (["skill", "error", "script"].includes(kind)) items.push({ label: "Ruhend setzen", run: run("entry.dormant", { target: id }) })
      items.push({ label: "Archivieren", icon: "archive", run: run("entry.archive", { target: id }) })
    } else if (tier === "dormant") items.push({ label: "Aktivieren", run: run("entry.activate", { target: id }) }, { label: "Archivieren", icon: "archive", run: run("entry.archive", { target: id }) })
    else items.push({ label: "Wiederherstellen", icon: "undo", run: run("entry.restore", { target: id }) })
    items.push("-")
    items.push({
      label: "Umbenennen …",
      icon: "edit",
      run: async () => {
        const to = await promptDialog("Umbenennen", { label: "Neuer Name (Kleinbuchstaben, Bindestriche)", value: nameOf(id), hint: "Alle Links im Store werden in einem Commit angepasst." })
        if (!to || to === nameOf(id)) return
        const r = await act("entry.rename", { target: id, to }, { label: `${id} umbenennen` })
        if (r?.open) location.hash = r.open
        else if (r) location.hash = entryHref(`${kind}:${to}`)
      },
    })
    if (kind === "knowledge")
      items.push({
        label: "In Ordner verschieben …",
        icon: "folder",
        run: async () => {
          const folder = await promptDialog("Verschieben", { label: "Ordner (leer = Hauptordner)", value: data.folder || "", required: false })
          if (folder === undefined) return
          ;(await act("entry.relocate", { target: id, folder })) && reload()
        },
      })
    if (kind === "knowledge" || kind === "memory")
      items.push({
        label: kind === "knowledge" ? "In Erfahrung umwandeln" : "In Wissen umwandeln",
        run: async () => {
          const r = await act("entry.convert", { target: id, to: kind === "knowledge" ? "memory" : "knowledge" })
          if (r?.open) location.hash = r.open
        },
      })
    if (!["task", "project", "glossary", "script"].includes(kind)) items.push({ label: "Zusammenführen mit …", run: () => mergeDialog(data, id) })
    if (tier === "archive") items.push("-", { label: "Endgültig löschen …", icon: "trash", danger: true, run: async () => (await act("entry.delete", {}, { target: id, confirmName: nameOf(id), confirmText: `„${data.title}“ endgültig löschen? Git behält die Historie.` })) && (location.hash = "#/") })
  }
  return items
}

async function mergeDialog(data, id) {
  const kind = kindOf(id)
  const picked = []
  const res = await modal((close) => {
    const chosen = h("div", { class: "chips" })
    const picker = targetPicker((x) => {
      if (kindOf(x.id) !== kind) return toast("Nur Einträge derselben Art lassen sich zusammenführen.", { variant: "warning" })
      if (x.id === id || picked.some((p) => p.id === x.id)) return
      picked.push(x)
      put(chosen, h("span", { class: "chip accent", text: x.title }))
    })
    return {
      title: "Zusammenführen",
      body: [h("p", { class: "muted", text: `„${data.title}“ bleibt erhalten; die gewählten Einträge werden archiviert und als zusammengeführt markiert.` }), picker.el, chosen],
      foot: [h("button", { class: "btn", type: "button", text: "Abbrechen", onclick: () => close(undefined) }), h("button", { class: "btn primary", type: "button", text: "Weiter", onclick: () => picked.length && close(picked) })],
    }
  })
  if (!res) return
  const others = await Promise.all(res.map((x) => get("entry", { id: x.id })))
  const body = [data.body, ...others.map((o) => `\n\n<!-- aus ${o.node.id} -->\n${o.body}`)].join("")
  const edited = await modal((close) => {
    const ta = h("textarea", { class: "input mono", rows: 18, value: body })
    const desc = h("input", { class: "input wide", value: data.description || "" })
    return { title: "Zusammengeführter Text", wide: true, body: [h("div", { class: "field" }, h("label", { text: "Beschreibung" }), desc), h("div", { class: "field" }, h("label", { text: "Text" }), ta)], foot: [h("button", { class: "btn", type: "button", text: "Abbrechen", onclick: () => close(undefined) }), h("button", { class: "btn primary", type: "button", text: "Vorschau", onclick: () => close({ body: ta.value, description: desc.value }) })] }
  })
  if (!edited) return
  const r = await act("entry.merge", { target: id, sources: [id, ...res.map((x) => x.id)], description: edited.description, body: edited.body }, { label: "Zusammenführen" })
  if (r) location.hash = entryHref(id)
}

function kindActions(data, id, reload) {
  const kind = kindOf(id)
  const out = []
  const btn = (label, action, args, ic) => h("button", { class: "btn", type: "button", onclick: async () => (await act(action, args)) && reload() }, ic ? icon(ic, 14) : null, label)
  if (app.readOnly) return out
  if (kind === "knowledge") out.push(btn("Jetzt prüfen lassen", "doc.check", { target: id }, "refresh"), btn("Geprüft", "doc.verified", { target: id }, "check"))
  if (kind === "memory") {
    if (data.node.status === "vorgeschlagen") out.push(btn("Entscheidung bestätigen", "memory.confirm", { target: id }, "check"))
    if (data.rawFields?.review_after) out.push(btn("Prüfung erledigt", "memory.reviewed", { target: id }, "check"))
    out.push(
      h("button", {
        class: "btn",
        type: "button",
        text: "Ablösen durch …",
        onclick: async () => {
          const pick = await modal((close) => {
            const p = targetPicker((x) => close(x), { placeholder: "neuere Erinnerung suchen …" })
            return { title: "Ablösen durch", body: [p.el], foot: [h("button", { class: "btn", type: "button", text: "Abbrechen", onclick: () => close(undefined) })] }
          })
          if (pick) (await act("memory.supersede", { target: id, by: pick.id })) && reload()
        },
      }),
      h("button", {
        class: "btn",
        type: "button",
        text: data.rawFields?.scope === "global" ? "Nur dieses Projekt" : "Global machen",
        onclick: async () => (await act("memory.scope", { target: id, scope: data.rawFields?.scope === "global" ? "projekt" : "global" })) && reload(),
      }),
    )
  }
  if (kind === "script") out.push(btn("Neu testen", "script.retest", { target: id }, "play"), h("a", { class: "btn", href: `#/werkstatt/${encodeURIComponent(nameOf(id))}` }, icon("workshop", 14), "Werkstatt"))
  if (kind === "glossary") out.push(h("a", { class: "btn", href: `#/glossar?q=${encodeURIComponent(data.rawFields?.term || data.title)}`, text: "In der Glossar-Tabelle" }))
  if (id.startsWith("state:")) {
    out.push(
      h("button", { class: "btn", type: "button", text: "Bearbeiten", onclick: () => stateEditor(id, reload) }),
      btn(data.node.status === "abgelaufen" ? "Wieder öffnen" : "Abschließen", "state.status", { id, status: data.node.status === "abgelaufen" ? "gueltig" : "abgelaufen" }),
    )
  }
  if (id.startsWith("result:")) {
    out.push(
      btn("Behalten", "result.keep", { id }, "pin"),
      h("button", { class: "btn", type: "button", text: "Als Wissen übernehmen", onclick: async () => {
        const r = await act("result.adopt", { id, as: "knowledge" })
        if (r?.open) location.hash = r.open
      } }),
      h("button", { class: "btn", type: "button", text: "Als Erfahrung übernehmen", onclick: async () => {
        const r = await act("result.adopt", { id, as: "erfahrung" })
        if (r?.open) location.hash = r.open
      } }),
      h("button", { class: "btn danger", type: "button", text: "Verwerfen", onclick: async () => (await confirmDialog("Ergebnis löschen?", { danger: true, ok: "Löschen" })) && (await act("result.delete", { id })) && (location.hash = "#/liste/ergebnis") }),
    )
  }
  return out
}

/** Work state editor: tick open items, add, reorder next steps, change the goal (local). */
async function stateEditor(id, reload) {
  const d = await get("entry", { id })
  const sec = (name) => {
    const m = new RegExp(`## ${name}\\n([\\s\\S]*?)(?=\\n## |$)`).exec(d.body)
    return m ? m[1].split("\n").map((l) => l.replace(/^- /, "").replace(/^`|`$/g, "").trim()).filter(Boolean) : []
  }
  const res = await modal((close) => {
    const goal = h("input", { class: "input wide", value: sec("Ziel").join(" ") })
    const area = (name, label) => h("div", { class: "field" }, h("label", { text: label }), h("textarea", { class: "input", rows: 5, "data-k": name, value: sec(label).join("\n") }))
    const done = area("done", "Erledigt")
    const open = area("open", "Offen")
    const next = area("next", "Nächste Schritte")
    const files = area("files", "Dateien")
    const lines = (el) => el.querySelector("textarea").value.split("\n").map((x) => x.trim()).filter(Boolean)
    return {
      title: "Arbeitsstand bearbeiten",
      wide: true,
      body: [h("p", { class: "muted", text: "Eine Zeile je Punkt. Lokal gespeichert (kein Commit), mit Vorher/Nachher im Audit-Log." }), h("div", { class: "field" }, h("label", { text: "Ziel" }), goal), h("div", { class: "grid two" }, open, next, done, files)],
      foot: [h("button", { class: "btn", type: "button", text: "Abbrechen", onclick: () => close(undefined) }), h("button", { class: "btn primary", type: "button", text: "Speichern", onclick: () => close({ goal: goal.value.trim(), done: lines(done), open: lines(open), next: lines(next), files: lines(files) }) })],
    }
  })
  if (res) (await act("state.edit", { id, ...res })) && reload()
}

export default async function entry(ctx) {
  const id = ctx.params.id
  let tab = ctx.query.get("tab") || "inhalt"
  const page = h("div", { class: "page" })
  ctx.el.replaceChildren(page)
  const load = async () => {
    const data = await get("entry", { id })
    if (!ctx.alive()) return
    ctx.title(data.node.title)
    draw(data)
  }
  const draw = (data) => {
    const kind = kindOf(id)
    const isStore = STORE.has(kind)
    const head = h("div", { class: "page-head" }, h("div", { class: "grow" }, entryHead(data), relevanceLine(data.relevance)))
    const actions = h(
      "div",
      { class: "toolbar" },
      isStore && data.owned !== false && !app.readOnly ? h("a", { class: "btn primary", href: editHref(id) }, icon("edit", 14), "Bearbeiten") : null,
      h("a", { class: "btn", href: graphHref(id) }, icon("graph", 14), "Im Graph"),
      isStore && !app.readOnly
        ? h(
            "select",
            {
              class: "input",
              title: "KI-Recht",
              onchange: async (e) => {
                const r = await act("entry.setAi", { target: id, ai: e.target.value })
                if (r) load()
                else e.target.value = data.ai
              },
            },
            Object.entries(AI_ACCESS).map(([k, v]) => h("option", { value: k, text: `KI: ${v.label}`, selected: data.ai === k })),
          )
        : null,
      kindActions(data, id, load),
      isStore && !app.readOnly ? moreButton(() => lifecycleItems(data, id, load)) : null,
    )
    const tabs = tabBar(
      [
        ["inhalt", "Inhalt"],
        ["links", "Verknüpfungen", data.relations.filter((r) => r.type !== "not_related").length + (data.backlinks?.length || 0) || ""],
        isStore ? ["versionen", "Versionen"] : null,
        ["audit", "Audit"],
        isStore ? ["nutzung", "Nutzung"] : null,
      ].filter(Boolean),
      tab,
      (t) => {
        tab = t
        ctx.setQuery({ tab: t === "inhalt" ? "" : t })
        draw(data)
      },
    )
    const body = h("div")
    swap(page, head, actions, proposalsBanner(data, load), conflictsBlock(data), tabs, body)
    if (tab === "inhalt") {
      put(
        body,
        h(
          "div",
          { class: "cols" },
          h("div", { class: "stack" }, h("div", { class: "card" }, mdBlock(data.body, { section: ctx.query.get("abschnitt") || undefined, checkboxes: kind === "knowledge" && !app.readOnly, onToggle: kind === "knowledge" && !app.readOnly ? async (line, done) => (await act("checklist.toggle", { target: id, line, done }, { quiet: true })) && load() : undefined })), evidenceBlock(data), historyBlock(data)),
          h("div", { class: "stack" }, factsBlock(data), data.backlinks?.length ? linksBlock({ ...data, links: [], mentions: [] }) : null),
        ),
      )
    } else if (tab === "links") {
      put(body, h("div", { class: "grid two" }, relationsBlock(data, { onChange: load }), linksBlock(data, { onChange: load })))
    } else if (tab === "versionen") {
      const box = h("div")
      put(body, box)
      fill(box, () => versionsTab(id, { onRestored: load }))
    } else if (tab === "audit") {
      const box = h("div")
      put(body, box)
      fill(box, () => auditTab(id))
    } else if (tab === "nutzung") {
      const box = h("div")
      put(body, box)
      fill(box, () => usageTab(id))
    }
  }
  await load()
  // another run changed this entry → offer reload
  ctx.on("run.finished", (d) => {
    if (!(d.targets || []).includes(id) || d.actor === "web") return
    toast(`Von ${d.smith}${d.actor ? ` (${d.actor})` : ""} geändert.`, { title: "Eintrag geändert", actions: [{ label: "Neu laden", run: load }] })
  })
}

export { previewDialog }
