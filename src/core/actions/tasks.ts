/** Board, task, project and pipeline actions (step 4e). */
import { oneLine, slugify, truncate } from "../../util/text"
import { str } from "../frontmatter"
import { taskId, TASK_PRIORITIES } from "../kinds"
import { GuardError } from "../ops"
import { expandPath, normalizePipeline } from "../projects"
import { versionOf } from "./index"
import type { ActionDef } from "./types"
import { defineAction } from "./types"
import { requireEntry } from "./util"

const taskArgs = {
  title: { t: "string", max: 160, optional: true },
  description: { t: "string", max: 300, optional: true },
  body: { t: "string", multiline: true, max: 2_000_000, optional: true },
  project: { t: "string", max: 64, optional: true },
  priority: { t: "enum", values: TASK_PRIORITIES, optional: true },
  labels: { t: "list", max: 12, item: 40, optional: true },
  due: { t: "string", pattern: /^(\d{4}-\d{2}-\d{2})?$/, optional: true },
  parent: { t: "string", max: 20, optional: true },
  assignee: { t: "enum", values: ["ich", "agent", ""], optional: true },
  branch: { t: "string", max: 200, optional: true },
  ticket: { t: "string", max: 60, optional: true },
} as const

const name = (target: string) => target.replace(/^task:/i, "").toLowerCase()

export const TASK_ACTIONS: ActionDef[] = [
  defineAction({
    name: "task.create",
    label: "Aufgabe anlegen",
    area: "aufgabe",
    smith: "memorysmith",
    args: { ...taskArgs, title: { t: "string", max: 160, min: 1 }, status: { t: "string", max: 40, optional: true } },
    async run({ ctx }, run, a) {
      const e = await ctx.tasks.create(run, { ...a, labels: a.labels, assignee: a.assignee || undefined })
      const id = str(e.fields.id)
      return { message: `${id} angelegt`, target: `task:${e.name}`, data: { id } }
    },
  }),
  defineAction({
    name: "task.update",
    label: "Aufgabe bearbeiten",
    area: "aufgabe",
    smith: "memorysmith",
    args: { target: { t: "id" }, ...taskArgs },
    version: ({ ctx }, a) => versionOf(ctx, a.target),
    async run({ ctx }, run, a) {
      const { target, ...patch } = a
      const e = await ctx.tasks.update(run, name(target), { ...patch, labels: patch.labels })
      return { message: `${str(e.fields.id)} gespeichert`, target }
    },
  }),
  defineAction({
    name: "task.move",
    label: "Spalte wechseln",
    area: "aufgabe",
    smith: "memorysmith",
    args: { target: { t: "id" }, to: { t: "string", max: 40 }, position: { t: "number", int: true, min: 0, optional: true }, force: { t: "boolean", optional: true } },
    async run({ ctx }, run, a) {
      const r = await ctx.tasks.move(run, name(a.target), a.to, { force: a.force, position: a.position })
      return { message: `${str(r.entry.fields.id)} → ${a.to}`, target: a.target, warnings: r.warnings }
    },
  }),
  defineAction({
    name: "task.reorder",
    label: "In der Spalte umsortieren",
    area: "aufgabe",
    smith: "memorysmith",
    local: true,
    args: { target: { t: "id" }, position: { t: "number", int: true, min: 0 } },
    async run({ ctx }, _run, a) {
      const e = requireEntry(ctx, a.target)
      ctx.tasks.place(e.name, str(e.fields.project) || undefined, str(e.fields.status), a.position)
      ctx.bus.emit("task.changed", { task: e.name, action: "order" })
      return { message: "umsortiert (lokal, ohne Commit)" }
    },
  }),
  defineAction({
    name: "task.subtask",
    label: "Unteraufgabe anlegen",
    area: "aufgabe",
    smith: "memorysmith",
    args: { target: { t: "id" }, title: { t: "string", max: 160, min: 1 } },
    async run({ ctx }, run, a) {
      const p = requireEntry(ctx, a.target)
      const e = await ctx.tasks.create(run, { title: a.title, parent: str(p.fields.id), project: str(p.fields.project) || undefined, branch: str(p.fields.branch) || undefined, ticket: str(p.fields.ticket) || undefined })
      return { message: `${str(e.fields.id)} als Unteraufgabe von ${str(p.fields.id)}`, target: `task:${e.name}` }
    },
  }),
  defineAction({
    name: "task.fromChecklist",
    label: "Checklistenpunkt umwandeln",
    area: "aufgabe",
    smith: "memorysmith",
    args: { target: { t: "id" }, line: { t: "number", int: true, min: 0 } },
    async run({ ctx }, run, a) {
      const sub = await ctx.tasks.checklistToSubtask(run, name(a.target), a.line)
      return { message: `${str(sub.fields.id)} angelegt`, target: a.target }
    },
  }),
  defineAction({
    name: "task.fromLoose",
    label: "Als Aufgabe übernehmen",
    area: "aufgabe",
    smith: "memorysmith",
    args: { source: { t: "string", max: 200 }, ref: { t: "number", int: true, min: 0 }, project: { t: "string", max: 64, optional: true } },
    async run({ ctx }, run, a) {
      const item = ctx.tasks.looseItems().find((x) => x.source === a.source && (x.line === a.ref || x.index === a.ref))
      if (!item) throw new GuardError("Punkt nicht gefunden – bitte neu laden")
      const project = a.project ?? ctx.projects.forDirectory(ctx.directory)?.name
      const e = await ctx.tasks.create(run, { title: truncate(item.text.replace(/\(bis \d{4}-\d{2}-\d{2}\)/, "").trim(), 160), due: item.due, branch: item.branch, project, body: `Aus [[${a.source.startsWith("knowledge:") ? a.source.slice(10) : a.source}]] übernommen.` })
      return { message: `${str(e.fields.id)} angelegt`, target: `task:${e.name}` }
    },
  }),
  defineAction({
    name: "task.acceptSuggestion",
    label: "Vorschlag einplanen",
    area: "aufgabe",
    smith: "memorysmith",
    args: { target: { t: "id" } },
    async run({ ctx }, run, a) {
      const e = requireEntry(ctx, a.target)
      const cols = ctx.tasks.columns(str(e.fields.project) || undefined)
      const r = await ctx.tasks.move(run, e.name, cols[1] ?? cols[0], { force: true })
      return { message: `${str(r.entry.fields.id)} eingeplant`, target: a.target }
    },
  }),
  defineAction({
    name: "task.dismissSuggestion",
    label: "Vorschlag verwerfen",
    area: "aufgabe",
    smith: "memorysmith",
    args: { target: { t: "id" } },
    async run({ ctx }, run, a) {
      const e = requireEntry(ctx, a.target)
      await ctx.store.move(run, "task", e.name, "archive", "archive", "Vorschlag verworfen")
      run.actions.push({ kind: "archive", target: "task", name: e.name, reason: "Vorschlag verworfen", applied: true })
      ctx.bus.emit("task.changed", { task: e.name, action: "archive" })
      return { message: `${str(e.fields.id)} verworfen (archiviert)` }
    },
  }),
  defineAction({
    name: "project.save",
    label: "Projekt speichern",
    area: "projekt",
    smith: "memorysmith",
    args: {
      name: { t: "string", max: 64, optional: true },
      title: { t: "string", max: 120, min: 1 },
      description: { t: "string", max: 300, optional: true },
      home_path: { t: "string", max: 500, optional: true },
      agent: { t: "string", max: 80, optional: true },
      model: { t: "string", max: 200, optional: true },
      color: { t: "string", max: 20, optional: true },
      columns: { t: "list", max: 12, item: 31, optional: true },
      wip: { t: "object", optional: true },
      pipeline: { t: "object", optional: true },
      aliases: { t: "list", max: 10, item: 60, optional: true },
      body: { t: "string", multiline: true, max: 200_000, optional: true },
    },
    // changing pipeline commands always needs the token (pipeline.requireToken) – checked by the server
    strongToken: ({ ctx }, a) => {
      const existing = a.name ? ctx.projects.get(a.name) : undefined
      let next: string
      try {
        next = JSON.stringify(normalizePipeline(a.pipeline, a.columns?.length ? a.columns : ctx.options.tasks.columns)?.stages ?? [])
      } catch {
        return "pipeline"
      }
      return JSON.stringify(existing?.pipeline?.stages ?? []) !== next ? "pipeline" : undefined
    },
    async preview({ ctx }, a) {
      const existing = a.name ? ctx.projects.get(a.name) : undefined
      const columns = a.columns?.length ? a.columns : ctx.options.tasks.columns
      const pipeline = normalizePipeline(a.pipeline, columns)
      const before = existing?.pipeline?.stages.map((s) => `${s.name}: ${s.run}`) ?? []
      const after = pipeline?.stages.map((s) => `${s.name}: ${s.run}`) ?? []
      return { message: existing ? "Projekt ändern" : "Projekt anlegen", data: { before, after, home: a.home_path ? expandPath(a.home_path) : undefined } }
    },
    async run({ ctx }, run, a) {
      const columns = a.columns?.length ? a.columns : undefined
      if (columns) for (const c of columns) if (!/^[a-z][a-z0-9_]{0,30}$/.test(c)) throw new GuardError(`Spalten-Id „${c}“ ungültig (a-z, 0-9, _)`)
      const pipeline = normalizePipeline(a.pipeline, columns ?? ctx.options.tasks.columns)
      const wip: Record<string, number> = {}
      for (const [k, v] of Object.entries((a.wip as Record<string, unknown>) ?? {})) if (Number(v) > 0) wip[k] = Math.round(Number(v))
      const fields = {
        home_path: a.home_path?.trim() ?? "",
        agent: a.agent ?? "",
        model: a.model ?? "",
        color: a.color ?? "",
        columns: columns ?? [],
        wip,
        pipeline: pipeline ?? "",
        aliases: a.aliases ?? [],
        author: "user",
        ai: "lesen",
      }
      const existing = a.name ? ctx.store.fresh("project", a.name) : undefined
      if (existing) {
        await ctx.ops.update(run, "project", { name: existing.name, title: oneLine(a.title), description: oneLine(a.description ?? ""), fields: { ...existing.fields, ...fields }, body: a.body, reason: "Projekt bearbeitet", approved: true })
        return { message: `Projekt „${a.title}“ gespeichert`, target: `project:${existing.name}` }
      }
      const pname = a.name?.trim() || slugify(a.title, 40)
      if (!pname) throw new GuardError("Projektname fehlt")
      if (ctx.store.fresh("project", pname)) throw new GuardError(`Projekt „${pname}“ gibt es schon`)
      await ctx.ops.create(run, "project", { name: pname, title: oneLine(a.title), description: oneLine(a.description ?? ""), fields, body: a.body ?? "", reason: "neues Projekt", approved: true })
      return { message: `Projekt „${a.title}“ angelegt`, target: `project:${pname}`, open: `#/projekt/${pname}` }
    },
  }),
  defineAction({
    name: "pipeline.start",
    label: "Pipeline starten",
    area: "projekt",
    smith: "memorysmith",
    local: true,
    args: { project: { t: "string", max: 64 }, task: { t: "string", max: 40, optional: true } },
    async run({ ctx, actor }, _run, a) {
      const task = a.task ? requireEntry(ctx, `task:${name(a.task)}`) : undefined
      const job = task ? ctx.agentTasks.ofTask(task.name) : undefined
      const workdir = (task && str(task.fields.worktree)) || (job && job.workplace === "worktree" ? job.workdir : undefined)
      void ctx.pipeline.start({ project: a.project, task: task?.name, trigger: "manual", by: actor === "web" ? "user-web" : "user-command", workdir: workdir || undefined, branch: task ? str(task.fields.branch) || undefined : undefined }).catch((err) => ctx.log.warn("pipeline failed", String(err)))
      const queued = ctx.pipeline.runs(a.project, 1)[0]
      return { message: `Pipeline gestartet${task ? ` für ${taskId(task.name)}` : ""}`, data: { run: queued?.id }, open: queued ? `#/pipeline/${a.project}/${queued.id}` : undefined }
    },
  }),
  defineAction({
    name: "pipeline.abort",
    label: "Pipeline abbrechen",
    area: "projekt",
    smith: "memorysmith",
    local: true,
    args: { project: { t: "string", max: 64 }, run: { t: "string", max: 60 } },
    async run({ ctx }, _run, a) {
      if (!ctx.pipeline.abort(a.project, a.run)) throw new GuardError("Lauf nicht aktiv")
      return { message: "Pipeline wird abgebrochen" }
    },
  }),
]
