/**
 * Phase-4 services of a plugin instance: audit log, metrics, versions, relevance and the
 * live event bus. Created the same way by the host adapter and the unit tests.
 */
import { AgentTasks } from "./agent-tasks"
import { Anchors } from "./anchors"
import { QualityEngine } from "./quality"
import { AuditLog } from "./audit"
import { EventBus } from "./bus"
import type { Ctx } from "./context"
import { M, type MetricOrigin, Metrics } from "./metrics"
import { LinkIndex } from "./links"
import { Pipeline } from "./pipeline"
import { Projects } from "./projects"
import { Tasks } from "./tasks"
import { RelevanceEngine } from "./relevance"
import type { DatabaseClass } from "./sqlite"
import { Versions } from "./versions"
import { Settings } from "./settings"

/** Use types that only count for the session that used the entry (background agents never count as use). */
const USE_ONLY = new Set<string>([M.load, M.hintShown, M.hintFollowed, M.hintHelped, M.hintFailed, M.scriptRun, M.view])

export function attachServices(ctx: Ctx, Database?: DatabaseClass, rawOptions: unknown = {}): void {
  ctx.bus = new EventBus()
  ctx.settings = new Settings(ctx, rawOptions)
  ctx.links = new LinkIndex(ctx.store, () => ctx.options.tasks.idPrefix)
  ctx.graph.links = ctx.links
  ctx.projects = new Projects(ctx.store, ctx.options)
  ctx.tasks = new Tasks(ctx)
  ctx.pipeline = new Pipeline(ctx)
  ctx.tasks.pipelineStatus = (name) => ctx.pipeline.badge(name)
  ctx.agentTasks = new AgentTasks(ctx)
  ctx.anchors = new Anchors(ctx)
  ctx.ops.setAnchorPin((text, previous, repin) => ctx.anchors!.pin(text, previous, repin))
  ctx.quality = new QualityEngine(ctx)
  ctx.tasks.agentStatus = (name) => ctx.agentTasks.statusOf(name)
  ctx.audit = new AuditLog(ctx.store.stateDir, ctx.options, ctx.log.child("audit"), Database)
  if (!ctx.audit.available) ctx.audit = undefined
  const metrics = ctx.options.metrics.enabled ? new Metrics(ctx.store.stateDir, ctx.options, ctx.log.child("metrics"), Database) : undefined
  ctx.metrics = metrics?.available ? metrics : undefined
  ctx.versions = new Versions(ctx.store, ctx.git)
  ctx.relevance = new RelevanceEngine(ctx.options, ctx.usage, ctx.metrics, ctx.mem)
  ctx.usage.sink = (type, entry, uc) => {
    const m = ctx.metrics
    if (!m) return
    const who = sessionInfo(ctx, uc.session, uc.origin, uc.agent)
    if (who.origin === "background" && USE_ONLY.has(type)) return
    m.record({ type, entry, ...who, project: ctx.project, branch: branchOf(ctx), value: uc.value, extra: uc.extra })
  }
  if (ctx.semantic) {
    ctx.semantic.privateEmbeddings = ctx.options.docs.privateEmbeddings
    ctx.semantic.client.onCall = (ms, texts, ok, mode) => ctx.metrics?.record({ type: M.embedCall, entry: `embed:${mode}`, origin: "system", value: ms, extra: { texts, ...(ok ? {} : { error: true }) } })
  }
  ctx.occurrences.sink = (sigKey, session, entry, tool) => {
    const who = sessionInfo(ctx, session)
    ctx.metrics?.record({ type: M.errorOccurrence, entry: `sig:${sigKey}`, ...who, project: ctx.project, extra: { tool, ...(entry ? { known: `error:${entry}` } : {}) } })
  }
}

/** origin, parent and agent of a session (background agent run, subagent or main session). */
export function sessionInfo(ctx: Ctx, session?: string, origin?: MetricOrigin, agent?: string): { session?: string; parent?: string; agent?: string; origin?: MetricOrigin; model?: string } {
  if (!session) return { origin: origin ?? "system", agent }
  const run = ctx.runs.forAgentSession(session)
  if (run) return { session, origin: "background", agent: `${run.smith}`, model: run.model }
  const st = ctx.sessions.peek(session)
  const parent = st?.parentID ?? undefined
  const model = st?.model ? `${st.model.providerID}/${st.model.modelID}` : undefined
  return { session, parent, origin: origin ?? (parent ? "subagent" : "main"), agent: agent ?? st?.agent, model }
}

export function branchOf(ctx: Ctx): string | undefined {
  try {
    return ctx.scope().branch || undefined
  } catch {
    return undefined
  }
}

/** Startup housekeeping of the phase-4 stores (once per process start; retention is the job "prune"). */
export function startupServices(ctx: Ctx): { journal: number; baseline: number } {
  const journal = ctx.audit?.importJournal() ?? 0
  ctx.audit?.repairTargets()
  const baseline = ctx.metrics?.importUsageBaseline() ?? 0
  ctx.pipeline.markInterrupted()
  if (ctx.agentTasks.active().length) ctx.agentTasks.start()
  return { journal, baseline }
}

export async function closeServices(ctx: Ctx): Promise<void> {
  ctx.agentTasks?.stop()
  await ctx.metrics?.flush().catch(() => {})
  ctx.metrics?.close()
  ctx.audit?.close()
}
