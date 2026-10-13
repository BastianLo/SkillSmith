/**
 * Agent tasks (5b): a card runs through the columns of the board, every column with a step
 * and an agent (workflow.ts): planning → gate 1 → implementation (+ pipeline) → test cases →
 * verification → gate 2 (acceptance by the user). A failed test or criterion sends the card
 * back to the implementation; after `maxLoops` back jumps it halts and asks the user.
 *
 *  - assign: brief from the task (description, subtasks, linked entries, project rules,
 *    learned rules, similar finished tasks, criteria and test cases), own git worktree below
 *    the state directory (or the home_path itself).
 *  - every step runs in an opencode session of the column's agent; planning and implementation
 *    of the same agent share one session (context), test and verification start fresh.
 *  - write tools are only allowed in the implementation – enforced for the whole session
 *    tree by the hub guard (tool.execute.before), never by prompt `tools` (opencode would keep
 *    them as session permissions).
 *  - the plugin writes plan, criteria, test results and the verification report into the task
 *    (one run, one commit each); agents never write tasks and never set "done".
 *
 * Jobs are local data (state/agent-jobs); every step is an audit event and a log line with
 * the job id. Agent sessions are normal opencode sessions and can be opened in the terminal.
 */
import { join } from "node:path"
import { parseModel } from "../config"
import { withLogContext } from "../log"
import type { Entry, Run } from "../types"
import { ensureDir, exists, listFiles, readJson, removePath, writeJsonAtomic } from "../util/fs"
import { diffLines, diffStats, parseUnifiedDiff, toHunks, type FileDiff } from "../util/diff"
import { errorMessage, escapeRegExp, nowIso, oneLine, shortId, slugify, truncate } from "../util/text"
import { agentHub, guardSession, unguardJob, type HubListener } from "./agent-hub"
import { unwrap } from "./agent-runner"
import { checkDiff, diffText, findingsOf, fixPrompt, implementPrompt, parseProposal, planPrompt, revisePrompt, testPrompt, verifyPrompt, type Finding, type Proposal } from "./agent-steps"
import type { Ctx } from "./context"
import { finalizeRun } from "./finalize"
import { str } from "./frontmatter"
import { gitIn } from "./git"
import type { InboxItem } from "./inbox"
import { spec, taskId } from "./kinds"
import { M } from "./metrics"
import { agentModelSpec, chooseModel, configModelSpec, matchModel, modelCatalog, ModelChoiceError, modelErrorHint, specOf } from "./models"
import { notify } from "./notify"
import { GuardError } from "./ops"
import { expandPath } from "./projects"
import { isSmithAgent } from "./prompts"
import { lastModel } from "./state"
import { criteriaOf, fieldsMarkdown, jsonBlock, parseTestResults, testcasesOf, type Criterion, type TestCase, type TestResult, type Verdict } from "./task-fields"
import { columnOfStep, resolveFlows, STEP_LABEL, type ColumnFlow, type StepKind } from "./workflow"

export type { Finding, Proposal } from "./agent-steps"
export { checkDiff, parseFindings, parseProposal } from "./agent-steps"

type AnyRecord = Record<string, any>

export type JobPhase = "starting" | "working" | "checking" | "waiting" | "halted" | "accepted" | "discarded" | "aborted" | "error"
/** what a waiting job waits for: plan approval (gate 1), another gate, acceptance (gate 2), manual tests, a manual column */
export type WaitingFor = "plan" | "gate" | "accept" | "tests" | "manual"

const FINAL = new Set<JobPhase>(["accepted", "discarded", "aborted", "error"])

const STEP_DOING: Record<StepKind, string> = { plan: "plant", implement: "setzt um", test: "testet", verify: "verifiziert" }
const WAIT_LABEL: Record<WaitingFor, string> = { plan: "wartet auf Freigabe des Plans", gate: "wartet auf Freigabe", accept: "fertig – bitte abnehmen", tests: "wartet auf manuelle Tests", manual: "wartet (Spalte ohne Agent)" }

export function phaseLabel(j: Pick<AgentJob, "phase" | "step" | "waitingFor" | "loops">): string {
  switch (j.phase) {
    case "starting":
      return "startet"
    case "working":
      return j.step ? STEP_DOING[j.step] : "arbeitet"
    case "checking":
      return "Prüfbefehle laufen"
    case "waiting":
      return WAIT_LABEL[j.waitingFor ?? "gate"]
    case "halted":
      return `angehalten nach ${j.loops} Rücksprüngen`
    case "accepted":
      return "abgenommen"
    case "discarded":
      return "verworfen"
    case "aborted":
      return "abgebrochen"
    case "error":
      return "Fehler"
  }
}

export interface SessionInfo {
  id: string
  parent?: string
  agent?: string
  title?: string
  model?: string
  status: "busy" | "idle" | "error" | "retry"
  tool?: string
  startedAt: number
  updatedAt: number
  endedAt?: number
  tokens: number
  cost: number
  error?: string
}

export interface StepRun {
  at: string
  column: string
  step?: StepKind
  agent?: string
  model?: string
  session?: string
  /** version of the agent definition in the store (5b statistics per version) */
  version?: string
  result?: "ok" | "failed" | "waiting" | "aborted"
  note?: string
  endedAt?: string
}

export interface AgentJob {
  id: string
  task: string
  project?: string
  /** agent the task was given (steps without an own agent use it) */
  agent: string
  /** resolved "provider/model" – every prompt of the job passes it explicitly */
  model?: string
  /** how the model was chosen when something had to be repaired or skipped */
  modelNote?: string
  workplace: "worktree" | "home"
  workdir: string
  home?: string
  branch?: string
  baseCommit?: string
  instructions?: string
  brief: string
  included: string[]
  phase: JobPhase
  /** current column and its step */
  column?: string
  step?: StepKind
  waitingFor?: WaitingFor
  /** agent and model of the current step */
  stepAgent?: string
  stepModel?: string
  /** root session of the current step */
  session?: string
  /** planning and implementation of one agent share a session */
  sessionsByAgent: Record<string, string>
  sessions: Record<string, SessionInfo>
  stepRuns: StepRun[]
  proposals: Proposal[]
  /** back jumps (test / verification failed) and extra rounds the user granted */
  loops: number
  extraLoops?: number
  /** why the card came back (for the next implementation prompt) */
  feedback?: string
  halted?: { at: string; reason: string }
  fixRounds: number
  improveRounds: number
  pipelineRuns: string[]
  pipelineFirstGreen?: boolean
  testRuns: Array<{ at: string; results: Array<{ id: string; result: TestResult; protocol?: string; by: string }>; pipelineRun?: string }>
  review?: { at: string; status: "running" | "done" | "error"; findings: Finding[]; summary?: string; verdicts?: Verdict[] }
  summary?: string
  diffStat?: { files: number; additions: number; deletions: number }
  permissions: Array<{ id: string; session: string; title: string; type: string; pattern?: string; at: number }>
  todos: Record<string, Array<{ id: string; content: string; status: string; priority: string }>>
  messages: Array<{ at: string; from: "user" | "system"; text: string; session?: string }>
  timeline: Array<{ at: number; session: string; event: "start" | "end" | "error"; agent?: string }>
  cost: number
  tokens: number
  startedAt: string
  updatedAt: string
  endedAt?: string
  error?: string
  prepared?: boolean
  owner: string
}

export interface RuleCandidate {
  id: string
  text: string
  kind: "vorgabe" | "skill"
  project?: string
  task?: string
  job?: string
  at: string
  status: "candidate" | "confirmed" | "dismissed"
}

/** Jobs written by 3.x had fixed phases – map them onto steps and waits. */
export function upgradeJob(raw: AnyRecord): AgentJob {
  const j = raw as AgentJob & AnyRecord
  j.sessionsByAgent ??= j.session ? { [j.agent]: j.session } : {}
  j.stepRuns ??= []
  j.loops ??= 0
  j.testRuns ??= []
  const old = String(raw.phase)
  const map: Record<string, Partial<AgentJob>> = {
    proposal: { phase: "working", step: "plan" },
    revising: { phase: "working", step: "plan" },
    awaiting_approval: { phase: "waiting", step: "plan", waitingFor: "plan" },
    implementing: { phase: "working", step: "implement" },
    fixing: { phase: "working", step: "implement" },
    checking: { phase: "checking", step: "implement" },
    reviewing: { phase: "working", step: "verify", session: raw.reviewSession ?? raw.session },
    in_test: { phase: "waiting", step: "verify", waitingFor: "accept" },
  }
  if (map[old]) Object.assign(j, map[old])
  delete j.reviewSession
  delete j.reviewModel
  return j
}

export class AgentTasks implements HubListener {
  readonly owner: string
  private jobs = new Map<string, AgentJob>()
  private timer?: ReturnType<typeof setInterval>
  private advancing = new Set<string>()

  constructor(private ctx: Ctx) {
    this.owner = ctx.directory
    agentHub().listeners.set(this.owner, this)
    for (const j of this.all()) {
      if (FINAL.has(j.phase) || j.owner !== this.owner) continue
      this.jobs.set(j.id, j)
      this.guard(j)
    }
  }

  private get dir(): string {
    return join(this.ctx.store.stateDir, "agent-jobs")
  }

  private file(id: string): string {
    return join(this.dir, `${id.replace(/[^A-Za-z0-9_-]/g, "")}.json`)
  }

  private save(j: AgentJob): void {
    j.updatedAt = nowIso()
    ensureDir(this.dir)
    writeJsonAtomic(this.file(j.id), j)
    this.ctx.bus.emit("agent.job", { job: j.id, task: j.task, phase: j.phase, step: j.step, column: j.column, label: phaseLabel(j) })
  }

  all(): AgentJob[] {
    return listFiles(this.dir, ".json")
      .map((f) => readJson<AnyRecord | null>(join(this.dir, f), null))
      .filter((j): j is AnyRecord => !!j?.id)
      .map(upgradeJob)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  get(id: string): AgentJob | undefined {
    const live = this.jobs.get(id)
    if (live) return live
    const raw = readJson<AnyRecord | null>(this.file(id), null)
    return raw ? upgradeJob(raw) : undefined
  }

  private require(id: string): AgentJob {
    const j = this.get(id)
    if (!j) throw new GuardError(`Auftrag ${id} nicht gefunden`)
    return j
  }

  active(): AgentJob[] {
    return [...this.jobs.values()].filter((j) => !FINAL.has(j.phase))
  }

  /** Current job of a task (card status). */
  ofTask(task: string): AgentJob | undefined {
    return [...this.jobs.values()].find((j) => j.task === task && !FINAL.has(j.phase)) ?? this.all().find((j) => j.task === task)
  }

  statusOf(task: string): { status: string; label: string; job?: string; waitingFor?: string; loops?: number } | undefined {
    const j = this.ofTask(task)
    if (!j) return undefined
    const waiting = j.permissions.length ? "braucht Antwort" : undefined
    return { status: j.permissions.length ? "permission" : j.phase, label: waiting ?? phaseLabel(j), job: j.id, waitingFor: j.waitingFor, loops: j.loops }
  }

  private client(): AnyRecord {
    return this.ctx.client
  }

  private q(j: AgentJob): { directory: string } {
    return { directory: j.workdir }
  }

  /** Flow of every column of the job's project. */
  flows(project?: string): Record<string, ColumnFlow> {
    const p = project ? this.ctx.projects.get(project) : undefined
    return resolveFlows(this.ctx.tasks.columns(project), this.ctx.options, p?.flow)
  }

  /** Primary agents of opencode (mode primary or all, without the internal smith agents). */
  async agents(): Promise<Array<{ name: string; description?: string; color?: string; model?: string; modelValid?: boolean; modelFix?: string; mode: string }>> {
    try {
      const list = unwrap<AnyRecord[]>(await this.client().app.agents())
      const catalog = await modelCatalog(this.client())
      return (list ?? [])
        .filter((a) => (a.mode === "primary" || a.mode === "all") && !isSmithAgent(a.name) && !a.hidden)
        .map((a) => {
          const model = specOf(a.model)
          const hit = model && catalog ? matchModel(model, catalog) : undefined
          return { name: a.name, description: a.description, color: a.color, model, modelValid: model && catalog ? !!hit && !hit.repaired : undefined, modelFix: hit?.repaired ? hit.spec : undefined, mode: a.mode }
        })
    } catch (err) {
      this.ctx.log.warn("agent list failed", errorMessage(err))
      return []
    }
  }

  /** Offered models for the assignment dialog: all, opencode's defaults, the one last used in opencode. */
  async models(): Promise<{ models: string[]; defaults: string[]; last?: string; config?: string }> {
    const catalog = await modelCatalog(this.client(), true)
    const last = specOf(lastModel(this.ctx.store.stateDir))
    const config = await configModelSpec(this.client())
    return { models: catalog?.specs ?? [], defaults: catalog?.defaults ?? [], last: last && catalog && matchModel(last, catalog) ? matchModel(last, catalog)!.spec : last, config }
  }

  /**
   * Model of a job: chosen in the dialog (must exist) → the agent's model → the model last used
   * in opencode → `model` of opencode.json → opencode's default. Names without provider are
   * repaired when unambiguous ("Hermes" → "9router/Hermes"); opencode itself would fail with
   * "Model not found: Hermes/." because only the TUI falls back silently.
   */
  private async jobModel(agent: string, requested?: string): Promise<{ spec?: string; note?: string }> {
    try {
      const choice = await chooseModel(this.client(), [
        { spec: requested, label: "Gewähltes Modell", strict: true },
        { spec: await agentModelSpec(this.client(), agent), label: `Modell des Agenten „${agent}“` },
        { spec: specOf(lastModel(this.ctx.store.stateDir)), label: "zuletzt in opencode genutztes Modell" },
        { spec: await configModelSpec(this.client()), label: "model in opencode.json" },
      ])
      return { spec: choice.spec, note: choice.note }
    } catch (err) {
      if (err instanceof ModelChoiceError) throw new GuardError(err.message.replace(/^Model not found: \S+ – /, ""))
      throw err
    }
  }

  // ---------------------------------------------------------------------------
  // brief
  // ---------------------------------------------------------------------------

  /** Finished tasks similar to this one with what the agent did (idea 18). */
  similar(task: Entry, max = this.ctx.options.tasks.similar): Array<{ id: string; title: string; text: string }> {
    if (max <= 0) return []
    const hits = this.ctx.index.search(`${task.title} ${task.description} ${task.tags.join(" ")} ${truncate(task.body, 600)}`, { kinds: ["task"], tiers: ["active", "archive"], limit: 12 })
    const out: Array<{ id: string; title: string; text: string }> = []
    for (const h of hits) {
      if (h.name === task.name) continue
      const e = this.ctx.store.getOwned("task", h.name)
      if (!e || !this.ctx.tasks.isDone(str(e.fields.status), str(e.fields.project) || undefined)) continue
      const job = this.all().find((j) => j.task === e.name && (j.phase === "accepted" || (j.phase === "waiting" && j.waitingFor === "accept")))
      const approved = job?.proposals.find((p) => p.verdict === "approved")
      const parts = [
        approved?.approach ? `Ansatz: ${truncate(approved.approach, 400)}` : "",
        job?.diffStat ? `Änderung: ${job.diffStat.files} Datei(en), +${job.diffStat.additions}/−${job.diffStat.deletions}` : "",
        job?.summary ? `Zusammenfassung: ${truncate(job.summary, 400)}` : "",
        job?.review?.findings.length ? `Review-Befunde: ${job.review.findings.slice(0, 4).map((f) => f.text).join("; ")}` : "",
      ].filter(Boolean)
      if (!parts.length) parts.push(truncate(e.description || e.body, 300))
      out.push({ id: str(e.fields.id) || taskId(e.name), title: e.title, text: parts.join("\n") })
      if (out.length >= max) break
    }
    return out
  }

  /** The brief for the agent: everything it needs, assembled from the task and the store. */
  composeBrief(task: Entry, input: { instructions?: string; workdir?: string; branch?: string; workplace?: string } = {}): { text: string; included: string[] } {
    const f = task.fields
    const id = str(f.id) || taskId(task.name)
    const project = str(f.project) ? this.ctx.projects.get(str(f.project)) : undefined
    const included: string[] = [`task:${task.name}`]
    const lines: string[] = [`# Auftrag ${id}: ${task.title}`]
    const meta = [project ? `Projekt: ${project.title}` : "", str(f.branch) ? `Branch: ${str(f.branch)}` : "", str(f.ticket) ? `Ticket: ${str(f.ticket)}` : "", `Priorität: ${str(f.priority) || "normal"}`, str(f.due) ? `fällig: ${str(f.due)}` : ""].filter(Boolean)
    lines.push(meta.join(" · "), "")
    if (task.description) lines.push(task.description, "")
    // the approved plan of 3.x lived in the body; 4.x keeps it in the plan field
    const body = task.body.replace(/<!-- vorschlag:start -->[\s\S]*?<!-- vorschlag:end -->/, "").trim()
    if (body) lines.push("## Beschreibung", body, "")
    const fields = fieldsMarkdown(task.fields)
    if (fields) lines.push(fields, "")
    const children = this.ctx.tasks.list({ project: "*" }).filter((t) => t.parent === id)
    if (children.length) lines.push("## Unteraufgaben", ...children.map((c) => `- ${c.id} ${c.title} [${c.status}]`), "")
    // linked entries: documents, knowledge, skills (given to the agent), memories, errors
    const linked: string[] = []
    for (const l of this.ctx.links.outgoingOf(`task:${task.name}`)) {
      if (!l.id || linked.includes(l.id) || this.ctx.graph.hidden(l.id)) continue
      linked.push(l.id)
    }
    if (linked.length) {
      lines.push("## Verlinkte Einträge")
      for (const lid of linked.slice(0, 12)) {
        const [kind, name] = [lid.slice(0, lid.indexOf(":")), lid.slice(lid.indexOf(":") + 1)]
        const e = this.ctx.store.getOwned(kind as Entry["kind"], name)
        if (!e) continue
        included.push(lid)
        lines.push(`### ${lid} – ${e.title} (${spec(e.kind).label})`, e.description, truncate(e.body, kind === "skill" ? 6000 : 3000), "")
      }
    }
    // project conventions and decisions
    const rules = this.ctx.store
      .list("memory")
      .filter((m) => m.tier === "active" && str(m.fields.status) === "gueltig" && (str(m.fields.type) === "vorgabe" || str(m.fields.type) === "entscheidung"))
      .filter((m) => str(m.fields.scope) === "global" || !project || str(m.fields.project_name) === project.title || str(m.fields.project) === project.name || !str(m.fields.project))
      .filter((m) => !this.ctx.graph.hidden(`memory:${m.name}`))
      .slice(0, 20)
    if (rules.length) {
      lines.push("## Vorgaben und Entscheidungen", ...rules.map((m) => `- [[memory:${m.name}]] ${m.title}${m.description ? ` – ${m.description}` : ""}`), "")
      for (const m of rules) included.push(`memory:${m.name}`)
    }
    const learned = this.rules().filter((r) => r.status === "confirmed" && (!r.project || r.project === project?.name))
    if (learned.length) lines.push("## Gelernte Regeln (aus früheren Korrekturen)", ...learned.slice(0, 15).map((r) => `- ${r.text}`), "")
    const similar = this.similar(task)
    if (similar.length) {
      lines.push("## So wurde Ähnliches gelöst")
      for (const s of similar) lines.push(`### [[task:${s.id}]] ${s.title}`, s.text, "")
    }
    if (input.instructions?.trim()) lines.push("## Zusätzliche Anweisungen", input.instructions.trim(), "")
    if (input.workdir) lines.push("## Arbeitsort", input.workplace === "home" ? `Du arbeitest direkt im Projektverzeichnis ${input.workdir}.` : `Du arbeitest in einem eigenen git-Worktree ${input.workdir}${input.branch ? ` (Branch ${input.branch})` : ""}. Committe und pushe nicht – das entscheidet der Nutzer.`, "")
    const text = this.ctx.redactor.redact(lines.join("\n")).trim()
    return { text, included }
  }

  /** Brief with the current fields of the task (criteria, test cases, plan change during the run). */
  private freshBrief(j: AgentJob): string {
    const task = this.ctx.tasks.get(j.task)
    if (!task) return j.brief
    return this.composeBrief(task, { instructions: j.instructions, workdir: j.workdir, branch: j.branch, workplace: j.workplace }).text
  }

  // ---------------------------------------------------------------------------
  // guards and writes on behalf of the job
  // ---------------------------------------------------------------------------

  /** Write access only for the session of the implementation step while it works. */
  private guard(j: AgentJob): void {
    const o = this.ctx.options.tasks
    const roots = new Set([j.session, ...Object.values(j.sessionsByAgent)].filter((x): x is string => !!x))
    for (const root of roots) {
      const current = root === j.session
      const write = current && j.step === "implement" && (j.phase === "working" || j.phase === "checking")
      const allowBash = current && (j.step === "implement" || j.step === "test") ? true : current && j.step === "plan" ? o.planAllowBash : false
      guardSession(root, { job: j.id, write, allowBash, writeTools: o.writeTools, owner: this.owner })
    }
  }

  private async userRun(trigger: string, actor: "web" | "command" = "web"): Promise<Run> {
    return this.ctx.runs.create({ smith: "memorysmith", actor, trigger, writeMode: "auto", directory: this.ctx.directory, project: this.ctx.project, limits: { maxNew: 100, maxChanges: 100, maxNotes: 0 } })
  }

  /** Writes the plugin does on behalf of an agent task (card moves, plan, results) – audit actor "agent". */
  private async systemWrite(label: string, fn: (run: Run) => Promise<unknown>): Promise<void> {
    const run = await this.userRun(`agent-task ${label}`, "command")
    let ok = true
    let error: string | undefined
    try {
      await fn(run)
    } catch (err) {
      ok = false
      error = errorMessage(err)
      this.ctx.log.warn(`agent task write failed (${label})`, error)
    }
    await finalizeRun(this.ctx, run, { ok, error })
  }

  private async setTaskFields(run: Run, task: string, patch: Record<string, unknown>, reason: string, body?: string): Promise<void> {
    const e = this.ctx.tasks.require(task)
    await this.ctx.ops.update(run, "task", { name: e.name, fields: { ...e.fields, ...patch }, ...(body !== undefined ? { body } : {}), reason, approved: true })
    this.ctx.bus.emit("task.changed", { task: e.name, action: "fields", project: str(e.fields.project) || undefined })
  }

  private async moveCard(j: AgentJob, column: string): Promise<void> {
    const t = this.ctx.tasks.get(j.task)
    if (!t || str(t.fields.status) === column) return
    await this.systemWrite(`${j.task} → ${column}`, (run) => this.ctx.tasks.move(run, j.task, column, { force: true, agent: true }))
  }

  // ---------------------------------------------------------------------------
  // assignment and steps
  // ---------------------------------------------------------------------------

  async assign(
    run: Run,
    input: { task: string; agent: string; model?: string; workplace?: "worktree" | "home"; instructions?: string; prepared?: boolean },
  ): Promise<AgentJob> {
    const o = this.ctx.options.tasks
    if (!o.agents) throw new GuardError("Agenten-Aufträge sind ausgeschaltet (tasks.agents)")
    if (this.active().length >= o.maxParallel) throw new GuardError(`Höchstens ${o.maxParallel} Aufträge gleichzeitig (tasks.maxParallel)`)
    const task = this.ctx.tasks.require(input.task)
    if (this.active().some((j) => j.task === task.name)) throw new GuardError("Für diese Aufgabe läuft schon ein Auftrag")
    const projectName = str(task.fields.project)
    const project = projectName ? this.ctx.projects.get(projectName) : undefined
    if (!project?.homePath) throw new GuardError("Die Aufgabe braucht ein Projekt mit home_path")
    if (!project.homeExists) throw new GuardError(`home_path ${project.homePath} existiert nicht`)
    const agents = await this.agents()
    if (agents.length && !agents.some((a) => a.name === input.agent)) throw new GuardError(`Agent „${input.agent}“ nicht gefunden (primär: ${agents.map((a) => a.name).join(", ")})`)
    const flows = this.flows(project.name)
    const columns = this.ctx.tasks.columns(project.name)
    // start at the task's column when it has a step, otherwise at the first step (planning)
    const current = str(task.fields.status) || columns[0]
    const startColumn = flows[current]?.step ? current : Object.values(flows).find((f) => f.step)?.column
    if (!startColumn) throw new GuardError("Keine Spalte des Boards hat einen Agenten-Schritt (tasks.flow / Workflow des Projekts)")
    const chosen = await this.jobModel(input.agent, input.model?.trim() || undefined)
    const home = expandPath(project.homePath)
    const workplace = input.workplace ?? (o.worktree ? "worktree" : "home")
    const id = `aj-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12)}-${shortId(4)}`
    let workdir = home
    let branch: string | undefined
    let baseCommit: string | undefined
    const bin = this.ctx.git.bin ?? (await this.ctx.git.init().then(() => this.ctx.git.bin))
    const head = await gitIn(bin, home, ["rev-parse", "HEAD"], 15_000)
    if (head.code === 0) baseCommit = head.stdout.trim()
    if (workplace === "worktree") {
      if (!baseCommit) throw new GuardError(`${home} ist kein git-Repository mit Commit – Worktree nicht möglich (Arbeitsort „home_path“ wählen)`)
      branch = `skillsmith/${task.name}-${slugify(task.title, 30) || "aufgabe"}-${shortId(3)}`
      workdir = join(this.ctx.store.stateDir, "worktrees", `${task.name}-${shortId(4)}`)
      ensureDir(join(this.ctx.store.stateDir, "worktrees"))
      const r = await gitIn(bin, home, ["worktree", "add", "-b", branch, workdir, baseCommit], 120_000)
      if (r.code !== 0) throw new GuardError(`git worktree add fehlgeschlagen: ${truncate(r.stderr.trim(), 300)}`)
    }
    const brief = this.composeBrief(task, { instructions: input.instructions, workdir, branch, workplace })
    const job: AgentJob = {
      id,
      task: task.name,
      project: project.name,
      agent: input.agent,
      model: chosen.spec,
      modelNote: chosen.note,
      workplace,
      workdir,
      home,
      branch,
      baseCommit,
      instructions: input.instructions,
      brief: brief.text,
      included: brief.included,
      phase: "starting",
      sessionsByAgent: {},
      sessions: {},
      stepRuns: [],
      proposals: [],
      loops: 0,
      fixRounds: 0,
      improveRounds: 0,
      pipelineRuns: [],
      testRuns: [],
      permissions: [],
      todos: {},
      messages: [],
      timeline: [],
      cost: 0,
      tokens: 0,
      startedAt: nowIso(),
      updatedAt: nowIso(),
      prepared: input.prepared,
      owner: this.owner,
    }
    this.jobs.set(id, job)
    this.save(job)
    // the task remembers who works on it
    await this.ctx.tasks.update(run, task.name, { assignee: "agent" })
    const fields = { ...this.ctx.tasks.require(task.name).fields, agent: input.agent, model: chosen.spec ?? "", ...(workplace === "worktree" ? { worktree: workdir } : { worktree: "" }) }
    await this.ctx.ops.update(run, "task", { name: task.name, fields, reason: `an ${input.agent} übergeben`, approved: true })
    this.stepAfter(run, job, startColumn)
    this.ctx.audit?.append({ actor: "user-web", category: "agent", action: "assign", targets: [`task:${task.name}`], result: "ok", message: `${id}: ${input.agent}${chosen.spec ? ` (${chosen.spec})` : ""}, ${workplace}${branch ? ` ${branch}` : ""}, Start in „${startColumn}“${chosen.note ? ` – Modell: ${chosen.note}` : ""}`, session: job.session, project: project.name, agent: input.agent, model: chosen.spec })
    this.ctx.metrics?.record({ type: M.agentRun, entry: `agent:${input.agent}`, origin: "web", agent: input.agent, model: chosen.spec, project: project.name, session: job.session, extra: { phase: "start", task: task.name, prepared: !!input.prepared } })
    this.start()
    return job
  }

  /** Agent, model and version of the step of a column. */
  private async stepAgent(j: AgentJob, f: ColumnFlow): Promise<{ agent: string; model?: string; version?: string }> {
    const agent = f.agent || (f.step === "verify" && this.ctx.options.tasks.reviewAgent) || j.agent
    let model = j.model
    if (f.model) model = (await this.jobModel(agent, f.model)).spec
    else if (agent !== j.agent) {
      // the step's own agent with its own model when that is usable, otherwise the job's
      const own = await this.jobModel(agent).catch(() => ({ spec: undefined, note: undefined }))
      const agentSpec = await agentModelSpec(this.client(), agent)
      model = agentSpec && own.spec && !own.note ? own.spec : j.model
    }
    const version = this.ctx.store.getOwned("agent", agent)?.version
    return { agent, model, version }
  }

  /** Enter a column: move the card, start the step's agent (or wait in a manual column). */
  /**
   * A step started by a user action (or another run that wrote the task) starts once that run is
   * finalized: the step moves the card and writes results in runs of its own, which would wait
   * for the claim of the still open run on the same task file.
   */
  private stepAfter(run: Run, j: AgentJob, column: string, opts: { reason?: string } = {}): void {
    j.column = column
    this.save(j)
    ;(run.followUps ??= []).push(async () => {
      try {
        await withLogContext({ job: j.id }, () => this.startStep(j, column, opts))
      } catch (err) {
        j.phase = "error"
        j.error = `Agent konnte nicht gestartet werden: ${errorMessage(err)}`
        this.save(j)
        this.ctx.log.child("agent").warn(`${j.id}: step ${column} failed to start`, errorMessage(err))
      }
    })
  }

  private async startStep(j: AgentJob, column: string, opts: { reason?: string } = {}): Promise<void> {
    const flows = this.flows(j.project)
    const f = flows[column]
    if (!f) throw new GuardError(`Spalte „${column}“ gibt es nicht`)
    j.column = column
    j.step = f.step
    await this.moveCard(j, column)
    const last = j.stepRuns[j.stepRuns.length - 1]
    if (last && !last.endedAt) last.endedAt = nowIso()
    if (!f.step) {
      j.phase = "waiting"
      j.waitingFor = "manual"
      j.stepRuns.push({ at: nowIso(), column, result: "waiting", note: "Spalte ohne Agent" })
      this.save(j)
      return
    }
    const sa = await this.stepAgent(j, f)
    // planning and implementation of the same agent continue one session (context);
    // test and verification look at the result with fresh eyes
    let session = f.step === "plan" || f.step === "implement" ? j.sessionsByAgent[sa.agent] : undefined
    const fresh = !session
    if (!session) {
      const s = unwrap<AnyRecord>(await this.client().session.create({ body: { title: `${taskId(j.task)} ${STEP_LABEL[f.step]}: ${truncate(this.ctx.tasks.get(j.task)?.title ?? "", 50)}` }, query: this.q(j) }))
      session = s.id as string
      j.sessions[session] = { id: session, agent: sa.agent, title: s.title, status: "busy", startedAt: Date.now(), updatedAt: Date.now(), tokens: 0, cost: 0 }
      j.timeline.push({ at: Date.now(), session, event: "start", agent: sa.agent })
      if (f.step === "plan" || f.step === "implement") j.sessionsByAgent[sa.agent] = session
    }
    j.session = session
    j.stepAgent = sa.agent
    j.stepModel = sa.model
    j.phase = "working"
    j.waitingFor = undefined
    j.stepRuns.push({ at: nowIso(), column, step: f.step, agent: sa.agent, model: sa.model, session, version: sa.version, note: opts.reason })
    this.guard(j)
    this.save(j)
    this.ctx.log.child("agent").info(`${j.id}: ${STEP_LABEL[f.step]} (${column}) mit ${sa.agent}`, { model: sa.model, session, loops: j.loops })
    const o = this.ctx.options.tasks
    const t = this.ctx.tasks.require(j.task)
    switch (f.step) {
      case "plan":
        await this.prompt(j, planPrompt(this.freshBrief(j), { allowBash: o.planAllowBash }))
        return
      case "implement": {
        const plan = (t.fields.plan ?? {}) as AnyRecord
        const text = implementPrompt({ brief: fresh ? this.freshBrief(j) : undefined, fields: t.fields, feedback: j.feedback, round: j.loops + 1, comments: plan.comments, answers: plan.answers })
        j.feedback = undefined
        await this.prompt(j, text)
        return
      }
      case "test":
        await this.runTests(j, f)
        return
      case "verify":
        await this.startVerify(j)
        return
    }
  }

  private async prompt(j: AgentJob, text: string, session = j.session): Promise<void> {
    if (!session) throw new GuardError("Auftrag hat keine Session")
    const o = this.ctx.options.tasks
    // opencode 1.x turns `tools` of a prompt into session permissions that stay for every later
    // prompt (and are inherited by subagents) – an "allow" afterwards would override the user's own
    // permission rules. Only the verification session (fresh, never writes) drops them; everything
    // else is enforced by the plugin guard over the whole session tree.
    const tools: Record<string, boolean> = {}
    if (j.step === "verify" && session === j.session) {
      for (const t of o.writeTools) tools[t] = false
      tools.bash = false
    }
    const info = j.sessions[session]
    if (info) {
      info.status = "busy"
      info.updatedAt = Date.now()
    }
    const modelRef = parseModel(j.stepModel ?? j.model)
    unwrap(
      await this.client().session.promptAsync({
        path: { id: session },
        query: this.q(j),
        body: { agent: j.stepAgent ?? j.agent, ...(modelRef ? { model: modelRef } : {}), ...(Object.keys(tools).length ? { tools } : {}), parts: [{ type: "text", text }] },
      }),
    )
  }

  // ---------------------------------------------------------------------------
  // step results
  // ---------------------------------------------------------------------------

  private async advance(j: AgentJob): Promise<void> {
    const last = await this.lastAssistant(j, j.session!)
    if (!last) return
    if (last.error && !last.text) {
      j.phase = "error"
      const hint = modelErrorHint(last.error, await modelCatalog(this.client()))
      j.error = hint ? `${last.error} – ${hint}` : last.error
      j.endedAt = nowIso()
      unguardJob(j.id)
      notify(this.ctx, "agent-error", `Agent ${j.stepAgent ?? j.agent} · ${taskId(j.task)}`, truncate(last.error, 200), { variant: "error", link: `#/agenten/${j.id}` })
      return
    }
    const flows = this.flows(j.project)
    const f = flows[j.column ?? ""]
    if (!f) return
    switch (j.step) {
      case "plan":
        return this.planDone(j, f, last.text)
      case "implement":
        j.summary = truncate(this.ctx.redactor.redact(last.text), 4000)
        return this.implementDone(j, f)
      case "test":
        return this.agentTestsDone(j, f, last.text)
      case "verify":
        return this.verifyDone(j, f, last.text)
    }
  }

  private async planDone(j: AgentJob, f: ColumnFlow, answer: string): Promise<void> {
    const text = this.ctx.redactor.redact(answer)
    const p: Proposal = { at: nowIso(), round: j.proposals.length + 1, text, ...parseProposal(text) }
    j.proposals.push(p)
    this.endStep(j, "ok", `Plan ${p.round}`)
    this.ctx.audit?.append({ actor: "agent", category: "agent", action: "proposal", targets: [`task:${j.task}`], result: "proposed", message: `${j.id}: Plan ${p.round}${p.criteria?.length ? `, ${p.criteria.length} Kriterien` : ""}${p.testcases?.length ? `, ${p.testcases.length} Testfälle` : ""}`, session: j.session, project: j.project, agent: j.stepAgent, model: j.stepModel })
    this.ctx.metrics?.record({ type: M.agentProposal, entry: `agent:${j.stepAgent ?? j.agent}`, origin: "background", agent: j.stepAgent ?? j.agent, model: j.stepModel, project: j.project, extra: { verdict: "created", round: p.round, task: j.task } })
    if (f.gate) {
      j.phase = "waiting"
      j.waitingFor = "plan"
      notify(this.ctx, "proposal", `Plan fertig · ${taskId(j.task)}`, `${j.stepAgent ?? j.agent}: ${truncate(p.approach ?? text, 160)}`, { variant: "info", link: `#/agenten/${j.id}` })
      return
    }
    // no gate: the plan is taken as it is
    await this.systemWrite(`${j.task} Plan ${p.round}`, (run) => this.writePlan(run, j, p, {}))
    await this.succeed(j, f)
  }

  /** Plan, criteria, test cases and the steps (checklist) into the task – one commit. */
  private async writePlan(run: Run, j: AgentJob, p: Proposal, input: { comments?: string; answers?: string; criteria?: unknown; testcases?: unknown; user?: boolean }): Promise<void> {
    const task = this.ctx.tasks.require(j.task)
    const criteria = criteriaOf(input.criteria ?? p.criteria ?? task.fields.criteria).map((c) => ({ ...c, ...(input.user ? { confirmed: true } : {}) }))
    const testcases = testcasesOf(input.testcases ?? p.testcases ?? task.fields.testcases)
    const plan = { approach: p.approach ?? truncate(p.text, 4000), files: p.files ?? [], steps: p.steps ?? [], risks: p.risks ?? [], questions: p.questions ?? [], round: p.round, by: j.stepAgent ?? j.agent, approvedAt: nowIso(), ...(input.comments ? { comments: input.comments } : {}), ...(input.answers ? { answers: input.answers } : {}) }
    const body = withSteps(task.body, p.steps ?? [])
    await this.setTaskFields(run, j.task, { plan, criteria, testcases }, `Plan ${p.round} von ${j.stepAgent ?? j.agent}${input.user ? " freigegeben" : " übernommen"}`, body)
  }

  private async implementDone(j: AgentJob, f: ColumnFlow): Promise<void> {
    const project = j.project ? this.ctx.projects.get(j.project) : undefined
    if (!f.checks.includes("pipeline") || !project?.pipeline?.stages.length) return this.succeed(j, f)
    j.phase = "checking"
    this.guard(j)
    this.save(j)
    const run = await this.ctx.pipeline.start({ project: project.name, task: j.task, trigger: j.fixRounds ? "fix" : "agent", by: `agent:${j.stepAgent ?? j.agent}`, workdir: j.workdir, branch: j.branch })
    j.pipelineRuns.push(run.id)
    if (j.pipelineFirstGreen === undefined) j.pipelineFirstGreen = run.status === "success"
    if (run.status === "success") return this.succeed(j, f)
    if (run.status === "aborted") return this.fail(j, f, "Pipeline abgebrochen")
    const stage = run.stages.find((s) => s.status === "failed" || s.status === "timeout")
    const log = this.ctx.pipeline.log(project.name, run.id).text
    const failed = run.tests?.failed.slice(0, 15).map((t) => `- ${t.suite}.${t.name}: ${t.message ?? ""}`).join("\n")
    // automatic fix rounds inside the implementation (no back jump)
    if (j.fixRounds < this.ctx.options.tasks.autoFixRounds) {
      j.fixRounds++
      j.phase = "working"
      this.guard(j)
      this.save(j)
      await this.prompt(j, fixPrompt({ stage: stage?.name, command: stage?.run, failed, log }))
      return
    }
    await this.fail(j, f, `Pipeline rot (Stufe ${stage?.name ?? "?"})${failed ? `\nFehlgeschlagene Tests:\n${failed}` : ""}\nEnde des Logs:\n${truncate(log.slice(-3000), 3000)}`)
  }

  /** Test step: command cases as a pipeline run, agent cases by the test agent, manual ones by the user. */
  private async runTests(j: AgentJob, f: ColumnFlow): Promise<void> {
    const task = this.ctx.tasks.require(j.task)
    const cases = testcasesOf(task.fields.testcases)
    const results: Array<{ id: string; result: TestResult; protocol?: string; by: string }> = []
    let pipelineRun: string | undefined
    const commands = cases.filter((c) => c.mode === "befehl" && c.command)
    if (commands.length && j.project) {
      j.phase = "checking"
      this.save(j)
      const out = await this.commandTests({ project: j.project, task: j.task, cases: commands, by: `agent:${j.stepAgent ?? j.agent}`, workdir: j.workdir, branch: j.branch })
      pipelineRun = out.run
      results.push(...out.results)
    }
    j.testRuns.push({ at: nowIso(), results, pipelineRun })
    const agentCases = cases.filter((c) => c.mode === "agent")
    if (agentCases.length) {
      j.phase = "working"
      this.save(j)
      const commandText = results.map((r) => `- ${r.id}: ${r.result}`).join("\n")
      await this.prompt(j, testPrompt({ brief: this.freshBrief(j), cases: agentCases, commandResults: commandText || undefined }))
      return
    }
    await this.evaluateTests(j, f)
  }

  private async agentTestsDone(j: AgentJob, f: ColumnFlow, answer: string): Promise<void> {
    const task = this.ctx.tasks.require(j.task)
    const cases = testcasesOf(task.fields.testcases).filter((c) => c.mode === "agent")
    const parsed = parseTestResults(this.ctx.redactor.redact(answer))
    const run = j.testRuns[j.testRuns.length - 1] ?? { at: nowIso(), results: [] }
    if (!j.testRuns.length) j.testRuns.push(run)
    for (const c of cases) {
      const r = parsed.find((x) => x.id === c.id)
      run.results.push({ id: c.id, result: r?.result ?? "offen", protocol: r?.protocol ?? (r ? undefined : "keine Aussage des Test-Agenten"), by: "agent" })
    }
    await this.evaluateTests(j, f)
  }

  /** Write the results into the test cases; red → back, manual open → wait, else on. */
  private async evaluateTests(j: AgentJob, f: ColumnFlow): Promise<void> {
    const run = j.testRuns[j.testRuns.length - 1]
    if (run?.results.length) {
      await this.systemWrite(`${j.task} Testergebnisse`, async (r) => {
        const task = this.ctx.tasks.require(j.task)
        const cases = testcasesOf(task.fields.testcases).map((c) => {
          const res = run.results.find((x) => x.id === c.id)
          return res && res.result !== "offen" ? { ...c, last: { at: run.at, result: res.result, protocol: res.protocol, by: res.by as "befehl" | "agent" | "user", job: j.id, ...(run.pipelineRun && res.by === "befehl" ? { run: run.pipelineRun } : {}) } } : c
        })
        await this.setTaskFields(r, j.task, { testcases: cases }, `Testfälle: ${run.results.map((x) => `${x.id} ${x.result}`).join(", ")}`)
      })
    }
    return this.checkTestState(j, f)
  }

  private async checkTestState(j: AgentJob, f: ColumnFlow): Promise<void> {
    const cases = testcasesOf(this.ctx.tasks.require(j.task).fields.testcases)
    const current = j.testRuns[j.testRuns.length - 1]
    // a case counts when it ran in this round (commands, agent) or – manual ones – since the round started
    const resultOf = (c: TestCase): TestResult => {
      const r = current?.results.find((x) => x.id === c.id)
      if (r) return r.result
      if (c.mode === "manuell" && c.last && current && c.last.at >= current.at) return c.last.result
      return "offen"
    }
    const red = cases.filter((c) => resultOf(c) === "fehlgeschlagen")
    if (red.length) {
      return this.fail(j, f, `Testfälle fehlgeschlagen:\n${red.map((c) => `- ${c.id} ${c.title}: ${truncate((current?.results.find((x) => x.id === c.id)?.protocol ?? c.last?.protocol ?? "").replace(/\s+/g, " "), 600)}`).join("\n")}`)
    }
    const open = cases.filter((c) => resultOf(c) === "offen")
    if (open.some((c) => c.mode === "manuell")) {
      j.phase = "waiting"
      j.waitingFor = "tests"
      this.guard(j)
      this.endStep(j, "waiting", `${open.length} Testfall/Testfälle von Hand prüfen`)
      return
    }
    if (open.length) return this.fail(j, f, `Testfälle ohne Ergebnis: ${open.map((c) => c.id).join(", ")}`)
    if (!f.checks.includes("criteria") && !f.checks.includes("review")) return this.succeed(j, f, cases.length ? `${cases.length} Testfälle bestanden` : "keine Testfälle")
    // a board without verification column: test also verifies
    await this.startVerify(j)
  }

  private async startVerify(j: AgentJob): Promise<void> {
    let files: FileDiff[] = []
    try {
      files = await this.diff(j)
      j.diffStat = { files: files.length, additions: files.reduce((n, x) => n + x.additions, 0), deletions: files.reduce((n, x) => n + x.deletions, 0) }
    } catch (err) {
      this.ctx.log.debug("agent diff failed", errorMessage(err))
    }
    const task = this.ctx.tasks.require(j.task)
    const plan = (task.fields.plan ?? {}) as AnyRecord
    const approved = [...j.proposals].reverse().find((p) => p.verdict === "approved")
    const checks = checkDiff(files, approved?.files ?? plan.files, (t) => this.ctx.redactor.scan(t), this.ctx.options.tasks.largeDeletion)
    j.review = { at: nowIso(), status: "running", findings: checks }
    const criteria = criteriaOf(task.fields.criteria)
    if (!this.ctx.options.tasks.review && !criteria.length) {
      j.review.status = "done"
      return this.verifyDone(j, this.flows(j.project)[j.column ?? ""], "")
    }
    if (!files.length && !criteria.length) {
      j.review.status = "done"
      j.review.summary = "keine Änderungen"
      return this.verifyDone(j, this.flows(j.project)[j.column ?? ""], "")
    }
    // the verifier needs a fresh session (also when test and verify share a column)
    if (j.step !== "verify" || j.sessions[j.session ?? ""]?.agent !== j.stepAgent || j.stepRuns[j.stepRuns.length - 1]?.step === "test") {
      const s = unwrap<AnyRecord>(await this.client().session.create({ body: { title: `${taskId(j.task)} Verifikation` }, query: this.q(j) }))
      j.sessions[s.id] = { id: s.id, agent: j.stepAgent, title: s.title, status: "busy", startedAt: Date.now(), updatedAt: Date.now(), tokens: 0, cost: 0 }
      j.timeline.push({ at: Date.now(), session: s.id, event: "start", agent: j.stepAgent })
      j.session = s.id
      j.step = "verify"
    }
    j.phase = "working"
    this.guard(j)
    this.save(j)
    const tests = j.testRuns.length ? j.testRuns[j.testRuns.length - 1].results.map((r) => `- ${r.id}: ${r.result}${r.protocol ? ` – ${truncate(r.protocol.replace(/\s+/g, " "), 300)}` : ""}`).join("\n") : undefined
    await this.prompt(j, verifyPrompt({ brief: this.freshBrief(j), fields: task.fields, diff: truncate(this.ctx.redactor.redact(diffText(files)), 60_000), tests }))
  }

  private async verifyDone(j: AgentJob, f: ColumnFlow | undefined, answer: string): Promise<void> {
    if (!f) return
    const task = this.ctx.tasks.require(j.task)
    const criteria = criteriaOf(task.fields.criteria)
    const obj = (answer ? jsonBlock(answer, "object") : undefined) as AnyRecord | undefined
    const verdicts: Verdict[] = Array.isArray(obj?.verdicts)
      ? obj!.verdicts
          .filter((v: AnyRecord) => v && typeof v === "object")
          .map((v: AnyRecord) => ({ criterion: String(v.criterion ?? v.id ?? ""), verdict: ["erfuellt", "nicht_erfuellt"].includes(v.verdict) ? v.verdict : "unklar", ...(v.evidence ? { evidence: truncate(String(v.evidence), 1500) } : {}) }))
          .filter((v: Verdict) => criteria.some((c) => c.id === v.criterion))
      : []
    const aiFindings = findingsOf(obj?.findings ?? (answer ? undefined : []))
    const review = j.review ?? { at: nowIso(), status: "done" as const, findings: [] }
    review.status = "done"
    review.findings = [...review.findings.filter((x) => x.source === "check"), ...aiFindings]
    review.summary = truncate(this.ctx.redactor.redact(String(obj?.summary ?? answer.replace(/```[\s\S]*?```/g, "").trim())), 1500)
    review.verdicts = verdicts
    j.review = review
    const missing = criteria.filter((c) => !verdicts.some((v) => v.criterion === c.id))
    const unmet = criteria.filter((c) => verdicts.find((v) => v.criterion === c.id)?.verdict !== "erfuellt")
    const errors = review.findings.filter((x) => x.severity === "error")
    const ok = (!f.checks.includes("criteria") || !unmet.length) && (!f.checks.includes("review") || !errors.length)
    await this.systemWrite(`${j.task} Verifikation`, async (run) => {
      const updated: Criterion[] = criteria.map((c) => {
        const v = verdicts.find((x) => x.criterion === c.id)
        return v ? { ...c, status: v.verdict === "erfuellt" ? "erfuellt" : v.verdict === "nicht_erfuellt" ? "nicht_erfuellt" : "offen", ...(v.evidence ? { evidence: v.evidence } : {}) } : c
      })
      const verification = { at: nowIso(), by: j.stepAgent ?? j.agent, verdicts, summary: review.summary, findings: review.findings.length, ok }
      await this.setTaskFields(run, j.task, { ...(criteria.length ? { criteria: updated } : {}), verification }, `Verifikation: ${ok ? "bestanden" : "nicht bestanden"}`)
    })
    this.ctx.audit?.append({ actor: "agent", category: "agent", action: "verify", targets: [`task:${j.task}`], result: ok ? "ok" : "rejected", message: `${j.id}: ${verdicts.filter((v) => v.verdict === "erfuellt").length}/${criteria.length} Kriterien erfüllt, ${review.findings.length} Befund(e)`, session: j.session, project: j.project, agent: j.stepAgent, model: j.stepModel })
    if (ok) return this.succeed(j, f, `${criteria.length ? `${criteria.length - unmet.length}/${criteria.length} Kriterien erfüllt` : "Review ohne Fehler"}`)
    const reasons = [
      ...unmet.map((c) => {
        const v = verdicts.find((x) => x.criterion === c.id)
        return `- ${c.id} ${c.text}: ${v ? (v.verdict === "unklar" ? "unklar" : "nicht erfüllt") : "nicht beurteilt"}${v?.evidence ? ` – ${v.evidence}` : ""}`
      }),
      ...errors.map((x) => `- Befund${x.file ? ` ${x.file}${x.line ? `:${x.line}` : ""}` : ""}: ${x.text}`),
    ]
    await this.fail(j, f, `Verifikation nicht bestanden${missing.length ? ` (${missing.length} Kriterien nicht beurteilt)` : ""}:\n${reasons.join("\n")}`)
  }

  private endStep(j: AgentJob, result: StepRun["result"], note?: string): void {
    const s = j.stepRuns[j.stepRuns.length - 1]
    if (!s) return
    s.result = result
    if (note) s.note = note
    s.endedAt = nowIso()
  }

  /** Step passed: next column (gate → wait for the user; the column before "done" always waits). */
  private async succeed(j: AgentJob, f: ColumnFlow, note?: string): Promise<void> {
    this.endStep(j, "ok", note)
    const columns = this.ctx.tasks.columns(j.project)
    const done = columns[columns.length - 1]
    const next = f.onSuccess
    if (!next) {
      j.phase = "waiting"
      j.waitingFor = "manual"
      this.save(j)
      return
    }
    if (next === done || f.gate) {
      j.phase = "waiting"
      j.waitingFor = next === done ? "accept" : "gate"
      this.guard(j)
      this.save(j)
      if (next === done) {
        this.ctx.audit?.append({ actor: "agent", category: "agent", action: "done", targets: [`task:${j.task}`], result: "ok", message: `${j.id}: ${j.diffStat ? `${j.diffStat.files} Datei(en)` : "fertig"}${j.review ? `, ${j.review.findings.length} Befund(e)` : ""}, ${j.loops} Rücksprung/Rücksprünge`, session: j.session, project: j.project, agent: j.agent, model: j.model })
        notify(this.ctx, "agent-done", `Fertig · ${taskId(j.task)}`, `${j.agent}: ${truncate(j.summary ?? "Umsetzung fertig", 160)}`, { variant: "success", link: `#/agenten/${j.id}` })
      }
      return
    }
    await this.startStep(j, next)
  }

  /** Step failed: back to the failure column, or halt after maxLoops back jumps. */
  private async fail(j: AgentJob, f: ColumnFlow, reason: string): Promise<void> {
    this.endStep(j, "failed", truncate(reason.split("\n")[0], 200))
    const flows = this.flows(j.project)
    const target = f.onFailure ?? columnOfStep(flows, "implement")
    j.loops++
    j.feedback = reason
    this.ctx.audit?.append({ actor: "agent", category: "agent", action: "loop", targets: [`task:${j.task}`], result: "rejected", message: `${j.id}: ${truncate(reason, 400)} → ${target ?? "?"} (Runde ${j.loops})`, project: j.project, agent: j.stepAgent ?? j.agent })
    this.ctx.metrics?.record({ type: M.agentRun, entry: `agent:${j.stepAgent ?? j.agent}`, origin: "background", agent: j.stepAgent ?? j.agent, model: j.stepModel, project: j.project, extra: { phase: "loop", step: j.step, task: j.task, loops: j.loops } })
    if (!target || j.loops > f.maxLoops + (j.extraLoops ?? 0)) {
      j.phase = "halted"
      j.halted = { at: nowIso(), reason: truncate(reason, 2000) }
      j.waitingFor = undefined
      this.guard(j)
      this.save(j)
      notify(this.ctx, "halted", `Angehalten · ${taskId(j.task)}`, `${j.loops} Rücksprünge – ${truncate(reason.split("\n")[0], 160)}`, { variant: "warning", link: `#/agenten/${j.id}` })
      return
    }
    await this.startStep(j, target, { reason: `zurück aus ${j.column}: ${truncate(reason.split("\n")[0], 120)}` })
  }

  // ---------------------------------------------------------------------------
  // the user's decisions
  // ---------------------------------------------------------------------------

  /** Gate 1: approve the plan (criteria and test cases may be edited) → written into the task, next column. */
  async approve(run: Run, id: string, input: { comments?: string; answers?: string; criteria?: unknown; testcases?: unknown } = {}): Promise<AgentJob> {
    const j = this.require(id)
    if (j.phase !== "waiting" || j.waitingFor !== "plan") throw new GuardError(`Auftrag wartet nicht auf die Freigabe eines Plans (${phaseLabel(j)})`)
    const p = j.proposals[j.proposals.length - 1]
    if (!p) throw new GuardError("Kein Plan vorhanden")
    p.verdict = "approved"
    p.comments = input.comments?.trim() || undefined
    p.answers = input.answers?.trim() || undefined
    await this.writePlan(run, j, p, { comments: p.comments, answers: p.answers, criteria: input.criteria, testcases: input.testcases, user: true })
    j.messages.push({ at: nowIso(), from: "user", text: `Plan freigegeben${p.comments ? `: ${p.comments}` : ""}` })
    this.ctx.metrics?.record({ type: M.agentProposal, entry: `agent:${j.stepAgent ?? j.agent}`, origin: "web", agent: j.stepAgent ?? j.agent, model: j.stepModel ?? j.model, project: j.project, extra: { verdict: "approved", round: p.round, labels: this.ctx.tasks.get(j.task)?.tags ?? [], task: j.task } })
    this.ctx.audit?.append({ actor: "user-web", category: "agent", action: "approve", targets: [`task:${j.task}`], result: "ok", message: `${j.id}: Plan ${p.round}`, session: j.session, project: j.project, agent: j.stepAgent ?? j.agent })
    const f = this.flows(j.project)[j.column ?? ""]
    const next = f?.onSuccess
    if (!next) throw new GuardError("Die Planungsspalte hat kein Ziel (onSuccess)")
    this.stepAfter(run, j, next)
    return j
  }

  /** Revise the plan: comments go back into the same session (still read-only); the reason may become a rule (idea 17). */
  async revise(id: string, comments: string): Promise<AgentJob> {
    const j = this.require(id)
    if (j.phase !== "waiting" || j.waitingFor !== "plan") throw new GuardError(`Auftrag wartet nicht auf die Freigabe eines Plans (${phaseLabel(j)})`)
    const text = comments.trim()
    if (text.length < 3) throw new GuardError("Bitte sagen, was überarbeitet werden soll")
    const p = j.proposals[j.proposals.length - 1]
    p.verdict = "revise"
    p.comments = text
    j.phase = "working"
    j.waitingFor = undefined
    j.stepRuns.push({ at: nowIso(), column: j.column!, step: "plan", agent: j.stepAgent, model: j.stepModel, session: j.session, note: "überarbeiten" })
    j.messages.push({ at: nowIso(), from: "user", text: `Überarbeiten: ${text}` })
    this.guard(j)
    this.save(j)
    this.learn(j, text)
    this.ctx.metrics?.record({ type: M.agentProposal, entry: `agent:${j.stepAgent ?? j.agent}`, origin: "web", agent: j.stepAgent ?? j.agent, model: j.stepModel ?? j.model, project: j.project, extra: { verdict: "revise", round: p.round, task: j.task } })
    this.ctx.audit?.append({ actor: "user-web", category: "agent", action: "revise", targets: [`task:${j.task}`], result: "ok", message: `${j.id}: ${truncate(text, 300)}`, session: j.session, project: j.project, agent: j.stepAgent ?? j.agent })
    await this.prompt(j, revisePrompt(text))
    return j
  }

  /** Go on: past a gate, out of a manual column, after manual tests, or one more round after a halt. */
  async continue(run: Run, id: string, input: { text?: string; to?: string } = {}): Promise<AgentJob> {
    const j = this.require(id)
    const flows = this.flows(j.project)
    const f = flows[j.column ?? ""]
    if (j.phase === "halted") {
      j.extraLoops = (j.extraLoops ?? 0) + 1
      j.halted = undefined
      const target = input.to ?? f?.onFailure ?? columnOfStep(flows, "implement")
      if (!target) throw new GuardError("Keine Spalte zum Weitermachen")
      j.feedback = [j.feedback, input.text ? `Hinweis des Nutzers: ${input.text}` : ""].filter(Boolean).join("\n\n")
      if (input.text) this.learn(j, input.text)
      this.ctx.audit?.append({ actor: "user-web", category: "agent", action: "continue", targets: [`task:${j.task}`], result: "ok", message: `${j.id}: eine weitere Runde${input.text ? ` – ${truncate(input.text, 200)}` : ""}`, project: j.project, agent: j.agent })
      this.stepAfter(run, j, target, { reason: "weitere Runde (Nutzer)" })
      return j
    }
    if (j.phase !== "waiting" || j.waitingFor === "plan" || j.waitingFor === "accept") throw new GuardError(`Hier geht es mit „Freigeben“ bzw. „Abnehmen“ weiter (${phaseLabel(j)})`)
    if (j.waitingFor === "tests") {
      ;(run.followUps ??= []).push(() => withLogContext({ job: j.id }, () => this.checkTestState(j, f!)))
      return j
    }
    const next = input.to ?? f?.onSuccess
    if (!next) throw new GuardError("Kein nächster Schritt")
    this.ctx.audit?.append({ actor: "user-web", category: "agent", action: "continue", targets: [`task:${j.task}`], result: "ok", message: `${j.id}: weiter nach „${next}“`, project: j.project, agent: j.agent })
    this.stepAfter(run, j, next)
    return j
  }

  /** Message into a running session (any phase; tool restrictions of the step stay). */
  async message(id: string, text: string, session?: string): Promise<void> {
    const j = this.require(id)
    if (FINAL.has(j.phase)) throw new GuardError("Auftrag ist beendet")
    const sid = session && j.sessions[session] ? session : j.session
    j.messages.push({ at: nowIso(), from: "user", text, session: sid })
    this.save(j)
    await this.prompt(j, text, sid)
  }

  /** Nachbessern (after the work is done or halted): the user's hint goes back into the implementation; the reason may become a rule. */
  async improve(run: Run, id: string, text: string): Promise<AgentJob> {
    const j = this.require(id)
    if (!(j.phase === "waiting" && j.waitingFor === "accept") && j.phase !== "halted") throw new GuardError(`Nachbessern geht nach der Umsetzung (${phaseLabel(j)})`)
    if (text.trim().length < 3) throw new GuardError("Bitte sagen, was nachgebessert werden soll")
    void run
    j.improveRounds++
    j.review = undefined
    j.halted = undefined
    j.feedback = `Der Nutzer bittet um Nachbesserung:\n${text}`
    j.messages.push({ at: nowIso(), from: "user", text: `Nachbessern: ${text}` })
    this.learn(j, text)
    this.ctx.audit?.append({ actor: "user-web", category: "agent", action: "improve", targets: [`task:${j.task}`], result: "ok", message: `${j.id}: ${truncate(text, 300)}`, session: j.session, project: j.project, agent: j.agent })
    const target = columnOfStep(this.flows(j.project), "implement")
    if (!target) throw new GuardError("Keine Umsetzungsspalte im Workflow")
    this.stepAfter(run, j, target, { reason: "Nachbesserung (Nutzer)" })
    return j
  }

  /** Command test cases as one ad-hoc pipeline run (a stage per case); result and log part per case. */
  async commandTests(o: { project: string; task: string; cases: TestCase[]; by: string; workdir?: string; branch?: string }): Promise<{ run: string; results: Array<{ id: string; result: TestResult; protocol: string; by: "befehl" }> }> {
    const commands = o.cases.filter((c) => c.mode === "befehl" && c.command)
    const run = await this.ctx.pipeline.start({ project: o.project, task: o.task, trigger: "tests", by: o.by, workdir: o.workdir, branch: o.branch, label: "Testfälle", stages: commands.map((c) => ({ name: c.id, run: c.command!, allowFailure: true })) })
    const log = this.ctx.pipeline.log(o.project, run.id).text
    const results = commands.map((c) => {
      const st = run.stages.find((s) => s.name === c.id)
      const part = new RegExp(`━━ ${escapeRegExp(c.id)}: [\\s\\S]*?━━ ${escapeRegExp(c.id)}: [^\\n]*`).exec(log)?.[0]
      return { id: c.id, result: (st?.status === "success" ? "bestanden" : "fehlgeschlagen") as TestResult, protocol: truncate(part ?? `Exit ${st?.exitCode ?? "?"}`, 4000), by: "befehl" as const }
    })
    return { run: run.id, results }
  }

  /** Command tests started by the user (task page): results go into the test cases in their own run. */
  async runTestsForUser(task: string, by: string): Promise<{ count: number; started: Promise<void> }> {
    const e = this.ctx.tasks.require(task)
    const project = str(e.fields.project)
    if (!project) throw new GuardError("Die Aufgabe braucht ein Projekt")
    const cases = testcasesOf(e.fields.testcases).filter((c) => c.mode === "befehl" && c.command)
    if (!cases.length) throw new GuardError("Keine Testfälle mit Befehl")
    const job = this.ofTask(e.name)
    const workdir = str(e.fields.worktree) || (job && !FINAL.has(job.phase) && job.workplace === "worktree" ? job.workdir : undefined)
    const started = (async () => {
      const out = await this.commandTests({ project, task: e.name, cases, by, workdir: workdir || undefined, branch: job && !FINAL.has(job.phase) ? job.branch : undefined })
      const at = nowIso()
      const run = await this.userRun(`Testfälle ${taskId(e.name)}`)
      let ok = true
      let error: string | undefined
      try {
        const fresh = this.ctx.tasks.require(e.name)
        const updated = testcasesOf(fresh.fields.testcases).map((c) => {
          const r = out.results.find((x) => x.id === c.id)
          return r ? { ...c, last: { at, result: r.result, protocol: r.protocol, by: "befehl" as const, run: out.run } } : c
        })
        await this.setTaskFields(run, e.name, { testcases: updated }, `Testfälle: ${out.results.map((x) => `${x.id} ${x.result}`).join(", ")}`)
      } catch (err) {
        ok = false
        error = errorMessage(err)
      }
      await finalizeRun(this.ctx, run, { ok, error })
      const waiting = [...this.jobs.values()].find((x) => x.task === e.name && x.phase === "waiting" && x.waitingFor === "tests")
      const f = waiting ? this.flows(waiting.project)[waiting.column ?? ""] : undefined
      if (waiting && f) await withLogContext({ job: waiting.id }, () => this.checkTestState(waiting, f))
    })()
    started.catch((err) => this.ctx.log.warn("test run failed", errorMessage(err)))
    return { count: cases.length, started }
  }

  /** A manual test result of the user (task page) – re-evaluates a job that waits for it. */
  async testResult(run: Run, task: string, caseId: string, result: TestResult, protocol?: string): Promise<void> {
    const e = this.ctx.tasks.require(task)
    const cases = testcasesOf(e.fields.testcases)
    if (!cases.some((c) => c.id === caseId)) throw new GuardError(`Testfall ${caseId} gibt es nicht`)
    const updated = cases.map((c) => (c.id === caseId ? { ...c, last: { at: nowIso(), result, ...(protocol ? { protocol: truncate(protocol, 4000) } : {}), by: "user" as const } } : c))
    await this.setTaskFields(run, e.name, { testcases: updated }, `Testfall ${caseId}: ${result}`)
    const j = [...this.jobs.values()].find((x) => x.task === e.name && x.phase === "waiting" && x.waitingFor === "tests")
    if (j) {
      const f = this.flows(j.project)[j.column ?? ""]
      if (f) (run.followUps ??= []).push(() => withLogContext({ job: j.id }, () => this.checkTestState(j, f)))
    }
  }

  /** The user moved the card: a waiting job follows into a column with a step; with autoStart an idle task starts its agent. */
  async onCardMoved(task: string, to: string): Promise<string | undefined> {
    const j = [...this.jobs.values()].find((x) => x.task === task && !FINAL.has(x.phase))
    const e = this.ctx.tasks.get(task)
    if (!e) return undefined
    const project = str(e.fields.project) || undefined
    const f = this.flows(project)[to]
    if (j) {
      if (j.phase === "working" || j.phase === "checking" || j.phase === "starting") return `${taskId(task)}: der Agent arbeitet gerade (${phaseLabel(j)})`
      if (!f?.step || j.column === to) return undefined
      await withLogContext({ job: j.id }, () => this.startStep(j, to, { reason: "Karte vom Nutzer verschoben" }))
      return `${taskId(task)}: ${STEP_LABEL[f.step]} gestartet`
    }
    const o = this.ctx.options.tasks
    if (!o.agents || !o.autoStart || !f?.step) return undefined
    const agent = f.agent || str(e.fields.agent) || (project ? this.ctx.projects.get(project)?.agent : undefined)
    if (!agent || !project) return undefined
    // only tasks that never had a job start by themselves (a discarded one waits for the user)
    if (this.all().some((x) => x.task === task)) return undefined
    const run = await this.userRun(`agent-task autostart ${task}`, "command")
    try {
      await this.assign(run, { task, agent, model: str(e.fields.model) || undefined })
      await finalizeRun(this.ctx, run, { ok: true })
      return `${taskId(task)}: ${agent} startet (${STEP_LABEL[f.step]})`
    } catch (err) {
      await finalizeRun(this.ctx, run, { ok: false, error: errorMessage(err) })
      return `${taskId(task)}: Agent nicht gestartet – ${errorMessage(err)}`
    }
  }

  async abort(id: string, session?: string): Promise<AgentJob> {
    const j = this.require(id)
    const ids = session ? [session] : Object.keys(j.sessions)
    for (const sid of ids) await this.client().session.abort({ path: { id: sid }, query: this.q(j) }).catch(() => undefined)
    if (!session || session === j.session) {
      this.endStep(j, "aborted")
      j.phase = "aborted"
      j.endedAt = nowIso()
      unguardJob(j.id)
    }
    this.save(j)
    this.ctx.audit?.append({ actor: "user-web", category: "agent", action: "abort", targets: [`task:${j.task}`], result: "ok", message: `${j.id}${session ? ` · Session ${session}` : ""}`, project: j.project, agent: j.agent })
    return j
  }

  /** Discard the agent's changes (worktree reset, or opencode revert in the home path). */
  async discard(run: Run, id: string): Promise<AgentJob> {
    const j = this.require(id)
    for (const sid of Object.keys(j.sessions)) await this.client().session.abort({ path: { id: sid }, query: this.q(j) }).catch(() => undefined)
    const bin = this.ctx.git.bin
    if (j.workplace === "worktree" && j.baseCommit) {
      await gitIn(bin, j.workdir, ["reset", "--hard", j.baseCommit], 60_000)
      await gitIn(bin, j.workdir, ["clean", "-fd"], 60_000)
    } else {
      for (const sid of Object.values(j.sessionsByAgent)) {
        const msgs = unwrap<AnyRecord[]>(await this.client().session.messages({ path: { id: sid }, query: this.q(j) }).catch(() => ({ data: [] })))
        const firstUser = (msgs ?? []).find((m) => m.info?.role === "user")
        if (firstUser) await this.client().session.revert({ path: { id: sid }, query: this.q(j), body: { messageID: firstUser.info.id } }).catch(() => undefined)
      }
    }
    this.endStep(j, "aborted", "verworfen")
    j.phase = "discarded"
    j.endedAt = nowIso()
    unguardJob(j.id)
    this.save(j)
    // back to the first step column (planning) – nothing restarts by itself
    const flows = this.flows(j.project)
    const first = Object.values(flows).find((f) => f.step)?.column ?? this.ctx.tasks.columns(j.project)[0]
    await this.ctx.tasks.move(run, j.task, first, { force: true, agent: true }).catch(() => undefined)
    this.ctx.audit?.append({ actor: "user-web", category: "agent", action: "discard", targets: [`task:${j.task}`], result: "ok", message: j.id, project: j.project, agent: j.agent })
    return j
  }

  /** Answer a permission question of an agent session (once, always, reject). */
  async permission(id: string, permissionID: string, response: "once" | "always" | "reject"): Promise<void> {
    const j = this.require(id)
    const p = j.permissions.find((x) => x.id === permissionID)
    if (!p) throw new GuardError("Rückfrage nicht (mehr) offen")
    unwrap(await this.client().postSessionIdPermissionsPermissionId({ path: { id: p.session, permissionID }, query: this.q(j), body: { response } }))
    j.permissions = j.permissions.filter((x) => x.id !== permissionID)
    this.save(j)
    this.ctx.audit?.append({ actor: "user-web", category: "agent", action: "permission", targets: [`task:${j.task}`], result: "ok", message: `${p.title}: ${response}`, session: p.session, project: j.project, agent: j.agent })
  }

  /**
   * Acceptance (gate 2, column "done", only by the user): commit the worktree on its branch and
   * merge it, push it for a pull request, or discard it.
   */
  async accept(run: Run, id: string, mode: "merge" | "pr" | "keep" | "discard"): Promise<{ message: string; url?: string }> {
    const j = this.require(id)
    if (!(j.phase === "waiting" && j.waitingFor === "accept") && j.phase !== "accepted" && j.phase !== "halted") throw new GuardError(`Abnahme erst nach der Umsetzung (${phaseLabel(j)})`)
    const bin = this.ctx.git.bin
    const task = this.ctx.tasks.require(j.task)
    let message = ""
    let url: string | undefined
    if (j.workplace === "worktree" && j.branch && j.home) {
      if (mode === "discard") {
        await gitIn(bin, j.home, ["worktree", "remove", "--force", j.workdir], 60_000)
        await gitIn(bin, j.home, ["branch", "-D", j.branch], 30_000)
        removePath(j.workdir)
        message = `Worktree und Branch ${j.branch} verworfen`
      } else {
        const st = await gitIn(bin, j.workdir, ["status", "--porcelain"], 30_000)
        if (st.stdout.trim()) {
          await gitIn(bin, j.workdir, ["add", "-A"], 60_000)
          const c = await gitIn(bin, j.workdir, ["commit", "-q", "--no-verify", "-m", `${taskId(task.name)}: ${task.title}\n\nUmgesetzt von ${j.agent} (skillsmith-Auftrag ${j.id}).`], 60_000)
          if (c.code !== 0) throw new GuardError(`Commit im Worktree fehlgeschlagen: ${truncate(c.stderr, 300)}`)
        }
        if (mode === "merge") {
          const dirty = await gitIn(bin, j.home, ["status", "--porcelain", "-uno"], 30_000)
          if (dirty.stdout.trim()) throw new GuardError("Das Projekt-Repo hat nicht committete Änderungen – erst aufräumen, dann mergen")
          const m = await gitIn(bin, j.home, ["merge", "--no-ff", "--no-edit", j.branch], 120_000)
          if (m.code !== 0) {
            await gitIn(bin, j.home, ["merge", "--abort"], 30_000)
            throw new GuardError(`Merge fehlgeschlagen (Konflikt?): ${truncate(m.stderr || m.stdout, 300)}`)
          }
          await gitIn(bin, j.home, ["worktree", "remove", "--force", j.workdir], 60_000)
          removePath(j.workdir)
          message = `Branch ${j.branch} in ${j.home} gemergt`
        } else if (mode === "pr") {
          const push = await gitIn(bin, j.workdir, ["push", "-u", "origin", j.branch], 180_000)
          if (push.code !== 0) throw new GuardError(`Push fehlgeschlagen: ${truncate(push.stderr, 300)}`)
          url = /https?:\/\/\S+/.exec(push.stderr)?.[0]
          message = `Branch ${j.branch} gepusht – Pull Request${url ? ` unter ${url}` : " im Git-Server"} anlegen`
        } else message = `Änderungen auf Branch ${j.branch} committet (Worktree bleibt)`
      }
    } else message = mode === "discard" ? "Änderungen bleiben im Projektverzeichnis – bitte dort zurücksetzen" : "Änderungen liegen im Projektverzeichnis"
    this.endStep(j, "ok", `abgenommen (${mode})`)
    j.phase = "accepted"
    j.waitingFor = undefined
    j.endedAt = nowIso()
    unguardJob(j.id)
    this.save(j)
    const cols = this.ctx.tasks.columns(j.project)
    await this.ctx.tasks.move(run, j.task, cols[cols.length - 1], { force: true })
    this.ctx.audit?.append({ actor: "user-web", category: "agent", action: `accept-${mode}`, targets: [`task:${j.task}`], result: "ok", message: `${j.id}: ${message}`, project: j.project, agent: j.agent })
    this.ctx.metrics?.record({
      type: M.agentRun,
      entry: `agent:${j.agent}`,
      origin: "web",
      agent: j.agent,
      model: j.model,
      project: j.project,
      value: Date.parse(j.endedAt) - Date.parse(j.startedAt),
      value2: j.cost,
      extra: { phase: "accepted", mode, task: j.task, labels: task.tags, rounds: j.proposals.length, fixRounds: j.fixRounds, improveRounds: j.improveRounds, loops: j.loops, firstGreen: j.pipelineFirstGreen, findings: j.review?.findings.length ?? 0, tokens: j.tokens },
    })
    return { message, url }
  }

  // ---------------------------------------------------------------------------
  // progress: events, polling, step transitions
  // ---------------------------------------------------------------------------

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.poll(), 3000)
    ;(this.timer as any).unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    agentHub().listeners.delete(this.owner)
  }

  onRejected(sessionID: string, tool: string, jobId: string, message: string): void {
    const j = this.jobs.get(jobId)
    this.ctx.audit?.append({ actor: "agent", category: "rejected", action: tool, targets: j ? [`task:${j.task}`] : [], result: "rejected", message, session: sessionID, project: j?.project, agent: j?.sessions[sessionID]?.agent ?? j?.agent })
    if (j) {
      j.messages.push({ at: nowIso(), from: "system", text: `abgelehnt: ${tool} in Session ${sessionID}`, session: sessionID })
      this.save(j)
    }
  }

  onEvent(_directory: string, event: AnyRecord, jobId: string): void {
    const j = this.jobs.get(jobId)
    if (!j) return
    const p = event.properties ?? {}
    const now = Date.now()
    const ses = (sid: string): SessionInfo => {
      let s = j.sessions[sid]
      if (!s) {
        s = j.sessions[sid] = { id: sid, status: "busy", startedAt: now, updatedAt: now, tokens: 0, cost: 0 }
        j.timeline.push({ at: now, session: sid, event: "start" })
      }
      return s
    }
    let changed = true
    switch (event.type) {
      case "session.created":
      case "session.updated": {
        const info = p.info
        if (!info?.id) return
        const s = ses(info.id)
        s.parent = info.parentID ?? s.parent
        s.title = info.title ?? s.title
        break
      }
      case "session.status": {
        const s = ses(p.sessionID)
        const t = p.status?.type
        s.status = t === "idle" ? "idle" : t === "retry" ? "retry" : "busy"
        if (t === "idle") {
          s.tool = undefined
          s.endedAt = now
          j.timeline.push({ at: now, session: s.id, event: "end", agent: s.agent })
        }
        s.updatedAt = now
        break
      }
      case "session.idle": {
        const s = ses(p.sessionID)
        s.status = "idle"
        s.tool = undefined
        s.updatedAt = now
        break
      }
      case "session.error": {
        if (!p.sessionID) return
        const s = ses(p.sessionID)
        s.status = "error"
        const raw = errorMessage(p.error?.data?.message ?? p.error?.message ?? p.error ?? "error")
        const hint = modelErrorHint(raw)
        s.error = truncate(hint ? `${raw} – ${hint}` : raw, 500)
        j.timeline.push({ at: now, session: s.id, event: "error", agent: s.agent })
        if (s.id === j.session) notify(this.ctx, "agent-error", `Agent ${j.agent} · ${taskId(j.task)}`, s.error, { variant: "error", link: `#/aufgabe/${j.task}` })
        break
      }
      case "message.updated": {
        const info = p.info
        if (!info?.sessionID) return
        const s = ses(info.sessionID)
        if (info.role === "assistant") {
          s.agent = info.mode ?? s.agent
          s.model = info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : s.model
          if (info.time?.completed) {
            const t = info.tokens ?? {}
            const tokens = (Number(t.input) || 0) + (Number(t.output) || 0) + (Number(t.reasoning) || 0)
            const key = `m:${info.id}`
            if (!(j as any)[key]) {
              ;(j as any)[key] = true
              s.tokens += tokens
              s.cost += Number(info.cost) || 0
              j.tokens += tokens
              j.cost += Number(info.cost) || 0
            }
          }
        }
        s.updatedAt = now
        break
      }
      case "message.part.updated": {
        const part = p.part
        if (part?.type !== "tool" || !part.sessionID) {
          changed = false
          break
        }
        const s = ses(part.sessionID)
        const st = part.state?.status
        s.tool = st === "running" || st === "pending" ? part.tool : undefined
        s.status = "busy"
        s.updatedAt = now
        this.ctx.bus.emit("agent.tool", { job: j.id, session: part.sessionID, tool: part.tool, status: st, title: part.state?.title })
        break
      }
      case "todo.updated": {
        j.todos[p.sessionID] = (p.todos ?? []).map((t: AnyRecord) => ({ id: t.id, content: truncate(String(t.content ?? ""), 300), status: t.status, priority: t.priority }))
        break
      }
      case "permission.updated": {
        if (!j.permissions.some((x) => x.id === p.id)) {
          j.permissions.push({ id: p.id, session: p.sessionID, title: truncate(String(p.title ?? p.type), 300), type: String(p.type ?? ""), pattern: Array.isArray(p.pattern) ? p.pattern.join(" ") : p.pattern, at: now })
          notify(this.ctx, "permission", `Rückfrage · ${taskId(j.task)}`, truncate(String(p.title ?? p.type), 160), { variant: "warning", link: `#/agenten/${j.id}` })
        }
        break
      }
      case "permission.replied": {
        j.permissions = j.permissions.filter((x) => x.id !== p.permissionID)
        break
      }
      default:
        changed = false
    }
    if (changed) {
      // the file is written by the poll loop (at most every 3 s); live updates go out now
      this.ctx.bus.emit("agent.event", { job: j.id, type: event.type, session: p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID ?? p.info?.id })
    }
  }

  /** One progress step for every active job (tests, manual refresh). */
  tick(): Promise<void> {
    return this.poll()
  }

  private async poll(): Promise<void> {
    for (const j of this.active()) {
      if (this.advancing.has(j.id)) continue
      try {
        await this.refresh(j)
        if (j.phase === "working" && (await this.settled(j))) {
          this.advancing.add(j.id)
          try {
            await withLogContext({ job: j.id }, () => this.advance(j))
          } finally {
            this.advancing.delete(j.id)
          }
        }
        this.save(j)
      } catch (err) {
        this.ctx.log.child("agent").warn(`agent job ${j.id} poll failed`, errorMessage(err))
        if (err instanceof GuardError) {
          j.phase = "error"
          j.error = err.message
          j.endedAt = nowIso()
          unguardJob(j.id)
          this.save(j)
        }
      }
    }
    if (!this.active().length && this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** Children and status of every session of the tree (fallback for missed events). */
  private async refresh(j: AgentJob): Promise<void> {
    const c = this.client()
    const roots = [...new Set([j.session, ...Object.values(j.sessionsByAgent)].filter((x): x is string => !!x))]
    const statuses = unwrap<Record<string, { type?: string }>>(await c.session.status({ query: this.q(j) }).catch(() => ({ data: {} }))) ?? {}
    const queue = [...roots]
    const seen = new Set<string>()
    while (queue.length) {
      const sid = queue.shift()!
      if (seen.has(sid)) continue
      seen.add(sid)
      const s = (j.sessions[sid] ??= { id: sid, status: "busy", startedAt: Date.now(), updatedAt: Date.now(), tokens: 0, cost: 0 })
      const st = statuses[sid]?.type
      s.status = !st || st === "idle" ? (s.status === "error" ? "error" : "idle") : st === "retry" ? "retry" : "busy"
      const kids = unwrap<AnyRecord[]>(await c.session.children({ path: { id: sid }, query: this.q(j) }).catch(() => ({ data: [] }))) ?? []
      for (const k of kids) {
        if (!j.sessions[k.id]) {
          j.sessions[k.id] = { id: k.id, parent: sid, title: k.title, status: "busy", startedAt: k.time?.created ?? Date.now(), updatedAt: Date.now(), tokens: 0, cost: 0 }
          j.timeline.push({ at: k.time?.created ?? Date.now(), session: k.id, event: "start" })
        }
        queue.push(k.id)
      }
    }
  }

  /** The current step's session tree is idle and the last answer is complete. */
  private async settled(j: AgentJob): Promise<boolean> {
    const root = j.session
    if (!root) return false
    const tree = Object.values(j.sessions).filter((s) => s.id === root || this.descends(j, s.id, root))
    if (tree.some((s) => s.status === "busy" || s.status === "retry")) return false
    const last = await this.lastAssistant(j, root)
    return !!last && last.completed
  }

  private descends(j: AgentJob, sid: string, root: string): boolean {
    let cur = j.sessions[sid]?.parent
    for (let i = 0; cur && i < 10; i++) {
      if (cur === root) return true
      cur = j.sessions[cur]?.parent
    }
    return false
  }

  private async lastAssistant(j: AgentJob, session: string): Promise<{ text: string; completed: boolean; error?: string } | undefined> {
    const msgs = unwrap<AnyRecord[]>(await this.client().session.messages({ path: { id: session }, query: this.q(j) }).catch(() => ({ data: [] }))) ?? []
    const last = msgs[msgs.length - 1]
    if (!last || last.info?.role !== "assistant") return undefined
    const text = (last.parts ?? [])
      .filter((p: AnyRecord) => p.type === "text" && !p.synthetic)
      .map((p: AnyRecord) => p.text)
      .join("\n")
      .trim()
    return { text, completed: !!last.info.time?.completed || !!last.info.error, error: last.info.error ? errorMessage(last.info.error?.data?.message ?? last.info.error) : undefined }
  }

  /** Changes of the job (worktree: git diff against the base commit incl. new files; home: session diff). */
  async diff(j: AgentJob | string): Promise<FileDiff[]> {
    const job = typeof j === "string" ? this.require(j) : j
    const bin = this.ctx.git.bin
    if (job.workplace === "worktree" && job.baseCommit && exists(job.workdir)) {
      await gitIn(bin, job.workdir, ["add", "-A", "-N"], 60_000)
      const r = await gitIn(bin, job.workdir, ["diff", "-M", job.baseCommit, "--"], 120_000)
      return parseUnifiedDiff(r.stdout)
    }
    if (!job.session) return []
    const files = unwrap<AnyRecord[]>(await this.client().session.diff({ path: { id: job.session }, query: this.q(job) }).catch(() => ({ data: [] }))) ?? []
    return files.map((f) => {
      const ops = diffLines(String(f.before ?? ""), String(f.after ?? ""))
      const st = diffStats(ops)
      return { path: String(f.file), status: !f.before ? "added" : !f.after ? "deleted" : "modified", hunks: toHunks(ops, 3), ...st } as FileDiff
    })
  }

  /** Messages and tool calls of one session (live view), redacted. */
  async sessionView(id: string, session: string): Promise<AnyRecord> {
    const j = this.require(id)
    if (!j.sessions[session]) throw new GuardError("Session gehört nicht zu diesem Auftrag")
    const msgs = unwrap<AnyRecord[]>(await this.client().session.messages({ path: { id: session }, query: this.q(j) }).catch(() => ({ data: [] }))) ?? []
    const red = (s: unknown, n: number) => truncate(this.ctx.redactor.redact(String(s ?? "")), n)
    return {
      session: j.sessions[session],
      todos: j.todos[session] ?? [],
      messages: msgs.slice(-200).map((m) => ({
        id: m.info?.id,
        role: m.info?.role,
        agent: m.info?.mode,
        at: m.info?.time?.created,
        completed: m.info?.time?.completed,
        tokens: m.info?.tokens ? (m.info.tokens.input ?? 0) + (m.info.tokens.output ?? 0) + (m.info.tokens.reasoning ?? 0) : undefined,
        cost: m.info?.cost,
        parts: (m.parts ?? [])
          .filter((p: AnyRecord) => (p.type === "text" && !p.synthetic) || p.type === "tool" || p.type === "reasoning")
          .map((p: AnyRecord) =>
            p.type === "tool"
              ? { type: "tool", tool: p.tool, status: p.state?.status, title: red(p.state?.title, 200), input: red(JSON.stringify(p.state?.input ?? {}), 600), output: red(p.state?.output ?? p.state?.error, 3000), start: p.state?.time?.start, end: p.state?.time?.end, child: p.state?.metadata?.sessionId }
              : { type: p.type, text: red(p.text, 8000) },
          ),
      })),
    }
  }

  // ---------------------------------------------------------------------------
  // learning from corrections (idea 17) and prepared plans (idea 21)
  // ---------------------------------------------------------------------------

  private get rulesFile(): string {
    return join(this.ctx.store.stateDir, "rule-candidates.json")
  }

  rules(): RuleCandidate[] {
    return readJson<RuleCandidate[]>(this.rulesFile, [])
  }

  /** A reason given for a revision or a fix becomes a candidate rule (confirmed in the inbox). */
  private learn(j: AgentJob, text: string): void {
    const t = oneLine(text)
    if (t.length < 15) return
    const list = this.rules()
    if (list.some((r) => r.text === t)) return
    const kind: RuleCandidate["kind"] = /\b(skill|ablauf|schritt|vorgehen|immer zuerst|checkliste)\b/i.test(t) ? "skill" : "vorgabe"
    list.push({ id: `r-${shortId(6)}`, text: truncate(t, 400), kind, project: j.project, task: j.task, job: j.id, at: nowIso(), status: "candidate" })
    writeJsonAtomic(this.rulesFile, list.slice(-300))
    this.ctx.bus.emit("inbox.changed", { reason: "rule-candidate" })
  }

  /** Confirm (→ convention of the project, the next agent gets it) or dismiss a rule candidate. */
  async decideRule(run: Run, id: string, decision: "confirm" | "dismiss", text?: string): Promise<string> {
    const list = this.rules()
    const r = list.find((x) => x.id === id)
    if (!r) throw new GuardError("Regel-Kandidat nicht gefunden")
    if (decision === "dismiss") {
      r.status = "dismissed"
      writeJsonAtomic(this.rulesFile, list)
      return "verworfen"
    }
    const rule = oneLine(text?.trim() || r.text)
    const project = r.project ? this.ctx.projects.get(r.project) : undefined
    const where = { project: project?.name ?? this.ctx.project, projectName: project?.title ?? this.ctx.project, projectSlug: slugify(project?.name ?? this.ctx.project, 18) || "projekt" }
    const msg = await this.ctx.ops.memorySave(run, {
      type: "vorgabe",
      topic: slugify(rule, 40) || "regel",
      title: truncate(rule, 120),
      summary: truncate(rule, 200),
      body: `${rule}\n\nAus einer Korrektur bei ${r.task ? `[[task:${taskId(r.task)}]]` : "einem Agenten-Auftrag"} (bestätigt vom Nutzer).`,
      where,
      approved: true,
      reason: "Regel aus Korrektur bestätigt",
    } as any)
    r.status = "confirmed"
    r.text = rule
    writeJsonAtomic(this.rulesFile, list)
    return msg
  }

  /** Tasks in the planning column assigned to an agent get their plan without supervision (idea 21, job "prepare"). */
  async prepareProposals(reason: string): Promise<number> {
    const o = this.ctx.options.tasks
    if (!o.agents || !o.prepare) return 0
    let started = 0
    for (const t of this.ctx.tasks.list({ project: "*" })) {
      if (t.assignee !== "agent" || !t.agent || !t.project) continue
      const plan = columnOfStep(this.flows(t.project), "plan")
      if (!plan || t.status !== plan) continue
      // only tasks that never had a job: after an abort or discard the user hands it over again
      if (this.all().some((j) => j.task === t.name)) continue
      if (this.active().length >= o.maxParallel) break
      try {
        const run = await this.userRun(`agent-task prepare ${t.name} (${reason})`, "command")
        await this.assign(run, { task: t.name, agent: t.agent, model: t.model, prepared: true })
        await finalizeRun(this.ctx, run, { ok: true })
        started++
      } catch (err) {
        this.ctx.log.info(`prepare proposal for ${t.id} skipped`, errorMessage(err))
      }
    }
    return started
  }

  /** Messages for the inbox: plans and gates to approve, manual tests, halted jobs, questions, finished work. */
  inboxItems(): InboxItem[] {
    const out: InboxItem[] = []
    for (const j of this.active()) {
      const id = j.task.toUpperCase()
      if (j.phase === "waiting" && j.waitingFor === "plan") out.push({ id: `agent-${j.id}`, type: "agent-proposal", group: "Agenten", title: `Plan von ${j.stepAgent ?? j.agent} für ${id}`, detail: truncate(j.proposals[j.proposals.length - 1]?.approach ?? "", 200), target: `task:${j.task}`, severity: "warn", actions: [], data: { job: j.id } })
      if (j.phase === "waiting" && (j.waitingFor === "gate" || j.waitingFor === "tests" || j.waitingFor === "manual")) out.push({ id: `agent-gate-${j.id}-${j.column}`, type: "agent-proposal", group: "Agenten", title: `${id}: ${phaseLabel(j)}`, detail: `Spalte ${j.column}`, target: `task:${j.task}`, severity: "warn", actions: [], data: { job: j.id } })
      if (j.phase === "halted") out.push({ id: `agent-halted-${j.id}`, type: "agent-halted", group: "Agenten", title: `${id} angehalten nach ${j.loops} Rücksprüngen`, detail: truncate(j.halted?.reason.split("\n")[0] ?? "", 200), target: `task:${j.task}`, severity: "critical", actions: [], data: { job: j.id } })
      for (const p of j.permissions) out.push({ id: `perm-${p.id}`, type: "permission", group: "Agenten", title: `Rückfrage: ${p.title}`, detail: `${j.agent} · ${id}`, target: `task:${j.task}`, severity: "critical", actions: ["once", "always", "reject"].map((r) => ({ action: "agent.permission", label: r === "once" ? "einmal" : r === "always" ? "immer" : "ablehnen", args: { job: j.id, permission: p.id, response: r } })), data: { job: j.id } })
      if (j.phase === "waiting" && j.waitingFor === "accept") out.push({ id: `agent-done-${j.id}`, type: "agent-done", group: "Agenten", title: `${id} umgesetzt – bitte abnehmen`, detail: truncate(j.summary ?? "", 200), target: `task:${j.task}`, severity: "info", actions: [], data: { job: j.id } })
    }
    return out
  }

  // ---------------------------------------------------------------------------
  // live view and statistics
  // ---------------------------------------------------------------------------

  tree(id: string): AnyRecord {
    const j = this.require(id)
    return {
      job: { ...j, brief: undefined },
      label: phaseLabel(j),
      flows: this.flows(j.project),
      sessions: Object.values(j.sessions).sort((a, b) => a.startedAt - b.startedAt),
    }
  }

  /** Agent evaluation per agent and version of its definition (5b): approval rate, back jumps, first time green. */
  stats(days = 90): Array<{ agent: string; version: string; model: string; jobs: number; steps: number; plans: number; approvedFirst: number; revisions: number; loops: number; halted: number; fixRounds: number; improveRounds: number; firstGreen: number; withPipeline: number; findings: number; avgMinutes: number; tokens: number; cost: number; labels: Record<string, number>; subagents: Record<string, number> }> {
    const from = Date.now() - days * 86_400_000
    type Row = ReturnType<AgentTasks["stats"]>[number]
    const groups = new Map<string, Row>()
    const row = (agent: string, version: string, model: string): Row => {
      const k = `${agent}|${version}`
      let g = groups.get(k)
      if (!g) groups.set(k, (g = { agent, version, model, jobs: 0, steps: 0, plans: 0, approvedFirst: 0, revisions: 0, loops: 0, halted: 0, fixRounds: 0, improveRounds: 0, firstGreen: 0, withPipeline: 0, findings: 0, avgMinutes: 0, tokens: 0, cost: 0, labels: {}, subagents: {} }))
      return g
    }
    for (const j of this.all()) {
      if (Date.parse(j.startedAt) < from) continue
      const steps = j.stepRuns.length ? j.stepRuns : [{ at: j.startedAt, column: "", agent: j.agent, model: j.model } as StepRun]
      const seen = new Set<string>()
      for (const s of steps) {
        if (!s.agent) continue
        const g = row(s.agent, s.version ?? "opencode", s.model ?? j.model ?? "(Standard)")
        g.steps++
        if (s.result === "failed") g.loops++
        if (!seen.has(`${s.agent}|${s.version}`)) {
          seen.add(`${s.agent}|${s.version}`)
          g.jobs++
          g.tokens += j.tokens
          g.cost += j.cost
          if (j.endedAt) g.avgMinutes += (Date.parse(j.endedAt) - Date.parse(j.startedAt)) / 60_000
          const task = this.ctx.tasks.get(j.task)
          for (const l of task?.tags ?? []) g.labels[l] = (g.labels[l] ?? 0) + 1
          if (j.phase === "halted" || j.halted) g.halted++
        }
        if (s.step === "plan" && s.result === "ok") g.plans++
      }
      const planner = row(steps.find((s) => s.step === "plan")?.agent ?? j.agent, steps.find((s) => s.step === "plan")?.version ?? "opencode", j.model ?? "(Standard)")
      if (j.proposals[0]?.verdict === "approved") planner.approvedFirst++
      planner.revisions += j.proposals.filter((p) => p.verdict === "revise").length
      const implementer = row(steps.find((s) => s.step === "implement")?.agent ?? j.agent, steps.find((s) => s.step === "implement")?.version ?? "opencode", j.model ?? "(Standard)")
      implementer.fixRounds += j.fixRounds
      implementer.improveRounds += j.improveRounds
      if (j.pipelineFirstGreen !== undefined) {
        implementer.withPipeline++
        if (j.pipelineFirstGreen) implementer.firstGreen++
      }
      implementer.findings += j.review?.findings.length ?? 0
      for (const s of Object.values(j.sessions)) if (s.parent && s.agent) implementer.subagents[s.agent] = (implementer.subagents[s.agent] ?? 0) + 1
    }
    return [...groups.values()].map((g) => ({ ...g, avgMinutes: g.jobs ? Math.round(g.avgMinutes / g.jobs) : 0, cost: Math.round(g.cost * 10000) / 10000 }))
  }
}

/** The steps of the plan as a checklist section of the task (ticked items survive a new plan). */
export function withSteps(body: string, steps: string[]): string {
  const without = body.replace(/\n*<!-- aufgaben:start -->[\s\S]*?<!-- aufgaben:end -->\n*/, "\n\n").trim()
  if (!steps.length) return without
  const done = new Set(
    [...body.matchAll(/^\s*[-*]\s+\[[xX]\]\s+(.*)$/gm)].map((m) => m[1].trim()),
  )
  const section = ["<!-- aufgaben:start -->", "## Aufgaben", ...steps.map((s) => `- [${done.has(s) ? "x" : " "}] ${oneLine(s)}`), "<!-- aufgaben:end -->"].join("\n")
  return `${without}\n\n${section}`.trim()
}
