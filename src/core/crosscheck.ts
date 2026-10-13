/**
 * Cross-check (5d): before knowledge written by the AI is stored (docsmith, memorysmith,
 * skillsmith, corrections of the doctor), a second model checks every changed paragraph
 * against its sources: gestützt, nicht gestützt or widersprochen, with a reason.
 *
 *   1. deterministic pre-check: every quoted source was found verbatim (the evidence gate
 *      of Ops already guarantees this – a paragraph without any source is "nicht gestützt"
 *      without asking a model);
 *   2. the checker model (crosscheck.model, a different model than the writer) judges the
 *      rest – it sees the paragraphs, their quotes and the transcript passages around them.
 *
 * Only "gestützt" is written directly. "nicht gestützt" becomes a proposal with the reason
 * (inbox), "widersprochen" is rejected and noted in the audit log. Counts per smith and
 * model (state/crosscheck.json) show where prompts need work.
 */
import { join } from "node:path"
import type { Kind, ProvenanceSource, Run } from "../types"
import { readJson, withLock, writeJsonAtomic } from "../util/fs"
import { fold, nowIso, truncate } from "../util/text"
import { runAgentSession, type ModelRef } from "./agent-runner"
import { parseModel } from "../config"
import type { Ctx } from "./context"
import { ASSISTANT_AGENT } from "./prompts"

export type Verdict = "gestuetzt" | "nicht_gestuetzt" | "widersprochen"

export interface CheckParagraph {
  index: number
  text: string
  sources: ProvenanceSource[]
}

export interface CrossCheckResult {
  verdicts: Array<{ index: number; verdict: Verdict; reason: string }>
  model?: string
  /** the checker could not run (no model, error) */
  error?: string
}

export type CrossChecker = (run: Run, kind: Kind, name: string, paragraphs: CheckParagraph[]) => Promise<CrossCheckResult>

export const VERDICT_LABEL: Record<Verdict, string> = { gestuetzt: "gestützt", nicht_gestuetzt: "nicht gestützt", widersprochen: "widersprochen" }

const norm = (s: string) => fold(s).replace(/[^a-z0-9]+/g, " ").trim()

/** Transcript passages around the quotes of the sources (the checker sees context, not only the quote). */
export function contextOf(haystack: string, quotes: string[], radius = 400, max = 6000): string {
  if (!haystack) return ""
  const lower = fold(haystack)
  const parts: string[] = []
  let used = 0
  for (const q of quotes) {
    const words = norm(q).split(" ").filter((w) => w.length > 3).slice(0, 4)
    if (!words.length) continue
    const i = lower.indexOf(words[0])
    if (i < 0) continue
    const part = haystack.slice(Math.max(0, i - radius), i + q.length + radius)
    if (used + part.length > max) break
    parts.push(part)
    used += part.length
  }
  return parts.join("\n…\n")
}

export function buildPrompt(kind: Kind, name: string, paragraphs: CheckParagraph[], context: string): string {
  return [
    `Du prüfst Aussagen, die ein anderes Modell in den Eintrag ${kind}:${name} schreiben will, gegen ihre Quellen.`,
    `Für jeden Absatz: "gestuetzt" (die Quelle trägt die Aussage), "nicht_gestuetzt" (die Quelle trägt sie nicht oder nur teilweise, die Aussage geht darüber hinaus) oder "widersprochen" (die Quelle sagt etwas anderes).`,
    `Nur die angegebenen Quellen und der Kontext zählen, kein eigenes Wissen. Antworte nur mit JSON:`,
    '```json\n[{"p": 1, "verdict": "gestuetzt", "reason": "kurz"}]\n```',
    "",
    ...paragraphs.map((p, i) => [`## Absatz P${i + 1}`, p.text, "Quellen:", ...(p.sources.length ? p.sources.map((s) => `- ${s.type}${s.ref ? ` ${s.ref}` : ""}${s.quote ? `: „${s.quote}“` : ""}`) : ["- (keine)"]), ""].join("\n")),
    context ? `## Kontext aus dem Transkript\n${context}` : "",
  ].join("\n")
}

export function parseVerdicts(text: string, n: number): Array<{ index: number; verdict: Verdict; reason: string }> | undefined {
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(text) ?? /(\[[\s\S]*\])/.exec(text)
  if (!m) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(m[1])
  } catch {
    return undefined
  }
  if (!Array.isArray(raw)) return undefined
  const out: Array<{ index: number; verdict: Verdict; reason: string }> = []
  for (const r of raw as Array<Record<string, unknown>>) {
    const p = Number(String(r.p ?? r.paragraph ?? "").replace(/^P/i, ""))
    const v = String(r.verdict ?? "").toLowerCase().replace(/ü/g, "ue").replace(/[\s-]+/g, "_")
    const verdict: Verdict | undefined = v.startsWith("gestuetzt") ? "gestuetzt" : v.startsWith("nicht") ? "nicht_gestuetzt" : v.startsWith("widersp") ? "widersprochen" : undefined
    if (!Number.isInteger(p) || p < 1 || p > n || !verdict) continue
    out.push({ index: p - 1, verdict, reason: truncate(String(r.reason ?? ""), 300) })
  }
  // a paragraph the checker skipped counts as not supported
  for (let i = 0; i < n; i++) if (!out.some((x) => x.index === i)) out.push({ index: i, verdict: "nicht_gestuetzt", reason: "vom Prüfer nicht beurteilt" })
  return out.sort((a, b) => a.index - b.index)
}

interface Stats {
  [key: string]: { gestuetzt: number; nicht_gestuetzt: number; widersprochen: number; fehler: number; last?: string }
}

export class CrossCheck {
  constructor(private ctx: Ctx) {}

  private get file(): string {
    return join(this.ctx.store.stateDir, "crosscheck.json")
  }

  /** Counts per "smith|writer model|checker model". */
  stats(): Array<{ smith: string; writer: string; checker: string; gestuetzt: number; nicht_gestuetzt: number; widersprochen: number; fehler: number; rate: number; last?: string }> {
    return Object.entries(readJson<Stats>(this.file, {})).map(([k, v]) => {
      const [smith, writer, checker] = k.split("|")
      const total = v.gestuetzt + v.nicht_gestuetzt + v.widersprochen
      return { smith, writer, checker, ...v, rate: total ? v.gestuetzt / total : 0 }
    })
  }

  private async record(run: Run, checker: string, verdicts: Verdict[], error?: boolean): Promise<void> {
    await withLock(this.ctx.store.locksDir, "crosscheck", () => {
      const st = readJson<Stats>(this.file, {})
      const k = `${run.smith}|${run.model ?? "?"}|${checker}`
      const row = (st[k] ??= { gestuetzt: 0, nicht_gestuetzt: 0, widersprochen: 0, fehler: 0 })
      for (const v of verdicts) row[v]++
      if (error) row.fehler++
      row.last = nowIso()
      writeJsonAtomic(this.file, st)
    }).catch(() => undefined)
  }

  /** Is the check active for this write? (agents only, configured kinds, a checker model) */
  applies(run: Run, kind: Kind): boolean {
    const o = this.ctx.options.crosscheck
    return o.enabled && !!o.model && o.kinds.includes(kind) && (run.actor === "reviewer" || run.actor === "curator")
  }

  readonly check: CrossChecker = async (run, kind, name, paragraphs) => {
    const o = this.ctx.options.crosscheck
    const model: ModelRef | undefined = parseModel(o.model)
    const checker = o.model
    // the checker must not be the writer
    if (model && run.model && run.model === `${model.providerID}/${model.modelID}`) {
      await this.record(run, checker, [], true)
      return { verdicts: [], model: checker, error: "Prüfmodell ist das Modell des Schreibers" }
    }
    const pre: Array<{ index: number; verdict: Verdict; reason: string }> = []
    const ask: CheckParagraph[] = []
    for (const p of paragraphs) {
      if (!p.sources.length) pre.push({ index: p.index, verdict: "nicht_gestuetzt", reason: "keine Quelle" })
      else ask.push(p)
    }
    let verdicts = pre
    if (ask.length) {
      const context = contextOf(`${run.userText ?? ""}\n${run.haystack ?? ""}`, ask.flatMap((p) => p.sources.map((s) => s.quote ?? "")).filter(Boolean))
      const res = await runAgentSession({
        client: this.ctx.client,
        agent: ASSISTANT_AGENT,
        title: `skillsmith-kreuzprüfung · ${kind}:${name}`,
        prompt: this.ctx.redactor.redact(buildPrompt(kind, name, ask, context)),
        timeoutMs: Math.min(this.ctx.options.reviewTimeoutMin, 10) * 60_000,
        keepSession: this.ctx.options.keepAgentSessions,
        log: this.ctx.log,
        model,
        collectText: true,
      }).catch((err) => ({ ok: false, error: String(err), text: undefined }) as { ok: boolean; error?: string; text?: string })
      const parsed = res.text ? parseVerdicts(res.text, ask.length) : undefined
      if (!parsed) {
        await this.record(run, checker, pre.map((x) => x.verdict), true)
        return { verdicts: pre, model: checker, error: res.error ?? "keine auswertbare Antwort des Prüfmodells" }
      }
      verdicts = [...pre, ...parsed.map((v) => ({ ...v, index: ask[v.index].index }))]
    }
    await this.record(run, checker, verdicts.map((v) => v.verdict))
    return { verdicts: verdicts.sort((a, b) => a.index - b.index), model: checker }
  }
}
