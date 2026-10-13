/** Memories, work states, results, relations, doctor conflicts, glossary candidates and new entries. */
import type { Kind, Run } from "../../types"
import { RELATION_TYPES } from "../../types"
import { oneLine, slugify, truncate } from "../../util/text"
import type { Ctx } from "../context"
import { str, strArray } from "../frontmatter"
import { canonicalEdge, isStoreId } from "../graph"
import { glossarySlug, meaningsOf, spec, fenceLanguage } from "../kinds"
import type { WorkState } from "../memory-db"
import { GuardError } from "../ops"
import { isSmithAgent } from "../prompts"
import type { ActionDef } from "./types"
import { defineAction } from "./types"
import { defaultAccess, parseId, requireEntry, smithOfId, uniqueName } from "./util"

const node = { t: "string", max: 200, pattern: /^[a-z]+:[^\s]+$/ } as const

function stateOf(ctx: Ctx, id: string): WorkState {
  const st = ctx.mem?.getState(id)
  if (!st) throw new GuardError(`Arbeitsstand ${id} nicht gefunden`)
  return st
}

function localChange(run: Run, id: string, kind: "state" | "result" | "relate", reason: string, before: unknown, after: unknown): void {
  run.actions.push({ kind, target: "memory", name: id, reason, applied: true, local: true })
  ;(run.localChanges ??= []).push({ id, before, after })
}

/** Remove the stored relation between two nodes (both ends; store meta or local db). */
export async function unrelate(ctx: Ctx, run: Run, a: string, b: string): Promise<boolean> {
  let removed = false
  for (const [x, y] of [
    [a, b],
    [b, a],
  ]) {
    const s = isStoreId(x)
    if (!s) continue
    const e = ctx.store.getOwned(s.kind, s.name)
    if (!e?.meta?.relations?.some((r) => r.to === y)) continue
    await ctx.store.editMeta(run, s.kind, s.name, (m) => (m.relations = (m.relations ?? []).filter((r) => r.to !== y)), "unrelate", `${x} ↛ ${y}`)
    run.actions.push({ kind: "relate", target: s.kind, name: s.name, reason: `Verknüpfung zu ${y} gelöscht`, detail: "unrelate", applied: true })
    removed = true
  }
  if (ctx.mem?.available) {
    const before = ctx.mem.relationsOf(a).find((r) => (r.from === a && r.to === b) || (r.from === b && r.to === a))
    if (before) {
      ctx.mem.deleteRelationBetween(a, b)
      localChange(run, before.from, "relate", `Verknüpfung ${a} – ${b} gelöscht`, before, undefined)
      removed = true
    }
  }
  return removed
}

/** The user decided a doctor conflict (shared by /smith-doctor resolve and the web view). */
export async function resolveConflict(ctx: Ctx, run: Run, id: string, choice: "a" | "b" | "both" | "unrelated"): Promise<string> {
  const mem = ctx.mem
  if (!mem) throw new GuardError("Der Doktor ist nicht verfügbar")
  const c = mem.conflict(id)
  if (!c) throw new GuardError(`Konflikt ${id} nicht gefunden`)
  if (c.status === "resolved") return `Konflikt ${id} ist bereits gelöst (${c.resolution ?? "–"})`
  const g = ctx.graph
  const na = g.node(c.a)
  const nb = g.node(c.b)
  if (!na || !nb) {
    mem.updateConflict(id, { status: "resolved", resolution: "Eintrag entfernt" })
    return `Einer der Einträge existiert nicht mehr – Konflikt ${id} geschlossen`
  }
  let msg: string
  if (choice === "unrelated") msg = await ctx.ops.relate(run, { from: c.a, to: c.b, type: "not_related", strength: 0, description: "vom Nutzer: kein Bezug", source: "user" })
  else if (choice === "both") msg = await ctx.ops.relate(run, { from: c.a, to: c.b, type: "related", strength: 0.6, description: "Beide gelten – vom Nutzer bestätigt.", source: "user" })
  else {
    const [keep, drop] = choice === "a" ? [c.a, c.b] : [c.b, c.a]
    msg = await outdate(ctx, run, keep, drop)
  }
  mem.markChecked(c.a, c.b, g.node(c.a)?.hash ?? na.hash, g.node(c.b)?.hash ?? nb.hash, `user:${choice}`)
  const label = choice === "a" ? `A gilt (${c.a})` : choice === "b" ? `B gilt (${c.b})` : choice === "both" ? "beide gelten" : "kein Bezug"
  mem.updateConflict(id, { status: "resolved", resolution: `Nutzer: ${label}` })
  ctx.audit?.append({ actor: run.actor === "web" ? "user-web" : "user-command", smith: "doctor", category: "conflict", action: `resolve-${choice}`, targets: [c.a, c.b], result: "ok", message: `${id}: ${label}`, run: run.id })
  return `Konflikt ${id} entschieden (${label}).\n${msg}`
}

/** `keep` is right, `drop` is outdated. */
async function outdate(ctx: Ctx, run: Run, keep: string, drop: string): Promise<string> {
  const k = isStoreId(keep)
  const d = isStoreId(drop)
  if (drop.startsWith("result:")) {
    const before = ctx.mem?.getResult(drop)
    ctx.mem?.deleteResult(drop)
    localChange(run, drop, "result", "veraltet (Nutzerentscheidung)", before, undefined)
    return `Ergebnis ${drop} gelöscht`
  }
  if (drop.startsWith("state:")) {
    const before = ctx.mem?.getState(drop)
    ctx.mem?.setStateStatus(drop, "abgelaufen")
    localChange(run, drop, "state", "veraltet (Nutzerentscheidung)", before ? { ...before, history: undefined } : undefined, { status: "abgelaufen" })
    return `Arbeitsstand ${drop} verworfen`
  }
  if (!d) throw new GuardError(`${drop} kann nicht als veraltet markiert werden`)
  if (k?.kind === "memory" && d.kind === "memory") return ctx.ops.memorySupersede(run, { old: d.name, by: k.name, reason: "Nutzerentscheidung im Doktor-Konflikt", approved: true })
  const parts = [await ctx.ops.relate(run, { from: keep, to: drop, type: "supersedes", strength: 0.9, description: "Vom Nutzer entschieden: dieser Eintrag gilt, der andere ist veraltet.", source: "user" })]
  if (ctx.store.getOwned(d.kind, d.name)?.tier !== "archive") parts.push(await ctx.ops.move(run, d.kind, { name: d.name, to: "archive", kind: "archive", reason: `veraltet – ${keep} gilt (Nutzerentscheidung)`, approved: true }))
  return parts.join("\n")
}

function strength(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0.6
  return n > 1 ? Math.min(5, n) / 5 : Math.max(0, n)
}

export const MEMORY_ACTIONS: ActionDef[] = [
  defineAction({
    name: "memory.create",
    label: "Erinnerung anlegen",
    area: "neu",
    smith: "memorysmith",
    args: {
      type: { t: "enum", values: ["entscheidung", "vorgabe", "erfahrung"] },
      title: { t: "string", max: 120, min: 3 },
      summary: { t: "string", max: 300, min: 3 },
      body: { t: "string", multiline: true, max: 100_000, min: 1 },
      tags: { t: "list", max: 12, item: 40, optional: true },
      scope: { t: "enum", values: ["projekt", "global"], optional: true },
      topic: { t: "string", max: 80, optional: true },
    },
    async run({ ctx }, run, a) {
      const where = ctx.scope()
      const msg = await ctx.ops.memorySave(run, { type: a.type, topic: a.topic || slugify(a.title, 40), title: a.title, summary: a.summary, body: a.body, tags: a.tags, scope: a.scope ?? "projekt", status: "gueltig", where, approved: true, reason: "vom Nutzer angelegt" })
      const id = /memory id: (memory:\S+)/.exec(msg)?.[1]
      if (id) {
        const e = requireEntry(ctx, id)
        await ctx.ops.update(run, "memory", { name: e.name, fields: { ...e.fields, author: "user", ai: str(e.fields.ai) || defaultAccess(ctx), ...(a.type === "entscheidung" ? { decided_by: "user" } : {}) }, reason: "vom Nutzer", approved: true })
      }
      return { message: msg.split("\n")[0], target: id, open: id ? `#/eintrag/${id}` : undefined }
    },
  }),
  defineAction({
    name: "entry.create",
    label: "Eintrag anlegen",
    area: "neu",
    smith: (a) => spec(a.kind as Kind).smith,
    args: {
      kind: { t: "enum", values: ["skill", "error", "glossary", "agent", "snippet", "prompt"] },
      name: { t: "string", max: 64, optional: true, pattern: /^([a-z0-9]+(-[a-z0-9]+)*)?$/ },
      title: { t: "string", max: 160, min: 1 },
      description: { t: "string", max: 1000, optional: true },
      body: { t: "string", multiline: true, max: 200_000, optional: true },
      tags: { t: "list", max: 12, item: 40, optional: true },
      fields: { t: "object", optional: true },
    },
    async run({ ctx }, run, a) {
      const kind = a.kind as Kind
      const f = (a.fields ?? {}) as Record<string, unknown>
      if (kind === "glossary") {
        const meanings = meaningsOf(f.meanings)
        const msg = await ctx.ops.glossaryUpsert(run, { term: a.title, meanings, aliases: strArray(f.aliases), tags: a.tags, reason: "vom Nutzer angelegt" })
        const name = ctx.store.glossaryByTerm(a.title)[0]?.name ?? glossarySlug(a.title)
        return { message: msg, target: `glossary:${name}`, open: `#/eintrag/glossary:${name}` }
      }
      const name = a.name || uniqueName(ctx, kind, a.title)
      const fields: Record<string, unknown> = { author: "user", ai: defaultAccess(ctx) }
      if (kind === "error") Object.assign(fields, { status: str(f.status) === "open" ? "open" : "solved", signatures: strArray(f.signatures), context: strArray(f.context) })
      if (kind === "agent") {
        if (!/^[A-Za-z0-9][\w.-]*$/.test(a.title)) throw new GuardError("Der Agentenname (Titel) darf keine Leerzeichen enthalten – so heißt er in opencode")
        if (isSmithAgent(a.title)) throw new GuardError("Dieser Name gehört einem internen Agenten von skillsmith")
        const model = str(f.model)
        Object.assign(fields, { mode: ["primary", "subagent", "all"].includes(str(f.mode)) ? str(f.mode) : "primary", ...(model ? { model } : {}), ...(typeof f.temperature === "number" ? { temperature: f.temperature } : {}) })
      }
      if (kind === "snippet") Object.assign(fields, { language: str(f.language) || fenceLanguage(a.body ?? "") || "text", ...(str(f.origin) ? { origin: str(f.origin) } : {}) })
      if (kind === "prompt") Object.assign(fields, { ...(str(f.agent) ? { agent: str(f.agent) } : {}), ...(str(f.model) ? { model: str(f.model) } : {}) })
      const msg = await ctx.ops.create(run, kind, { name, title: a.title, description: a.description || a.title, tags: a.tags, fields, body: a.body ?? "", reason: "vom Nutzer angelegt", approved: true })
      return { message: `${msg.split("\n")[0]}${kind === "agent" ? " – wirkt nach einem Neustart von opencode" : ""}`, target: `${kind}:${name}`, open: `#/editor/${kind}:${name}` }
    },
  }),
  defineAction({
    name: "memory.confirm",
    label: "Entscheidung bestätigen",
    area: "erinnerung",
    smith: "memorysmith",
    args: { target: { t: "id" } },
    async run({ ctx }, run, a) {
      const e = requireEntry(ctx, a.target)
      if (e.kind !== "memory") throw new GuardError("keine Erinnerung")
      await ctx.ops.update(run, "memory", { name: e.name, fields: { ...e.fields, status: "gueltig", decided_by: "user" }, reason: "vom Nutzer bestätigt", approved: true })
      return { message: "bestätigt (gültig, entschieden vom Nutzer)", target: a.target }
    },
  }),
  defineAction({
    name: "memory.supersede",
    label: "Ablösen durch …",
    area: "erinnerung",
    smith: "memorysmith",
    args: { target: { t: "id" }, by: { t: "id" } },
    async run({ ctx }, run, a) {
      const { name } = parseId(a.target)
      const { name: by } = parseId(a.by)
      return { message: await ctx.ops.memorySupersede(run, { old: name, by, reason: "vom Nutzer abgelöst", approved: true }), target: a.by }
    },
  }),
  defineAction({
    name: "memory.reviewed",
    label: "Prüfung erledigt",
    area: "erinnerung",
    smith: "memorysmith",
    args: { target: { t: "id" } },
    async run({ ctx }, run, a) {
      const e = requireEntry(ctx, a.target)
      const next = new Date(Date.now() + ctx.options.memorysmith.decisionReviewDays * 86_400_000).toISOString().slice(0, 10)
      await ctx.ops.update(run, e.kind, { name: e.name, fields: { ...e.fields, review_after: next }, reason: "geprüft", approved: true })
      return { message: `geprüft – nächste Prüfung ${next}`, target: a.target }
    },
  }),
  defineAction({
    name: "memory.scope",
    label: "Gültigkeit umstellen",
    area: "erinnerung",
    smith: "memorysmith",
    args: { target: { t: "id" }, scope: { t: "enum", values: ["projekt", "global"] }, project: { t: "string", max: 200, optional: true }, projectName: { t: "string", max: 120, optional: true } },
    async run({ ctx }, run, a) {
      const e = requireEntry(ctx, a.target)
      const s = ctx.scope()
      const fields = a.scope === "global" ? { ...e.fields, scope: "global", project: "", project_name: "" } : { ...e.fields, scope: "projekt", project: a.project ?? s.project, project_name: a.projectName ?? s.projectName }
      await ctx.ops.update(run, "memory", { name: e.name, fields, reason: `Gültigkeit: ${a.scope}`, approved: true })
      return { message: a.scope === "global" ? "gilt jetzt überall" : `gilt für ${fields.project_name || fields.project}`, target: a.target }
    },
  }),
  defineAction({
    name: "state.edit",
    label: "Arbeitsstand bearbeiten",
    area: "erinnerung",
    smith: "memorysmith",
    local: true,
    args: { id: { t: "string", max: 200 }, goal: { t: "string", max: 300, optional: true }, done: { t: "list", max: 30, item: 300, optional: true }, open: { t: "list", max: 30, item: 300, optional: true }, next: { t: "list", max: 20, item: 300, optional: true }, files: { t: "list", max: 50, item: 300, optional: true } },
    async run({ ctx }, run, a) {
      const st = stateOf(ctx, a.id)
      const text = [a.goal ?? "", ...(a.done ?? []), ...(a.open ?? []), ...(a.next ?? []), ...(a.files ?? [])].join("\n")
      const secrets = ctx.redactor.scan(text)
      if (secrets.length) throw new GuardError(`enthält vertrauliche Daten (${secrets.join(", ")})`)
      const before = { ...st, history: undefined }
      ctx.mem!.upsertState({ project: st.project, projectName: st.projectName, branch: st.branch, ticket: st.ticket, goal: a.goal ?? st.goal, done: a.done ?? st.done, open: a.open ?? st.open, next: a.next ?? st.next, files: a.files ?? st.files, summary: st.summary, evidence: st.evidence, session: st.session, run: run.id })
      localChange(run, st.id, "state", "vom Nutzer bearbeitet", before, { ...ctx.mem!.getState(st.id), history: undefined })
      return { message: "Arbeitsstand gespeichert (lokal)", target: st.id }
    },
  }),
  defineAction({
    name: "state.status",
    label: "Arbeitsstand abschließen oder öffnen",
    area: "erinnerung",
    smith: "memorysmith",
    local: true,
    args: { id: { t: "string", max: 200 }, status: { t: "enum", values: ["gueltig", "abgelaufen"] } },
    async run({ ctx }, run, a) {
      const st = stateOf(ctx, a.id)
      ctx.mem!.setStateStatus(st.id, a.status)
      localChange(run, st.id, "state", a.status === "gueltig" ? "wieder geöffnet" : "abgeschlossen", { status: st.status }, { status: a.status })
      return { message: a.status === "gueltig" ? "wieder geöffnet" : "abgeschlossen", target: st.id }
    },
  }),
  defineAction({
    name: "result.keep",
    label: "Ergebnis behalten",
    area: "erinnerung",
    smith: "memorysmith",
    local: true,
    args: { id: { t: "string", max: 200 } },
    async run({ ctx }, run, a) {
      const r = ctx.mem?.getResult(a.id)
      if (!r) throw new GuardError("Ergebnis nicht gefunden")
      ctx.mem!.markResultUsed(a.id)
      localChange(run, a.id, "result", "behalten (verfällt nicht)", { used: r.used }, { used: r.used + 1 })
      return { message: "Ergebnis bleibt erhalten", target: a.id }
    },
  }),
  defineAction({
    name: "result.delete",
    label: "Ergebnis löschen",
    area: "erinnerung",
    smith: "memorysmith",
    local: true,
    args: { id: { t: "string", max: 200 } },
    async run({ ctx }, run, a) {
      const r = ctx.mem?.getResult(a.id)
      if (!r) throw new GuardError("Ergebnis nicht gefunden")
      ctx.mem!.deleteResult(a.id)
      localChange(run, a.id, "result", "gelöscht", r, undefined)
      return { message: "Ergebnis gelöscht" }
    },
  }),
  defineAction({
    name: "result.adopt",
    label: "Ergebnis übernehmen",
    area: "erinnerung",
    smith: (a) => (a.as === "knowledge" ? "docsmith" : "memorysmith"),
    args: { id: { t: "string", max: 200 }, as: { t: "enum", values: ["knowledge", "erfahrung"] }, folder: { t: "string", max: 200, optional: true } },
    async run({ ctx }, run, a) {
      const r = ctx.mem?.getResult(a.id)
      if (!r) throw new GuardError("Ergebnis nicht gefunden")
      let target: string
      if (a.as === "knowledge") {
        const name = uniqueName(ctx, "knowledge", r.title)
        await ctx.ops.create(run, "knowledge", { name, title: r.title, description: truncate(oneLine(r.question || r.title), 300), tags: r.tags, fields: { author: "user", ai: defaultAccess(ctx, a.folder ?? "") }, body: `${r.answer}${r.sources.length ? `\n\n## Quellen\n${r.sources.map((s) => `- ${s}`).join("\n")}` : ""}`, reason: `aus Ergebnis ${a.id}`, approved: true, folder: a.folder })
        target = `knowledge:${name}`
      } else {
        const msg = await ctx.ops.memorySave(run, { type: "erfahrung", topic: slugify(r.title, 40), title: r.title, summary: truncate(oneLine(r.question || r.title), 200), body: r.answer, tags: r.tags, where: { project: r.project, projectName: r.projectName, projectSlug: slugify(r.projectName, 18) || "projekt", branch: r.branch }, approved: true, reason: `aus Ergebnis ${a.id}` })
        target = /memory id: (memory:\S+)/.exec(msg)?.[1] ?? ""
      }
      if (target) await ctx.ops.relate(run, { from: target, to: a.id, type: "derived_from", strength: 0.8, description: "Aus dem Ergebnis übernommen.", source: "user" }).catch(() => undefined)
      ctx.mem!.markResultUsed(a.id)
      return { message: `übernommen als ${a.as === "knowledge" ? "Wissen" : "Erfahrung"}`, target, open: target ? `#/eintrag/${target}` : undefined }
    },
  }),
  defineAction({
    name: "relation.create",
    label: "Verknüpfung anlegen",
    area: "verknuepfung",
    smith: (a) => smithOfId(a.from, "memorysmith"),
    args: { from: node, to: node, type: { t: "enum", values: RELATION_TYPES }, strength: { t: "number", min: 0, max: 5, optional: true }, description: { t: "string", max: 300, optional: true } },
    async run({ ctx }, run, a) {
      const msg = await ctx.ops.relate(run, { from: a.from, to: a.to, type: a.type, strength: strength(a.strength ?? 3), description: a.description || (a.type === "not_related" ? "" : "vom Nutzer verknüpft"), source: "user", approved: true })
      return { message: msg, target: a.from }
    },
  }),
  defineAction({
    name: "relation.delete",
    label: "Verknüpfung löschen",
    area: "verknuepfung",
    smith: (a) => smithOfId(a.from, "memorysmith"),
    args: { from: node, to: node },
    async run({ ctx }, run, a) {
      if (!(await unrelate(ctx, run, a.from, a.to))) throw new GuardError("Keine gespeicherte Verknüpfung zwischen den beiden (abgeleitete lassen sich mit „kein Bezug“ ausblenden)")
      return { message: "Verknüpfung gelöscht", target: a.from }
    },
  }),
  defineAction({
    name: "relation.reverse",
    label: "Richtung umkehren",
    area: "verknuepfung",
    smith: (a) => smithOfId(a.from, "memorysmith"),
    args: { from: node, to: node },
    async run({ ctx }, run, a) {
      const e = ctx.graph.between(a.from, a.to)
      if (!e || e.derived) throw new GuardError("Keine gespeicherte Verknüpfung")
      await unrelate(ctx, run, a.from, a.to)
      const { from, to } = canonicalEdge(e.to, e.from, e.type)
      const msg = await ctx.ops.relate(run, { from, to, type: e.type, strength: e.strength, description: e.description, source: "user", approved: true })
      return { message: `umgekehrt: ${msg}`, target: a.from }
    },
  }),
  defineAction({
    name: "relation.notRelated",
    label: "Kein Bezug",
    area: "verknuepfung",
    smith: (a) => smithOfId(a.from, "memorysmith"),
    args: { from: node, to: node },
    async run({ ctx }, run, a) {
      return { message: await ctx.ops.relate(run, { from: a.from, to: a.to, type: "not_related", strength: 0, description: "", source: "user", approved: true }), target: a.from }
    },
  }),
  defineAction({
    name: "relation.confirmDerived",
    label: "Abgeleitete Verknüpfung bestätigen",
    area: "verknuepfung",
    smith: (a) => smithOfId(a.from, "memorysmith"),
    args: { from: node, to: node },
    async run({ ctx }, run, a) {
      const e = ctx.graph.between(a.from, a.to)
      if (!e?.derived) throw new GuardError("Keine abgeleitete Verknüpfung zwischen den beiden")
      return { message: await ctx.ops.relate(run, { from: e.from, to: e.to, type: e.type, strength: e.strength, description: e.description, source: "user", approved: true }), target: a.from }
    },
  }),
  defineAction({
    name: "conflict.resolve",
    label: "Konflikt entscheiden",
    area: "doktor",
    smith: "doctor",
    args: { id: { t: "string", max: 40 }, choice: { t: "enum", values: ["a", "b", "both", "unrelated"] } },
    async run({ ctx }, run, a) {
      return { message: await resolveConflict(ctx, run, a.id, a.choice) }
    },
  }),
  defineAction({
    name: "conflict.correct",
    label: "Korrektur übernehmen",
    area: "doktor",
    smith: "doctor",
    args: { id: { t: "string", max: 40 }, target: { t: "id" }, oldText: { t: "string", multiline: true, max: 50_000, min: 1 }, newText: { t: "string", multiline: true, max: 50_000 } },
    async preview({ ctx }, a) {
      const e = requireEntry(ctx, a.target)
      if (!e.body.includes(a.oldText)) throw new GuardError("Die Stelle steht nicht (mehr) im Eintrag")
      const { contentDiff } = await import("./entries")
      return { message: "Stelle wird ersetzt", diff: contentDiff(e, { title: e.title, description: e.description, tags: e.tags, body: e.body.replace(a.oldText, () => a.newText) }) }
    },
    async run({ ctx }, run, a) {
      const { kind, name } = parseId(a.target)
      const msg = await ctx.ops.patch(run, kind, { name, oldText: a.oldText, newText: a.newText, reason: `Korrektur aus Konflikt ${a.id}`, approved: true })
      const c = ctx.mem?.conflict(a.id)
      if (c && c.status !== "resolved") {
        ctx.mem!.markChecked(c.a, c.b, ctx.graph.node(c.a)?.hash ?? "", ctx.graph.node(c.b)?.hash ?? "", "user:corrected")
        ctx.mem!.updateConflict(a.id, { status: "resolved", resolution: `Nutzer: ${a.target} korrigiert` })
      }
      return { message: msg, target: a.target }
    },
  }),
  defineAction({
    name: "conflict.recheck",
    label: "Erneut prüfen",
    area: "doktor",
    smith: "doctor",
    local: true,
    args: { id: { t: "string", max: 40 } },
    async run({ ctx }, run, a) {
      const c = ctx.mem?.conflict(a.id)
      if (!c) throw new GuardError("Konflikt nicht gefunden")
      ctx.mem!.updateConflict(a.id, { status: "open", attempts: 0 })
      run.actions.push({ kind: "note", target: "memory", name: a.id, reason: "erneut prüfen", applied: true, local: true })
      void ctx.doctor?.maybeRun("manual", 2000)
      return { message: "Paar geht zurück an den Doktor" }
    },
  }),
  defineAction({
    name: "conflict.defer",
    label: "Zurückstellen",
    area: "doktor",
    smith: "doctor",
    local: true,
    args: { id: { t: "string", max: 40 } },
    async run({ ctx }, run, a) {
      const c = ctx.mem?.conflict(a.id)
      if (!c) throw new GuardError("Konflikt nicht gefunden")
      ctx.mem!.markChecked(c.a, c.b, ctx.graph.node(c.a)?.hash ?? "", ctx.graph.node(c.b)?.hash ?? "", "user:deferred")
      ctx.mem!.updateConflict(a.id, { status: "resolved", resolution: "zurückgestellt bis zur nächsten Änderung" })
      run.actions.push({ kind: "note", target: "memory", name: a.id, reason: "zurückgestellt", applied: true, local: true })
      return { message: "zurückgestellt – kommt wieder, wenn sich einer der Einträge ändert" }
    },
  }),
  defineAction({
    name: "doctor.checkPair",
    label: "Paar prüfen lassen",
    area: "doktor",
    smith: "doctor",
    local: true,
    args: { a: node, b: node },
    async run({ ctx }, run, a) {
      const mem = ctx.mem
      if (!mem || !ctx.doctor?.enabled) throw new GuardError("Der Doktor ist nicht verfügbar")
      const na = ctx.graph.node(a.a)
      const nb = ctx.graph.node(a.b)
      if (!na || !nb) throw new GuardError("Eintrag nicht gefunden")
      const id = mem.openConflict(a.a, a.b, "vom Nutzer vorgelegt", 1, na.hash, nb.hash)
      run.actions.push({ kind: "note", target: "memory", name: id ?? `${a.a}|${a.b}`, reason: "Paar dem Doktor vorgelegt", applied: true, local: true })
      void ctx.doctor.maybeRun("manual", 2000)
      return { message: `Paar vorgelegt (${id}) – der Doktor prüft gleich` }
    },
  }),
  defineAction({
    name: "glossary.ignore",
    label: "Abkürzung ignorieren",
    area: "glossar",
    smith: "docsmith",
    args: { terms: { t: "list", max: 50, item: 60 } },
    async run({ ctx }, run, a) {
      const msg = await ctx.ops.ignoreTerms(run, a.terms)
      for (const t of a.terms as string[]) {
        const id = `abbr-${glossarySlug(t)}`
        const c = ctx.store.candidate("glossary", id)
        if (c && !c.promotedTo) await ctx.store.markCandidatePromoted(run, "glossary", id, "(ignoriert)")
      }
      return { message: msg }
    },
  }),
  defineAction({
    name: "candidate.dismiss",
    label: "Kandidat verwerfen",
    area: "glossar",
    smith: (a) => spec(a.kind as Kind).smith,
    args: { kind: { t: "enum", values: ["skill", "knowledge", "glossary", "error", "script", "memory"] }, id: { t: "string", max: 120 } },
    async run({ ctx }, run, a) {
      const c = ctx.store.candidate(a.kind, a.id)
      if (!c) throw new GuardError("Kandidat nicht gefunden")
      await ctx.store.markCandidatePromoted(run, a.kind, a.id, "(verworfen)")
      run.actions.push({ kind: "note", target: a.kind, name: a.id, reason: "Kandidat verworfen", applied: true })
      return { message: "Kandidat verworfen" }
    },
  }),
]

