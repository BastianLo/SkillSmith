/** Actions on any entry: edit, tier, pin, AI access, rename, merge, convert, restore a version, delete, bulk. */
import type { Entry, Kind, Run, Tier } from "../../types"
import { AI_ACCESS } from "../../types"
import { diffLines, diffStats, toHunks } from "../../util/diff"
import { nowIso, oneLine, truncate } from "../../util/text"
import type { Ctx } from "../context"
import { str, strArray } from "../frontmatter"
import { scriptFiles, spec } from "../kinds"
import { rewriteLinks } from "../links"
import { GuardError } from "../ops"
import { versionOf } from "./index"
import type { ActionDef, ActionEnv } from "./types"
import { defineAction } from "./types"
import { parseId, pickFields, requireEntry, smithOfId } from "./util"

const target = { t: "id" } as const
const smith = (a: any) => smithOfId(a.target)

/** Unified diff of an entry's content before/after (editor preview, conflict answer). */
export function contentDiff(before: Entry | undefined, after: { title: string; description: string; tags: string[]; body: string; fields?: Record<string, unknown> }) {
  const ops = diffLines(before?.body ?? "", after.body)
  const fields: Array<{ label: string; before: string; after: string }> = []
  const cmp = (label: string, a: unknown, b: unknown) => {
    const x = Array.isArray(a) ? a.join(", ") : typeof a === "object" && a ? JSON.stringify(a) : String(a ?? "")
    const y = Array.isArray(b) ? b.join(", ") : typeof b === "object" && b ? JSON.stringify(b) : String(b ?? "")
    if (x !== y) fields.push({ label, before: x, after: y })
  }
  cmp("Titel", before?.title, after.title)
  cmp("Beschreibung", before?.description, after.description)
  cmp("Tags", before?.tags, after.tags)
  for (const k of Object.keys(after.fields ?? {})) cmp(k, before?.fields[k], after.fields?.[k])
  return { fields, hunks: toHunks(ops, 3), ...diffStats(ops) }
}

async function save(env: ActionEnv, run: Run, a: any): Promise<{ message: string; target: string }> {
  const { ctx } = env
  const e = requireEntry(ctx, a.target)
  if (e.kind === "task") {
    await ctx.tasks.update(run, e.name, { title: a.title, description: a.description, labels: a.tags, body: a.body })
    return { message: `${str(e.fields.id)} gespeichert`, target: a.target }
  }
  if (e.kind === "project") throw new GuardError("Projekte über „Projekt speichern“ ändern")
  const fields = pickFields(e.kind, a.fields)
  const msg = await ctx.ops.update(run, e.kind, {
    name: e.name,
    title: a.title,
    description: a.description,
    tags: a.tags,
    fields: fields ? { ...e.fields, ...fields } : undefined,
    body: a.body,
    reason: a.reason || "im Editor bearbeitet",
    approved: true,
  })
  return { message: msg, target: a.target }
}

const tierAction = (name: string, label: string, to: Tier, kind: "archive" | "restore" | "dormant" | "activate"): ActionDef =>
  defineAction({
    name,
    label,
    area: "eintrag",
    smith,
    args: { target, reason: { t: "string", max: 300, optional: true } },
    async run({ ctx }, run, a) {
      const { kind: k, name: n } = parseId(a.target)
      if (k === "task" || k === "project") {
        const e = requireEntry(ctx, a.target)
        if (e.tier === to) return { message: `bereits ${to}`, target: a.target }
        await ctx.store.move(run, k, n, to, kind, a.reason || `vom Nutzer (${label})`)
        run.actions.push({ kind, target: k, name: n, reason: a.reason, applied: true })
        return { message: `${spec(k).label} ${label.toLowerCase()}`, target: a.target }
      }
      if (to === "dormant" && !spec(k).tiers.includes("dormant")) throw new GuardError(`${spec(k).labelPlural} kennen keine Stufe „ruhend“`)
      const msg = await ctx.ops.move(run, k, { name: n, to, kind, reason: a.reason || `vom Nutzer (${label})`, approved: true })
      return { message: msg, target: a.target }
    },
  })

/** Every place that refers to an entry by name: links, relations, superseded_by, absorbedInto. */
function references(ctx: Ctx, id: string): Array<{ id: string; title: string; detail: string }> {
  const { kind, name } = parseId(id)
  const out = new Map<string, { id: string; title: string; detail: string[] }>()
  const add = (eid: string, title: string, detail: string) => {
    const cur = out.get(eid) ?? { id: eid, title, detail: [] }
    cur.detail.push(detail)
    out.set(eid, cur)
  }
  for (const b of ctx.links.backlinksOf(id)) {
    const [k, n] = [b.from.slice(0, b.from.indexOf(":")), b.from.slice(b.from.indexOf(":") + 1)]
    const e = ctx.store.getOwned(k as Kind, n)
    if (e && (b.link.target === name || b.link.target.toLowerCase() === id.toLowerCase())) add(b.from, e.title, `Link ${b.link.raw}`)
  }
  for (const k of ["skill", "knowledge", "glossary", "error", "script", "memory", "task", "project"] as Kind[]) {
    for (const e of ctx.store.list(k)) {
      const eid = `${k}:${e.name}`
      if (eid === id) continue
      if ((e.meta?.relations ?? []).some((r) => r.to === id)) add(eid, e.title, "Verknüpfung")
      if (k === kind && e.meta?.absorbedInto === name) add(eid, e.title, "zusammengeführt in")
      if (k === "memory" && kind === "memory" && str(e.fields.superseded_by) === name) add(eid, e.title, "abgelöst durch")
      if ((e.meta?.related ?? []).includes(id)) add(eid, e.title, "verwandt")
    }
  }
  return [...out.values()].map((x) => ({ id: x.id, title: x.title, detail: [...new Set(x.detail)].join(", ") }))
}

async function rename(ctx: Ctx, run: Run, id: string, to: string): Promise<string> {
  const { kind, name } = parseId(id)
  if (kind === "task") throw new GuardError("Aufgaben behalten ihre Kurz-Id")
  if (kind === "script") throw new GuardError("Skripte umbenennen: neues Skript in der Werkstatt anlegen (Modulnamen hängen am Namen)")
  const refs = references(ctx, id)
  await ctx.store.rename(run, kind, name, to, "umbenannt")
  run.actions.push({ kind: "update", target: kind, name: to, reason: `umbenannt aus ${name}`, detail: "rename", applied: true })
  const newId = `${kind}:${to}`
  let links = 0
  for (const r of refs) {
    const { kind: rk, name: rn } = parseId(r.id)
    const e = ctx.store.fresh(rk, rn)
    if (!e) continue
    const rw = rewriteLinks(e.body, kind, name, to)
    const rels = (e.meta?.relations ?? []).map((x) => (x.to === id ? { ...x, to: newId } : x))
    const relChanged = JSON.stringify(rels) !== JSON.stringify(e.meta?.relations ?? [])
    const fields: Record<string, unknown> = { ...e.fields }
    let fieldChanged = false
    if (rk === "memory" && str(e.fields.superseded_by) === name) {
      fields.superseded_by = to
      fieldChanged = true
    }
    if (rw.count || fieldChanged) {
      await ctx.ops.update(run, rk, { name: rn, body: rw.text, fields, reason: `Links auf ${name} → ${to}`, approved: true })
      links += rw.count
    }
    const needsMeta = relChanged || (e.meta?.absorbedInto === name && rk === kind) || e.meta?.related?.includes(id)
    if (needsMeta) {
      await ctx.store.editMeta(
        run,
        rk,
        rn,
        (m) => {
          if (relChanged) m.relations = rels
          if (m.absorbedInto === name && rk === kind) m.absorbedInto = to
          if (m.related) m.related = m.related.map((x) => (x === id ? newId : x))
        },
        "relink",
        `${name} → ${to}`,
      )
    }
  }
  // relations with a volatile end live in the local database
  if (ctx.mem?.available) {
    for (const r of ctx.mem.relationsOf(id)) {
      ctx.mem.deleteRelationBetween(r.from, r.to)
      ctx.mem.addRelation(r.from === id ? newId : r.from, { ...r, to: r.to === id ? newId : r.to })
    }
  }
  return `umbenannt: ${name} → ${to}${refs.length ? ` · ${refs.length} verweisende(r) Eintrag/Einträge angepasst (${links} Link(s))` : ""}`
}

export const ENTRY_ACTIONS: ActionDef[] = [
  defineAction({
    name: "entry.save",
    label: "Speichern",
    area: "eintrag",
    smith,
    args: {
      target,
      title: { t: "string", max: 200, optional: true },
      description: { t: "string", max: 1000, optional: true },
      tags: { t: "list", max: 20, item: 60, optional: true },
      fields: { t: "object", optional: true },
      body: { t: "string", multiline: true, max: 2_000_000, optional: true },
      reason: { t: "string", max: 300, optional: true },
    },
    version: ({ ctx }, a) => versionOf(ctx, a.target),
    async preview({ ctx }, a) {
      const e = requireEntry(ctx, a.target)
      const diff = contentDiff(e, { title: a.title ?? e.title, description: a.description ?? e.description, tags: a.tags ?? e.tags, body: a.body ?? e.body, fields: a.fields ? { ...e.fields, ...a.fields } : undefined })
      return { message: `${diff.additions} Zeile(n) hinzu, ${diff.deletions} entfernt`, diff }
    },
    run: save,
  }),
  tierAction("entry.archive", "Archivieren", "archive", "archive"),
  tierAction("entry.restore", "Wiederherstellen", "active", "restore"),
  tierAction("entry.dormant", "Ruhend", "dormant", "dormant"),
  tierAction("entry.activate", "Aktivieren", "active", "activate"),
  defineAction({
    name: "entry.pin",
    label: "Anpinnen",
    area: "eintrag",
    smith,
    args: { target, pinned: { t: "boolean" } },
    async run({ ctx }, run, a) {
      const { kind, name } = parseId(a.target)
      return { message: await ctx.ops.pin(run, kind, name, a.pinned), target: a.target }
    },
  }),
  defineAction({
    name: "entry.setAi",
    label: "KI-Recht setzen",
    area: "eintrag",
    smith,
    args: { target, ai: { t: "enum", values: AI_ACCESS } },
    async run({ ctx }, run, a) {
      const e = requireEntry(ctx, a.target)
      const before = str(e.fields.ai) || "frei"
      if (before === a.ai) return { message: `KI-Recht bleibt ${a.ai}`, target: a.target }
      await ctx.ops.update(run, e.kind, { name: e.name, fields: { ...e.fields, ai: a.ai }, reason: `KI-Recht ${before} → ${a.ai}`, approved: true })
      return { message: `KI-Recht: ${before} → ${a.ai}`, target: a.target }
    },
  }),
  defineAction({
    name: "entry.rename",
    label: "Umbenennen",
    area: "eintrag",
    smith,
    confirm: "rename",
    args: { target, to: { t: "string", max: 64, pattern: /^[a-z0-9]+(-[a-z0-9]+)*$/ } },
    async preview({ ctx }, a) {
      const { kind, name } = parseId(a.target)
      if (ctx.store.fresh(kind, a.to)) throw new GuardError(`„${a.to}“ gibt es schon`)
      const affected = references(ctx, a.target)
      return { message: `${name} → ${a.to}: ${affected.length} verweisende(r) Eintrag/Einträge werden angepasst`, affected }
    },
    async run({ ctx }, run, a) {
      const { kind } = parseId(a.target)
      return { message: await rename(ctx, run, a.target, a.to), target: `${kind}:${a.to}`, open: `#/eintrag/${kind}:${a.to}` }
    },
  }),
  defineAction({
    name: "entry.merge",
    label: "Zusammenführen",
    area: "eintrag",
    smith,
    confirm: "merge",
    args: {
      target,
      sources: { t: "list", max: 20, item: 120 },
      title: { t: "string", max: 200, optional: true },
      description: { t: "string", max: 1000 },
      tags: { t: "list", max: 20, item: 60, optional: true },
      body: { t: "string", multiline: true, max: 2_000_000 },
      reason: { t: "string", max: 300, optional: true },
    },
    async preview({ ctx }, a) {
      const { kind } = parseId(a.target)
      const affected = a.sources.map((s: string) => {
        const e = ctx.store.getOwned(kind, s.replace(`${kind}:`, ""))
        return { id: `${kind}:${s.replace(`${kind}:`, "")}`, title: e?.title ?? s, detail: e ? "wird archiviert (zusammengeführt)" : "nicht gefunden" }
      })
      const t = ctx.store.getOwned(kind, parseId(a.target).name)
      return { message: `${affected.length} Eintrag/Einträge gehen in ${a.target} auf`, affected, diff: contentDiff(t, { title: a.title ?? t?.title ?? "", description: a.description, tags: a.tags ?? t?.tags ?? [], body: a.body }) }
    },
    async run({ ctx }, run, a) {
      const { kind, name } = parseId(a.target)
      const msg = await ctx.ops.merge(run, kind, { sources: a.sources.map((s: string) => s.replace(`${kind}:`, "")), target: name, title: a.title, description: a.description, tags: a.tags, body: a.body, reason: a.reason || "im Editor zusammengeführt", approved: true })
      return { message: msg, target: a.target }
    },
  }),
  defineAction({
    name: "entry.convert",
    label: "Umwandeln",
    area: "eintrag",
    smith: (a) => (a.to === "knowledge" ? "docsmith" : "memorysmith"),
    args: { target, to: { t: "enum", values: ["knowledge", "memory"] }, folder: { t: "string", max: 200, optional: true } },
    async preview({ ctx }, a) {
      const e = requireEntry(ctx, a.target)
      return { message: `${spec(e.kind).label} „${e.title}“ wird ${a.to === "knowledge" ? "Wissen" : "Erfahrung"}; Herkunft und Verknüpfungen bleiben, das Original wird archiviert` }
    },
    async run({ ctx }, run, a) {
      const e = requireEntry(ctx, a.target)
      if (e.kind === a.to) throw new GuardError("ist bereits diese Art")
      if (!((e.kind === "memory" && str(e.fields.type) === "erfahrung" && a.to === "knowledge") || (e.kind === "knowledge" && a.to === "memory"))) {
        throw new GuardError("Umwandeln geht zwischen Erfahrung und Wissen")
      }
      const to = a.to as Kind
      let name = e.name
      for (let i = 2; ctx.store.fresh(to, name); i++) name = `${e.name}-${i}`
      const scope = ctx.scope()
      const fields: Record<string, unknown> =
        to === "memory"
          ? { type: "erfahrung", scope: "projekt", project: scope.project, project_name: scope.projectName, topic: `erfahrung/${name}`, status: "gueltig", author: str(e.fields.author), ai: str(e.fields.ai) }
          : { author: str(e.fields.author), ai: str(e.fields.ai) }
      await ctx.ops.create(run, to, { name, title: e.title, description: e.description || e.title, tags: e.tags, fields, body: e.body || e.description, reason: `umgewandelt aus ${a.target}`, approved: true, folder: to === "knowledge" ? a.folder : undefined })
      const newId = `${to}:${name}`
      const meta = e.meta
      if (meta?.relations?.length || meta?.evidence?.length) {
        await ctx.store.updateMeta(run, to, name, { relations: meta.relations, evidence: meta.evidence, origin: { ...(meta.origin ?? {}), adoptedFrom: a.target } } as any, "convert", `aus ${a.target}`)
      }
      await ctx.ops.relate(run, { from: newId, to: a.target, type: "derived_from", strength: 0.9, description: "Umgewandelt aus dem ursprünglichen Eintrag.", source: "user" })
      if (e.tier !== "archive") await ctx.ops.move(run, e.kind, { name: e.name, to: "archive", kind: "archive", reason: `umgewandelt in ${newId}`, approved: true })
      return { message: `umgewandelt: ${a.target} → ${newId}`, target: newId, open: `#/eintrag/${newId}` }
    },
  }),
  defineAction({
    name: "entry.restoreVersion",
    label: "Version wiederherstellen",
    area: "eintrag",
    smith,
    confirm: "restore",
    args: { target, hash: { t: "hash" } },
    async preview({ ctx }, a) {
      const { kind, name } = parseId(a.target)
      const diff = await ctx.versions.diff(kind, name, a.hash, "working", ctx.options.web.diffMaxLines)
      return { message: `Stand ${a.hash.slice(0, 8)} wird neue Version`, diff }
    },
    async run({ ctx }, run, a) {
      const { kind, name } = parseId(a.target)
      const cur = requireEntry(ctx, a.target)
      const old = await ctx.versions.contentAt(kind, name, a.hash)
      if (!old.main) throw new GuardError(`Version ${a.hash.slice(0, 8)} enthält ${a.target} nicht`)
      const c = spec(kind).parse(old.main, name)
      if (kind === "script") {
        const f = scriptFiles(name)
        const check = await ctx.workshop.recheck({
          name,
          isNew: false,
          content: { ...c, name },
          files: { [f.code]: old.files[f.code] ?? "", [f.test]: old.files[f.test] ?? "" },
          test: cur.meta?.test ?? { status: "untested", at: nowIso() },
          capabilities: strArray(c.fields.capabilities),
          reason: "restore",
        } as any)
        if (!check.ok) throw new GuardError(`Die Tests der alten Version bestehen nicht mehr:\n${truncate(check.message, 1500)}`)
        await ctx.store.update(run, kind, name, { description: c.description, tags: c.tags, fields: c.fields, body: c.body, files: { [f.code]: old.files[f.code] ?? "", [f.test]: old.files[f.test] ?? "" } }, "restore-version", `Stand ${a.hash.slice(0, 8)}`, { test: check.test })
        run.actions.push({ kind: "restore", target: kind, name, reason: `Version ${a.hash.slice(0, 8)}`, applied: true })
        return { message: `Skript auf Stand ${a.hash.slice(0, 8)} zurückgesetzt (Tests grün)`, target: a.target }
      }
      const msg = await ctx.ops.update(run, kind, { name, title: c.title, description: c.description, tags: c.tags, fields: { ...cur.fields, ...c.fields }, body: c.body, reason: `Version ${a.hash.slice(0, 8)} wiederhergestellt`, approved: true }, "restore")
      return { message: msg, target: a.target }
    },
  }),
  defineAction({
    name: "entry.delete",
    label: "Endgültig löschen",
    area: "eintrag",
    smith,
    confirm: "delete",
    args: { target, confirm: { t: "string", max: 120 } },
    async preview({ ctx }, a) {
      const e = requireEntry(ctx, a.target)
      return { message: `„${e.name}“ wird gelöscht; git behält die Historie`, confirmName: e.name }
    },
    async run({ ctx }, run, a) {
      const e = requireEntry(ctx, a.target)
      const mode = ctx.options.web.confirm.delete
      if (mode === "name" && a.confirm !== e.name) throw new GuardError(`Zum Löschen den Namen „${e.name}“ eintippen`)
      if (e.tier !== "archive") throw new GuardError("Nur archivierte Einträge lassen sich löschen")
      await ctx.store.remove(run, e.kind, e.name)
      run.actions.push({ kind: "archive", target: e.kind, name: e.name, reason: "endgültig gelöscht", detail: "delete", applied: true })
      ctx.mem?.deleteRelationsOf?.(a.target)
      return { message: `${spec(e.kind).label} „${e.name}“ gelöscht (git behält die Historie)`, open: "#/" }
    },
  }),
  defineAction({
    name: "entry.relocate",
    label: "In Ordner verschieben",
    area: "dokument",
    smith: "docsmith",
    args: { target, folder: { t: "string", max: 200 } },
    async run({ ctx }, run, a) {
      const { kind, name } = parseId(a.target)
      if (kind !== "knowledge") throw new GuardError("Nur Dokumente liegen in Ordnern")
      const e = await ctx.store.relocate(run, kind, name, a.folder)
      run.actions.push({ kind: "update", target: kind, name, reason: `Ordner ${e.folder || "/"}`, detail: "move-folder", applied: true })
      return { message: `verschoben nach ${e.folder || "Hauptordner"}`, target: a.target }
    },
  }),
  defineAction({
    name: "entries.bulk",
    label: "Mehrfachauswahl",
    area: "eintrag",
    smith: (a) => smithOfId(a.ids?.[0]),
    args: { ids: { t: "list", max: 500, item: 200 }, op: { t: "enum", values: ["archive", "restore", "tag", "untag", "relate", "ai"] }, value: { t: "string", max: 200, optional: true } },
    async preview({ ctx }, a) {
      const affected = a.ids.map((id: string) => {
        const e = (() => {
          try {
            return requireEntry(ctx, id)
          } catch {
            return undefined
          }
        })()
        return { id, title: e?.title ?? id, detail: e ? "" : "nicht gefunden" }
      })
      return { message: `${affected.length} Einträge: ${a.op}${a.value ? ` ${a.value}` : ""}`, affected }
    },
    async run({ ctx }, run, a) {
      const done: string[] = []
      const failed: string[] = []
      for (const id of a.ids as string[]) {
        try {
          const e = requireEntry(ctx, id)
          switch (a.op) {
            case "archive":
              if (e.kind === "task" || e.kind === "project") await ctx.store.move(run, e.kind, e.name, "archive", "archive", "Mehrfachauswahl")
              else await ctx.ops.move(run, e.kind, { name: e.name, to: "archive", kind: "archive", reason: "Mehrfachauswahl", approved: true })
              break
            case "restore":
              if (e.kind === "task" || e.kind === "project") await ctx.store.move(run, e.kind, e.name, "active", "restore", "Mehrfachauswahl")
              else await ctx.ops.move(run, e.kind, { name: e.name, to: "active", kind: "restore", reason: "Mehrfachauswahl", approved: true })
              break
            case "tag":
            case "untag": {
              const tag = oneLine(a.value ?? "").toLowerCase()
              if (!tag) throw new GuardError("Tag fehlt")
              const tags = a.op === "tag" ? [...new Set([...e.tags, tag])] : e.tags.filter((t) => t !== tag)
              await ctx.ops.update(run, e.kind, { name: e.name, tags, reason: `Tag ${a.op === "tag" ? "+" : "−"}${tag}`, approved: true })
              break
            }
            case "relate":
              if (!a.value) throw new GuardError("Ziel fehlt")
              await ctx.ops.relate(run, { from: id, to: a.value, type: "related", strength: 0.6, description: "vom Nutzer per Mehrfachauswahl verknüpft", source: "user" })
              break
            case "ai":
              if (!(AI_ACCESS as string[]).includes(String(a.value))) throw new GuardError(`KI-Recht: ${AI_ACCESS.join(", ")}`)
              await ctx.ops.update(run, e.kind, { name: e.name, fields: { ...e.fields, ai: a.value }, reason: `KI-Recht ${a.value}`, approved: true })
              break
          }
          done.push(id)
        } catch (err) {
          failed.push(`${id}: ${(err as Error).message}`)
        }
      }
      return { message: `${done.length} Eintrag/Einträge geändert${failed.length ? `, ${failed.length} abgelehnt` : ""}`, warnings: failed }
    },
  }),
]

export { references }
