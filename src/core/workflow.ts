/**
 * Task workflow (5b): every column of the board can have a step with an agent. A card runs
 * from planning through implementation and test to verification and jumps back to the
 * implementation while a test or a criterion fails; after `maxLoops` back jumps it halts and
 * asks the user. Columns without a step stay manual.
 *
 * The flow of a column comes from (later wins): the defaults derived from the column id,
 * `tasks.flow.<column>` of the options/settings page, `flow.<column>` of the project.
 *
 *   step       plan | implement | test | verify (none = manual column)
 *   agent      opencode agent of the step (empty = the agent the task was given)
 *   model      provider/model (empty = the job's model)
 *   checks     exit checks: pipeline, tests, criteria, review, pr-check
 *   onSuccess  next column when the step and its checks pass
 *   onFailure  column a failed check sends the card back to
 *   gate       the user approves before the card leaves the column (Tor)
 *   maxLoops   back jumps before the card halts (default tasks.maxLoops)
 */
import { DEFAULT_TASK_COLUMNS, type Options } from "../config"

export type StepKind = "plan" | "implement" | "test" | "verify"
export const STEP_KINDS: StepKind[] = ["plan", "implement", "test", "verify"]
export type ExitCheck = "pipeline" | "tests" | "criteria" | "review" | "pr-check"
export const EXIT_CHECKS: ExitCheck[] = ["pipeline", "tests", "criteria", "review", "pr-check"]

export const STEP_LABEL: Record<StepKind, string> = { plan: "Planung", implement: "Umsetzung", test: "Test", verify: "Verifikation" }
export const CHECK_LABEL: Record<ExitCheck, string> = { pipeline: "Pipeline grün", tests: "Testfälle bestanden", criteria: "Kriterien erfüllt", review: "Review ohne Fehler", "pr-check": "Vor-PR-Prüfung" }

export interface ColumnFlow {
  column: string
  step?: StepKind
  agent?: string
  model?: string
  checks: ExitCheck[]
  onSuccess?: string
  onFailure?: string
  gate: boolean
  maxLoops: number
}

export type FlowConfig = Partial<Omit<ColumnFlow, "column">>

/** Default columns of new boards. */
export const DEFAULT_COLUMNS = DEFAULT_TASK_COLUMNS

/** Statuses of boards before 4.0 → the column that does the same work now. */
export const LEGACY_STATUS: Record<string, string> = { eingeplant: "planung", in_umsetzung: "umsetzung", review: "verifikation" }

/** Step a column id stands for (old and new names). */
export function stepOfColumn(column: string): StepKind | undefined {
  if (/^(planung|eingeplant|plan|planning)$/.test(column)) return "plan"
  if (/^(umsetzung|in_umsetzung|implement|implementation|entwicklung|dev)$/.test(column)) return "implement"
  if (/^(test|tests|testing)$/.test(column)) return "test"
  if (/^(verifikation|review|verify|abnahme|qa)$/.test(column)) return "verify"
  return undefined
}

/** Defaults for the columns of a board: steps from the column ids, success to the next step. */
export function defaultFlows(columns: string[], o: Pick<Options, "tasks">): Record<string, ColumnFlow> {
  const done = columns[columns.length - 1]
  const steps = columns.map((c) => ({ column: c, step: c === done || c === columns[0] ? undefined : stepOfColumn(c) }))
  const implement = steps.find((s) => s.step === "implement")?.column
  const hasVerify = steps.some((s) => s.step === "verify")
  const out: Record<string, ColumnFlow> = {}
  steps.forEach((s, i) => {
    const next = columns[i + 1]
    const f: ColumnFlow = { column: s.column, step: s.step, checks: [], gate: false, maxLoops: o.tasks.maxLoops }
    if (s.step) {
      f.onSuccess = next
      if (s.step === "plan") f.gate = true
      if (s.step === "implement") f.checks = ["pipeline"]
      if (s.step === "test") {
        f.checks = ["tests"]
        f.onFailure = implement
        // a board without a verification column: the test column also checks the criteria and reviews
        if (!hasVerify) f.checks.push("criteria", "review")
      }
      if (s.step === "verify") {
        f.checks = ["criteria", "review"]
        f.onFailure = implement
      }
      if (s.step === "implement") f.onFailure = s.column
      // only the user sets "done": the step before it always ends at the gate (acceptance)
      if (next === done) f.gate = true
    }
    out[s.column] = f
  })
  return out
}

/** Effective flow of every column: defaults ⊕ options ⊕ project. */
export function resolveFlows(columns: string[], o: Pick<Options, "tasks">, project?: Record<string, FlowConfig>): Record<string, ColumnFlow> {
  const flows = defaultFlows(columns, o)
  const done = columns[columns.length - 1]
  for (const layer of [(o.tasks.flow ?? {}) as Record<string, FlowConfig>, project ?? {}]) {
    for (const [col, cfg] of Object.entries(layer)) {
      if (!flows[col] || !cfg) continue
      const f = flows[col]
      for (const [k, v] of Object.entries(cfg)) if (v !== undefined && v !== null && v !== "") (f as any)[k] = v
      // an explicitly emptied step makes the column manual
      if ((cfg as any).step === "keiner" || (cfg as any).step === "none") f.step = undefined
    }
  }
  for (const f of Object.values(flows)) {
    if (f.onSuccess && !columns.includes(f.onSuccess)) f.onSuccess = undefined
    if (f.onFailure && !columns.includes(f.onFailure)) f.onFailure = undefined
    if (f.step && f.onSuccess === done) f.gate = true
    if (!f.step) f.checks = []
  }
  return flows
}

/** Validate a project's flow object (throws with a German message). */
export function normalizeFlow(raw: unknown, columns: string[]): Record<string, FlowConfig> | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("Workflow muss ein Objekt je Spalte sein")
  const out: Record<string, FlowConfig> = {}
  for (const [col, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!columns.includes(col)) throw new Error(`Workflow: Spalte „${col}“ gibt es nicht (${columns.join(", ")})`)
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`Workflow „${col}“: erwartet ein Objekt`)
    const r = v as Record<string, unknown>
    const f: FlowConfig = {}
    if (r.step !== undefined && r.step !== "") {
      if (r.step === "keiner" || r.step === "none") (f as any).step = "keiner"
      else if ((STEP_KINDS as unknown[]).includes(r.step)) f.step = r.step as StepKind
      else throw new Error(`Workflow „${col}“: Schritt ${String(r.step)} unbekannt (${STEP_KINDS.join(", ")}, keiner)`)
    }
    for (const k of ["agent", "model"] as const) if (typeof r[k] === "string" && (r[k] as string).trim()) f[k] = (r[k] as string).trim()
    for (const k of ["onSuccess", "onFailure"] as const) {
      if (r[k] === undefined || r[k] === "") continue
      if (!columns.includes(String(r[k]))) throw new Error(`Workflow „${col}“: ${k} „${String(r[k])}“ ist keine Spalte`)
      f[k] = String(r[k])
    }
    if (r.checks !== undefined) {
      if (!Array.isArray(r.checks) || r.checks.some((c) => !(EXIT_CHECKS as unknown[]).includes(c))) throw new Error(`Workflow „${col}“: Prüfungen aus ${EXIT_CHECKS.join(", ")}`)
      f.checks = r.checks as ExitCheck[]
    }
    if (r.gate !== undefined) f.gate = r.gate === true || r.gate === "true"
    if (r.maxLoops !== undefined) {
      const n = Number(r.maxLoops)
      if (!Number.isInteger(n) || n < 0 || n > 20) throw new Error(`Workflow „${col}“: maxLoops 0–20`)
      f.maxLoops = n
    }
    if (Object.keys(f).length) out[col] = f
  }
  return Object.keys(out).length ? out : undefined
}

/** First column of a step (e.g. where a failed test sends the card back to). */
export function columnOfStep(flows: Record<string, ColumnFlow>, step: StepKind): string | undefined {
  return Object.values(flows).find((f) => f.step === step)?.column
}
