/**
 * Gym (5d): does an entry really help the agents? A/B runs of the same task without (arm A)
 * and with the entry (arm B), at least gym.runsPerArm runs per arm, same model, the normal
 * build agent. Only deterministically checkable tasks:
 *
 *   contains       the answer contains a text
 *   order          texts appear in this order in the answer
 *   executed       a shell command containing the text was run
 *   exit0          a shell command containing the text ran with exit code 0
 *   output_equals  (mode "arbeiten") a command run in the work directory afterwards prints exactly this
 *
 * Tasks are stored in the store (gym/<id>.json, versioned); they come from the user or are
 * proposed from earlier sessions (later sessions weigh more) and must be confirmed. The
 * prompt may not contain what the checks look for (no leaking of the solution).
 *
 * Safety: MCP tools, web and subagents are switched off in every gym session; modes "fragen"
 * (answer only), "lesen" (read tools) and "arbeiten" (git worktree of the project, shell).
 * The entry reaches arm B the way it would in a session: as hint block. Verdicts: hilft,
 * neutral, schadet, ungenutzt. Consequences are a report at first; with gym.consequence
 * "archivieren" an entry is archived only after 2 confirmed rounds on different days
 * (knowledge and glossary are only taken out of the hints).
 */
import { execFile } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseModel } from "../config"
import type { Entry, Kind } from "../types"
import { listFiles, readJson, removePath, withLock, writeJsonAtomic } from "../util/fs"
import { fold, nowIso, shortId, slugify, truncate } from "../util/text"
import { runAgentSession, unwrap, type ModelRef } from "./agent-runner"
import type { Ctx } from "./context"
import { finalizeRun } from "./finalize"
import { str } from "./frontmatter"
import { gitIn } from "./git"
import { GuardError } from "./ops"
import { expandPath } from "./projects"
import { lastModel } from "./state"

export const GYM_MODES = ["fragen", "lesen", "arbeiten"] as const
export type GymMode = (typeof GYM_MODES)[number]
export const CHECK_TYPES = ["contains", "order", "executed", "exit0", "output_equals"] as const
export type CheckType = (typeof CHECK_TYPES)[number]

export interface GymCheck {
  type: CheckType
  /** contains / executed / exit0: text; output_equals: command */
  text?: string
  items?: string[]
  expected?: string
}

export interface GymTask {
  id: string
  /** entry under test ("kind:name") */
  entry: string
  title: string
  prompt: string
  mode: GymMode
  checks: GymCheck[]
  /** project whose home_path is the work directory (mode arbeiten) */
  project?: string
  status: "aktiv" | "vorgeschlagen" | "verworfen"
  /** sessions the task was seen in (later sessions weigh more) */
  sessions: string[]
  weight: number
  createdAt: string
  createdBy: "user" | "gym"
}

export type GymVerdict = "hilft" | "neutral" | "schadet" | "ungenutzt"

export interface ArmResult {
  runs: number
  passed: number
  used: number
  errors: number
}

export interface GymRound {
  at: string
  day: string
  task: string
  entry: string
  model?: string
  a: ArmResult
  b: ArmResult
  verdict: GymVerdict
  details: string[]
}

interface GymState {
  rounds: GymRound[]
  /** knowledge / glossary taken out of the hints after a confirmed "schadet" */
  suppressed: Record<string, { at: string; reason: string }>
  archived: Record<string, string>
}

export interface ToolCall {
  tool: string
  command?: string
  output?: string
  exit?: number
}

export interface Transcript {
  answer: string
  calls: ToolCall[]
}

/** Text the checks look for must not appear in the prompt. */
export function leaks(task: Pick<GymTask, "prompt" | "checks">): string[] {
  const p = fold(task.prompt)
  const out: string[] = []
  for (const c of task.checks) {
    const texts = c.type === "order" ? (c.items ?? []) : c.type === "contains" ? [c.text ?? ""] : c.type === "output_equals" ? [c.expected ?? ""] : []
    for (const t of texts) if (t.trim().length >= 3 && p.includes(fold(t.trim()))) out.push(t.trim())
  }
  return out
}

export function validateTask(t: Partial<GymTask>): string | undefined {
  if (!t.entry || !/^[a-z]+:[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(t.entry)) return "Eintrag fehlt (kind:name)"
  if (!t.prompt || t.prompt.trim().length < 10) return "Aufgabe zu kurz"
  if (!t.mode || !(GYM_MODES as readonly string[]).includes(t.mode)) return `Modus muss ${GYM_MODES.join(", ")} sein`
  if (!t.checks?.length) return "mindestens eine Prüfung"
  for (const c of t.checks) {
    if (!(CHECK_TYPES as readonly string[]).includes(c.type)) return `Prüfung ${c.type} unbekannt`
    if (c.type === "order" && (c.items?.length ?? 0) < 2) return "Reihenfolge braucht mindestens zwei Texte"
    if (c.type !== "order" && !c.text?.trim()) return `Prüfung ${c.type} braucht einen Text`
    if (c.type === "output_equals" && (t.mode !== "arbeiten" || c.expected === undefined)) return "output_equals nur im Modus arbeiten und mit erwarteter Ausgabe"
    if ((c.type === "executed" || c.type === "exit0") && t.mode === "fragen") return `${c.type} braucht den Modus lesen oder arbeiten`
  }
  const l = leaks(t as GymTask)
  if (l.length) return `Die Aufgabe verrät die Lösung („${l.join("“, „")}“) – anders formulieren`
  return undefined
}

/** Answer and tool calls of a session (opencode message structure). */
export function transcriptOf(msgs: any[]): Transcript {
  const calls: ToolCall[] = []
  let answer = ""
  for (const m of msgs ?? []) {
    if (m?.info?.role !== "assistant") continue
    for (const p of m.parts ?? []) {
      if (p?.type === "text" && p.text) answer = `${answer}\n${p.text}`.trim()
      if (p?.type === "tool") {
        const st = p.state ?? {}
        const exit = st.metadata?.exit ?? st.metadata?.exitCode
        calls.push({ tool: String(p.tool), command: typeof st.input?.command === "string" ? st.input.command : undefined, output: typeof st.output === "string" ? st.output : undefined, exit: typeof exit === "number" ? exit : undefined })
      }
    }
  }
  return { answer, calls }
}

/** Deterministic checks against a transcript (output_equals is evaluated separately). */
export function evaluate(checks: GymCheck[], t: Transcript, outputs: Record<string, string> = {}): { ok: boolean; failed: string[] } {
  const answer = fold(t.answer)
  const failed: string[] = []
  const shell = t.calls.filter((c) => c.command !== undefined)
  for (const c of checks) {
    const want = fold(c.text ?? "")
    let ok = false
    if (c.type === "contains") ok = answer.includes(want)
    else if (c.type === "order") {
      let pos = -1
      ok = (c.items ?? []).every((it) => {
        const i = answer.indexOf(fold(it), pos + 1)
        if (i < 0) return false
        pos = i
        return true
      })
    } else if (c.type === "executed") ok = shell.some((x) => fold(x.command!).includes(want))
    else if (c.type === "exit0") ok = shell.some((x) => fold(x.command!).includes(want) && x.exit === 0)
    else if (c.type === "output_equals") ok = (outputs[c.text ?? ""] ?? "\u0000").trim() === (c.expected ?? "").trim()
    if (!ok) failed.push(`${c.type} ${c.text ?? (c.items ?? []).join(" → ")}`)
  }
  return { ok: !failed.length, failed }
}

export function verdictOf(a: ArmResult, b: ArmResult): GymVerdict {
  const ra = a.runs ? a.passed / a.runs : 0
  const rb = b.runs ? b.passed / b.runs : 0
  if (!b.used && Math.abs(rb - ra) < 0.34) return "ungenutzt"
  if (rb - ra >= 0.34) return "hilft"
  if (ra - rb >= 0.34) return "schadet"
  return "neutral"
}

/** The hint block arm B gets (as the plugin would inject it). */
export function hintBlock(e: Entry): string {
  const body = truncate(e.body, 4000)
  return `<smith_hints source="skillsmith">\nPassender ${e.kind === "skill" ? "Skill" : "Eintrag"} „${e.title}“ (${e.kind}:${e.name}): ${e.description}\n\n${body}\n</smith_hints>`
}

/** Tool switches per mode: MCP / plugin tools (name_with_underscore), web and subagents are always off. */
export function toolsFor(mode: GymMode): Record<string, boolean> {
  const off = { "*_*": false, webfetch: false, websearch: false, task: false, skill: false }
  if (mode === "fragen") return { ...off, bash: false, edit: false, write: false, patch: false, read: false, glob: false, grep: false, list: false }
  if (mode === "lesen") return { ...off, bash: false, edit: false, write: false, patch: false }
  return off
}

const usedIn = (e: Entry, t: Transcript): boolean => {
  const hay = fold(`${t.answer}\n${t.calls.map((c) => `${c.command ?? ""}`).join("\n")}`)
  const marks = [e.name, e.title].filter((x) => x && x.length >= 6).map((x) => fold(x))
  // a distinctive line of the entry (≥ 20 chars, code or step) shows up in what the agent did
  const lines = e.body
    .split("\n")
    .map((l) => l.replace(/^[\s>*\-\d.`]+|`+$/g, "").trim())
    .filter((l) => l.length >= 20)
    .slice(0, 30)
    .map((l) => fold(l).slice(0, 40))
  return marks.some((m) => hay.includes(m)) || lines.some((l) => hay.includes(l))
}

export class Gym {
  constructor(private ctx: Ctx) {}

  private get dir(): string {
    return join(this.ctx.store.root, "gym")
  }
  private get stateFile(): string {
    return join(this.ctx.store.stateDir, "gym.json")
  }

  state(): GymState {
    return readJson<GymState>(this.stateFile, { rounds: [], suppressed: {}, archived: {} })
  }

  tasks(): GymTask[] {
    return listFiles(this.dir, ".json")
      .map((f) => readJson<GymTask | null>(join(this.dir, f), null))
      .filter((t): t is GymTask => !!t && !!t.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  task(id: string): GymTask | undefined {
    return this.tasks().find((t) => t.id === id)
  }

  /** Latest verdict of an entry (quality score, gym view). */
  verdict(entry: string): { verdict: GymVerdict; at: string } | undefined {
    const r = this.state().rounds.filter((x) => x.entry === entry).pop()
    return r ? { verdict: r.verdict, at: r.at } : undefined
  }

  /** Hints leave out knowledge / glossary the gym found harmful (confirmed). */
  suppressed(entry: string): boolean {
    return !!this.state().suppressed[entry]
  }

  /** Save a task (run of the user, one commit gym/<id>.json). */
  async save(run: import("../types").Run, input: Omit<GymTask, "id" | "createdAt" | "createdBy" | "sessions" | "weight" | "status"> & { id?: string; status?: GymTask["status"] }): Promise<GymTask> {
    const err = validateTask(input)
    if (err) throw new GuardError(err)
    const i = input.entry.indexOf(":")
    if (!this.ctx.store.getOwned(input.entry.slice(0, i) as Kind, input.entry.slice(i + 1))) throw new GuardError(`Eintrag ${input.entry} nicht gefunden`)
    const prev = input.id ? this.task(input.id) : undefined
    const task: GymTask = {
      id: prev?.id ?? `g-${slugify(input.title || input.entry, 30)}-${shortId(4)}`,
      entry: input.entry,
      title: truncate(input.title || input.prompt, 120),
      prompt: input.prompt.trim(),
      mode: input.mode,
      checks: input.checks,
      ...(input.project ? { project: input.project } : {}),
      status: input.status ?? prev?.status ?? "aktiv",
      sessions: prev?.sessions ?? [],
      weight: prev?.weight ?? 1,
      createdAt: prev?.createdAt ?? nowIso(),
      createdBy: prev?.createdBy ?? "user",
    }
    await this.ctx.store.writeTracked(run, `gym/${task.id}.json`, task)
    run.actions.push({ kind: prev ? "update" : "create", target: "gym", name: task.id, reason: task.title, applied: true })
    return task
  }

  /**
   * Proposals from the session history: a request whose session used the entry and solved
   * a problem → task "the same request", check: the fix command was executed. Later sessions
   * with the same entry raise the weight. Proposals wait for the user's confirmation.
   */
  async propose(run: import("../types").Run, limit = 5): Promise<number> {
    const existing = this.tasks()
    let n = 0
    const records = [...(this.ctx.history?.all() ?? [])].sort((a, b) => a.at.localeCompare(b.at))
    for (const r of records) {
      const used = r.links.filter((l) => l.rel === "used")
      const fixed = r.problems.find((p) => p.resolved && p.fix)
      if (!used.length || !fixed || !r.requests[0]) continue
      const entry = `${used[0].kind}:${used[0].name}`
      const cmd = /`([^`]{4,120})`/.exec(fixed.fix!)?.[1] ?? fixed.fix!.split(/\s+/).slice(0, 4).join(" ")
      const same = existing.find((t) => t.entry === entry && t.checks.some((c) => c.text === cmd))
      if (same) {
        if (!same.sessions.includes(r.id)) {
          same.sessions.push(r.id)
          same.weight = Math.round((same.weight + 1 + same.sessions.length / 10) * 100) / 100
          await this.ctx.store.writeTracked(run, `gym/${same.id}.json`, same)
        }
        continue
      }
      const task: Omit<GymTask, "id" | "createdAt" | "createdBy" | "sessions" | "weight" | "status"> = { entry, title: truncate(r.requests[0], 100), prompt: r.requests[0], mode: "arbeiten", checks: [{ type: "executed", text: cmd }] }
      if (validateTask(task) || !this.ctx.store.getOwned(used[0].kind, used[0].name)) continue
      const saved = await this.save(run, { ...task, status: "vorgeschlagen" })
      saved.createdBy = "gym"
      saved.sessions = [r.id]
      await this.ctx.store.writeTracked(run, `gym/${saved.id}.json`, saved)
      existing.push(saved)
      if (++n >= limit) break
    }
    return n
  }

  private async model(): Promise<ModelRef | undefined> {
    const o = this.ctx.options.gym.model
    if (o) return parseModel(o)
    const last = lastModel(this.ctx.store.stateDir)
    return last
  }

  /** Work directory for mode "arbeiten": a detached git worktree of the project. */
  private async worktree(task: GymTask): Promise<{ dir: string; cleanup: () => Promise<void> } | undefined> {
    const p = task.project ? this.ctx.projects.get(task.project) : undefined
    if (!p?.homePath || !p.homeExists) return undefined
    const home = expandPath(p.homePath)
    const bin = this.ctx.git.bin ?? (await this.ctx.git.init().then(() => this.ctx.git.bin))
    const dir = join(mkdtempSync(join(tmpdir(), "skillsmith-gym-")), "wt")
    const r = await gitIn(bin, home, ["worktree", "add", "--detach", dir, "HEAD"], 120_000)
    if (r.code !== 0) throw new Error(`git worktree: ${r.stderr.trim()}`)
    return {
      dir,
      cleanup: async () => {
        await gitIn(bin, home, ["worktree", "remove", "--force", dir], 60_000).catch(() => undefined)
        removePath(dir)
      },
    }
  }

  private shell(cmd: string, cwd: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve) => execFile("/bin/sh", ["-c", cmd], { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (_err, stdout) => resolve(String(stdout ?? ""))))
  }

  /** One run of one arm. */
  private async once(task: GymTask, entry: Entry, arm: "a" | "b", model: ModelRef | undefined): Promise<{ ok: boolean; used: boolean; failed: string[]; error?: string }> {
    const o = this.ctx.options.gym
    const wt = task.mode === "arbeiten" ? await this.worktree(task) : undefined
    if (task.mode === "arbeiten" && !wt) return { ok: false, used: false, failed: [], error: "Modus arbeiten braucht ein Projekt mit home_path" }
    try {
      const prompt = arm === "b" ? `${task.prompt}\n\n${hintBlock(entry)}` : task.prompt
      const res = await runAgentSession({
        client: this.ctx.client,
        agent: o.agent,
        title: `skillsmith-gym · ${task.id} · ${arm.toUpperCase()}`,
        prompt,
        timeoutMs: o.timeoutMin * 60_000,
        keepSession: true,
        log: this.ctx.log,
        model,
        collectText: true,
        tools: toolsFor(task.mode),
        ...(wt ? { query: { directory: wt.dir } } : {}),
      })
      if (!res.sessionID) return { ok: false, used: false, failed: [], error: res.error ?? "keine Session" }
      const msgs = unwrap<any[]>(await this.ctx.client.session.messages({ path: { id: res.sessionID } }))
      const t = transcriptOf(msgs)
      if (!t.answer && res.text) t.answer = res.text
      const outputs: Record<string, string> = {}
      for (const c of task.checks) if (c.type === "output_equals" && wt && c.text) outputs[c.text] = await this.shell(c.text, wt.dir, 60_000)
      const r = evaluate(task.checks, t, outputs)
      if (!this.ctx.options.keepAgentSessions) await this.ctx.client.session.delete?.({ path: { id: res.sessionID } }).catch(() => undefined)
      return { ok: r.ok, used: arm === "b" && usedIn(entry, t), failed: r.failed, ...(res.ok ? {} : { error: res.error }) }
    } finally {
      await wt?.cleanup()
    }
  }

  /** A/B round of one task: runsPerArm runs per arm, alternating. */
  async runTask(id: string): Promise<GymRound> {
    const task = this.task(id)
    if (!task) throw new GuardError(`Gym-Aufgabe ${id} nicht gefunden`)
    const i = task.entry.indexOf(":")
    const entry = this.ctx.store.getOwned(task.entry.slice(0, i) as Kind, task.entry.slice(i + 1))
    if (!entry) throw new GuardError(`Eintrag ${task.entry} gibt es nicht mehr`)
    if (str(entry.fields.ai) === "privat") throw new GuardError("Private Einträge kommen nicht ins Gym")
    const model = await this.model()
    const a: ArmResult = { runs: 0, passed: 0, used: 0, errors: 0 }
    const b: ArmResult = { runs: 0, passed: 0, used: 0, errors: 0 }
    const details: string[] = []
    for (let k = 0; k < this.ctx.options.gym.runsPerArm; k++) {
      for (const arm of ["a", "b"] as const) {
        const r = await this.once(task, entry, arm, model)
        const t = arm === "a" ? a : b
        if (r.error && !r.ok && !r.failed.length) {
          t.errors++
          details.push(`${arm.toUpperCase()}${k + 1}: Fehler ${truncate(r.error, 120)}`)
          continue
        }
        t.runs++
        if (r.ok) t.passed++
        if (r.used) t.used++
        details.push(`${arm.toUpperCase()}${k + 1}: ${r.ok ? "bestanden" : `nicht bestanden (${r.failed.join(", ")})`}${r.used ? " · Eintrag genutzt" : ""}`)
      }
    }
    if (!a.runs || !b.runs) throw new GuardError(`Gym-Lauf ohne Ergebnis: ${details.join("; ")}`)
    const round: GymRound = { at: nowIso(), day: nowIso().slice(0, 10), task: task.id, entry: task.entry, model: model ? `${model.providerID}/${model.modelID}` : undefined, a, b, verdict: verdictOf(a, b), details }
    await withLock(this.ctx.store.locksDir, "gym", () => {
      const st = this.state()
      st.rounds.push(round)
      st.rounds = st.rounds.slice(-500)
      writeJsonAtomic(this.stateFile, st)
    })
    await this.consequences(task.entry)
    return round
  }

  /** "schadet" confirmed in 2 rounds on different days → archive / out of the hints (gym.consequence). */
  private async consequences(entryId: string): Promise<string | undefined> {
    if (this.ctx.options.gym.consequence !== "archivieren") return undefined
    const st = this.state()
    const harmful = st.rounds.filter((r) => r.entry === entryId).slice(-2)
    if (harmful.length < 2 || harmful.some((r) => r.verdict !== "schadet") || harmful[0].day === harmful[1].day) return undefined
    const i = entryId.indexOf(":")
    const kind = entryId.slice(0, i) as Kind
    const name = entryId.slice(i + 1)
    if (kind === "knowledge" || kind === "glossary") {
      st.suppressed[entryId] = { at: nowIso(), reason: "Gym: schadet (2 Runden)" }
      writeJsonAtomic(this.stateFile, st)
      return "aus den Hinweisen genommen"
    }
    const run = this.ctx.runs.create({ smith: kind === "error" ? "errorsmith" : kind === "script" ? "toolsmith" : kind === "memory" ? "memorysmith" : "skillsmith", actor: "curator", trigger: "gym", writeMode: "auto", directory: this.ctx.directory, project: this.ctx.project, limits: { maxNew: 0, maxChanges: 5, maxNotes: 0 } })
    let error: string | undefined
    try {
      await this.ctx.ops.move(run, kind, { name, to: "archive", kind: "archive", reason: "Gym: schadet in 2 Runden an verschiedenen Tagen" })
      st.archived[entryId] = nowIso()
      writeJsonAtomic(this.stateFile, st)
    } catch (err) {
      error = String(err)
    }
    await finalizeRun(this.ctx, run, { ok: !error, error })
    return error ? undefined : "archiviert"
  }

  /** The job: active tasks with the oldest last round first (weight breaks ties). */
  async runJob(trigger: string): Promise<{ summary: string; status?: "ok" | "skipped" | "warn" }> {
    const st = this.state()
    const last = (id: string) => st.rounds.filter((r) => r.task === id).pop()?.at ?? ""
    const due = this.tasks()
      .filter((t) => t.status === "aktiv")
      .sort((x, y) => last(x.id).localeCompare(last(y.id)) || y.weight - x.weight)
      .slice(0, this.ctx.options.gym.maxTasksPerRun)
    if (!due.length) return { summary: "keine aktiven Gym-Aufgaben", status: "skipped" }
    const lines: string[] = []
    for (const t of due) {
      try {
        const r = await this.runTask(t.id)
        lines.push(`${t.entry}: ${r.verdict} (A ${r.a.passed}/${r.a.runs}, B ${r.b.passed}/${r.b.runs})`)
      } catch (err) {
        lines.push(`${t.id}: ${String(err instanceof Error ? err.message : err)}`)
      }
    }
    void trigger
    return { summary: lines.join("; "), status: lines.some((l) => /schadet|Fehler|ohne Ergebnis/.test(l)) ? "warn" : "ok" }
  }
}
