/** Approvals, scripts (workshop), runs, system switches, metrics, feedback and the static export. */
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import type { Smith } from "../../types"
import { ensureDir, readText } from "../../util/fs"
import { nowIso, truncate } from "../../util/text"
import type { Ctx } from "../context"
import { exportStatic } from "../export"
import { finalizeRun } from "../finalize"
import { shadowLine } from "../legacy"
import { SMITH_SUBJECT_RE } from "../git"
import { M } from "../metrics"
import { GuardError, type StagedChange } from "../ops"
import { checkDraft, pythonEnv, type DraftSpec } from "../pyworkshop"
import { toPublishArgs } from "../toolsmith"
import { sessionLock } from "./index"
import type { ActionDef } from "./types"
import { defineAction } from "./types"
import { parseId } from "./util"

/** Revert a run (git revert of its commit) – shared with /smith-undo. */
export async function undoRun(ctx: Ctx, runOrHash: string | undefined, actor: "web" | "command", session?: string): Promise<{ message: string; commit?: string }> {
  const target = await ctx.git.findRunCommit(runOrHash || undefined)
  if (!target) throw new GuardError(runOrHash ? `Kein Smith-Commit zu „${runOrHash}“ gefunden` : "Kein Smith-Commit zum Zurücknehmen gefunden")
  const reverted = await ctx.git.revertToIndex(target.hash)
  if (!reverted.ok) throw new GuardError(`Zurücknehmen fehlgeschlagen: ${reverted.message} – „Version wiederherstellen“ am Eintrag nutzen`)
  const smith = (SMITH_SUBJECT_RE.exec(target.subject)?.[1] as Smith) ?? "skillsmith"
  const run = ctx.runs.create({ smith, actor, trigger: `undo ${target.runId ?? target.hash}`, writeMode: "auto", directory: ctx.directory, project: ctx.project, sessionID: session, limits: { maxNew: 0, maxChanges: 10_000, maxNotes: 0 } })
  run.subject = `${smith}(${actor}): undo ${target.runId ?? target.hash}`
  run.summary = `revert of ${target.hash} "${target.subject}"`
  for (const p of reverted.paths) run.touched.add(p)
  ctx.store.bump()
  const fin = await finalizeRun(ctx, run, { ok: true })
  return { message: `Zurückgenommen: ${target.hash} „${truncate(target.subject, 80)}“`, commit: fin.commit }
}

function stagedOf(ctx: Ctx, id: string): StagedChange[] {
  const list = ctx.ops.staged().filter((s) => id === "all" || s.id === id)
  if (!list.length) throw new GuardError(`Keine vorgemerkte Änderung „${id}“`)
  return list
}

/** Draft spec of the script workshop from the web form. */
function specOf(a: Record<string, any>): DraftSpec {
  return {
    name: String(a.name).trim(),
    description: String(a.description ?? "").trim(),
    usage: String(a.usage ?? "").trim(),
    code: String(a.code ?? ""),
    tests: String(a.tests ?? ""),
    docs: String(a.docs ?? ""),
    capabilities: (a.capabilities as string[] | undefined) ?? [],
    requirements: (a.requirements as string[] | undefined) ?? [],
    tags: (a.tags as string[] | undefined) ?? [],
  }
}

const scriptArgs = {
  name: { t: "string", max: 64, pattern: /^[a-z0-9]+(-[a-z0-9]+)*$/ },
  description: { t: "string", max: 1000, min: 3 },
  usage: { t: "string", max: 300, min: 3 },
  code: { t: "string", multiline: true, max: 60_000, min: 1 },
  tests: { t: "string", multiline: true, max: 60_000, min: 1 },
  docs: { t: "string", multiline: true, max: 60_000, min: 1 },
  capabilities: { t: "list", max: 10, item: 40, optional: true },
  requirements: { t: "list", max: 20, item: 80, optional: true },
  tags: { t: "list", max: 12, item: 40, optional: true },
} as const

export const SYSTEM_ACTIONS: ActionDef[] = [
  defineAction({
    name: "staged.approve",
    label: "Vorgemerkte Änderung übernehmen",
    area: "freigabe",
    smith: (a, env) => (stagedOf(env.ctx, a.id)[0]?.smith as Smith) ?? "skillsmith",
    args: { id: { t: "string", max: 80 } },
    async run({ ctx }, run, a) {
      const out: string[] = []
      for (const c of stagedOf(ctx, a.id)) {
        try {
          out.push(`${c.id}: ${await ctx.ops.applyStaged(run, c)}`)
        } catch (err) {
          out.push(`${c.id}: abgelehnt – ${(err as Error).message}`)
        }
      }
      return { message: out.join("\n") }
    },
  }),
  defineAction({
    name: "staged.reject",
    label: "Vorgemerkte Änderung verwerfen",
    area: "freigabe",
    smith: "skillsmith",
    local: true,
    args: { id: { t: "string", max: 80 }, reason: { t: "string", max: 500, optional: true } },
    async run({ ctx }, run, a) {
      const list = stagedOf(ctx, a.id)
      for (const s of list) {
        ctx.ops.rejectStaged(s.id, a.reason)
        run.actions.push({ kind: "note", target: s.target, name: s.name, reason: `vorgemerkte Änderung ${s.id} verworfen`, applied: true, local: true })
      }
      return { message: `${list.length} vorgemerkte Änderung(en) verworfen` }
    },
  }),
  defineAction({
    name: "shadow.apply",
    label: "Shadow-Vorschlag übernehmen",
    area: "freigabe",
    smith: "skillsmith",
    args: { index: { t: "number", int: true, min: 0 } },
    async run({ ctx }, run, a) {
      const lines = (readText(ctx.ops.shadowFile) ?? "").split("\n").filter(Boolean)
      const line = lines[a.index]
      if (!line) throw new GuardError("Vorschlag nicht gefunden")
      const p = shadowLine(JSON.parse(line))
      run.smith = p.smith
      const change: StagedChange = { id: `shadow-${a.index}`, runId: p.runId, createdAt: p.at, actor: p.actor, smith: p.smith, sessionID: p.sessionID, project: p.project, action: p.action, target: p.target, name: p.name, reason: p.reason, args: p.args }
      return { message: await ctx.ops.applyStaged(run, change), target: `${p.target}:${p.name}` }
    },
  }),
  defineAction({
    name: "script.retest",
    label: "Skript neu testen",
    area: "freigabe",
    smith: "toolsmith",
    local: true,
    args: { target: { t: "id" } },
    async run({ ctx }, _run, a) {
      const { name } = parseId(a.target)
      if (!ctx.curator) throw new GuardError("Curator nicht verfügbar")
      return { message: await ctx.curator.retestScripts("web", [name]), target: a.target }
    },
  }),
  defineAction({
    name: "script.check",
    label: "Skript prüfen",
    area: "neu",
    smith: "toolsmith",
    local: true,
    readOnlySafe: true,
    args: scriptArgs,
    async run({ ctx }, run, a) {
      const env = await pythonEnv(ctx.options, ctx.store.stateDir)
      const dir = join(ctx.store.stateDir, "drafts", `web-${run.id}`, a.name)
      const report = await checkDraft({ spec: specOf(a), dir, env, options: ctx.options, log: ctx.log })
      return { message: report.ok ? "Prüfung bestanden" : "Prüfung fehlgeschlagen", data: report }
    },
  }),
  defineAction({
    name: "script.publish",
    label: "Skript veröffentlichen",
    area: "neu",
    smith: "toolsmith",
    args: { ...scriptArgs, approveRisky: { t: "boolean", optional: true }, reason: { t: "string", max: 300, optional: true } },
    async run({ ctx }, run, a) {
      const spec0 = specOf(a)
      const env = await pythonEnv(ctx.options, ctx.store.stateDir)
      const dir = join(ctx.store.stateDir, "drafts", `web-${run.id}`, spec0.name)
      const report = await checkDraft({ spec: spec0, dir, env, options: ctx.options, log: ctx.log })
      if (!report.ok) throw new GuardError(`Die Prüfung ist nicht bestanden – erst beheben:\n${truncate(report.text, 2000)}`)
      if (report.needsApproval && !a.approveRisky) {
        const { ConfirmNeeded } = await import("../tasks")
        throw new ConfirmNeeded(`Riskante Fähigkeiten (${report.risky.join(", ") || report.needsApproval}) – bitte ausdrücklich freigeben`)
      }
      const isNew = !ctx.store.getOwned("script", spec0.name)
      const args = toPublishArgs({ ...spec0, isNew }, report, ctx.options.toolsmith.pythonTarget, { reason: a.reason || "in der Skript-Werkstatt veröffentlicht" })
      args.content.fields = { ...args.content.fields, author: "user" }
      args.approved = true
      return { message: await ctx.ops.publishScript(run, args), target: `script:${spec0.name}` }
    },
  }),
  defineAction({
    name: "run.undo",
    label: "Lauf rückgängig machen",
    area: "system",
    smith: "skillsmith",
    confirm: "undo",
    args: { run: { t: "string", max: 80, optional: true } },
    async preview({ ctx }, a) {
      const target = await ctx.git.findRunCommit(a.run || undefined)
      if (!target) throw new GuardError("Kein passender Commit")
      const view = await ctx.versions.commit(target.hash)
      return { message: `${target.hash} „${target.subject}“ wird per git revert zurückgenommen`, affected: view.entries.map((e) => ({ id: e.id, title: e.name, detail: `${e.status}, +${e.additions}/−${e.deletions}` })), data: view }
    },
    async run({ ctx, actor, session }, _run, a) {
      const r = await undoRun(ctx, a.run, actor, session)
      return { message: `${r.message}${r.commit ? ` (commit ${r.commit})` : ""}` }
    },
  }),
  defineAction({
    name: "session.review",
    label: "Session jetzt bewerten",
    area: "system",
    smith: "skillsmith",
    local: true,
    args: { session: { t: "string", max: 120 } },
    async run({ ctx }, _run, a) {
      if (!ctx.queue) throw new GuardError("Review-Queue nicht verfügbar")
      ctx.queue.enqueue(a.session, "manual", true)
      return { message: "Review eingeplant – läuft im Hintergrund" }
    },
  }),
  defineAction({
    name: "curator.run",
    label: "Curator",
    area: "system",
    smith: "skillsmith",
    local: true,
    readOnlySafe: false,
    args: { dry: { t: "boolean", optional: true } },
    async run({ ctx }, _run, a) {
      const c = ctx.curator
      if (!c) throw new GuardError("Curator nicht verfügbar")
      if (a.dry !== false) return { message: "Vorschau des Curators", data: { report: await c.dryRunReport() } }
      void (async () => {
        try {
          await c.lifecycle("web", true)
          ctx.toast(truncate(await c.consolidate("web"), 300), "info")
        } catch (err) {
          ctx.log.error("curator (web) failed", String(err))
        }
      })()
      return { message: "Curator gestartet (Lebenszyklus, Konsolidierung im Hintergrund)" }
    },
  }),
  defineAction({
    name: "doctor.run",
    label: "Doktor starten",
    area: "system",
    smith: "doctor",
    local: true,
    args: {},
    async run({ ctx }) {
      if (!ctx.doctor?.enabled) throw new GuardError("Der Doktor ist aus")
      void ctx.doctor.run("web").catch((err) => ctx.log.error("doctor (web) failed", String(err)))
      return { message: "Doktor gestartet" }
    },
  }),
  defineAction({
    name: "embeddings.sync",
    label: "Embeddings neu aufbauen",
    area: "system",
    smith: "skillsmith",
    local: true,
    args: {},
    async run({ ctx }) {
      if (!ctx.semantic) throw new GuardError("Semantische Suche ist aus")
      const n = await ctx.semantic.sync()
      const docs = (await ctx.projectDocs?.syncVectors()) ?? 0
      const hist = (await ctx.history?.syncVectors()) ?? 0
      return { message: `${n} Eintrag/Kandidat(en), ${docs} Doku-Abschnitt(e), ${hist} Session(s) eingebettet` }
    },
  }),
  defineAction({
    name: "system.lock",
    label: "Nur lesen für diese Sitzung",
    area: "system",
    smith: "skillsmith",
    local: true,
    readOnlySafe: true,
    args: { locked: { t: "boolean" } },
    async run({ ctx }, _run, a) {
      if (!a.locked && ctx.options.web.readOnly) throw new GuardError("web.readOnly ist in der Konfiguration gesetzt")
      sessionLock().locked = a.locked
      ctx.audit?.security(a.locked ? "lock" : "unlock", a.locked ? "Schreibaktionen bis zum Neustart gesperrt" : "Schreibaktionen wieder erlaubt", { result: "ok" })
      return { message: a.locked ? "Schreibaktionen sind bis zum Neustart gesperrt" : "Schreibaktionen wieder erlaubt" }
    },
  }),
  defineAction({
    name: "metrics.clear",
    label: "Metriken löschen",
    area: "system",
    smith: "skillsmith",
    local: true,
    strongToken: "tasks",
    args: { confirm: { t: "string", max: 40 } },
    async preview() {
      return { message: "Alle Metriken (Nutzung, Tokens, Tool-Aufrufe, Statistik) werden gelöscht; Audit-Log und Store bleiben", confirmName: "metriken löschen" }
    },
    async run({ ctx }, _run, a) {
      if (a.confirm !== "metriken löschen") throw new GuardError("Zur Bestätigung „metriken löschen“ eintippen")
      ctx.metrics?.clear()
      ctx.audit?.append({ actor: "user-web", category: "local", action: "metrics.clear", result: "ok", message: "Metriken gelöscht" })
      return { message: "Metriken gelöscht" }
    },
  }),
  defineAction({
    name: "feedback",
    label: "Feedback zu einer Änderung",
    area: "system",
    smith: "skillsmith",
    local: true,
    args: { seq: { t: "number", int: true, min: 1 }, good: { t: "boolean" }, note: { t: "string", max: 500, optional: true } },
    async run({ ctx }, _run, a) {
      const ev = ctx.audit?.query({ before: a.seq + 1, limit: 1 }).events[0]
      if (!ev || ev.seq !== a.seq) throw new GuardError("Ereignis nicht gefunden")
      ensureDir(ctx.store.stateDir)
      appendFileSync(join(ctx.store.stateDir, "feedback.jsonl"), JSON.stringify({ at: nowIso(), seq: a.seq, good: a.good, note: a.note, smith: ev.smith, action: ev.action, targets: ev.targets }) + "\n")
      ctx.metrics?.record({ type: a.good ? M.feedbackOk : M.feedbackIssue, entry: ev.targets[0] ?? "", origin: "web", extra: { source: "inbox", smith: ev.smith } })
      return { message: a.good ? "Danke – als gut vermerkt" : "Danke – als schlecht vermerkt" }
    },
  }),
  defineAction({
    name: "export.static",
    label: "Statischer Export",
    area: "system",
    smith: "docsmith",
    local: true,
    readOnlySafe: true,
    args: { format: { t: "enum", values: ["html", "md"] }, kinds: { t: "list", max: 4, item: 20, optional: true }, includePrivate: { t: "boolean", optional: true } },
    async run({ ctx }, _run, a) {
      const r = await exportStatic(ctx, { format: a.format, kinds: (a.kinds as string[] | undefined) ?? ["knowledge", "glossary"], includePrivate: !!a.includePrivate })
      return { message: `${r.count} Seite(n) exportiert nach ${r.dir}`, data: r }
    },
  }),
]

