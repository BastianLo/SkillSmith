/**
 * Statistics tab: overview, knowledge, hints, errors, smiths and costs, tools and MCPs,
 * times of day, tasks, pipeline, agents. Everything reads the metrics database
 * (daily sums for long ranges, raw events for percentiles) and a few store facts.
 */
import type { Ctx } from "../core/context"
import { str } from "../core/frontmatter"
import { spec } from "../core/kinds"
import { M, percentile, USE_TYPES, weekOf } from "../core/metrics"
import { localDay } from "../core/sqlite"
import type { Kind } from "../types"
import { KINDS } from "../types"

const DAY = 86_400_000

function window(days: number, now = Date.now()): { from: number; to: number; prevFrom: number; fromDay: string; toDay: string; prevFromDay: string; prevToDay: string } {
  const to = now
  const from = now - days * DAY
  return { from, to, prevFrom: from - days * DAY, fromDay: localDay(from + DAY), toDay: localDay(to), prevFromDay: localDay(from - days * DAY + DAY), prevToDay: localDay(from) }
}

const sumOf = (m: Map<string, Record<string, number>>, type: string, filter?: (entry: string) => boolean) => {
  let n = 0
  for (const [e, r] of m) if (!filter || filter(e)) n += r[type] ?? 0
  return n
}

export function statsOverview(ctx: Ctx, days: number, project?: string): Record<string, unknown> {
  const m = ctx.metrics
  const w = window(days)
  const kpi = (from: number, to: number) => {
    const t = m?.windowTotals([M.hintFollowed, M.hintShown, M.errorSolved, M.reply, M.toolCall, M.smithRun], from, to) ?? {}
    const audit = ctx.audit?.query({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), category: ["change"], limit: 5000 }).events ?? []
    return {
      sessions: m?.distinctSessions(from, to) ?? 0,
      hintsFollowed: t[M.hintFollowed]?.n ?? 0,
      hintsShown: t[M.hintShown]?.n ?? 0,
      created: audit.filter((e) => e.action === "create" || e.action === "upsert").length,
      changed: audit.filter((e) => e.action !== "create" && e.action !== "upsert").length,
      errorsSolved: t[M.errorSolved]?.n ?? 0,
      tokens: Math.round(t[M.reply]?.sum ?? 0),
      cost: Math.round((t[M.reply]?.sum2 ?? 0) * 100) / 100,
      toolCalls: t[M.toolCall]?.n ?? 0,
      smithRuns: t[M.smithRun]?.n ?? 0,
    }
  }
  return {
    available: !!m,
    days,
    project: project ?? null,
    current: kpi(w.from, w.to),
    previous: kpi(w.prevFrom, w.from),
    calendar: m?.calendar(365) ?? [],
    series: m?.series({ types: [M.userMessage, M.load, M.hintFollowed, M.toolCall], days }) ?? null,
  }
}

export function statsKnowledge(ctx: Ctx, days: number): Record<string, unknown> {
  const m = ctx.metrics
  const w = window(days)
  const cur = m?.totalsBetween([...USE_TYPES], w.fromDay, w.toDay) ?? new Map()
  const prev = m?.totalsBetween([...USE_TYPES], w.prevFromDay, w.prevToDay) ?? new Map()
  const uses = (r?: Record<string, number>) => (r ? USE_TYPES.reduce((n, t) => n + (r[t] ?? 0), 0) : 0)
  const label = (id: string) => {
    const i = id.indexOf(":")
    const e = i > 0 && (KINDS as string[]).includes(id.slice(0, i)) ? ctx.store.getOwned(id.slice(0, i) as Kind, id.slice(i + 1)) : undefined
    return { id, title: e?.title ?? id, kind: id.slice(0, i), tier: e?.tier ?? null }
  }
  const top = [...cur.entries()]
    .map(([id, r]) => ({ ...label(id), uses: uses(r), prev: uses(prev.get(id)) }))
    .filter((x) => x.uses > 0)
    .sort((a, b) => b.uses - a.uses)
    .slice(0, 20)
  const all = new Set([...cur.keys(), ...prev.keys()])
  const deltas = [...all].map((id) => ({ ...label(id), uses: uses(cur.get(id)), prev: uses(prev.get(id)) })).map((x) => ({ ...x, delta: x.uses - x.prev }))
  const risers = deltas.filter((x) => x.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 10)
  const fallers = deltas.filter((x) => x.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 10)
  const usedEver = m?.totalsByEntry([...USE_TYPES], 0) ?? new Map()
  const used90 = m?.totalsByEntry([...USE_TYPES], 90) ?? new Map()
  const unused: Array<Record<string, unknown>> = []
  for (const kind of ["skill", "knowledge", "error", "script", "memory"] as Kind[]) {
    for (const e of ctx.store.list(kind)) {
      if (e.tier !== "active") continue
      const id = `${kind}:${e.name}`
      if (uses(used90.get(id)) === 0) unused.push({ id, title: e.title, kind, never: uses(usedEver.get(id)) === 0, createdAt: e.meta?.createdAt ?? null })
    }
  }
  // growth per kind: created per week (store meta)
  const weeks = [...new Set(Array.from({ length: Math.ceil(Math.max(days, 28) / 7) }, (_, i) => weekOf(localDay(Date.now() - i * 7 * DAY))))].reverse()
  const growth: Record<string, number[]> = {}
  for (const kind of KINDS) {
    const arr = new Array(weeks.length).fill(0)
    for (const e of ctx.store.list(kind)) {
      const c = e.meta?.createdAt
      if (!c) continue
      const i = weeks.indexOf(weekOf(localDay(Date.parse(c))))
      if (i >= 0) arr[i]++
    }
    growth[kind] = arr
  }
  return { available: !!m, top, risers, fallers, unused: unused.slice(0, 200), growth: { weeks, series: growth, labels: Object.fromEntries(KINDS.map((k) => [k, spec(k).labelPlural])) } }
}

export function statsHints(ctx: Ctx, days: number): Record<string, unknown> {
  const m = ctx.metrics
  const w = window(days)
  const t = m?.totalsBetween([M.hintShown, M.hintFollowed, M.hintHelped, M.hintFailed], w.fromDay, w.toDay) ?? new Map()
  const perKind = KINDS.filter((k) => k !== "project").map((k) => {
    const shown = sumOf(t, M.hintShown, (e) => e.startsWith(`${k}:`))
    const followed = sumOf(t, M.hintFollowed, (e) => e.startsWith(`${k}:`))
    return { kind: k, label: spec(k).labelPlural, shown, followed, rate: shown ? Math.round((followed / shown) * 1000) / 10 : null }
  })
  const series = m?.series({ types: [M.hintShown, M.hintFollowed], days, bucket: days > 60 ? "week" : "day" }) ?? null
  const compute = m?.rows([M.hintCompute], w.from, w.to) ?? []
  const ms = compute.map((r) => r.value ?? 0).sort((a, b) => a - b)
  const semantic = compute.filter((r) => r.extra?.semantic === true).length
  const noEffect = [...t.entries()]
    .filter(([, r]) => (r[M.hintShown] ?? 0) >= 5 && !(r[M.hintFollowed] ?? 0))
    .map(([id, r]) => {
      const i = id.indexOf(":")
      const e = ctx.store.getOwned(id.slice(0, i) as Kind, id.slice(i + 1))
      return { id, title: e?.title ?? id, shown: r[M.hintShown] ?? 0 }
    })
    .sort((a, b) => b.shown - a.shown)
    .slice(0, 20)
  return {
    available: !!m,
    perKind,
    series,
    compute: { n: compute.length, p50: percentile(ms, 50), p95: percentile(ms, 95), semanticShare: compute.length ? Math.round((semantic / compute.length) * 100) : null, shownShare: compute.length ? Math.round((compute.filter((r) => r.extra?.shown).length / compute.length) * 100) : null },
    errorHints: { helped: sumOf(t, M.hintHelped), failed: sumOf(t, M.hintFailed) },
    noEffect,
    thresholds: { minScore: ctx.options.hints.minScore, hintMinSimilarity: ctx.options.embedding.hintMinSimilarity, max: ctx.options.hints.max },
  }
}

export function statsErrors(ctx: Ctx, days: number): Record<string, unknown> {
  const m = ctx.metrics
  const w = window(days)
  const occ = ctx.occurrences.all()
  const rows = m?.rows([M.errorOccurrence], w.from, w.to) ?? []
  const bySig = new Map<string, { n: number; sessions: Set<string>; projects: Set<string> }>()
  for (const r of rows) {
    const g = bySig.get(r.entry) ?? { n: 0, sessions: new Set(), projects: new Set() }
    g.n++
    if (r.session) g.sessions.add(r.session)
    if (r.project) g.projects.add(r.project)
    bySig.set(r.entry, g)
  }
  const top = [...bySig.entries()]
    .map(([sig, g]) => {
      const o = occ[sig.replace(/^sig:/, "")]
      return { sig, signature: o?.signature ?? sig, n: g.n, sessions: g.sessions.size, entry: o?.entry ? `error:${o.entry}` : null, tool: o?.tool ?? null }
    })
    .sort((a, b) => b.n - a.n)
    .slice(0, 20)
  // recurring although documented as solved
  const recurring = Object.values(occ)
    .filter((o) => o.entry && Date.parse(o.lastSeen) >= w.from)
    .map((o) => {
      const e = ctx.store.getOwned("error", o.entry!)
      return { o, e }
    })
    .filter(({ o, e }) => e && str(e.fields.status) === "solved" && e.meta?.createdAt && o.lastSeen > e.meta.createdAt)
    .map(({ o, e }) => ({ id: `error:${e!.name}`, title: e!.title, count: o.count, sessions: o.sessions.length, lastSeen: o.lastSeen }))
    .slice(0, 20)
  // time from first occurrence to the documented solution
  const solveTimes: Array<{ id: string; title: string; days: number }> = []
  for (const e of ctx.store.list("error")) {
    const sigs = ((e.fields.signatures as string[]) ?? []).map((s) => s)
    const first = Object.values(occ)
      .filter((o) => sigs.includes(o.signature) || o.entry === e.name)
      .map((o) => Date.parse(o.firstSeen))
      .sort((a, b) => a - b)[0]
    if (first && e.meta?.createdAt && str(e.fields.status) === "solved") solveTimes.push({ id: `error:${e.name}`, title: e.title, days: Math.max(0, Math.round(((Date.parse(e.meta.createdAt) - first) / DAY) * 10) / 10) })
  }
  const hints = m?.totalsBetween([M.hintHelped, M.hintFailed], w.fromDay, w.toDay, "error:") ?? new Map()
  const perProject = new Map<string, number>()
  for (const r of rows) perProject.set(r.project ?? "?", (perProject.get(r.project ?? "?") ?? 0) + 1)
  return {
    available: !!m,
    top,
    recurring,
    solveTimes: solveTimes.sort((a, b) => b.days - a.days).slice(0, 20),
    medianSolveDays: percentile(solveTimes.map((x) => x.days).sort((a, b) => a - b), 50),
    liveHints: { helped: sumOf(hints, M.hintHelped), failed: sumOf(hints, M.hintFailed) },
    perProject: [...perProject.entries()].map(([project, n]) => ({ project, n })).sort((a, b) => b.n - a.n),
    series: m?.series({ types: [M.errorOccurrence, M.errorSolved], days }) ?? null,
  }
}

export function statsSmiths(ctx: Ctx, days: number): Record<string, unknown> {
  const m = ctx.metrics
  const w = window(days)
  const runs = m?.grouped(M.smithRun, "entry", w.from, w.to) ?? []
  const replies = (m?.rows([M.reply], w.from, w.to) ?? []).filter((r) => r.origin === "background")
  const tokens = new Map<string, { smith: string; model: string; tokens: number; cost: number; n: number }>()
  for (const r of replies) {
    const k = `${r.entry}|${r.model ?? "?"}`
    const g = tokens.get(k) ?? { smith: r.entry.replace(/^smith:/, ""), model: r.model ?? "?", tokens: 0, cost: 0, n: 0 }
    g.tokens += r.value ?? 0
    g.cost += r.value2 ?? 0
    g.n++
    tokens.set(k, g)
  }
  const rejected = new Map<string, { gate: string; n: number; smiths: Set<string> }>()
  for (const r of m?.rows([M.smithRejected], w.from, w.to) ?? []) {
    const gate = String(r.extra?.gate ?? "?")
    const g = rejected.get(gate) ?? { gate, n: 0, smiths: new Set() }
    g.n++
    g.smiths.add(r.entry.replace(/^smith:/, ""))
    rejected.set(gate, g)
  }
  const waits = (m?.rows([M.queueWait], w.from, w.to) ?? []).map((r) => r.value ?? 0).sort((a, b) => a - b)
  const verdicts = m?.grouped(M.doctorVerdict, "entry", w.from, w.to) ?? []
  return {
    available: !!m,
    runs: runs.map((g) => ({ smith: g.key.replace(/^smith:/, ""), n: g.n, errors: g.errors, p50: g.p50, p95: g.p95 })),
    tokens: [...tokens.values()].map((g) => ({ ...g, cost: Math.round(g.cost * 10000) / 10000 })).sort((a, b) => b.tokens - a.tokens),
    costPerDay: m?.series({ types: [M.reply], days, field: "sum2", bucket: "day" }) ?? null,
    tokensPerDay: m?.series({ types: [M.reply], days, field: "sum", bucket: "day" }) ?? null,
    rejected: [...rejected.values()].map((g) => ({ gate: g.gate, n: g.n, smiths: [...g.smiths] })).sort((a, b) => b.n - a.n),
    rejectedAudit: ctx.audit?.rejectedByReason(days) ?? [],
    queueWait: { n: waits.length, p50: percentile(waits, 50), p95: percentile(waits, 95) },
    verdicts: verdicts.map((g) => ({ verdict: g.key.replace(/^verdict:/, ""), n: g.n })),
  }
}

export function statsTools(ctx: Ctx, days: number, tool?: string): Record<string, unknown> {
  const m = ctx.metrics
  const w = window(days)
  const groups = m?.grouped(M.toolCall, "entry", w.from, w.to, "tool:") ?? []
  const out: Record<string, unknown> = {
    available: !!m,
    enabled: ctx.options.metrics.toolCalls,
    tools: groups.map((g) => ({ tool: g.key.replace(/^tool:/, ""), n: g.n, errors: g.errors, errorRate: g.n ? Math.round((g.errors / g.n) * 1000) / 10 : 0, p50: g.p50, p95: g.p95, mcp: !/^(bash|read|write|edit|glob|grep|list|task|webfetch|todowrite|todoread|patch|multiedit|skill|lsp_\w+)$/.test(g.key.replace(/^tool:/, "")) })),
  }
  if (tool) {
    const entry = `tool:${tool}`
    out.series = m?.series({ entry, types: [M.toolCall], days }) ?? null
    const rows = (m?.events({ entry, types: [M.toolCall], from: w.from, limit: 20_000 }) ?? []).reverse()
    const byDay = new Map<string, { n: number; errors: number; ms: number[] }>()
    for (const r of rows) {
      const d = localDay(r.at)
      const g = byDay.get(d) ?? { n: 0, errors: 0, ms: [] }
      g.n++
      if (r.extra?.error) g.errors++
      if (r.value !== undefined) g.ms.push(r.value)
      byDay.set(d, g)
    }
    out.daily = [...byDay.entries()].map(([day, g]) => ({ day, n: g.n, errors: g.errors, p50: percentile(g.ms.sort((a, b) => a - b), 50), p95: percentile(g.ms, 95) }))
    out.recent = rows.slice(-50).reverse().map((r) => ({ at: r.at, session: r.session, agent: r.agent, origin: r.origin, ms: r.value, error: !!r.extra?.error }))
  }
  return out
}

export function statsTasks(ctx: Ctx, days: number, project?: string): Record<string, unknown> {
  const m = ctx.metrics
  const w = window(days)
  const moves = (m?.rows([M.taskMove, M.taskCreate], w.from - 365 * DAY, w.to) ?? []).filter((r) => !project || r.project === project)
  const tasks = ctx.tasks.list({ project: project ?? "*", includeArchived: true })
  const cols = ctx.tasks.columns(project)
  const done = cols[cols.length - 1]
  const lead: number[] = []
  const cycle: number[] = []
  const throughput = new Map<string, number>()
  for (const t of tasks) {
    const own = moves.filter((r) => r.entry === t.key)
    const doneAt = own.filter((r) => r.type === M.taskMove && r.extra?.to === done).pop()?.at
    if (!doneAt || doneAt < w.from) continue
    const created = Date.parse(t.createdAt ?? "") || own.find((r) => r.type === M.taskCreate)?.at
    const started = own.find((r) => r.type === M.taskMove && (r.extra?.to === "in_umsetzung" || r.extra?.to === cols[2]))?.at
    if (created) lead.push((doneAt - created) / DAY)
    if (started) cycle.push((doneAt - started) / DAY)
    const wk = weekOf(localDay(doneAt))
    throughput.set(wk, (throughput.get(wk) ?? 0) + 1)
  }
  // cumulative flow: tasks per column at the end of each day
  const dayList: string[] = []
  for (let i = Math.min(days, 90) - 1; i >= 0; i--) dayList.push(localDay(Date.now() - i * DAY))
  const cfd: Record<string, number[]> = Object.fromEntries(cols.map((c) => [c, new Array(dayList.length).fill(0)]))
  for (const t of tasks) {
    const created = Date.parse(t.createdAt ?? "")
    const own = moves.filter((r) => r.entry === t.key && r.type === M.taskMove).sort((a, b) => a.at - b.at)
    dayList.forEach((d, i) => {
      const end = Date.parse(`${d}T23:59:59`)
      if (created && created > end) return
      const last = own.filter((r) => r.at <= end).pop()
      const col = last ? String(last.extra?.to ?? "") : own.length ? String(own[0].extra?.from ?? cols[0]) : t.status
      if (cfd[col]) cfd[col][i]++
    })
  }
  const sorted = (a: number[]) => [...a].sort((x, y) => x - y)
  return {
    available: !!m,
    columns: cols,
    leadDays: { n: lead.length, p50: Math.round(percentile(sorted(lead), 50) * 10) / 10, p95: Math.round(percentile(sorted(lead), 95) * 10) / 10 },
    cycleDays: { n: cycle.length, p50: Math.round(percentile(sorted(cycle), 50) * 10) / 10, p95: Math.round(percentile(sorted(cycle), 95) * 10) / 10 },
    throughput: [...throughput.entries()].sort().map(([week, n]) => ({ week, n })),
    cfd: { days: dayList, series: cfd },
  }
}

export function statsPipeline(ctx: Ctx, days: number, project?: string): Record<string, unknown> {
  const w = window(days)
  const runs = ctx.pipeline.runs(project, 5000).filter((r) => Date.parse(r.queuedAt) >= w.from)
  const perProject = new Map<string, { n: number; green: number }>()
  const stages = new Map<string, Map<string, number[]>>()
  for (const r of runs) {
    const g = perProject.get(r.project) ?? { n: 0, green: 0 }
    if (r.status === "success" || r.status === "failed" || r.status === "timeout") {
      g.n++
      if (r.status === "success") g.green++
    }
    perProject.set(r.project, g)
    for (const s of r.stages) {
      if (s.ms === undefined) continue
      const wk = weekOf(localDay(Date.parse(r.queuedAt)))
      const byWeek = stages.get(s.name) ?? new Map<string, number[]>()
      ;(byWeek.get(wk) ?? byWeek.set(wk, []).get(wk)!).push(s.ms)
      stages.set(s.name, byWeek)
    }
  }
  return {
    projects: [...perProject.entries()].map(([p, g]) => ({ project: p, runs: g.n, green: g.green, rate: g.n ? Math.round((g.green / g.n) * 1000) / 10 : null })),
    stages: [...stages.entries()].map(([name, byWeek]) => ({ name, weeks: [...byWeek.entries()].sort().map(([week, ms]) => ({ week, p50: percentile([...ms].sort((a, b) => a - b), 50), n: ms.length })) })),
    flaky: ctx.pipeline.flaky(project).slice(0, 30),
    recent: runs.slice(0, 30).map((r) => ({ id: r.id, project: r.project, task: r.task, status: r.status, ms: r.ms, at: r.queuedAt, tests: r.tests ? { total: r.tests.total, failed: r.tests.failures + r.tests.errors } : null })),
  }
}

export function statsAgents(ctx: Ctx, days: number): Record<string, unknown> {
  const w = window(days)
  const proposals = ctx.metrics?.rows([M.agentProposal], w.from, w.to) ?? []
  const verdicts = new Map<string, { approved: number; revise: number; created: number }>()
  for (const r of proposals) {
    const k = r.agent ?? "?"
    const g = verdicts.get(k) ?? { approved: 0, revise: 0, created: 0 }
    const v = String(r.extra?.verdict ?? "")
    if (v === "approved") g.approved++
    else if (v === "revise") g.revise++
    else if (v === "created") g.created++
    verdicts.set(k, g)
  }
  return { agents: ctx.agentTasks.stats(days), verdicts: [...verdicts.entries()].map(([agent, g]) => ({ agent, ...g })) }
}

export function statsEvents(ctx: Ctx, q: { type?: string; entry?: string; day?: string; prefix?: string; limit?: number }): unknown[] {
  const m = ctx.metrics
  if (!m) return []
  const from = q.day ? Date.parse(`${q.day}T00:00:00`) : Date.now() - 30 * DAY
  const to = q.day ? from + DAY : Date.now()
  return m.events({ types: q.type ? [q.type] : undefined, entry: q.entry, prefix: q.prefix, from, to, limit: Math.min(2000, q.limit ?? 300) })
}

/** Usage of one entry: stacked series, recent uses, users, success figure, relevance curve. */
export function entryUsage(ctx: Ctx, id: string, days: number): Record<string, unknown> {
  const m = ctx.metrics
  const kind = id.slice(0, id.indexOf(":"))
  const types = [M.load, M.hintFollowed, M.scriptRun, M.hintHelped, M.hintShown, M.view]
  const totals = m?.totals(id) ?? {}
  const u = ctx.usage.all()[id]
  let success: { label: string; value: number | null; detail: string } | null = null
  if (kind === "skill") {
    const ok = totals[M.feedbackOk] ?? 0
    const bad = totals[M.feedbackIssue] ?? 0
    success = { label: "Einsätze ohne Probleme", value: ok + bad ? Math.round((ok / (ok + bad)) * 100) : null, detail: `${ok} von ${ok + bad} bewerteten Einsätzen` }
  } else if (kind === "script") {
    const runs = m?.events({ entry: id, types: [M.scriptRun], limit: 1000 }) ?? []
    const okRuns = runs.filter((r) => (r.value ?? 0) === 0).length
    const ms = runs.map((r) => Number(r.extra?.ms ?? 0)).filter(Boolean).sort((a, b) => a - b)
    success = { label: "Läufe mit Exit-Code 0", value: runs.length ? Math.round((okRuns / runs.length) * 100) : null, detail: `${okRuns} von ${runs.length} · Laufzeit Median ${Math.round(percentile(ms, 50))} ms` }
  } else if (kind === "error") {
    const h = totals[M.hintHelped] ?? u?.helped ?? 0
    const f = totals[M.hintFailed] ?? u?.failed ?? 0
    success = { label: "Hinweis half", value: h + f ? Math.round((h / (h + f)) * 100) : null, detail: `${h}× geholfen, ${f}× nicht` }
  } else {
    const shown = totals[M.hintShown] ?? u?.hintsShown ?? 0
    const followed = totals[M.hintFollowed] ?? u?.hintsFollowed ?? 0
    success = { label: "Hinweis befolgt", value: shown ? Math.round((followed / shown) * 100) : null, detail: `${followed} von ${shown} Hinweisen` }
  }
  return {
    available: !!m,
    days,
    series: m?.series({ entry: id, types, days }) ?? null,
    totals,
    recent: (m?.events({ entry: id, types, limit: 30 }) ?? []).map((r) => ({ at: r.at, type: r.type, session: r.session, project: r.project, agent: r.agent, origin: r.origin })),
    users: m?.usersOf(id, days) ?? null,
    success,
    curve: ctx.relevance.curve(id),
    usageFile: u ?? null,
  }
}
