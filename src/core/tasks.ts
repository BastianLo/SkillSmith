/**
 * Tasks and the Kanban board (kind "task", maintained by the user; memorysmith may only
 * suggest tasks in the first column). A column change is a real change (one commit, audit
 * event); the order inside a column is local (state/board.json) so re-sorting never commits.
 * Short ids (T-12) run across all projects.
 */
import { join } from "node:path"
import type { Entry, Run } from "../types"
import { readJson, writeJsonAtomic } from "../util/fs"
import { nowIso, oneLine, truncate } from "../util/text"
import type { Ctx } from "./context"
import { str, strArray } from "./frontmatter"
import { taskId, taskName, TASK_PRIORITIES } from "./kinds"
import { finalizeRun } from "./finalize"
import { M } from "./metrics"
import { GuardError } from "./ops"
import { LEGACY_STATUS } from "./workflow"

export interface ChecklistItem {
  line: number
  done: boolean
  text: string
  due?: string
}

export interface TaskView {
  id: string
  key: string
  name: string
  title: string
  description: string
  status: string
  priority: string
  labels: string[]
  due?: string
  parent?: string
  assignee?: string
  agent?: string
  model?: string
  project?: string
  branch?: string
  ticket?: string
  suggested: boolean
  own: boolean
  ai?: string
  tier: string
  version: string
  createdAt?: string
  updatedAt?: string
  children: string[]
  progress: { done: number; total: number }
  checklist: { done: number; total: number }
  links: number
  attachments: string[]
  /** last pipeline run of this task */
  pipeline?: { status: string; stages: Array<{ name: string; status: string }>; at?: string; run?: string }
  /** agent work on this task */
  agentStatus?: { status: string; label: string; job?: string }
  order: number
}

export interface TaskInput {
  title: string
  description?: string
  body?: string
  project?: string
  status?: string
  priority?: string
  labels?: unknown
  due?: string
  parent?: string
  assignee?: string
  branch?: string
  ticket?: string
  suggested?: boolean
  ai?: string
}

const CHECK_RE = /^(\s*)[-*]\s+\[( |x|X)\]\s+(.*)$/

export function checklistOf(body: string): ChecklistItem[] {
  const out: ChecklistItem[] = []
  const lines = body.split("\n")
  let inCode = false
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) inCode = !inCode
    if (inCode) return
    const m = CHECK_RE.exec(l)
    if (!m) return
    const due = /\(bis (\d{4}-\d{2}-\d{2})\)/.exec(m[3])?.[1]
    out.push({ line: i, done: m[2] !== " ", text: m[3].trim(), ...(due ? { due } : {}) })
  })
  return out
}

/** Toggle a checklist line (by line number); returns the new body. */
export function toggleChecklist(body: string, line: number, done: boolean): string {
  const lines = body.split("\n")
  const m = CHECK_RE.exec(lines[line] ?? "")
  if (!m) throw new GuardError("Diese Zeile ist kein Checklisten-Punkt (mehr) – bitte neu laden")
  lines[line] = lines[line].replace(/\[( |x|X)\]/, done ? "[x]" : "[ ]")
  return lines.join("\n")
}

export class Tasks {
  /** pipeline / agent status providers (set by the pipeline and agent-task modules) */
  pipelineStatus?: (name: string) => TaskView["pipeline"]
  agentStatus?: (name: string) => TaskView["agentStatus"]

  constructor(private ctx: Ctx) {}

  private get boardFile(): string {
    return join(this.ctx.store.stateDir, "board.json")
  }

  columns(project?: string): string[] {
    return this.ctx.projects.columns(project)
  }

  isDone(status: string, project?: string): boolean {
    const cols = this.columns(project)
    return status === cols[cols.length - 1]
  }

  /** Board order (local): "project|column" → task names. */
  private order(): Record<string, string[]> {
    return readJson<Record<string, string[]>>(this.boardFile, {})
  }

  view(e: Entry, all?: Entry[]): TaskView {
    const f = e.fields
    const list = all ?? this.ctx.store.list("task")
    const children = list.filter((t) => taskName(str(t.fields.parent)) === e.name)
    const done = children.filter((c) => this.isDone(str(c.fields.status), str(c.fields.project) || undefined)).length
    const cl = checklistOf(e.body)
    const project = str(f.project) || undefined
    const status = str(f.status) || this.columns(project)[0]
    const orderKey = `${project ?? ""}|${status}`
    const pos = this.order()[orderKey]?.indexOf(e.name) ?? -1
    return {
      id: str(f.id) || taskId(e.name),
      key: `task:${e.name}`,
      name: e.name,
      title: e.title,
      description: e.description,
      status,
      priority: str(f.priority) || "normal",
      labels: e.tags,
      due: str(f.due) || undefined,
      parent: str(f.parent) ? taskId(taskName(str(f.parent))) : undefined,
      assignee: str(f.assignee) || undefined,
      agent: str(f.agent) || undefined,
      model: str(f.model) || undefined,
      project,
      branch: str(f.branch) || undefined,
      ticket: str(f.ticket) || undefined,
      suggested: f.suggested === true,
      own: str(f.author) === "user" || str(f.created_by) === "user" || e.meta?.createdBy === "web" || e.meta?.createdBy === "command",
      ai: str(f.ai) || undefined,
      tier: e.tier,
      version: e.version,
      createdAt: e.meta?.createdAt,
      updatedAt: e.meta?.updatedAt,
      children: children.map((c) => str(c.fields.id) || taskId(c.name)),
      progress: { done, total: children.length },
      checklist: { done: cl.filter((c) => c.done).length, total: cl.length },
      links: this.ctx.links.outgoingOf(`task:${e.name}`).filter((l) => l.id).length + this.ctx.links.backlinksOf(`task:${e.name}`).length,
      attachments: strArray(f.attachments),
      pipeline: this.pipelineStatus?.(e.name),
      agentStatus: this.agentStatus?.(e.name),
      order: pos < 0 ? Number.MAX_SAFE_INTEGER : pos,
    }
  }

  list(filter: { project?: string; includeArchived?: boolean } = {}): TaskView[] {
    const all = this.ctx.store.list("task")
    return all
      .filter((e) => filter.includeArchived || e.tier === "active")
      .filter((e) => !filter.project || filter.project === "*" || str(e.fields.project) === filter.project || (filter.project === "-" && !str(e.fields.project)))
      .map((e) => this.view(e, all))
      .sort((a, b) => a.order - b.order || prioRank(b.priority) - prioRank(a.priority) || Number(a.id.slice(2)) - Number(b.id.slice(2)))
  }

  get(idOrName: string): Entry | undefined {
    const n = taskName(idOrName.replace(/^task:/i, ""))
    return this.ctx.store.getOwned("task", n)
  }

  require(idOrName: string): Entry {
    const e = this.get(idOrName)
    if (!e) throw new GuardError(`Aufgabe ${idOrName} nicht gefunden`)
    return e
  }

  private depth(name: string): number {
    let d = 0
    let cur = this.get(name)
    const seen = new Set<string>()
    while (cur && str(cur.fields.parent) && !seen.has(cur.name)) {
      seen.add(cur.name)
      d++
      cur = this.get(str(cur.fields.parent))
    }
    return d
  }

  /** Next short id (tracked counter, never below the highest existing id). */
  private async nextName(run: Run): Promise<string> {
    const prefix = this.ctx.options.tasks.idPrefix
    const existing = this.ctx.store.list("task").map((e) => Number(/-(\d+)$/.exec(e.name)?.[1] ?? 0))
    const max = Math.max(0, ...existing)
    const next = await this.ctx.store.updateTracked<{ next: number }>(run, "tasks/.counter.json", { next: 1 }, (cur) => ({ next: Math.max(cur.next ?? 1, max + 1) + 1 }))
    return `${prefix.toLowerCase()}-${next.next - 1}`
  }

  async create(run: Run, input: TaskInput): Promise<Entry> {
    const title = oneLine(input.title ?? "")
    if (!title) throw new GuardError("Titel fehlt")
    const project = input.project ? input.project.replace(/^project:/, "") : undefined
    if (project && !this.ctx.projects.get(project)) throw new GuardError(`Projekt „${project}“ nicht gefunden`)
    const cols = this.columns(project)
    const status = input.status && cols.includes(input.status) ? input.status : cols[0]
    if (input.suggested && status !== cols[0]) throw new GuardError("Vorschläge landen immer in der ersten Spalte")
    let parent: string | undefined
    if (input.parent) {
      const p = this.require(input.parent)
      if (this.depth(p.name) + 1 >= this.ctx.options.tasks.maxDepth) throw new GuardError(`Unteraufgaben höchstens ${this.ctx.options.tasks.maxDepth} Ebenen tief (tasks.maxDepth)`)
      parent = str(p.fields.id) || taskId(p.name)
    }
    const name = await this.nextName(run)
    const priority = (TASK_PRIORITIES as readonly string[]).includes(String(input.priority)) ? String(input.priority) : "normal"
    if (input.due && !/^\d{4}-\d{2}-\d{2}$/.test(input.due)) throw new GuardError("Fälligkeit als JJJJ-MM-TT")
    const fields: Record<string, unknown> = {
      id: taskId(name),
      status,
      priority,
      ...(input.due ? { due: input.due } : {}),
      ...(parent ? { parent } : {}),
      ...(input.assignee ? { assignee: input.assignee } : {}),
      ...(project ? { project } : {}),
      ...(input.branch ? { branch: oneLine(input.branch) } : {}),
      ...(input.ticket ? { ticket: oneLine(input.ticket) } : {}),
      ...(input.suggested ? { suggested: true, author: "agent" } : { author: "user", created_by: "user" }),
      ai: input.ai ?? (input.suggested ? "frei" : this.ctx.options.docs.defaultAiAccess),
    }
    await this.ctx.ops.create(run, "task", {
      name,
      title,
      description: oneLine(input.description ?? ""),
      tags: input.labels,
      fields,
      body: input.body ?? "",
      reason: input.suggested ? "Vorschlag von memorysmith" : "neue Aufgabe",
      approved: true,
    })
    this.ctx.metrics?.record({ type: M.taskCreate, entry: `task:${name}`, origin: run.actor === "web" ? "web" : "system", project, extra: { suggested: !!input.suggested } })
    this.ctx.bus.emit("task.changed", { task: name, action: "create", project })
    return this.ctx.store.getOwned("task", name)!
  }

  /**
   * Move a card to another column. Checks: column exists, WIP limit, open subtasks before
   * the last column (warning unless forced), red pipeline before done (pipeline.requireGreen).
   */
  async move(run: Run, idOrName: string, to: string, opts: { force?: boolean; base?: string; position?: number; agent?: boolean } = {}): Promise<{ warnings: string[]; entry: Entry }> {
    const e = this.require(idOrName)
    const project = str(e.fields.project) || undefined
    const cols = this.columns(project)
    if (!cols.includes(to)) throw new GuardError(`Spalte „${to}“ gibt es nicht (${cols.join(", ")})`)
    const from = str(e.fields.status) || cols[0]
    const warnings: string[] = []
    if (opts.agent && this.isDone(to, project)) throw new GuardError("„erledigt“ setzt nur der Nutzer")
    if (from !== to) {
      const wip = this.ctx.projects.get(project ?? "")?.wip[to] ?? this.ctx.options.tasks.wipLimits[to]
      if (wip) {
        const inCol = this.list({ project: project ?? "-" }).filter((t) => t.status === to).length
        if (inCol >= wip) {
          if (!opts.force) throw new ConfirmNeeded(`WIP-Limit von „${to}“ erreicht (${inCol}/${wip})`)
          warnings.push(`WIP-Limit überschritten (${inCol + 1}/${wip})`)
        }
      }
      if (this.isDone(to, project)) {
        const v = this.view(e)
        const open = v.progress.total - v.progress.done
        if (open > 0) {
          if (!opts.force) throw new ConfirmNeeded(`${open} Unteraufgabe(n) noch offen`)
          warnings.push(`${open} Unteraufgabe(n) offen`)
        }
        const green = this.ctx.options.pipeline.requireGreen
        if (green !== "off" && v.pipeline && v.pipeline.status === "failed") {
          if (green === "block") throw new GuardError("Pipeline ist rot – „erledigt“ ist gesperrt (pipeline.requireGreen: block)")
          if (!opts.force) throw new ConfirmNeeded("Pipeline ist rot")
          warnings.push("trotz roter Pipeline")
        }
      }
    }
    if (from !== to) {
      const fields: Record<string, unknown> = { ...e.fields, status: to }
      if (e.fields.suggested && to !== cols[0]) fields.suggested = undefined
      await this.ctx.ops.update(run, "task", { name: e.name, fields, reason: `${from} → ${to}${warnings.length ? ` (${warnings.join("; ")})` : ""}`, approved: true, baseVersion: opts.base }, "update")
      const since = lastMoveAt(e) ?? e.meta?.createdAt
      this.ctx.metrics?.record({
        type: M.taskMove,
        entry: `task:${e.name}`,
        origin: run.actor === "web" ? "web" : opts.agent ? "background" : "system",
        project,
        value: since ? Date.now() - Date.parse(since) : undefined,
        extra: { from, to, done: this.isDone(to, project) },
      })
    }
    this.place(e.name, project, to, opts.position)
    this.ctx.bus.emit("task.changed", { task: e.name, action: "move", from, to, project })
    // the project's pipeline runs when a card enters a trigger column (agent tasks run it before)
    const def = project ? this.ctx.projects.get(project)?.pipeline : undefined
    if (from !== to && !opts.agent && def?.stages.length && def.trigger.includes(to)) {
      const workdir = str(e.fields.worktree) || undefined
      void this.ctx.pipeline
        .start({ project: project!, task: e.name, trigger: "column", by: run.actor === "web" ? "user-web" : "user-command", workdir, branch: str(e.fields.branch) || undefined })
        .catch((err) => this.ctx.log.warn("pipeline start failed", String(err)))
      warnings.push("Pipeline gestartet")
    }
    return { warnings, entry: this.ctx.store.getOwned("task", e.name)! }
  }

  /** Local position inside a column (no commit). */
  place(name: string, project: string | undefined, column: string, position?: number): void {
    const order = this.order()
    for (const k of Object.keys(order)) order[k] = order[k].filter((n) => n !== name)
    const key = `${project ?? ""}|${column}`
    const list = order[key] ?? this.list({ project: project ?? "-" }).filter((t) => t.status === column && t.name !== name).map((t) => t.name)
    const pos = position === undefined || position < 0 || position > list.length ? list.length : position
    list.splice(pos, 0, name)
    order[key] = list
    for (const k of Object.keys(order)) if (!order[k].length) delete order[k]
    writeJsonAtomic(this.boardFile, order)
  }

  async update(run: Run, idOrName: string, patch: Partial<TaskInput> & { title?: string; body?: string }, base?: string): Promise<Entry> {
    const e = this.require(idOrName)
    const fields: Record<string, unknown> = { ...e.fields }
    // Ops merges fields onto the stored ones: "" removes a field (empty values are not written)
    const set = (k: string, v: unknown) => {
      if (v === undefined) return
      fields[k] = v === null ? "" : v
    }
    if (patch.priority !== undefined && !(TASK_PRIORITIES as readonly string[]).includes(String(patch.priority))) throw new GuardError(`Priorität: ${TASK_PRIORITIES.join(", ")}`)
    if (patch.due && !/^\d{4}-\d{2}-\d{2}$/.test(patch.due)) throw new GuardError("Fälligkeit als JJJJ-MM-TT")
    if (patch.project !== undefined && patch.project && !this.ctx.projects.get(patch.project)) throw new GuardError(`Projekt „${patch.project}“ nicht gefunden`)
    if (patch.parent) {
      const p = this.require(patch.parent)
      if (p.name === e.name) throw new GuardError("Eine Aufgabe kann nicht ihre eigene Unteraufgabe sein")
      if (this.depth(p.name) + 1 >= this.ctx.options.tasks.maxDepth) throw new GuardError(`Unteraufgaben höchstens ${this.ctx.options.tasks.maxDepth} Ebenen tief`)
      patch.parent = str(p.fields.id) || taskId(p.name)
    }
    set("priority", patch.priority)
    set("due", patch.due)
    set("parent", patch.parent)
    set("assignee", patch.assignee)
    set("project", patch.project)
    set("branch", patch.branch === undefined ? undefined : oneLine(patch.branch))
    set("ticket", patch.ticket === undefined ? undefined : oneLine(patch.ticket))
    set("ai", patch.ai)
    if (patch.status !== undefined && patch.status !== str(e.fields.status)) throw new GuardError("Spaltenwechsel über „verschieben“")
    await this.ctx.ops.update(
      run,
      "task",
      {
        name: e.name,
        title: patch.title !== undefined ? oneLine(patch.title) : undefined,
        description: patch.description !== undefined ? oneLine(patch.description) : undefined,
        tags: patch.labels,
        fields,
        body: patch.body,
        reason: "Aufgabe bearbeitet",
        approved: true,
        baseVersion: base,
      },
      "update",
    )
    this.ctx.bus.emit("task.changed", { task: e.name, action: "update", project: str(fields.project) || undefined })
    return this.ctx.store.getOwned("task", e.name)!
  }

  /** Checklist item → subtask (the line becomes a link to the new task). */
  async checklistToSubtask(run: Run, idOrName: string, line: number): Promise<Entry> {
    const e = this.require(idOrName)
    const item = checklistOf(e.body).find((c) => c.line === line)
    if (!item) throw new GuardError("Checklisten-Punkt nicht gefunden – bitte neu laden")
    const sub = await this.create(run, { title: truncate(item.text.replace(/\(bis \d{4}-\d{2}-\d{2}\)/, "").trim(), 160), parent: str(e.fields.id) || taskId(e.name), project: str(e.fields.project) || undefined, due: item.due, branch: str(e.fields.branch) || undefined })
    const lines = e.body.split("\n")
    lines[line] = lines[line].replace(/[-*]\s+\[( |x|X)\]\s+.*$/, `- [[task:${str(sub.fields.id)}|${item.text.replace(/[[\]|]/g, " ").trim()}]]`)
    await this.ctx.ops.update(run, "task", { name: e.name, body: lines.join("\n"), reason: `Unteraufgabe ${str(sub.fields.id)} aus Checkliste`, approved: true }, "update")
    return sub
  }

  /**
   * Open checklist items of documents and open items of work states (shown on the board,
   * filterable by due date; a click turns them into a task, ticking writes back).
   */
  looseItems(project?: string): Array<{ source: string; title: string; line?: number; index?: number; text: string; done: boolean; due?: string; project?: string; branch?: string }> {
    const out: Array<{ source: string; title: string; line?: number; index?: number; text: string; done: boolean; due?: string; project?: string; branch?: string }> = []
    for (const e of this.ctx.store.list("knowledge")) {
      if (e.tier !== "active") continue
      for (const c of checklistOf(e.body)) if (!c.done) out.push({ source: `knowledge:${e.name}`, title: e.title, line: c.line, text: c.text, done: false, due: c.due })
    }
    const scope = (() => {
      try {
        return this.ctx.scope()
      } catch {
        return undefined
      }
    })()
    for (const s of this.ctx.mem?.states(project ? undefined : scope?.project) ?? []) {
      if (s.status !== "gueltig") continue
      s.open.forEach((text, index) => out.push({ source: s.id, title: `Arbeitsstand ${s.ticket || s.branch}`, index, text, done: false, project: s.projectName, branch: s.branch }))
    }
    return out
  }

  /** Tick a checklist item of a document (commit) or a work state's open item (local). */
  async tickLoose(run: Run, source: string, ref: number, done = true): Promise<string> {
    if (source.startsWith("knowledge:")) {
      const name = source.slice(10)
      const e = this.ctx.store.getOwned("knowledge", name)
      if (!e) throw new GuardError("Dokument nicht gefunden")
      const body = toggleChecklist(e.body, ref, done)
      await this.ctx.ops.update(run, "knowledge", { name, body, reason: done ? "Punkt abgehakt" : "Punkt wieder offen", approved: true })
      return `${e.title}: Punkt ${done ? "abgehakt" : "wieder offen"}`
    }
    if (source.startsWith("state:")) {
      const mem = this.ctx.mem
      const st = mem?.getState(source)
      if (!mem || !st) throw new GuardError("Arbeitsstand nicht gefunden")
      const item = st.open[ref]
      if (item === undefined) throw new GuardError("Punkt nicht gefunden – bitte neu laden")
      const before = { ...st, history: undefined }
      const open = st.open.filter((_, i) => i !== ref)
      const doneList = done ? [...st.done, item] : st.done
      mem.upsertState({ project: st.project, projectName: st.projectName, branch: st.branch, ticket: st.ticket, goal: st.goal, done: doneList, open, next: st.next, files: st.files, summary: st.summary, evidence: st.evidence, session: st.session, run: run.id })
      run.actions.push({ kind: "state", target: "memory", name: st.id, reason: `erledigt: ${truncate(item, 120)}`, applied: true, local: true })
      ;(run.localChanges ??= []).push({ id: st.id, before, after: { ...mem.getState(st.id), history: undefined } })
      return `Arbeitsstand: „${truncate(item, 80)}“ erledigt`
    }
    throw new GuardError("unbekannte Quelle")
  }
}

/**
 * Boards of 3.x had the columns eingeplant / in_umsetzung; 4.x plans in „planung“ and
 * implements in „umsetzung“. Tasks whose status is no column of their board any more move
 * to the column that does the same work – once, in one run (commit).
 */
export async function migrateTaskColumns(ctx: Ctx): Promise<number> {
  const moves: Array<{ e: Entry; to: string; from: string }> = []
  for (const e of ctx.store.list("task")) {
    const project = str(e.fields.project) || undefined
    const cols = ctx.tasks.columns(project)
    const status = str(e.fields.status)
    if (!status || cols.includes(status)) continue
    const to = LEGACY_STATUS[status]
    if (to && cols.includes(to)) moves.push({ e, to, from: status })
  }
  if (!moves.length) return 0
  const run = ctx.runs.create({ smith: "memorysmith", actor: "command", trigger: "migrate task columns", writeMode: "auto", directory: ctx.directory, project: ctx.project, limits: { maxNew: 0, maxChanges: 100_000, maxNotes: 0 } })
  run.subject = `memorysmith(command): migrate ${moves.length} task column(s)`
  for (const m of moves) await ctx.ops.update(run, "task", { name: m.e.name, fields: { ...m.e.fields, status: m.to }, reason: `Spalte ${m.from} → ${m.to} (Board 4.0)`, approved: true })
  await finalizeRun(ctx, run, { ok: true })
  return moves.length
}

/** Needs an explicit confirmation by the user (WIP limit, open subtasks, red pipeline). */
export class ConfirmNeeded extends GuardError {}

function prioRank(p: string): number {
  return Math.max(0, (TASK_PRIORITIES as readonly string[]).indexOf(p))
}

function lastMoveAt(e: Entry): string | undefined {
  const h = [...(e.meta?.history ?? [])].reverse().find((x) => / → /.test(x.reason ?? ""))
  return h?.at
}

export function nowDate(): string {
  return nowIso().slice(0, 10)
}
