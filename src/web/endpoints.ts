/**
 * Read endpoints of the features since 5a, one small module per feature instead of a growing
 * switch in api.ts. Each endpoint gets the context and the query; it only reads.
 */
import { join } from "node:path"
import type { Ctx } from "../core/context"
import { groupByRun, readLogs, tailLogs, type LogFilter } from "../core/logs"
import type { Level } from "../log"
import { LEVELS } from "../log"

export type Endpoint = (ctx: Ctx, q: URLSearchParams) => unknown | Promise<unknown>

const int = (v: string | null, def: number, min: number, max: number) => Math.min(max, Math.max(min, Number(v) || def))

function logFilter(q: URLSearchParams): LogFilter {
  const level = q.get("level") as Level | null
  return {
    from: q.get("from") ?? undefined,
    to: q.get("to") ?? undefined,
    level: level && LEVELS.includes(level) ? level : undefined,
    areas: q.get("areas") ? q.get("areas")!.split(",").filter(Boolean) : undefined,
    run: q.get("run") ?? undefined,
    session: q.get("session") ?? undefined,
    job: q.get("job") ?? undefined,
    cid: q.get("cid") ?? undefined,
    text: q.get("text") ?? undefined,
    limit: int(q.get("limit"), 500, 1, 5000),
  }
}

const logDir = (ctx: Ctx) => join(ctx.store.stateDir, "log")

export const ENDPOINTS: Record<string, Endpoint> = {
  // settings page
  settings: (ctx) => {
    if (!ctx.settings) return { unavailable: true }
    return ctx.settings.view()
  },
  // log tab
  logs: (ctx, q) => {
    const r = readLogs(logDir(ctx), logFilter(q))
    return q.get("group") === "run" ? { ...r, groups: groupByRun(r.lines), lines: [] } : r
  },
  "logs/tail": (ctx, q) => tailLogs(logDir(ctx), q.get("cursor") ?? "", logFilter(q)),
  // jobs page
  scheduled: (ctx) => ({ available: !!ctx.jobs, jobs: ctx.jobs?.list() ?? [] }),
  "scheduled/history": (ctx, q) => ctx.jobs?.history(q.get("id") ?? "") ?? [],
}
