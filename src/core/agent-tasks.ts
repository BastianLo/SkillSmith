/**
 * Delegate tasks to opencode agents (step 4f): proposal → approval → implementation →
 * checks → review → acceptance by the user.
 *
 *  1. assign: brief from the task (description, subtasks, linked entries, project rules,
 *     learned rules, similar finished tasks), own git worktree below the state directory
 *     (or the home_path itself), a session with the chosen primary agent and model.
 *  2. proposal: write tools are off for the agent (tools of the prompt) and for every
 *     subagent it starts (tool.execute.before over the whole session tree, agent-hub.ts).
 *  3. approval by the user (token, audit, commit at the task) → same session continues with
 *     write access. Revisions go back into the same session.
 *  4. implementation → the project's pipeline in the worktree; red → one automatic fix round
 *     (tasks.autoFixRounds) → card to "test" → read-only review session plus deterministic
 *     checks (files outside the proposal, secrets, large deletions, new TODOs).
 *  5. the user accepts (done: merge, prepare a pull request or discard) – the agent never sets done.
 *
 * Jobs are local data (state/agent-jobs); every step is an audit event. Agent sessions are
 * normal opencode sessions and can be opened in the terminal.
 */
import { join } from "node:path"
import { parseModel } from "../config"
import type { Entry, Run } from "../types"
import { ensureDir, exists, listFiles, readJson, removePath, writeJsonAtomic } from "../util/fs"
import { diffLines, diffStats, parseUnifiedDiff, toHunks, type FileDiff } from "../util/diff"
import { errorMessage, nowIso, oneLine, shortId, slugify, truncate } from "../util/text"
import { agentHub, guardSession, setWrite, unguardJob, type HubListener } from "./agent-hub"
import { unwrap } from "./agent-runner"
import type { Ctx } from "./context"
import { finalizeRun } from "./finalize"
import { str } from "./frontmatter"
import { gitIn } from "./git"
import { spec, taskId } from "./kinds"
import { M } from "./metrics"
import { notify } from "./notify"
import { GuardError } from "./ops"
import { expandPath } from "./projects"
import { isSmithAgent } from "./prompts"
import { agentModelSpec, chooseModel, configModelSpec, matchModel, modelCatalog, ModelChoiceError, modelErrorHint, specOf } from "./models"
import { lastModel } from "./state"

type AnyRecord = Record<string, any>

export type JobPhase =
  | "starting"
  | "proposal"
  | "awaiting_approval"
  | "revising"
  | "implementing"
  | "checking"
  | "fixing"
  | "reviewing"
  | "in_test"
  | "accepted"
  | "discarded"
  | "aborted"
  | "error"

export const PHASE_LABEL: Record<JobPhase, string> = {
  starting: "startet",
  proposal: "plant",
  awaiting_approval: "wartet auf Freigabe",
  revising: "überarbeitet Vorschlag",
  implementing: "setzt um",
  checking: "Prüfbefehle laufen",
  fixing: "bessert nach",
  reviewing: "Review läuft",
  in_test: "fertig – bitte prüfen",
  accepted: "abgenommen",
  discarded: "verworfen",
  aborted: "abgebrochen",
  error: "Fehler",
}

const FINAL = new Set<JobPhase>(["accepted", "discarded", "aborted", "error"])
const WAITING = new Set<JobPhase>(["proposal", "revising", "implementing", "fixing", "reviewing"])

export interface Proposal {
  at: string
  round: number
  text: string
  approach?: string
  files?: string[]
  steps?: string[]
  risks?: string[]
  questions?: string[]
  tests?: string[]
  verdict?: "approved" | "revise" | "rejected"
  comments?: string
  answers?: string
}

export interface Finding {
  source: "check" | "ai"
  severity: "info" | "warn" | "error"
  file?: string
  line?: number
  text: string
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

export interface AgentJob {
  id: string
  task: string
  project?: string
  agent: string
  /** resolved "provider/model" – every prompt of the job passes it explicitly */
  model?: string
  /** how the model was chosen when something had to be repaired or skipped */
  modelNote?: string
  /** model of the review session (tasks.reviewAgent with its own model) */
  reviewModel?: string
  workplace: "worktree" | "home"
  workdir: string
  home?: string
  branch?: string
  baseCommit?: string
  instructions?: string
  brief: string
  included: string[]
  phase: JobPhase
  session?: string
  reviewSession?: string
  sessions: Record<string, SessionInfo>
  proposals: Proposal[]
  fixRounds: number
  improveRounds: number
  pipelineRuns: string[]
  pipelineFirstGreen?: boolean
  review?: { at: string; status: "running" | "done" | "error"; findings: Finding[]; summary?: string }
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

const PROPOSAL_FORMAT = `Antworte am Ende mit dem Vorschlag in genau diesem Format (ein JSON-Block, danach eine kurze Zusammenfassung in Sätzen):
\`\`\`json
{"approach": "Ansatz in 2–5 Sätzen", "files": ["betroffene/Datei.java"], "steps": ["Schritt 1", "Schritt 2"], "risks": ["Risiko"], "questions": ["offene Frage an den Nutzer"], "tests": ["wie geprüft wird"]}
\`\`\``

export function parseProposal(text: string): Omit<Proposal, "at" | "round" | "text"> {
  const block = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(text)?.[1] ?? /(\{[\s\S]*"approach"[\s\S]*\})/.exec(text)?.[1]
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => oneLine(String(x))).filter(Boolean).slice(0, 40) : undefined)
  if (block) {
    try {
      const j = JSON.parse(block)
      return { approach: j.approach ? String(j.approach) : undefined, files: list(j.files), steps: list(j.steps), risks: list(j.risks), questions: list(j.questions), tests: list(j.tests) }
    } catch {
      // fall through to sections
    }
  }
  const section = (re: RegExp) => {
    const m = new RegExp(`^#{1,4}\\s*(${re.source})[^\\n]*\\n([\\s\\S]*?)(?=^#{1,4}\\s|$(?![\\s\\S]))`, "im").exec(text)
    return m?.[2]?.trim()
  }
  const items = (s?: string) => (s ? s.split("\n").map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim()).filter(Boolean) : undefined)
  return {
    approach: section(/ansatz|approach/),
    files: items(section(/dateien|files/)),
    steps: items(section(/schritte|steps/)),
    risks: items(section(/risiken|risks/)),
    questions: items(section(/fragen|offene fragen|questions/)),
    tests: items(section(/tests|prüfung/)),
  }
}

export function parseFindings(text: string): Finding[] {
  const block = /```(?:json)?\s*(\[[\s\S]*?\])\s*```/.exec(text)?.[1]
  if (!block) return []
  try {
    const arr = JSON.parse(block)
    if (!Array.isArray(arr)) return []
    return arr.slice(0, 60).map((f: AnyRecord): Finding => ({
      source: "ai",
      severity: f.severity === "error" ? "error" : f.severity === "info" ? "info" : "warn",
      file: f.file ? String(f.file) : undefined,
      line: Number.isFinite(Number(f.line)) && Number(f.line) > 0 ? Number(f.line) : undefined,
      text: truncate(oneLine(String(f.text ?? f.message ?? "")), 400),
    })).filter((f: Finding) => f.text)
  } catch {
    return []
  }
}

/** Deterministic review checks over a diff (idea 16). */
export function checkDiff(files: FileDiff[], proposalFiles: string[] | undefined, scan: (t: string) => string[], largeDeletion: number): Finding[] {
  const out: Finding[] = []
  const planned = (proposalFiles ?? []).map((f) => f.replace(/^\.\//, ""))
  for (const f of files) {
    if (planned.length && !planned.some((p) => f.path === p || f.path.endsWith(`/${p}`) || p.endsWith(`/${f.path}`) || (p.endsWith("/") && f.path.startsWith(p)))) {
      out.push({ source: "check", severity: "warn", file: f.path, text: "Datei liegt außerhalb des freigegebenen Vorschlags" })
    }
    const added = f.hunks.flatMap((h) => h.lines.filter((l) => l.type === "add"))
    const secrets = scan(added.map((l) => l.text).join("\n"))
    if (secrets.length) out.push({ source: "check", severity: "error", file: f.path, text: `mögliches Geheimnis im Diff (${secrets.join(", ")})` })
    if (f.deletions >= largeDeletion) out.push({ source: "check", severity: "warn", file: f.path, text: `große Löschung (${f.deletions} Zeilen)` })
    if (f.status === "deleted") out.push({ source: "check", severity: "warn", file: f.path, text: "Datei gelöscht" })
    for (const l of added) {
      if (/\b(TODO|FIXME|XXX)\b/.test(l.text)) out.push({ source: "check", severity: "info", file: f.path, line: l.newNo, text: `neues ${/\bFIXME\b/.test(l.text) ? "FIXME" : "TODO"}: ${truncate(l.text.trim(), 160)}` })
    }
  }
  return out
}

export class AgentTasks implements HubListener {
  readonly owner: string
  private jobs = new Map<string, AgentJob>()
  private timer?: ReturnType<typeof setInterval>
  private advancing = new Set<string>()
  private prepareTimer?: ReturnType<typeof setInterval>
  private lastPrepare = ""

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
    this.ctx.bus.emit("agent.job", { job: j.id, task: j.task, phase: j.phase, label: PHASE_LABEL[j.phase] })
  }

  all(): AgentJob[] {
    return listFiles(this.dir, ".json")
      .map((f) => readJson<AgentJob | null>(join(this.dir, f), null))
      .filter((j): j is AgentJob => !!j?.id)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  get(id: string): AgentJob | undefined {
    return this.jobs.get(id) ?? readJson<AgentJob | null>(this.file(id), null) ?? undefined
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

  statusOf(task: string): { status: string; label: string; job?: string } | undefined {
    const j = this.ofTask(task)
    if (!j) return undefined
    const waiting = j.permissions.length ? "braucht Antwort" : undefined
    return { status: j.permissions.length ? "permission" : j.phase, label: waiting ?? PHASE_LABEL[j.phase], job: j.id }
  }

  private client(): AnyRecord {
    return this.ctx.client
  }

  private q(j: AgentJob): { directory: string } {
    return { directory: j.workdir }
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
      const job = this.all().find((j) => j.task === e.name && (j.phase === "accepted" || j.phase === "in_test"))
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
    const body = task.body.replace(/<!-- vorschlag:start -->[\s\S]*?<!-- vorschlag:end -->/, "").trim()
    if (body) lines.push("## Beschreibung", body, "")
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

  // ---------------------------------------------------------------------------
  // assignment and phases
  // ---------------------------------------------------------------------------

  private guard(j: AgentJob): void {
    const o = this.ctx.options.tasks
    const write = j.phase === "implementing" || j.phase === "fixing" || j.phase === "checking"
    for (const root of [j.session, j.reviewSession].filter((x): x is string => !!x)) {
      guardSession(root, { job: j.id, write: root === j.reviewSession ? false : write, allowBash: root === j.reviewSession ? false : o.planAllowBash, writeTools: o.writeTools, owner: this.owner })
    }
  }

  private async userRun(trigger: string, actor: "web" | "command" = "web"): Promise<Run> {
    return this.ctx.runs.create({ smith: "memorysmith", actor, trigger, writeMode: "auto", directory: this.ctx.directory, project: this.ctx.project, limits: { maxNew: 100, maxChanges: 100, maxNotes: 0 } })
  }

  /** Writes the plugin does on behalf of an agent task (card moves, proposal) – audit actor "agent". */
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
    const chosen = await this.jobModel(input.agent, input.model?.trim() || undefined)
    const model = chosen.spec
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
      model,
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
      sessions: {},
      proposals: [],
      fixRounds: 0,
      improveRounds: 0,
      pipelineRuns: [],
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
    const fields = { ...this.ctx.tasks.require(task.name).fields, agent: input.agent, model: model ?? "", ...(workplace === "worktree" ? { worktree: workdir } : { worktree: "" }) }
    await this.ctx.ops.update(run, "task", { name: task.name, fields, reason: `an ${input.agent} übergeben`, approved: true })
    try {
      const session = unwrap<AnyRecord>(await this.client().session.create({ body: { title: `${taskId(task.name)}: ${truncate(task.title, 60)}` }, query: this.q(job) }))
      job.session = session.id
      job.sessions[session.id] = { id: session.id, agent: input.agent, title: session.title, status: "busy", startedAt: Date.now(), updatedAt: Date.now(), tokens: 0, cost: 0 }
      job.timeline.push({ at: Date.now(), session: session.id, event: "start", agent: input.agent })
      job.phase = "proposal"
      this.guard(job)
      await this.prompt(job, `${brief.text}\n\n---\nPHASE 1 – VORSCHLAG. Ändere noch nichts: Schreibwerkzeuge${o.planAllowBash ? "" : " und bash"} sind bis zur Freigabe gesperrt, auch für Subagenten. Lies den Code, kläre den Ansatz und plane die Umsetzung.\n\n${PROPOSAL_FORMAT}`, false)
    } catch (err) {
      job.phase = "error"
      job.error = errorMessage(err)
      this.save(job)
      throw new GuardError(`Agent konnte nicht gestartet werden: ${job.error}`)
    }
    this.save(job)
    this.ctx.audit?.append({ actor: "user-web", category: "agent", action: "assign", targets: [`task:${task.name}`], result: "ok", message: `${id}: ${input.agent}${model ? ` (${model})` : ""}, ${workplace}${branch ? ` ${branch}` : ""}${chosen.note ? ` – Modell: ${chosen.note}` : ""}`, session: job.session, project: project.name, agent: input.agent, model })
    this.ctx.metrics?.record({ type: M.agentRun, entry: `agent:${input.agent}`, origin: "web", agent: input.agent, model, project: project.name, session: job.session, extra: { phase: "start", task: task.name, prepared: !!input.prepared } })
    this.start()
    return job
  }

  private async prompt(j: AgentJob, text: string, write: boolean, session = j.session): Promise<void> {
    if (!session) throw new GuardError("Auftrag hat keine Session")
    const o = this.ctx.options.tasks
    // opencode 1.x turns `tools` of a prompt into session permissions that stay for every later
    // prompt (and are inherited by subagents) – an "allow" afterwards would override the user's own
    // permission rules. The main session therefore gets no `tools`: the phase is enforced by the
    // plugin guard over the whole session tree. Only the review session (never writes) drops them.
    const tools: Record<string, boolean> = {}
    if (!write && session === j.reviewSession) {
      for (const t of o.writeTools) tools[t] = false
      tools.bash = false
    }
    setWrite(j.id, write)
    const modelRef = parseModel(session === j.reviewSession ? (j.reviewModel ?? j.model) : j.model)
    const info = j.sessions[session]
    if (info) {
      info.status = "busy"
      info.updatedAt = Date.now()
    }
    unwrap(
      await this.client().session.promptAsync({
        path: { id: session },
        query: this.q(j),
        body: { agent: session === j.reviewSession ? o.reviewAgent || j.agent : j.agent, ...(modelRef ? { model: modelRef } : {}), ...(Object.keys(tools).length ? { tools } : {}), parts: [{ type: "text", text }] },
      }),
    )
  }

  /** Approve the last proposal: written into the task (commit), card to "in Umsetzung", same session continues with write access. */
  async approve(run: Run, id: string, input: { comments?: string; answers?: string } = {}): Promise<AgentJob> {
    const j = this.require(id)
    if (j.phase !== "awaiting_approval") throw new GuardError(`Auftrag wartet nicht auf Freigabe (${PHASE_LABEL[j.phase]})`)
    const p = j.proposals[j.proposals.length - 1]
    p.verdict = "approved"
    p.comments = input.comments?.trim() || undefined
    p.answers = input.answers?.trim() || undefined
    const task = this.ctx.tasks.require(j.task)
    const section = proposalSection(p)
    const body = /<!-- vorschlag:start -->[\s\S]*?<!-- vorschlag:end -->/.test(task.body)
      ? task.body.replace(/<!-- vorschlag:start -->[\s\S]*?<!-- vorschlag:end -->/, section)
      : `${task.body.trim()}\n\n${section}`.trim()
    await this.ctx.ops.update(run, "task", { name: task.name, body, reason: `Vorschlag ${p.round} von ${j.agent} freigegeben`, approved: true })
    const cols = this.ctx.tasks.columns(j.project)
    const implementCol = cols.includes("in_umsetzung") ? "in_umsetzung" : cols[Math.min(2, cols.length - 2)]
    if (str(this.ctx.tasks.require(task.name).fields.status) !== implementCol) await this.ctx.tasks.move(run, task.name, implementCol, { force: true, agent: true })
    j.phase = "implementing"
    j.messages.push({ at: nowIso(), from: "user", text: `Freigegeben${p.comments ? `: ${p.comments}` : ""}` })
    this.save(j)
    this.ctx.metrics?.record({ type: M.agentProposal, entry: `agent:${j.agent}`, origin: "web", agent: j.agent, model: j.model, project: j.project, extra: { verdict: "approved", round: p.round, labels: task.tags, task: j.task } })
    this.ctx.audit?.append({ actor: "user-web", category: "agent", action: "approve", targets: [`task:${j.task}`], result: "ok", message: `${j.id}: Vorschlag ${p.round}`, session: j.session, project: j.project, agent: j.agent })
    await this.prompt(
      j,
      `PHASE 2 – UMSETZUNG freigegeben.${p.comments ? `\nKommentare des Nutzers:\n${p.comments}` : ""}${p.answers ? `\nAntworten auf deine Fragen:\n${p.answers}` : ""}\nSetze den freigegebenen Vorschlag jetzt um. Committe und pushe nicht. Schreibe am Ende eine kurze Zusammenfassung: was geändert wurde, welche Dateien, wie es getestet wurde.`,
      true,
    )
    return j
  }

  /** Revise: comments go back into the same session (still read-only); the reason may become a rule (idea 17). */
  async revise(id: string, comments: string): Promise<AgentJob> {
    const j = this.require(id)
    if (j.phase !== "awaiting_approval") throw new GuardError(`Auftrag wartet nicht auf Freigabe (${PHASE_LABEL[j.phase]})`)
    const text = comments.trim()
    if (text.length < 3) throw new GuardError("Bitte sagen, was überarbeitet werden soll")
    const p = j.proposals[j.proposals.length - 1]
    p.verdict = "revise"
    p.comments = text
    j.phase = "revising"
    j.messages.push({ at: nowIso(), from: "user", text: `Überarbeiten: ${text}` })
    this.save(j)
    this.learn(j, text)
    this.ctx.metrics?.record({ type: M.agentProposal, entry: `agent:${j.agent}`, origin: "web", agent: j.agent, model: j.model, project: j.project, extra: { verdict: "revise", round: p.round, task: j.task } })
    this.ctx.audit?.append({ actor: "user-web", category: "agent", action: "revise", targets: [`task:${j.task}`], result: "ok", message: `${j.id}: ${truncate(text, 300)}`, session: j.session, project: j.project, agent: j.agent })
    await this.prompt(j, `Der Nutzer möchte den Vorschlag überarbeitet haben:\n${text}\n\nÄndere weiterhin nichts. Überarbeite den Vorschlag.\n\n${PROPOSAL_FORMAT}`, false)
    return j
  }

  /** Message into a running session (any phase; tool restrictions of the phase stay). */
  async message(id: string, text: string, session?: string): Promise<void> {
    const j = this.require(id)
    if (FINAL.has(j.phase)) throw new GuardError("Auftrag ist beendet")
    const sid = session && j.sessions[session] ? session : j.session
    j.messages.push({ at: nowIso(), from: "user", text, session: sid })
    this.save(j)
    const write = j.phase === "implementing" || j.phase === "fixing"
    await this.prompt(j, text, write && sid !== j.reviewSession, sid)
  }

  /** Nachbessern: the user's hint goes into the same session with write access; the reason may become a rule. */
  async improve(run: Run, id: string, text: string): Promise<AgentJob> {
    const j = this.require(id)
    if (j.phase !== "in_test") throw new GuardError(`Nachbessern geht erst nach der Umsetzung (${PHASE_LABEL[j.phase]})`)
    if (text.trim().length < 3) throw new GuardError("Bitte sagen, was nachgebessert werden soll")
    j.improveRounds++
    j.phase = "implementing"
    j.review = undefined
    j.messages.push({ at: nowIso(), from: "user", text: `Nachbessern: ${text}` })
    this.save(j)
    this.learn(j, text)
    const cols = this.ctx.tasks.columns(j.project)
    const implementCol = cols.includes("in_umsetzung") ? "in_umsetzung" : cols[Math.min(2, cols.length - 2)]
    await this.ctx.tasks.move(run, j.task, implementCol, { force: true, agent: true }).catch(() => undefined)
    this.ctx.audit?.append({ actor: "user-web", category: "agent", action: "improve", targets: [`task:${j.task}`], result: "ok", message: `${j.id}: ${truncate(text, 300)}`, session: j.session, project: j.project, agent: j.agent })
    await this.prompt(j, `Der Nutzer bittet um Nachbesserung:\n${text}\n\nBessere nach und fasse am Ende kurz zusammen, was du geändert hast.`, true)
    return j
  }

  async abort(id: string, session?: string): Promise<AgentJob> {
    const j = this.require(id)
    const ids = session ? [session] : Object.keys(j.sessions)
    for (const sid of ids) await this.client().session.abort({ path: { id: sid }, query: this.q(j) }).catch(() => undefined)
    if (!session || session === j.session) {
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
    } else if (j.session) {
      const msgs = unwrap<AnyRecord[]>(await this.client().session.messages({ path: { id: j.session }, query: this.q(j) }).catch(() => ({ data: [] })))
      const firstUser = (msgs ?? []).find((m) => m.info?.role === "user")
      if (firstUser) await this.client().session.revert({ path: { id: j.session }, query: this.q(j), body: { messageID: firstUser.info.id } }).catch(() => undefined)
    }
    j.phase = "discarded"
    j.endedAt = nowIso()
    unguardJob(j.id)
    this.save(j)
    const cols = this.ctx.tasks.columns(j.project)
    await this.ctx.tasks.move(run, j.task, cols[Math.min(1, cols.length - 1)], { force: true, agent: true }).catch(() => undefined)
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
   * Acceptance (column "done", only by the user): commit the worktree on its branch and
   * merge it, push it for a pull request, or discard it.
   */
  async accept(run: Run, id: string, mode: "merge" | "pr" | "keep" | "discard"): Promise<{ message: string; url?: string }> {
    const j = this.require(id)
    if (j.phase !== "in_test" && j.phase !== "accepted") throw new GuardError(`Abnahme erst nach der Umsetzung (${PHASE_LABEL[j.phase]})`)
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
    j.phase = "accepted"
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
      extra: { phase: "accepted", mode, task: j.task, labels: task.tags, rounds: j.proposals.length, fixRounds: j.fixRounds, improveRounds: j.improveRounds, firstGreen: j.pipelineFirstGreen, findings: j.review?.findings.length ?? 0, tokens: j.tokens },
    })
    return { message, url }
  }

  // ---------------------------------------------------------------------------
  // progress: events, polling, phase transitions
  // ---------------------------------------------------------------------------

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.poll(), 3000)
    ;(this.timer as any).unref?.()
    if (!this.prepareTimer && this.ctx.options.tasks.prepare) {
      this.prepareTimer = setInterval(() => void this.prepareTick(), 60_000)
      ;(this.prepareTimer as any).unref?.()
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.prepareTimer) clearInterval(this.prepareTimer)
    this.timer = undefined
    this.prepareTimer = undefined
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
        if (WAITING.has(j.phase) && (await this.settled(j))) {
          this.advancing.add(j.id)
          try {
            await this.advance(j)
          } finally {
            this.advancing.delete(j.id)
          }
        }
        this.save(j)
      } catch (err) {
        this.ctx.log.debug(`agent job ${j.id} poll failed`, errorMessage(err))
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
    const roots = [j.session, j.reviewSession].filter((x): x is string => !!x)
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

  /** The current phase's session tree is idle and the last answer is complete. */
  private async settled(j: AgentJob): Promise<boolean> {
    const root = j.phase === "reviewing" ? j.reviewSession : j.session
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

  private async advance(j: AgentJob): Promise<void> {
    const root = j.phase === "reviewing" ? j.reviewSession! : j.session!
    const last = await this.lastAssistant(j, root)
    if (!last) return
    if (last.error && !last.text) {
      j.phase = "error"
      const hint = modelErrorHint(last.error, await modelCatalog(this.client()))
      j.error = hint ? `${last.error} – ${hint}` : last.error
      j.endedAt = nowIso()
      unguardJob(j.id)
      notify(this.ctx, "agent-error", `Agent ${j.agent} · ${taskId(j.task)}`, truncate(last.error, 200), { variant: "error", link: `#/agenten/${j.id}` })
      return
    }
    switch (j.phase) {
      case "proposal":
      case "revising": {
        const text = this.ctx.redactor.redact(last.text)
        j.proposals.push({ at: nowIso(), round: j.proposals.length + 1, text, ...parseProposal(text) })
        j.phase = "awaiting_approval"
        this.ctx.audit?.append({ actor: "agent", category: "agent", action: "proposal", targets: [`task:${j.task}`], result: "proposed", message: `${j.id}: Vorschlag ${j.proposals.length}`, session: j.session, project: j.project, agent: j.agent, model: j.model })
        this.ctx.metrics?.record({ type: M.agentProposal, entry: `agent:${j.agent}`, origin: "background", agent: j.agent, model: j.model, project: j.project, extra: { verdict: "created", round: j.proposals.length, task: j.task } })
        notify(this.ctx, "proposal", `Vorschlag fertig · ${taskId(j.task)}`, `${j.agent}: ${truncate(j.proposals[j.proposals.length - 1].approach ?? text, 160)}`, { variant: "info", link: `#/agenten/${j.id}` })
        return
      }
      case "implementing":
      case "fixing": {
        j.summary = truncate(this.ctx.redactor.redact(last.text), 4000)
        await this.check(j)
        return
      }
      case "reviewing": {
        const findings = parseFindings(last.text)
        j.review = { at: nowIso(), status: "done", findings: [...(j.review?.findings.filter((f) => f.source === "check") ?? []), ...findings], summary: truncate(this.ctx.redactor.redact(last.text.replace(/```[\s\S]*?```/g, "").trim()), 1500) }
        await this.finish(j)
        return
      }
    }
  }

  /** After the implementation: pipeline in the work directory, automatic fix rounds, then review. */
  private async check(j: AgentJob): Promise<void> {
    const project = j.project ? this.ctx.projects.get(j.project) : undefined
    if (!project?.pipeline?.stages.length) {
      await this.toTest(j)
      return
    }
    j.phase = "checking"
    setWrite(j.id, false)
    this.save(j)
    const run = await this.ctx.pipeline.start({ project: project.name, task: j.task, trigger: j.fixRounds ? "fix" : "agent", by: `agent:${j.agent}`, workdir: j.workdir, branch: j.branch })
    j.pipelineRuns.push(run.id)
    if (j.pipelineFirstGreen === undefined) j.pipelineFirstGreen = run.status === "success"
    if (run.status !== "success" && run.status !== "aborted" && j.fixRounds < this.ctx.options.tasks.autoFixRounds) {
      j.fixRounds++
      j.phase = "fixing"
      const stage = run.stages.find((s) => s.status === "failed" || s.status === "timeout")
      const log = this.ctx.pipeline.log(project.name, run.id).text
      const failed = run.tests?.failed.slice(0, 15).map((t) => `- ${t.suite}.${t.name}: ${t.message ?? ""}`).join("\n")
      this.save(j)
      await this.prompt(
        j,
        `Die Prüfbefehle des Projekts sind rot (Stufe ${stage?.name ?? "?"}: ${stage?.run ?? ""}).${failed ? `\nFehlgeschlagene Tests:\n${failed}` : ""}\n\nEnde des Logs:\n\`\`\`\n${truncate(log.slice(-6000), 6000)}\n\`\`\`\nBessere nach, bis die Prüfung grün ist, und fasse am Ende zusammen, was du geändert hast.`,
        true,
      )
      return
    }
    await this.toTest(j)
  }

  /** Card to "test" (never done), deterministic checks and the read-only review session. */
  private async toTest(j: AgentJob): Promise<void> {
    const cols = this.ctx.tasks.columns(j.project)
    const testCol = cols.includes("test") ? "test" : cols[cols.length - 2]
    await this.systemWrite(`${j.task} → ${testCol}`, (run) => this.ctx.tasks.move(run, j.task, testCol, { force: true, agent: true }))
    let files: FileDiff[] = []
    try {
      files = await this.diff(j)
      j.diffStat = { files: files.length, additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0) }
    } catch (err) {
      this.ctx.log.debug("agent diff failed", errorMessage(err))
    }
    const approved = [...j.proposals].reverse().find((p) => p.verdict === "approved")
    const checks = checkDiff(files, approved?.files, (t) => this.ctx.redactor.scan(t), this.ctx.options.tasks.largeDeletion)
    j.review = { at: nowIso(), status: "running", findings: checks }
    if (!this.ctx.options.tasks.review || !files.length) {
      j.review.status = "done"
      await this.finish(j)
      return
    }
    try {
      const session = unwrap<AnyRecord>(await this.client().session.create({ body: { title: `Review ${taskId(j.task)}` }, query: this.q(j) }))
      j.reviewSession = session.id
      const reviewAgent = this.ctx.options.tasks.reviewAgent
      if (reviewAgent && reviewAgent !== j.agent) {
        // the review agent's own model when it has a usable one, otherwise the job's
        const own = await this.jobModel(reviewAgent).catch(() => ({ spec: undefined, note: undefined }))
        const agentSpec = await agentModelSpec(this.client(), reviewAgent)
        j.reviewModel = agentSpec && own.spec && !own.note ? own.spec : j.model
      }
      j.sessions[session.id] = { id: session.id, agent: this.ctx.options.tasks.reviewAgent || j.agent, title: session.title, status: "busy", startedAt: Date.now(), updatedAt: Date.now(), tokens: 0, cost: 0 }
      j.timeline.push({ at: Date.now(), session: session.id, event: "start", agent: this.ctx.options.tasks.reviewAgent || j.agent })
      j.phase = "reviewing"
      this.guard(j)
      const diffText = files
        .map((f) => `--- ${f.path} (${f.status}, +${f.additions}/−${f.deletions})\n${f.hunks.map((h) => h.lines.map((l) => `${l.type === "add" ? "+" : l.type === "del" ? "-" : " "}${l.text}`).join("\n")).join("\n...\n")}`)
        .join("\n\n")
      await this.prompt(
        j,
        `Du prüfst die Umsetzung einer Aufgabe, nur lesend (keine Änderungen).\n\n${j.brief}\n\n## Freigegebener Vorschlag\n${approved?.text ?? "(keiner)"}\n\n## Diff\n\`\`\`diff\n${truncate(this.ctx.redactor.redact(diffText), 60_000)}\n\`\`\`\n\nVergleiche den Diff mit dem Vorschlag und den Vorgaben. Antworte mit einer kurzen Einschätzung und den Befunden als JSON-Liste:\n\`\`\`json\n[{"file": "pfad", "line": 12, "severity": "warn", "text": "Befund"}]\n\`\`\`\n(severity: info, warn oder error; leere Liste, wenn alles passt)`,
        false,
        session.id,
      )
    } catch (err) {
      j.review.status = "error"
      j.review.summary = errorMessage(err)
      await this.finish(j)
    }
  }

  private async finish(j: AgentJob): Promise<void> {
    j.phase = "in_test"
    setWrite(j.id, false)
    if (j.review && j.review.status === "running") j.review.status = "done"
    this.ctx.audit?.append({ actor: "agent", category: "agent", action: "done", targets: [`task:${j.task}`], result: "ok", message: `${j.id}: ${j.diffStat ? `${j.diffStat.files} Datei(en)` : "fertig"}${j.review ? `, ${j.review.findings.length} Befund(e)` : ""}`, session: j.session, project: j.project, agent: j.agent, model: j.model })
    notify(this.ctx, "agent-done", `Fertig · ${taskId(j.task)}`, `${j.agent}: ${truncate(j.summary ?? "Umsetzung fertig", 160)}`, { variant: "success", link: `#/agenten/${j.id}` })
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
  // learning from corrections (idea 17) and prepared proposals (idea 21)
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

  /** Planned tasks assigned to an agent get their proposal without supervision (idea 21). */
  async prepareProposals(reason: string): Promise<number> {
    const o = this.ctx.options.tasks
    if (!o.agents || !o.prepare) return 0
    let started = 0
    for (const t of this.ctx.tasks.list({ project: "*" })) {
      const cols = this.ctx.tasks.columns(t.project)
      if (t.status !== cols[1] || t.assignee !== "agent" || !t.agent || !t.project) continue
      if (this.all().some((j) => j.task === t.name && (!FINAL.has(j.phase) || j.prepared))) continue
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

  private async prepareTick(): Promise<void> {
    const times = this.ctx.options.tasks.prepareAt
    if (!times.length) return
    const now = new Date()
    const hm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`
    const key = `${now.toDateString()} ${hm}`
    if (this.lastPrepare === key) return
    if (!times.some((t) => t.padStart(5, "0") === hm)) return
    this.lastPrepare = key
    await this.prepareProposals(`prepareAt ${hm}`).catch(() => 0)
  }

  // ---------------------------------------------------------------------------
  // live view and statistics
  // ---------------------------------------------------------------------------

  tree(id: string): AnyRecord {
    const j = this.require(id)
    return {
      job: { ...j, brief: undefined },
      label: PHASE_LABEL[j.phase],
      sessions: Object.values(j.sessions).sort((a, b) => a.startedAt - b.startedAt),
    }
  }

  /** Agent evaluation (idea 24): per agent and model, also per label. */
  stats(days = 90): Array<{ agent: string; model: string; jobs: number; approvedFirst: number; revisions: number; fixRounds: number; improveRounds: number; firstGreen: number; withPipeline: number; findings: number; avgMinutes: number; tokens: number; cost: number; labels: Record<string, number>; subagents: Record<string, number> }> {
    const from = Date.now() - days * 86_400_000
    const groups = new Map<string, ReturnType<AgentTasks["stats"]>[number]>()
    for (const j of this.all()) {
      if (Date.parse(j.startedAt) < from) continue
      const k = `${j.agent}|${j.model ?? ""}`
      const g = groups.get(k) ?? { agent: j.agent, model: j.model ?? "(Standard)", jobs: 0, approvedFirst: 0, revisions: 0, fixRounds: 0, improveRounds: 0, firstGreen: 0, withPipeline: 0, findings: 0, avgMinutes: 0, tokens: 0, cost: 0, labels: {}, subagents: {} }
      g.jobs++
      if (j.proposals[0]?.verdict === "approved") g.approvedFirst++
      g.revisions += j.proposals.filter((p) => p.verdict === "revise").length
      g.fixRounds += j.fixRounds
      g.improveRounds += j.improveRounds
      if (j.pipelineFirstGreen !== undefined) {
        g.withPipeline++
        if (j.pipelineFirstGreen) g.firstGreen++
      }
      g.findings += j.review?.findings.length ?? 0
      if (j.endedAt) g.avgMinutes += (Date.parse(j.endedAt) - Date.parse(j.startedAt)) / 60_000
      g.tokens += j.tokens
      g.cost += j.cost
      const task = this.ctx.tasks.get(j.task)
      for (const l of task?.tags ?? []) g.labels[l] = (g.labels[l] ?? 0) + 1
      for (const s of Object.values(j.sessions)) if (s.parent && s.agent) g.subagents[s.agent] = (g.subagents[s.agent] ?? 0) + 1
      groups.set(k, g)
    }
    return [...groups.values()].map((g) => ({ ...g, avgMinutes: g.jobs ? Math.round(g.avgMinutes / g.jobs) : 0, cost: Math.round(g.cost * 10000) / 10000 }))
  }
}

/** The approved proposal as a section of the task text (versioned with the task). */
export function proposalSection(p: Proposal): string {
  const list = (title: string, items?: string[]) => (items?.length ? `**${title}**\n${items.map((x) => `- ${x}`).join("\n")}\n` : "")
  return [
    "<!-- vorschlag:start -->",
    `## Vorschlag (Runde ${p.round}, freigegeben ${p.at.slice(0, 10)})`,
    p.approach ? `${p.approach}\n` : truncate(p.text, 4000),
    list("Dateien", p.files),
    list("Schritte", p.steps),
    list("Risiken", p.risks),
    list("Tests", p.tests),
    p.comments ? `**Kommentare**\n${p.comments}\n` : "",
    p.answers ? `**Antworten**\n${p.answers}\n` : "",
    "<!-- vorschlag:end -->",
  ]
    .filter(Boolean)
    .join("\n")
}
