/**
 * What the agents of the workflow get and what comes back (5b): the prompt of each step
 * (plan, implement, test, verify) and the parsing of their answers. Pure functions – the
 * engine (agent-tasks.ts) decides when a step runs and what happens with the result.
 */
import type { FileDiff } from "../util/diff"
import { oneLine, truncate } from "../util/text"
import { criteriaOf, fieldsMarkdown, jsonBlock, testcasesOf, type Criterion, type TestCase } from "./task-fields"

type AnyRecord = Record<string, any>

export interface Proposal {
  at: string
  round: number
  text: string
  approach?: string
  files?: string[]
  steps?: string[]
  risks?: string[]
  questions?: string[]
  /** legacy: free test descriptions of 3.x proposals */
  tests?: string[]
  criteria?: Criterion[]
  testcases?: TestCase[]
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

export const PLAN_FORMAT = `Antworte am Ende mit dem Plan in genau diesem Format (ein JSON-Block, danach eine kurze Zusammenfassung in Sätzen):
\`\`\`json
{"approach": "Ansatz in 2–5 Sätzen", "files": ["betroffene/Datei.java"], "steps": ["Schritt 1", "Schritt 2"], "risks": ["Risiko"], "questions": ["offene Frage an den Nutzer"],
 "criteria": ["prüfbares Akzeptanzkriterium"],
 "testcases": [{"title": "Testfall", "pre": "Vorbedingung", "steps": ["Schritt"], "expected": "erwartetes Ergebnis", "mode": "befehl", "command": "mvn -q -Dtest=LogoutTest test"}]}
\`\`\`
mode: „befehl“ (ein Befehl prüft es, Exit 0 = bestanden), „agent“ (ein Test-Agent führt es aus, etwa über einen Browser) oder „manuell“ (der Nutzer prüft von Hand).`

/** The planner's answer (JSON block, otherwise Markdown sections). */
export function parseProposal(text: string): Omit<Proposal, "at" | "round" | "text"> {
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => oneLine(typeof x === "string" ? x : String((x as AnyRecord)?.text ?? x))).filter(Boolean).slice(0, 40) : undefined)
  const j = jsonBlock(text, "object") as AnyRecord | undefined
  if (j && (j.approach || j.steps || j.criteria)) {
    const criteria = criteriaOf(j.criteria)
    const testcases = testcasesOf(j.testcases)
    // 3.x planners answered "tests": ["…"] – they become test cases for the test agent
    const legacy = list(j.tests)
    return {
      approach: j.approach ? String(j.approach) : undefined,
      files: list(j.files),
      steps: list(j.steps),
      risks: list(j.risks),
      questions: list(j.questions),
      ...(legacy?.length ? { tests: legacy } : {}),
      ...(criteria.length ? { criteria } : {}),
      ...(testcases.length ? { testcases } : legacy?.length ? { testcases: testcasesOf(legacy.map((t) => ({ title: t, expected: "erfolgreich", mode: "agent" }))) } : {}),
    }
  }
  const section = (re: RegExp) => {
    const m = new RegExp(`^#{1,4}\\s*(${re.source})[^\\n]*\\n([\\s\\S]*?)(?=^#{1,4}\\s|$(?![\\s\\S]))`, "im").exec(text)
    return m?.[2]?.trim()
  }
  const items = (s?: string) => (s ? s.split("\n").map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim()).filter(Boolean) : undefined)
  const criteria = criteriaOf(items(section(/akzeptanzkriterien|kriterien|criteria/)) ?? [])
  return {
    approach: section(/ansatz|approach/),
    files: items(section(/dateien|files/)),
    steps: items(section(/schritte|steps/)),
    risks: items(section(/risiken|risks/)),
    questions: items(section(/fragen|offene fragen|questions/)),
    tests: items(section(/tests|prüfung/)),
    ...(criteria.length ? { criteria } : {}),
  }
}

/** Findings of a review answer (a JSON list, or `findings` of an object). */
export function findingsOf(v: unknown): Finding[] {
  if (!Array.isArray(v)) return []
  return v
    .slice(0, 60)
    .filter((f): f is AnyRecord => !!f && typeof f === "object")
    .map((f): Finding => ({
      source: "ai",
      severity: f.severity === "error" ? "error" : f.severity === "info" ? "info" : "warn",
      file: f.file ? String(f.file) : undefined,
      line: Number.isFinite(Number(f.line)) && Number(f.line) > 0 ? Number(f.line) : undefined,
      text: truncate(oneLine(String(f.text ?? f.message ?? "")), 400),
    }))
    .filter((f) => f.text)
}

export function parseFindings(text: string): Finding[] {
  const arr = jsonBlock(text, "array")
  if (Array.isArray(arr)) return findingsOf(arr)
  return findingsOf((jsonBlock(text, "object") as AnyRecord | undefined)?.findings)
}

/** Deterministic review checks over a diff (idea 16). */
export function checkDiff(files: FileDiff[], proposalFiles: string[] | undefined, scan: (t: string) => string[], largeDeletion: number): Finding[] {
  const out: Finding[] = []
  const planned = (proposalFiles ?? []).map((f) => f.replace(/^\.\//, ""))
  for (const f of files) {
    if (planned.length && !planned.some((p) => f.path === p || f.path.endsWith(`/${p}`) || p.endsWith(`/${f.path}`) || (p.endsWith("/") && f.path.startsWith(p)))) {
      out.push({ source: "check", severity: "warn", file: f.path, text: "Datei liegt außerhalb des freigegebenen Plans" })
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

/** Diff as text for a prompt. */
export function diffText(files: FileDiff[]): string {
  return files
    .map((f) => `--- ${f.path} (${f.status}, +${f.additions}/−${f.deletions})\n${f.hunks.map((h) => h.lines.map((l) => `${l.type === "add" ? "+" : l.type === "del" ? "-" : " "}${l.text}`).join("\n")).join("\n...\n")}`)
    .join("\n\n")
}

// ---------------------------------------------------------------------------
// prompts of the steps
// ---------------------------------------------------------------------------

export function planPrompt(brief: string, opts: { allowBash: boolean }): string {
  return `${brief}\n\n---\nSCHRITT PLANUNG. Ändere noch nichts: Schreibwerkzeuge${opts.allowBash ? "" : " und bash"} sind bis zur Freigabe gesperrt, auch für Subagenten. Lies den Code, kläre den Ansatz, plane die Umsetzung, lege prüfbare Akzeptanzkriterien und Testfälle fest.\n\n${PLAN_FORMAT}`
}

export function revisePrompt(comments: string): string {
  return `Der Nutzer möchte den Plan überarbeitet haben:\n${comments}\n\nÄndere weiterhin nichts. Überarbeite den Plan.\n\n${PLAN_FORMAT}`
}

/** Implementation: first round after the plan, or back from test/verification with the reasons. */
export function implementPrompt(input: { brief?: string; fields: Record<string, unknown>; feedback?: string; round: number; comments?: string; answers?: string }): string {
  const parts: string[] = []
  if (input.brief) parts.push(input.brief, "", "---")
  if (input.feedback) {
    parts.push(`SCHRITT UMSETZUNG (Runde ${input.round}): Die Aufgabe kommt zurück, weil ein Test oder ein Kriterium nicht bestanden hat.`, "", input.feedback, "", fieldsMarkdown(input.fields, { results: true }))
  } else {
    parts.push("SCHRITT UMSETZUNG – der Plan ist freigegeben.")
    if (input.comments) parts.push(`Kommentare des Nutzers:\n${input.comments}`)
    if (input.answers) parts.push(`Antworten auf deine Fragen:\n${input.answers}`)
    parts.push("", fieldsMarkdown(input.fields))
  }
  parts.push("", "Setze das jetzt um. Committe und pushe nicht. Schreibe am Ende eine kurze Zusammenfassung: was geändert wurde, welche Dateien, wie es geprüft wurde.")
  return parts.join("\n").trim()
}

export function fixPrompt(input: { stage?: string; command?: string; failed?: string; log: string }): string {
  return `Die Prüfbefehle des Projekts sind rot (Stufe ${input.stage ?? "?"}: ${input.command ?? ""}).${input.failed ? `\nFehlgeschlagene Tests:\n${input.failed}` : ""}\n\nEnde des Logs:\n\`\`\`\n${truncate(input.log.slice(-6000), 6000)}\n\`\`\`\nBessere nach, bis die Prüfung grün ist, und fasse am Ende zusammen, was du geändert hast.`
}

/** Test agent: runs the test cases of mode "agent", changes nothing. */
export function testPrompt(input: { brief: string; cases: TestCase[]; commandResults?: string }): string {
  const list = input.cases.map((t) => [`### ${t.id}: ${t.title}`, t.pre ? `Vorbedingung: ${t.pre}` : "", ...t.steps.map((s, i) => `${i + 1}. ${s}`), `Erwartet: ${t.expected}`].filter(Boolean).join("\n")).join("\n\n")
  return `${input.brief}\n\n---\nSCHRITT TEST. Führe diese Testfälle aus und protokolliere, was du beobachtest. Ändere keinen Code (Schreibwerkzeuge sind gesperrt).${input.commandResults ? `\n\nErgebnisse der Befehls-Tests:\n${input.commandResults}` : ""}\n\n${list}\n\nAntworte am Ende mit genau einem JSON-Block:\n\`\`\`json\n[{"id": "TF1", "result": "bestanden", "protocol": "was du getan und beobachtet hast"}]\n\`\`\`\nresult: „bestanden“ oder „fehlgeschlagen“.`
}

/** Verifier: judges every criterion against diff and test protocol, read only. */
export function verifyPrompt(input: { brief: string; fields: Record<string, unknown>; diff: string; tests?: string }): string {
  return `Du verifizierst die Umsetzung einer Aufgabe, nur lesend (keine Änderungen).\n\n${input.brief}\n\n${fieldsMarkdown(input.fields, { results: true })}\n\n## Diff\n\`\`\`diff\n${input.diff || "(keine Änderungen)"}\n\`\`\`${input.tests ? `\n\n## Testprotokoll\n${input.tests}` : ""}\n\nPrüfe jedes Akzeptanzkriterium mit Beleg aus Diff oder Testprotokoll und vergleiche den Diff mit dem Plan und den Vorgaben. Antworte mit einer kurzen Einschätzung und genau einem JSON-Block:\n\`\`\`json\n{"verdicts": [{"criterion": "K1", "verdict": "erfuellt", "evidence": "Beleg"}], "findings": [{"file": "pfad", "line": 12, "severity": "warn", "text": "Befund"}], "summary": "Gesamturteil in einem Satz"}\n\`\`\`\nverdict: erfuellt, nicht_erfuellt oder unklar; severity: info, warn oder error (leere Listen, wenn alles passt).`
}
