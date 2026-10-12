/** Shared end-of-run handling: git commit, journal entry, run cleanup. */
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import type { Run } from "../types"
import { ensureDir } from "../util/fs"
import { errorMessage, nowIso } from "../util/text"
import { auditActor, gateOf, type AuditInput } from "./audit"
import type { Ctx } from "./context"
import { actionLabel } from "./git"
import { M } from "./metrics"

export interface FinalizeResult {
  commit?: string
  applied: number
  proposed: number
}

export async function finalizeRun(ctx: Ctx, run: Run, outcome: { ok: boolean; error?: string }): Promise<FinalizeResult> {
  let commit: string | undefined
  try {
    commit = await ctx.git.commitRun(run)
  } catch (err) {
    ctx.log.error(`commit for ${run.id} failed`, errorMessage(err))
  } finally {
    ctx.store.unregisterRun(run)
  }
  const applied = run.actions.filter((a) => a.applied && a.kind !== "note").length
  const proposed = run.actions.filter((a) => !a.applied).length
  try {
    ensureDir(ctx.store.stateDir)
    appendFileSync(
      join(ctx.store.stateDir, "journal.jsonl"),
      JSON.stringify({
        at: nowIso(),
        run: run.id,
        smith: run.smith,
        actor: run.actor,
        trigger: run.trigger,
        writeMode: run.writeMode,
        session: run.sessionID,
        parent: run.parentSessionID,
        agent: run.sessionAgent,
        project: run.project,
        ok: outcome.ok,
        error: outcome.error,
        commit,
        summary: run.summary,
        actions: run.actions,
      }) + "\n",
    )
  } catch (err) {
    ctx.log.warn("journal write failed", errorMessage(err))
  }
  try {
    recordRun(ctx, run, outcome, commit)
  } catch (err) {
    ctx.log.warn("audit/metrics of run failed", errorMessage(err))
  }
  try {
    ctx.doctor?.onRunFinished(run)
  } catch (err) {
    ctx.log.debug("doctor queue failed", errorMessage(err))
  }
  ctx.runs.end(run)
  return { commit, applied, proposed }
}

/** Audit events (one per action, rejection and the run itself), metrics and a live event. */
function recordRun(ctx: Ctx, run: Run, outcome: { ok: boolean; error?: string }, commit: string | undefined): void {
  const actor = auditActor(run)
  const at = nowIso()
  const special = /^(undo|restore)\b/.exec(run.trigger.replace(/^web /, ""))?.[1] as "undo" | "restore" | undefined
  const base = {
    at,
    actor,
    agent: run.sessionAgent,
    model: run.model,
    session: run.sessionID,
    directory: run.directory,
    smith: run.smith,
    run: run.id,
    project: run.project,
  }
  const events: AuditInput[] = []
  const local = new Map((run.localChanges ?? []).map((c) => [c.id, c]))
  for (const a of run.actions) {
    if (a.kind === "note") continue
    // never write a target that cannot be resolved later ("undefined:undefined")
    if (a.local ? !a.name : !a.target || !a.name) continue
    const id = a.local ? a.name : `${a.target}:${a.name}`
    const change = a.local ? local.get(a.name) : undefined
    const after = !a.local && a.applied ? ctx.store.fresh(a.target, a.name)?.version : undefined
    events.push({
      ...base,
      category: a.local ? "local" : a.applied ? (special ?? "change") : a.stagedId ? "staged" : "proposed",
      action: a.kind,
      targets: [id],
      reason: a.reason,
      result: a.applied ? "ok" : a.stagedId ? "staged" : "proposed",
      message: a.detail,
      commit: a.local || !a.applied ? undefined : commit,
      afterHash: after,
      before: change?.before,
      after: change?.after,
    })
  }
  if (ctx.options.audit.logRejected) {
    for (const r of run.rejections ?? []) {
      events.push({ ...base, at: r.at, category: "rejected", action: r.tool ?? "tool", targets: r.target ? [r.target] : [], result: "rejected", message: r.message })
    }
  }
  events.push({
    ...base,
    category: special === "undo" ? "undo" : "run",
    action: `${run.smith}(${run.actor})`,
    reason: run.trigger,
    result: outcome.ok ? "ok" : "error",
    message: outcome.error ?? run.summary,
    commit,
  })
  const seqs = ctx.audit?.append(...events) ?? []
  // metrics
  const m = ctx.metrics
  if (m) {
    const origin = run.actor === "web" ? "web" : run.actor === "command" ? "system" : "background"
    const common = { session: run.sessionID, parent: run.parentSessionID, project: run.project, agent: run.sessionAgent, model: run.model, origin } as const
    m.record({ ...common, type: M.smithRun, entry: `smith:${run.smith}`, value: Date.now() - Date.parse(run.startedAt), extra: { ok: outcome.ok, actor: run.actor, applied: run.actions.filter((a) => a.applied).length, ...(outcome.ok ? {} : { error: true }) } })
    for (const a of run.actions) {
      if (!a.applied || a.kind === "note") continue
      m.record({ ...common, type: M.smithAction, entry: a.local ? a.name : `${a.target}:${a.name}`, extra: { action: a.kind, smith: run.smith } })
      if (run.smith === "errorsmith" && a.target === "error" && (a.kind === "create" || a.kind === "update")) m.record({ ...common, type: M.errorSolved, entry: `error:${a.name}` })
    }
    for (const r of run.rejections ?? []) m.record({ ...common, type: M.smithRejected, entry: `smith:${run.smith}`, extra: { gate: gateOf(r.message), tool: r.tool } })
  }
  ctx.bus?.emit("run.finished", {
    run: run.id,
    smith: run.smith,
    actor: run.actor,
    trigger: run.trigger,
    ok: outcome.ok,
    commit,
    audit: seqs[seqs.length - 1],
    targets: [...new Set(run.actions.filter((a) => a.applied).map((a) => (a.local ? a.name : `${a.target}:${a.name}`)))],
    summary: run.summary,
  })
}

export function describeActions(run: Run): string {
  const applied = run.actions.filter((a) => a.applied && a.kind !== "note")
  const staged = run.actions.filter((a) => !a.applied)
  const parts: string[] = []
  if (applied.length) parts.push([...new Set(applied.map((a) => actionLabel(a)))].join(", "))
  if (staged.length) parts.push(`${staged.length} ${run.writeMode === "shadow" ? "Vorschläge (shadow)" : "zur Freigabe"}`)
  return parts.join(" · ")
}
