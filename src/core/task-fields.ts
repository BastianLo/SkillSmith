/**
 * Structured fields of a task (5b), versioned in the task's frontmatter:
 *
 *   criteria      acceptance criteria: open / met / not met, with evidence
 *   testcases     precondition, steps, expected result; mode command / agent / manual; last run
 *   plan          approach, files, steps, risks, open questions (the approved plan, gate 1)
 *   verification  verdict per criterion with evidence from diff and test protocol (gate 2)
 *
 * The planner fills them, the user confirms (gate 1), the tester runs the test cases, the
 * verifier writes the report. Agents never write the task directly – the plugin writes what
 * their answer contains, in one run with a commit.
 */
import { oneLine, truncate } from "../util/text"

export type CriterionStatus = "offen" | "erfuellt" | "nicht_erfuellt"
export const CRITERION_STATUS: CriterionStatus[] = ["offen", "erfuellt", "nicht_erfuellt"]
export interface Criterion {
  id: string
  text: string
  status: CriterionStatus
  evidence?: string
  /** confirmed by the user at gate 1 (or written by the user) */
  confirmed?: boolean
}

export type TestMode = "befehl" | "agent" | "manuell"
export const TEST_MODES: TestMode[] = ["befehl", "agent", "manuell"]
export type TestResult = "offen" | "bestanden" | "fehlgeschlagen"
export interface TestRun {
  at: string
  result: TestResult
  protocol?: string
  by: "befehl" | "agent" | "user"
  job?: string
  /** pipeline run of a command test */
  run?: string
}
export interface TestCase {
  id: string
  title: string
  pre?: string
  steps: string[]
  expected: string
  mode: TestMode
  command?: string
  last?: TestRun
}

export interface TaskPlan {
  approach: string
  files: string[]
  steps: string[]
  risks: string[]
  questions: string[]
  round?: number
  by?: string
  approvedAt?: string
  comments?: string
  answers?: string
}

export type VerdictValue = "erfuellt" | "nicht_erfuellt" | "unklar"
export interface Verdict {
  criterion: string
  verdict: VerdictValue
  evidence?: string
}
export interface Verification {
  at: string
  by: string
  verdicts: Verdict[]
  summary?: string
  findings?: number
  ok: boolean
}

const MAX = { criteria: 40, testcases: 40, text: 600, protocol: 4000 }

const list = (v: unknown, max = 40, len = 400): string[] =>
  Array.isArray(v)
    ? v
        .map((x) => (typeof x === "string" ? x : x && typeof x === "object" && "text" in x ? String((x as any).text) : String(x ?? "")))
        .map((x) => truncate(oneLine(x), len))
        .filter(Boolean)
        .slice(0, max)
    : []
const text = (v: unknown, len = MAX.text) => (typeof v === "string" ? truncate(v.trim(), len) : v === undefined || v === null ? "" : truncate(String(v).trim(), len))

export function criteriaOf(v: unknown): Criterion[] {
  if (!Array.isArray(v)) return []
  const out: Criterion[] = []
  for (const [i, raw] of v.slice(0, MAX.criteria).entries()) {
    const r = typeof raw === "string" ? { text: raw } : raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined
    if (!r) continue
    const t = text(r.text ?? r.criterion ?? r.kriterium)
    if (!t) continue
    const status = (CRITERION_STATUS as string[]).includes(String(r.status)) ? (r.status as CriterionStatus) : "offen"
    out.push({ id: text(r.id, 12) || `K${i + 1}`, text: t, status, ...(r.evidence ? { evidence: text(r.evidence, 1000) } : {}), ...(r.confirmed === true ? { confirmed: true } : {}) })
  }
  return dedupeIds(out, "K")
}

export function testcasesOf(v: unknown): TestCase[] {
  if (!Array.isArray(v)) return []
  const out: TestCase[] = []
  for (const [i, raw] of v.slice(0, MAX.testcases).entries()) {
    const r = typeof raw === "string" ? { title: raw } : raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined
    if (!r) continue
    const title = text(r.title ?? r.name ?? r.titel, 200)
    if (!title) continue
    const command = text(r.command ?? r.befehl, 2000)
    const mode: TestMode = (TEST_MODES as string[]).includes(String(r.mode)) ? (r.mode as TestMode) : command ? "befehl" : "agent"
    const last = r.last && typeof r.last === "object" ? runOf(r.last) : undefined
    out.push({
      id: text(r.id, 12) || `TF${i + 1}`,
      title,
      ...(text(r.pre ?? r.precondition ?? r.vorbedingung) ? { pre: text(r.pre ?? r.precondition ?? r.vorbedingung) } : {}),
      steps: list(r.steps ?? r.schritte, 20),
      expected: text(r.expected ?? r.erwartet) || "wie beschrieben",
      mode,
      ...(mode === "befehl" && command ? { command: oneLine(command) } : {}),
      ...(last ? { last } : {}),
    })
  }
  return dedupeIds(out, "TF")
}

function runOf(v: unknown): TestRun | undefined {
  if (!v || typeof v !== "object") return undefined
  const r = v as Record<string, unknown>
  const result = ["offen", "bestanden", "fehlgeschlagen"].includes(String(r.result)) ? (r.result as TestResult) : undefined
  if (!result) return undefined
  return { at: text(r.at, 40) || new Date().toISOString(), result, ...(r.protocol ? { protocol: text(r.protocol, MAX.protocol) } : {}), by: r.by === "befehl" || r.by === "agent" ? r.by : "user", ...(r.job ? { job: text(r.job, 60) } : {}), ...(r.run ? { run: text(r.run, 60) } : {}) }
}

export function planOf(v: unknown): TaskPlan | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined
  const r = v as Record<string, unknown>
  const approach = text(r.approach ?? r.ansatz, 4000)
  if (!approach && !list(r.steps).length) return undefined
  return {
    approach,
    files: list(r.files ?? r.dateien, 60, 300),
    steps: list(r.steps ?? r.schritte),
    risks: list(r.risks ?? r.risiken),
    questions: list(r.questions ?? r.fragen),
    ...(Number(r.round) > 0 ? { round: Number(r.round) } : {}),
    ...(r.by ? { by: text(r.by, 80) } : {}),
    ...(r.approvedAt ? { approvedAt: text(r.approvedAt, 40) } : {}),
    ...(r.comments ? { comments: text(r.comments, 4000) } : {}),
    ...(r.answers ? { answers: text(r.answers, 4000) } : {}),
  }
}

export function verificationOf(v: unknown): Verification | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined
  const r = v as Record<string, unknown>
  const verdicts: Verdict[] = Array.isArray(r.verdicts)
    ? r.verdicts
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .map((x) => ({ criterion: text(x.criterion ?? x.id, 12), verdict: (["erfuellt", "nicht_erfuellt", "unklar"].includes(String(x.verdict)) ? x.verdict : "unklar") as VerdictValue, ...(x.evidence ? { evidence: text(x.evidence, 1500) } : {}) }))
        .filter((x) => x.criterion)
        .slice(0, MAX.criteria)
    : []
  return { at: text(r.at, 40) || new Date().toISOString(), by: text(r.by, 80) || "agent", verdicts, ...(r.summary ? { summary: text(r.summary, 3000) } : {}), ...(Number(r.findings) >= 0 ? { findings: Number(r.findings) } : {}), ok: r.ok === true }
}

function dedupeIds<T extends { id: string }>(items: T[], prefix: string): T[] {
  const seen = new Set<string>()
  let n = items.length
  return items.map((it) => {
    if (!seen.has(it.id)) {
      seen.add(it.id)
      return it
    }
    while (seen.has(`${prefix}${++n}`));
    seen.add(`${prefix}${n}`)
    return { ...it, id: `${prefix}${n}` }
  })
}

/** Structured fields of a task's frontmatter (for kinds.ts). */
export function readTaskFields(fm: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const c = criteriaOf(fm.criteria)
  if (c.length) out.criteria = c
  const t = testcasesOf(fm.testcases)
  if (t.length) out.testcases = t
  const p = planOf(fm.plan)
  if (p) out.plan = p
  const v = verificationOf(fm.verification)
  if (v) out.verification = v
  return out
}

export function writeTaskFields(f: Record<string, unknown>): Array<[string, unknown]> {
  const c = criteriaOf(f.criteria)
  const t = testcasesOf(f.testcases)
  return [
    ["criteria", c.length ? c : undefined],
    ["testcases", t.length ? t : undefined],
    ["plan", planOf(f.plan)],
    ["verification", verificationOf(f.verification)],
  ]
}

/** The fields as Markdown for an agent's brief. */
export function fieldsMarkdown(f: Record<string, unknown>, opts: { results?: boolean } = {}): string {
  const lines: string[] = []
  const plan = planOf(f.plan)
  if (plan) {
    lines.push("## Freigegebener Plan", plan.approach)
    if (plan.files.length) lines.push("", "Dateien:", ...plan.files.map((x) => `- ${x}`))
    if (plan.risks.length) lines.push("", "Risiken:", ...plan.risks.map((x) => `- ${x}`))
    if (plan.comments) lines.push("", `Kommentare des Nutzers: ${plan.comments}`)
    if (plan.answers) lines.push("", `Antworten des Nutzers: ${plan.answers}`)
    lines.push("")
  }
  const crit = criteriaOf(f.criteria)
  if (crit.length) lines.push("## Akzeptanzkriterien", ...crit.map((c) => `- ${c.id}: ${c.text}${opts.results && c.status !== "offen" ? ` [${c.status === "erfuellt" ? "erfüllt" : "nicht erfüllt"}${c.evidence ? `: ${c.evidence}` : ""}]` : ""}`), "")
  const tc = testcasesOf(f.testcases)
  if (tc.length) {
    lines.push("## Testfälle")
    for (const t of tc) {
      lines.push(`- ${t.id} (${t.mode}) ${t.title}${t.pre ? ` – Vorbedingung: ${t.pre}` : ""}`)
      t.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`))
      lines.push(`  Erwartet: ${t.expected}${t.command ? ` · Befehl: \`${t.command}\`` : ""}`)
      if (opts.results && t.last) lines.push(`  Letzter Lauf: ${t.last.result}${t.last.protocol ? ` – ${truncate(t.last.protocol.replace(/\s+/g, " "), 400)}` : ""}`)
    }
    lines.push("")
  }
  return lines.join("\n").trim()
}

/** JSON block of an agent answer (```json … ``` or the first {…} / […]). */
export function jsonBlock(answer: string, kind: "object" | "array" = "object"): unknown {
  const fence = new RegExp("```(?:json)?\\s*(" + (kind === "object" ? "\\{" : "\\[") + "[\\s\\S]*?" + (kind === "object" ? "\\}" : "\\]") + ")\\s*```").exec(answer)?.[1]
  const raw = fence ?? (kind === "object" ? /(\{[\s\S]*\})/.exec(answer)?.[1] : /(\[[\s\S]*\])/.exec(answer)?.[1])
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** The tester's answer: [{id, result, protocol}]. */
export function parseTestResults(answer: string): Array<{ id: string; result: TestResult; protocol?: string }> {
  const j = jsonBlock(answer, "array") ?? (jsonBlock(answer, "object") as any)?.results
  if (!Array.isArray(j)) return []
  return j
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => {
      const r = String(x.result ?? x.ergebnis ?? "").toLowerCase()
      const result: TestResult = /^(bestanden|passed|pass|ok|grün|gruen)$/.test(r) ? "bestanden" : /^(fehlgeschlagen|failed|fail|rot|error)$/.test(r) ? "fehlgeschlagen" : "offen"
      return { id: text(x.id, 12), result, ...(x.protocol || x.protokoll ? { protocol: text(x.protocol ?? x.protokoll, MAX.protocol) } : {}) }
    })
    .filter((x) => x.id)
}

/** The verifier's answer: {verdicts: [{criterion, verdict, evidence}], findings: [...], summary}. */
export function parseVerification(answer: string): { verdicts: Verdict[]; summary?: string } {
  const j = jsonBlock(answer, "object") as Record<string, unknown> | undefined
  const v = verificationOf({ ...(j ?? {}), ok: false })
  const summary = text(j?.summary ?? answer.replace(/```[\s\S]*?```/g, "").trim(), 2000) || undefined
  return { verdicts: v?.verdicts ?? [], summary }
}
