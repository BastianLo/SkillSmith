/**
 * Read endpoints of the features since 5a, one small module per feature instead of a growing
 * switch in api.ts. Each endpoint gets the context and the query; it only reads.
 */
import { statSync } from "node:fs"
import { join, relative } from "node:path"
import type { Ctx } from "../core/context"
import { groupByRun, readLogs, tailLogs, type LogFilter } from "../core/logs"
import type { Level } from "../log"
import { LEVELS } from "../log"
import { liveTemplates } from "../core/library"

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

const statSize = (p: string) => {
  try {
    return statSync(p).size
  } catch {
    return 0
  }
}

const logDir = (ctx: Ctx) => join(ctx.store.stateDir, "log")

export const ENDPOINTS: Record<string, Endpoint> = {
  // office documents: entry, draft, templates
  "office/one": (ctx, q) => {
    const name = (q.get("id") ?? "").replace(/^office:/, "")
    const e = ctx.store.getOwned("office", name)
    if (!e) return { missing: true }
    const draft = ctx.office?.draft(name)
    return {
      id: `office:${name}`,
      name,
      title: e.title,
      description: e.description,
      tags: e.tags,
      tier: e.tier,
      version: e.version,
      fields: e.fields,
      text: e.body,
      draft: draft ? { ...draft, running: ctx.office?.isRunning(name) ?? false, stale: draft.baseVersion !== e.version } : undefined,
      aiEdit: ctx.options.office.aiEdit,
      skills: [...(ctx.options.office.skills[e.fields.format === "pptx" || e.fields.format === "potx" ? "pptx" : "docx"] ?? [])],
    }
  },
  "office/list": (ctx, q) => {
    const tier = q.get("tier") === "archive" ? "archive" : "active"
    return ctx.store
      .list("office")
      .filter((e) => e.tier === tier)
      .map((e) => {
        const d = ctx.office?.draft(e.name)
        return { id: `office:${e.name}`, name: e.name, title: e.title, description: e.description, tags: e.tags, format: e.fields.format, pages: e.fields.pages, size: e.fields.size, template: e.fields.template, ai: e.fields.ai, updatedAt: e.meta?.updatedAt, draft: d ? d.status : undefined }
      })
      .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
  },
  "office/templates": (ctx, q) => {
    const family = q.get("family")
    return (ctx.office?.templates(family === "pptx" || family === "docx" ? family : undefined) ?? []).map((e) => ({ id: `office:${e.name}`, title: e.title, format: e.fields.format }))
  },
  // skills that the PowerPoint/Word agents load completely with every AI edit
  "office/skills": (ctx) => {
    const skills = ctx.store
      .list("skill")
      .filter((e) => e.tier !== "archive" && e.fields.ai !== "privat")
      .map((e) => ({ name: e.name, description: e.description, tier: e.tier, files: ctx.store.supportFiles(e, 200).length }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const o = ctx.options.office
    return { pptx: [...o.skills.pptx], docx: [...o.skills.docx], maxChars: o.skillMaxChars, skills }
  },
  // files of a skill (references/…) and one file as text
  "skill/files": (ctx, q) => {
    const e = ctx.store.get("skill", (q.get("name") ?? "").replace(/^skill:/, ""))
    if (!e) return { missing: true }
    return { name: e.name, files: ctx.store.supportFiles(e, 200).map((f) => ({ path: relative(e.dir, f), size: statSize(f) })).sort((a, b) => a.path.localeCompare(b.path)) }
  },
  "skill/file": (ctx, q) => {
    const e = ctx.store.get("skill", (q.get("name") ?? "").replace(/^skill:/, ""))
    const path = (q.get("path") ?? "").replace(/^\.?\/+/, "")
    if (!e || !path || path.split("/").some((x) => x === ".." || x === "")) return { missing: true }
    if (!/\.(md|markdown|txt|json|ya?ml|csv|tsv|xml|html|css|svg|py|ts|js|mjs|sh|sql|toml|ini)$/i.test(path)) return { binary: true, path }
    const text = ctx.store.readFileOf(e, path)
    return text === undefined ? { missing: true } : { path, text }
  },
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
  // code anchors (5c): files with anchored knowledge, one file with its entries and status
  code: (ctx) => {
    if (!ctx.anchors) return { available: false, files: [] }
    const st = ctx.anchors.state()
    return { available: true, checkedAt: st.checkedAt ?? null, files: ctx.anchors.byFile() }
  },
  // cross-check and gym (5d)
  crosscheck: (ctx) => ({ enabled: ctx.options.crosscheck.enabled && !!ctx.options.crosscheck.model, model: ctx.options.crosscheck.model || null, stats: ctx.crosscheck?.stats() ?? [] }),
  gym: (ctx, q) => {
    if (!ctx.gym) return { available: false, tasks: [], rounds: [] }
    const entry = q.get("entry")
    const st = ctx.gym.state()
    const tasks = ctx.gym.tasks().filter((t) => !entry || t.entry === entry)
    const rounds = st.rounds.filter((r) => !entry || r.entry === entry).slice(-100).reverse()
    return { available: true, consequence: ctx.options.gym.consequence, tasks, rounds, suppressed: st.suppressed, archived: st.archived }
  },
  // document import (5h)
  imports: (ctx) => (ctx.importer?.list() ?? []).map((j) => ({ id: j.id, file: j.file, status: j.status, createdAt: j.createdAt, pages: j.pages.length, findings: j.findings.length, done: j.sections.filter((s) => s.done).length, total: j.sections.length, error: j.error ?? null })),
  "imports/one": (ctx, q) => {
    const j = ctx.importer?.get(q.get("id") ?? "")
    if (!j) return { found: false }
    return { found: true, ...j, changes: ctx.importer!.changes(j.id) }
  },
  // review knowledge (5f)
  reviews: (ctx) => {
    if (!ctx.reviews) return { available: false, candidates: [], rules: [] }
    const st = ctx.reviews.state()
    return {
      available: true,
      repos: ctx.options.reviews.repos,
      source: ctx.options.reviews.source,
      fetched: st.fetched,
      comments: Object.keys(st.comments).length,
      candidates: ctx.reviews.candidates().map((c) => ({ ...c, items: c.comments.map((id) => st.comments[id]).filter(Boolean).slice(0, 20) })),
      rules: ctx.reviews.rules(),
    }
  },
  // snippet and prompt library (5j)
  library: (ctx) => ({
    candidates: ctx.library?.candidates() ?? [],
    prompts: ctx.store.list("prompt").map((p) => ({ name: p.name, title: p.title, stats: ctx.library?.promptStats(p.name) ?? [] })),
  }),
  "library/live-templates": (ctx) => ({ xml: liveTemplates(ctx.store.list("snippet").filter((e) => e.tier === "active")) }),
  "code/file": (ctx, q) => {
    const path = q.get("path") ?? ""
    const project = q.get("project") || undefined
    const file = ctx.anchors?.byFile().find((f) => f.path === path && (!project || f.project === project))
    if (!file) return { path, project: project ?? null, entries: [] }
    const entries = file.entries.map((x) => {
      const status = ctx.anchors!.statusOf(x.id).find((s) => s.ref === x.ref)
      return { ...x, before: status?.before ?? null, after: status?.after ?? null, newPath: status?.newPath ?? null }
    })
    return { ...file, entries }
  },
}
