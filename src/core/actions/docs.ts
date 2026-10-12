/**
 * Knowledge base and productivity actions: documents from templates, folders and their
 * AI access, mentions → links, AI proposals (accept, adjust, reject), "check now",
 * drafts from sessions, daily note, quick note, checklists, tags, glossary table, chat.
 */
import { join } from "node:path"
import type { Run } from "../../types"
import { AI_ACCESS } from "../../types"
import { readJson } from "../../util/fs"
import { nowIso, oneLine, slugify, truncate } from "../../util/text"
import { askAssistant, sessionTranscript } from "../assistant"
import type { Ctx } from "../context"
import { str, strArray } from "../frontmatter"
import { meaningsOf } from "../kinds"
import { linkFor } from "../links"
import { GuardError } from "../ops"
import { journalBody, standupOf } from "../productivity"
import { normalizeFolder } from "../store"
import { checklistOf, toggleChecklist } from "../tasks"
import { fillTemplate, templateById, TEMPLATE_FOLDER } from "../templates"
import { glossaryRows, parseCsv, parseMarkdownTable } from "./csv"
import { contentDiff } from "./entries"
import type { ActionDef } from "./types"
import { defineAction } from "./types"
import { defaultAccess, parseId, requireEntry, uniqueName } from "./util"

const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10)

/** Create a document of the user (author user, AI access from the folder default). */
export async function createDocument(
  ctx: Ctx,
  run: Run,
  a: { title: string; folder?: string; template?: string; body?: string; description?: string; tags?: string[]; ai?: string; name?: string; fields?: Record<string, unknown> },
): Promise<string> {
  const folder = normalizeFolder(a.folder)
  const name = a.name && !ctx.store.fresh("knowledge", a.name) ? a.name : uniqueName(ctx, "knowledge", a.title)
  let body = a.body ?? ""
  if (!body && a.template) {
    const t = templateById(ctx, a.template)
    if (!t) throw new GuardError(`Vorlage „${a.template}“ nicht gefunden`)
    const scope = (() => {
      try {
        return ctx.scope()
      } catch {
        return undefined
      }
    })()
    body = fillTemplate(t.body, { titel: a.title, datum: today(), projekt: scope?.projectName ?? ctx.project, branch: scope?.branch ?? "" })
  }
  const ai = a.ai && (AI_ACCESS as string[]).includes(a.ai) ? a.ai : defaultAccess(ctx, folder)
  await ctx.ops.create(run, "knowledge", {
    name,
    title: oneLine(a.title),
    description: oneLine(a.description ?? ""),
    tags: a.tags,
    fields: { ...(a.fields ?? {}), author: "user", ai, ...(a.template ? { template: a.template } : {}) },
    body,
    reason: a.template ? `neues Dokument aus Vorlage ${a.template}` : "neues Dokument",
    approved: true,
    folder,
  })
  return name
}

export const DOC_ACTIONS: ActionDef[] = [
  defineAction({
    name: "doc.create",
    label: "Dokument anlegen",
    area: "dokument",
    smith: "docsmith",
    args: {
      title: { t: "string", max: 160, min: 1 },
      folder: { t: "string", max: 200, optional: true },
      template: { t: "string", max: 200, optional: true },
      body: { t: "string", multiline: true, max: 2_000_000, optional: true },
      description: { t: "string", max: 300, optional: true },
      tags: { t: "list", max: 12, item: 60, optional: true },
      ai: { t: "enum", values: AI_ACCESS, optional: true },
    },
    async run({ ctx }, run, a) {
      const name = await createDocument(ctx, run, a)
      return { message: `Dokument „${a.title}“ angelegt`, target: `knowledge:${name}`, open: `#/editor/knowledge:${name}` }
    },
  }),
  defineAction({
    name: "folder.create",
    label: "Ordner anlegen",
    area: "dokument",
    smith: "docsmith",
    args: { path: { t: "string", max: 200, min: 1 } },
    async run({ ctx }, run, a) {
      const folder = normalizeFolder(a.path)
      if (!folder) throw new GuardError("Ordnername fehlt")
      await ctx.store.writeTracked(run, `knowledge/active/${folder}/.gitkeep.json`, {})
      run.actions.push({ kind: "create", target: "knowledge", name: folder, detail: "folder", applied: true })
      return { message: `Ordner ${folder} angelegt` }
    },
  }),
  defineAction({
    name: "folder.rename",
    label: "Ordner umbenennen",
    area: "dokument",
    smith: "docsmith",
    confirm: "rename",
    args: { from: { t: "string", max: 200, min: 1 }, to: { t: "string", max: 200, min: 1 } },
    async preview({ ctx }, a) {
      const from = normalizeFolder(a.from)
      const docs = ctx.store.list("knowledge").filter((e) => e.folder === from || e.folder?.startsWith(`${from}/`))
      return { message: `${docs.length} Dokument(e) werden verschoben (Links bleiben gültig)`, affected: docs.map((e) => ({ id: `knowledge:${e.name}`, title: e.title, detail: e.folder })) }
    },
    async run({ ctx }, run, a) {
      const from = normalizeFolder(a.from)
      const to = normalizeFolder(a.to)
      if (!from || !to) throw new GuardError("Ordnernamen fehlen")
      const docs = ctx.store.list("knowledge").filter((e) => e.folder === from || e.folder?.startsWith(`${from}/`))
      for (const e of docs) {
        const target = to + (e.folder ?? "").slice(from.length)
        await ctx.store.relocate(run, "knowledge", e.name, target, `Ordner ${from} → ${to}`)
        run.actions.push({ kind: "update", target: "knowledge", name: e.name, reason: `Ordner ${from} → ${to}`, detail: "move-folder", applied: true })
      }
      // folder defaults move along
      const conf = readJson<Record<string, string>>(join(ctx.store.root, "knowledge", ".ordner.json"), {})
      const moved = Object.fromEntries(Object.entries(conf).map(([k, v]) => [k === from || k.startsWith(`${from}/`) ? to + k.slice(from.length) : k, v]))
      if (JSON.stringify(moved) !== JSON.stringify(conf)) await ctx.store.writeTracked(run, "knowledge/.ordner.json", moved)
      return { message: `Ordner ${from} → ${to}: ${docs.length} Dokument(e) verschoben` }
    },
  }),
  defineAction({
    name: "folder.setAi",
    label: "KI-Recht des Ordners",
    area: "dokument",
    smith: "docsmith",
    args: { folder: { t: "string", max: 200 }, ai: { t: "enum", values: [...AI_ACCESS, "standard"] } },
    async run({ ctx }, run, a) {
      const folder = normalizeFolder(a.folder)
      const conf = await ctx.store.updateTracked<Record<string, string>>(run, "knowledge/.ordner.json", {}, (cur) => {
        const next = { ...cur }
        if (a.ai === "standard") delete next[folder]
        else next[folder] = a.ai
        return next
      })
      run.actions.push({ kind: "update", target: "knowledge", name: folder || "(Hauptordner)", reason: `KI-Recht für neue Dokumente: ${a.ai}`, detail: "folder-ai", applied: true })
      return { message: `Neue Dokumente in ${folder || "Hauptordner"}: KI-Recht ${conf[folder] ?? `Standard (${ctx.options.docs.defaultAiAccess})`}` }
    },
  }),
  defineAction({
    name: "mention.link",
    label: "Erwähnung verlinken",
    area: "dokument",
    smith: "docsmith",
    args: { target: { t: "id" }, to: { t: "id" }, phrase: { t: "string", max: 200, min: 2 } },
    async run({ ctx }, run, a) {
      const e = requireEntry(ctx, a.target)
      const re = new RegExp(`(?<![\\p{L}\\p{N}\\[])${a.phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}\\]])`, "iu")
      const m = re.exec(e.body)
      if (!m) throw new GuardError("Die Erwähnung steht nicht (mehr) im Text")
      const body = e.body.slice(0, m.index) + linkFor(a.to, m[0]) + e.body.slice(m.index + m[0].length)
      await ctx.ops.update(run, e.kind, { name: e.name, body, reason: `Erwähnung von ${a.to} verlinkt`, approved: true })
      return { message: `„${m[0]}“ ist jetzt ein Link auf ${a.to}`, target: a.target }
    },
  }),
  defineAction({
    name: "proposal.accept",
    label: "Vorschlag übernehmen",
    area: "freigabe",
    smith: ({ id }, env) => (env.ctx.ops.staged().find((s) => s.id === id)?.smith as any) ?? "docsmith",
    args: { id: { t: "string", max: 80 }, body: { t: "string", multiline: true, max: 2_000_000, optional: true }, title: { t: "string", max: 200, optional: true }, description: { t: "string", max: 1000, optional: true } },
    async preview({ ctx }, a) {
      const s = ctx.ops.staged().find((x) => x.id === a.id)
      if (!s) throw new GuardError("Vorschlag nicht (mehr) vorhanden")
      const e = ctx.store.getOwned(s.target, s.name)
      const args = s.args as Record<string, any>
      if (s.action === "patch" && e) {
        const body = e.body.includes(args.oldText) ? e.body.replace(args.oldText, () => args.newText) : e.body
        return { message: s.reason ?? "", diff: contentDiff(e, { title: e.title, description: e.description, tags: e.tags, body }), data: { change: s, stale: !!s.baseVersion && s.baseVersion !== e.version, proposed: body } }
      }
      if (typeof args.body === "string" || args.title || args.description) {
        const after = { title: args.title ?? e?.title ?? "", description: args.description ?? e?.description ?? "", tags: args.tags ?? e?.tags ?? [], body: args.body ?? e?.body ?? "" }
        return { message: s.reason ?? "", diff: contentDiff(e, after), data: { change: s, stale: !!e && !!s.baseVersion && s.baseVersion !== e.version, proposed: after.body } }
      }
      return { message: s.reason ?? "", data: { change: s } }
    },
    async run({ ctx }, run, a) {
      const s = ctx.ops.staged().find((x) => x.id === a.id)
      if (!s) throw new GuardError("Vorschlag nicht (mehr) vorhanden")
      if (a.body !== undefined || a.title !== undefined || a.description !== undefined) {
        // adjusted by the user: the user's version is saved, the proposal counts as accepted
        const e = ctx.store.getOwned(s.target, s.name)
        if (!e) throw new GuardError("Eintrag nicht gefunden")
        await ctx.ops.update(run, s.target, { name: s.name, title: a.title, description: a.description, body: a.body, reason: `Vorschlag ${s.id} angepasst übernommen${s.reason ? ` – ${truncate(s.reason, 160)}` : ""}`, approved: true })
        ctx.ops.rejectStaged(s.id)
        return { message: "angepasster Vorschlag gespeichert", target: `${s.target}:${s.name}` }
      }
      const msg = await ctx.ops.applyStaged(run, s)
      return { message: msg, target: `${s.target}:${s.name}` }
    },
  }),
  defineAction({
    name: "proposal.reject",
    label: "Vorschlag ablehnen",
    area: "freigabe",
    smith: "docsmith",
    local: true,
    args: { id: { t: "string", max: 80 }, reason: { t: "string", max: 500, optional: true } },
    async run({ ctx }, run, a) {
      const s = ctx.ops.staged().find((x) => x.id === a.id)
      if (!s) throw new GuardError("Vorschlag nicht (mehr) vorhanden")
      ctx.ops.rejectStaged(a.id, a.reason)
      run.actions.push({ kind: "note", target: s.target, name: s.name, reason: `Vorschlag ${a.id} abgelehnt${a.reason ? `: ${a.reason}` : ""}`, applied: true, local: true })
      ctx.audit?.append({ actor: "user-web", smith: s.smith, category: "proposed", action: "reject", targets: [`${s.target}:${s.name}`], result: "rejected", reason: a.reason, message: `Vorschlag ${a.id} (${s.action})`, run: run.id })
      return { message: "Vorschlag abgelehnt – die KI wiederholt ihn nicht, solange sich das Dokument nicht ändert" }
    },
  }),
  defineAction({
    name: "doc.check",
    label: "Jetzt prüfen lassen",
    area: "dokument",
    smith: "docsmith",
    args: { target: { t: "id" } },
    async run({ ctx }, run, a) {
      const e = requireEntry(ctx, a.target)
      if (str(e.fields.ai) === "privat") throw new GuardError("Private Dokumente sieht die KI nicht")
      const related = await ctx.retriever.search(`${e.title} ${e.description}`, { kinds: ["knowledge", "memory", "error"], tiers: ["active"], limit: 6, exclude: new Set([a.target]) }).catch(() => [])
      const sessions = (await ctx.history?.search(`${e.title} ${e.description}`, { limit: 3 }).catch(() => [])) ?? []
      const prompt = [
        `Prüfe das folgende Dokument des Nutzers gegen neueres Wissen (verwandte Einträge, Erinnerungen, frühere Sessions, die Doku des Projekts über docs_search).`,
        `Wenn etwas veraltet, falsch oder lückenhaft ist: gib den vollständigen überarbeiteten Text des Dokuments zwischen <dokument> und </dokument> aus und danach unter "Begründung:" die Belege mit [[Links]].`,
        `Wenn alles aktuell ist, antworte nur mit: UNVERÄNDERT – und einer kurzen Begründung.`,
        "",
        `# ${e.title}`,
        e.description,
        "",
        e.body,
        "",
        related.length ? `Verwandte Einträge: ${related.map((h) => `[[${h.kind}:${h.name}]] ${h.title}`).join("; ")}` : "",
        sessions.length ? `Frühere Sessions: ${sessions.map((s) => `${s.record.title ?? s.record.requests[0]} (${s.record.at.slice(0, 10)})`).join("; ")}` : "",
      ]
        .filter((l) => l !== undefined)
        .join("\n")
      const answer = await askAssistant(ctx, prompt, `Prüfung ${e.title}`)
      const doc = /<dokument>\s*([\s\S]*?)\s*<\/dokument>/.exec(answer)?.[1]
      const why = truncate((/Begründung:\s*([\s\S]*)$/.exec(answer)?.[1] ?? answer.replace(/<dokument>[\s\S]*<\/dokument>/, "")).trim(), 1500)
      if (!doc || /^UNVERÄNDERT/i.test(answer.trim()) || doc.trim() === e.body.trim()) {
        return { message: `Keine Änderung nötig: ${truncate(why || answer, 300)}` }
      }
      // always a proposal (the user decides), never a direct change
      run.writeMode = "stage"
      run.actor = "reviewer"
      const msg = await ctx.ops.update(run, e.kind, { name: e.name, body: doc, reason: `Prüfung auf Knopfdruck: ${truncate(why, 280)}`, approved: true })
      run.actor = "web"
      return { message: `Vorschlag erstellt (${truncate(msg, 120)}) – im Eingang bzw. im Editor als Diff`, target: a.target, data: { why } }
    },
  }),
  defineAction({
    name: "doc.verified",
    label: "Ist aktuell",
    area: "dokument",
    smith: "docsmith",
    args: { target: { t: "id" } },
    async run({ ctx }, run, a) {
      const e = requireEntry(ctx, a.target)
      await ctx.store.editMeta(run, e.kind, e.name, (m) => {
        m.verifiedAt = nowIso()
        delete m.doubts
      }, "verified", "vom Nutzer als aktuell bestätigt")
      if (str(e.fields.review_after)) await ctx.ops.update(run, e.kind, { name: e.name, fields: { ...e.fields, review_after: new Date(Date.now() + ctx.options.docsmith.reviewAfterDays * 86_400_000).toISOString().slice(0, 10) }, reason: "geprüft", approved: true })
      run.actions.push({ kind: "update", target: e.kind, name: e.name, reason: "als aktuell bestätigt", applied: true })
      return { message: "als aktuell bestätigt", target: a.target }
    },
  }),
  defineAction({
    name: "doc.draft",
    label: "Entwurf schreiben lassen",
    area: "dokument",
    smith: "docsmith",
    local: true,
    args: {
      session: { t: "string", max: 120, optional: true },
      state: { t: "string", max: 200, optional: true },
      template: { t: "string", max: 200, optional: true },
      title: { t: "string", max: 160, optional: true },
      topic: { t: "string", max: 300, optional: true },
    },
    async run({ ctx }, _run, a) {
      const tpl = a.template ? templateById(ctx, a.template) : undefined
      const parts: string[] = []
      if (a.session) {
        const t = await sessionTranscript(ctx, a.session)
        parts.push(`## Session${t.title ? ` „${t.title}“` : ""}\n${t.text}`)
      }
      if (a.state) {
        const st = ctx.mem?.getState(a.state)
        if (st) parts.push(`## Arbeitsstand ${st.ticket || st.branch}\nZiel: ${st.goal}\nErledigt: ${st.done.join("; ")}\nOffen: ${st.open.join("; ")}\nNächste Schritte: ${st.next.join("; ")}\nDateien: ${st.files.join(", ")}`)
      }
      if (!parts.length && !a.topic) throw new GuardError("Session, Arbeitsstand oder Thema angeben")
      const prompt = [
        `Schreibe einen Entwurf für ein Dokument des Nutzers${a.title ? ` mit dem Titel „${a.title}“` : ""}${a.topic ? ` zum Thema: ${a.topic}` : ""}.`,
        tpl ? `Folge dieser Vorlage (${tpl.title}):\n${tpl.body}` : "Wähle die passende Form: How-to, Runbook oder Troubleshooting.",
        "Nur Fakten aus dem Material unten oder aus den Lesewerkzeugen; verlinke verwendete Einträge mit [[Links]]. Antworte mit dem Markdown-Text des Dokuments (ohne Frontmatter), die erste Zeile ist die Überschrift „# Titel“.",
        "",
        ...parts,
      ].join("\n")
      const text = await askAssistant(ctx, prompt, `Entwurf ${a.title ?? a.topic ?? ""}`)
      const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? a.title ?? "Entwurf"
      const body = text.replace(/^#\s+.+\n+/, "").trim()
      return { message: "Entwurf fertig – im Editor prüfen und speichern", data: { title, body, template: tpl?.id } }
    },
  }),
  defineAction({
    name: "journal.open",
    label: "Tagesnotiz öffnen",
    area: "dokument",
    smith: "docsmith",
    args: { date: { t: "string", pattern: /^\d{4}-\d{2}-\d{2}$/, optional: true } },
    async run({ ctx }, run, a) {
      const date = a.date ?? today()
      const name = `journal-${date}`
      const existing = ctx.store.fresh("knowledge", name)
      if (existing) return { message: "Tagesnotiz geöffnet", target: `knowledge:${name}`, open: `#/editor/knowledge:${name}`, data: { standup: standupOf(existing.body) } }
      const body = await journalBody(ctx, date)
      await createDocument(ctx, run, { name, title: `Tagesnotiz ${date}`, folder: ctx.options.docs.journalFolder, body, description: "", ai: "vorschlag", tags: ["tagesnotiz"] })
      return { message: "Tagesnotiz angelegt und vorbefüllt", target: `knowledge:${name}`, open: `#/editor/knowledge:${name}`, data: { standup: standupOf(body) } }
    },
  }),
  defineAction({
    name: "note.quick",
    label: "Schnellnotiz",
    area: "dokument",
    smith: "docsmith",
    args: { text: { t: "string", multiline: true, max: 5000, min: 1 }, session: { t: "string", max: 120, optional: true } },
    async run({ ctx, session }, run, a) {
      return { message: await quickNote(ctx, run, a.text, a.session ?? session), target: `knowledge:${slugify(ctx.options.docs.inboxDoc, 60) || "eingang"}` }
    },
  }),
  defineAction({
    name: "checklist.toggle",
    label: "Punkt abhaken",
    area: "aufgabe",
    smith: (a) => (String(a.target).startsWith("task:") ? "memorysmith" : "docsmith"),
    args: { target: { t: "string", max: 200 }, line: { t: "number", int: true, min: 0 }, done: { t: "boolean" } },
    async run({ ctx }, run, a) {
      if (a.target.startsWith("task:")) {
        const e = requireEntry(ctx, a.target)
        await ctx.tasks.update(run, e.name, { body: toggleChecklist(e.body, a.line, a.done) })
        const cl = checklistOf(ctx.store.fresh("task", e.name)?.body ?? "")
        return { message: `${cl.filter((c) => c.done).length}/${cl.length} erledigt`, target: a.target }
      }
      return { message: await ctx.tasks.tickLoose(run, a.target, a.line, a.done), target: a.target.startsWith("knowledge:") ? a.target : undefined }
    },
  }),
  defineAction({
    name: "tags.rename",
    label: "Tag umbenennen oder zusammenführen",
    area: "eintrag",
    smith: "docsmith",
    confirm: "rename",
    args: { from: { t: "string", max: 60, min: 1 }, to: { t: "string", max: 60, min: 1 } },
    async preview({ ctx }, a) {
      const affected = ["skill", "knowledge", "glossary", "error", "script", "memory", "task", "project"].flatMap((k) =>
        ctx.store
          .list(k as any)
          .filter((e) => e.tags.includes(a.from))
          .map((e) => ({ id: `${k}:${e.name}`, title: e.title })),
      )
      return { message: `#${a.from} → #${a.to}: ${affected.length} Eintrag/Einträge`, affected }
    },
    async run({ ctx }, run, a) {
      const to = slugify(a.to.replace(/^#/, ""), 40)
      if (!to) throw new GuardError("ungültiger Tag")
      let n = 0
      for (const k of ["skill", "knowledge", "glossary", "error", "script", "memory", "task", "project"] as const) {
        for (const e of ctx.store.list(k)) {
          if (!e.tags.includes(a.from)) continue
          const tags = [...new Set(e.tags.map((t) => (t === a.from ? to : t)))]
          if (k === "task") await ctx.tasks.update(run, e.name, { labels: tags })
          else await ctx.ops.update(run, k, { name: e.name, tags, reason: `Tag ${a.from} → ${to}`, approved: true })
          n++
        }
      }
      return { message: `#${a.from} → #${to} in ${n} Eintrag/Einträgen` }
    },
  }),
  defineAction({
    name: "glossary.row",
    label: "Glossar-Zeile speichern",
    area: "glossar",
    smith: "docsmith",
    args: { target: { t: "id", optional: true }, term: { t: "string", max: 60, min: 1 }, meanings: { t: "object" }, aliases: { t: "list", max: 20, item: 60, optional: true } },
    async run({ ctx }, run, a) {
      const meanings = meaningsOf((a.meanings as any).list ?? a.meanings)
      if (!meanings.length) throw new GuardError("mindestens eine Bedeutung")
      if (a.target) {
        const e = requireEntry(ctx, a.target)
        await ctx.ops.update(run, "glossary", { name: e.name, title: a.term, description: meanings.map((m) => m.expansion).join(" / "), fields: { ...e.fields, term: a.term, meanings, aliases: a.aliases ?? strArray(e.fields.aliases) }, reason: "Glossar-Tabelle", approved: true })
        return { message: `${a.term} gespeichert`, target: a.target }
      }
      const msg = await ctx.ops.glossaryUpsert(run, { term: a.term, meanings, aliases: a.aliases, reason: "Glossar-Tabelle" })
      return { message: msg }
    },
  }),
  defineAction({
    name: "glossary.import",
    label: "Glossar importieren",
    area: "glossar",
    smith: "docsmith",
    args: { text: { t: "string", multiline: true, max: 2_000_000, min: 1 }, format: { t: "enum", values: ["csv", "md"] } },
    async preview(_env, a) {
      const rows = glossaryRows(a.format === "md" ? parseMarkdownTable(a.text) : parseCsv(a.text))
      return { message: `${rows.length} Bedeutung(en) erkannt`, data: rows.slice(0, 50) }
    },
    async run({ ctx }, run, a) {
      const rows = glossaryRows(a.format === "md" ? parseMarkdownTable(a.text) : parseCsv(a.text)).slice(0, 2000)
      if (!rows.length) throw new GuardError("Keine Einträge erkannt (Spalten: Abkürzung, Bedeutung, Beschreibung[, Kontext])")
      let ok = 0
      const failed: string[] = []
      for (const r of rows) {
        try {
          await ctx.ops.glossaryUpsert(run, { term: r.term, meanings: [r.meaning], reason: "Import in der Weboberfläche" })
          ok++
        } catch (err) {
          failed.push(`${r.term}: ${(err as Error).message}`)
        }
      }
      return { message: `${ok} Bedeutung(en) importiert${failed.length ? `, ${failed.length} abgelehnt` : ""}`, warnings: failed.slice(0, 20) }
    },
  }),
  defineAction({
    name: "attachment.add",
    label: "Anhang hochladen",
    area: "dokument",
    smith: (a) => (String(a.target ?? "").startsWith("task:") ? "memorysmith" : "docsmith"),
    args: { path: { t: "string", max: 300, pattern: /^knowledge\/_anhaenge\/\d{4}-\d{2}\/[a-z0-9-]+\.[a-z0-9]+$/ }, target: { t: "id", optional: true }, name: { t: "string", max: 200, optional: true } },
    async run({ ctx, payload }, run, a) {
      if (!payload?.length) throw new GuardError("Datei fehlt")
      const rel = await ctx.store.writeAttachment(run, a.path, payload)
      const short = rel.replace(/^knowledge\/_anhaenge\//, "")
      run.actions.push({ kind: "create", target: "knowledge", name: short, detail: "attachment", reason: a.name, applied: true })
      const label = (a.name ?? short).replace(/[[\]()]/g, "")
      const markdown = /\.(png|jpe?g|gif|webp|svg)$/i.test(short) ? `![${label}](anhang:${short})` : `[${label}](anhang:${short})`
      if (a.target?.startsWith("task:")) {
        const e = requireEntry(ctx, a.target)
        const list = [...strArray(e.fields.attachments), short]
        await ctx.ops.update(run, "task", { name: e.name, fields: { ...e.fields, attachments: [...new Set(list)] }, reason: `Anhang ${short}`, approved: true })
      }
      return { message: `Anhang gespeichert (${Math.round(payload.length / 1024)} KB)`, target: a.target, data: { path: short, markdown } }
    },
  }),
  defineAction({
    name: "chat.ask",
    label: "Wissens-Chat",
    area: "dokument",
    smith: "docsmith",
    local: true,
    readOnlySafe: true,
    args: { question: { t: "string", multiline: true, max: 4000, min: 3 } },
    async run({ ctx }, _run, a) {
      const answer = await askAssistant(ctx, `Frage des Nutzers:\n${a.question}\n\nSuche mit den Lesewerkzeugen in der Wissensbasis und beantworte die Frage. Belege jede Aussage mit [[Links]] auf die Einträge, die du gelesen hast. Was du nicht findest, sagst du offen.`, `Chat ${a.question}`)
      const sources = [...new Set([...answer.matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1].trim()))].map((t) => ctx.links.resolve(t)?.id).filter(Boolean)
      return { message: "Antwort", data: { answer, sources } }
    },
  }),
  defineAction({
    name: "chat.save",
    label: "Antwort speichern",
    area: "dokument",
    smith: (a) => (a.as === "result" ? "memorysmith" : "docsmith"),
    args: { question: { t: "string", multiline: true, max: 4000 }, answer: { t: "string", multiline: true, max: 200_000 }, as: { t: "enum", values: ["doc", "result"] }, title: { t: "string", max: 160, optional: true }, folder: { t: "string", max: 200, optional: true } },
    async run({ ctx }, run, a) {
      const title = a.title ?? truncate(oneLine(a.question), 120)
      if (a.as === "doc") {
        const name = await createDocument(ctx, run, { title, folder: a.folder, body: `> ${oneLine(a.question)}\n\n${a.answer}` })
        return { message: "als Dokument gespeichert", target: `knowledge:${name}`, open: `#/editor/knowledge:${name}` }
      }
      const scope = ctx.scope()
      const msg = await ctx.ops.memoryResult(run, { title, question: a.question, answer: a.answer, where: scope, reason: "Antwort des Wissens-Chats", approved: true } as any)
      return { message: msg }
    },
  }),
]

/** Append to the inbox document ("Eingang") with timestamp and session link. */
export async function quickNote(ctx: Ctx, run: Run, text: string, session?: string): Promise<string> {
  const name = slugify(ctx.options.docs.inboxDoc, 60) || "eingang"
  const stamp = new Date().toLocaleString("sv-SE").slice(0, 16)
  const line = `- ${stamp} · ${text.trim().replace(/\n+/g, " ")}${session ? ` ([Session](#/session/${session}))` : ""}`
  const e = ctx.store.fresh("knowledge", name)
  if (!e) {
    await createDocument(ctx, run, { name, title: "Eingang", body: `Schnellnotizen – später einsortieren.\n\n${line}`, description: "Schnellnotizen aus opencode und der Weboberfläche", tags: ["eingang"] })
    return "Notiz im neuen Dokument „Eingang“ abgelegt"
  }
  await ctx.ops.update(run, "knowledge", { name, body: `${e.body.trim()}\n${line}`, reason: "Schnellnotiz", approved: true })
  return "Notiz im Eingang abgelegt"
}

export { TEMPLATE_FOLDER, parseId }
