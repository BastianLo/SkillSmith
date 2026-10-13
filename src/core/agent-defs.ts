/**
 * Agents managed by skillsmith (5b): kind "agent" in the store (prompt, description, mode,
 * model, tools, rights, temperature) – versioned with diff like every entry.
 *
 *  - import: the existing opencode agents become the first version (KI-Recht „vorschlag“);
 *  - register: the config hook enters the store's agents into opencode (effective after a
 *    restart of opencode); the store version wins over opencode.json and agent files;
 *  - review: a job looks at back jumps, review findings, revisions and corrections of the
 *    last weeks and proposes prompt changes as a diff with reason – the user approves
 *    (KI-Recht „vorschlag“, never written directly).
 */
import { expandPromptRefs } from "./library"
import type { Run } from "../types"
import { parseModel } from "../config"
import { oneLine, slugify, truncate } from "../util/text"
import { unwrap } from "./agent-runner"
import { askAssistant } from "./assistant"
import type { Ctx } from "./context"
import { finalizeRun } from "./finalize"
import { str } from "./frontmatter"
import type { JobOutcome, JobRunContext } from "./jobs"
import { aiAccessOf } from "./kinds"
import { specOf } from "./models"
import { isSmithAgent } from "./prompts"
import { jsonBlock } from "./task-fields"

type AnyRecord = Record<string, any>

/** opencode's built-in agents: their prompts live in opencode – importing them would only copy an empty prompt. */
const BUILT_IN = new Set(["build", "plan", "general", "explore", "compaction", "title", "summary"])

/** Store name of an opencode agent ("Athene" → "athene"). */
export function agentEntryName(name: string): string {
  return slugify(name, 60) || "agent"
}

/** The opencode agents become store entries (first version). Existing entries stay. */
export async function importAgents(ctx: Ctx, run: Run, names?: string[]): Promise<string[]> {
  const list = unwrap<AnyRecord[]>(await ctx.client.app.agents()) ?? []
  const out: string[] = []
  for (const a of list) {
    if (!a?.name || isSmithAgent(a.name) || a.hidden) continue
    if (names?.length && !names.includes(a.name)) continue
    if (!names?.length && BUILT_IN.has(a.name) && !a.prompt) continue
    const name = agentEntryName(a.name)
    if (ctx.store.fresh("agent", name)) continue
    const model = specOf(a.model)
    const fields: Record<string, unknown> = {
      mode: a.mode === "subagent" || a.mode === "all" ? a.mode : "primary",
      ...(model ? { model } : {}),
      ...(typeof a.temperature === "number" ? { temperature: a.temperature } : {}),
      ...(typeof a.steps === "number" ? { steps: a.steps } : {}),
      ...(a.color ? { color: String(a.color) } : {}),
      ...(a.tools && typeof a.tools === "object" && Object.keys(a.tools).length ? { tools: a.tools } : {}),
      ...(a.permission && typeof a.permission === "object" && !Array.isArray(a.permission) && Object.keys(a.permission).length ? { permission: a.permission } : {}),
      imported_from: "opencode",
      author: "user",
      ai: "vorschlag",
    }
    await ctx.ops.create(run, "agent", { name, title: a.name, description: oneLine(String(a.description ?? "")), tags: [], fields, body: String(a.prompt ?? "").trim(), reason: `aus opencode übernommen (${a.name})`, approved: true })
    out.push(a.name)
  }
  return out
}

/** Config hook: the store's active agents into opencode's config (store wins). */
export function registerAgents(ctx: Ctx, cfg: AnyRecord): string[] {
  const out: string[] = []
  cfg.agent ??= {}
  for (const e of ctx.store.list("agent")) {
    if (e.tier !== "active") continue
    const f = e.fields
    const name = e.title && e.title !== e.name && !/\s/.test(e.title) ? e.title : e.name
    if (isSmithAgent(name)) continue
    const prev = (cfg.agent[name] ?? {}) as AnyRecord
    const model = str(f.model)
    cfg.agent[name] = {
      ...prev,
      ...(e.description ? { description: e.description } : {}),
      mode: str(f.mode) || prev.mode || "primary",
      // an empty prompt never replaces opencode's own
      ...(e.body.trim() ? { prompt: expandPromptRefs(ctx.store.list("prompt"), e.body.trim()) } : {}),
      ...(parseModel(model) ? { model } : {}),
      ...(typeof f.temperature === "number" ? { temperature: f.temperature } : {}),
      ...(typeof f.steps === "number" ? { steps: f.steps } : {}),
      ...(str(f.color) ? { color: str(f.color) } : {}),
      ...(f.tools && typeof f.tools === "object" ? { tools: f.tools } : {}),
      ...(f.permission && typeof f.permission === "object" ? { permission: f.permission } : {}),
    }
    out.push(name)
  }
  return out
}

/** Evidence of the last `days` for one agent: back jumps, revisions, corrections, halts, findings. */
export function agentEvidence(ctx: Ctx, agent: string, days: number): string[] {
  const from = Date.now() - days * 86_400_000
  const out: string[] = []
  for (const j of ctx.agentTasks.all()) {
    if (Date.parse(j.startedAt) < from) continue
    const mine = j.stepRuns.filter((s) => s.agent === agent)
    if (!mine.length && j.agent !== agent) continue
    const id = j.task.toUpperCase()
    for (const s of mine) if (s.result === "failed") out.push(`${id} ${s.step ?? ""}: zurückgesprungen – ${s.note ?? ""}`)
    for (const p of j.proposals) if (p.verdict === "revise" && p.comments) out.push(`${id} Plan überarbeiten: ${p.comments}`)
    for (const m of j.messages) if (m.from === "user" && /^(Nachbessern|Überarbeiten):/.test(m.text)) out.push(`${id} ${m.text}`)
    if (j.halted) out.push(`${id} angehalten: ${j.halted.reason.split("\n")[0]}`)
    for (const f of j.review?.findings ?? []) if (f.severity !== "info") out.push(`${id} Befund (${f.severity}): ${f.text}`)
  }
  for (const r of ctx.agentTasks.rules()) if (r.status === "confirmed") out.push(`bestätigte Regel: ${r.text}`)
  return [...new Set(out.map((x) => truncate(oneLine(x), 400)))].slice(0, 40)
}

/** Job "agent-review": prompt improvements as proposals (diff + reason) for agents with enough evidence. */
export async function reviewAgents(ctx: Ctx, jr: JobRunContext): Promise<JobOutcome> {
  const days = Number(jr.params.days) || 30
  const min = Number(jr.params.minEvidence) || 3
  const proposed: string[] = []
  const skipped: string[] = []
  for (const e of ctx.store.list("agent")) {
    if (jr.signal.aborted) break
    if (e.tier !== "active" || !e.body.trim()) continue
    const access = aiAccessOf(e)
    if (access === "privat" || access === "lesen") continue
    if (ctx.ops.staged().some((s) => s.target === "agent" && s.name === e.name)) {
      skipped.push(`${e.name} (Vorschlag offen)`)
      continue
    }
    const name = e.title && !/\s/.test(e.title) ? e.title : e.name
    const evidence = agentEvidence(ctx, name, days)
    if (evidence.length < min) {
      skipped.push(`${name} (${evidence.length} Beleg(e))`)
      continue
    }
    jr.progress(`prüfe ${name}`)
    const answer = await askAssistant(
      ctx,
      `Du verbesserst den System-Prompt eines Agenten anhand von Belegen aus seiner Arbeit. Ändere nur, was die Belege stützen; erfinde nichts; behalte Aufbau und Sprache bei.\n\n## Aktueller Prompt von „${name}“\n\`\`\`\n${truncate(e.body, 20_000)}\n\`\`\`\n\n## Belege der letzten ${days} Tage\n${evidence.map((x) => `- ${x}`).join("\n")}\n\nAntworte mit genau einem JSON-Block:\n\`\`\`json\n{"change": true, "prompt": "der vollständige neue Prompt", "reason": "warum, mit Bezug auf die Belege", "evidence": ["welche Belege das stützen"]}\n\`\`\`\nWenn keine Änderung nötig ist: {"change": false, "reason": "…"}.`,
      `Agent ${name} verbessern`,
    )
    const j = jsonBlock(answer, "object") as AnyRecord | undefined
    if (!j?.change || typeof j.prompt !== "string" || !j.prompt.trim() || j.prompt.trim() === e.body.trim()) {
      skipped.push(`${name} (keine Änderung${j?.reason ? `: ${truncate(String(j.reason), 80)}` : ""})`)
      continue
    }
    const run = ctx.runs.create({ smith: "skillsmith", actor: "curator", trigger: `agent-review ${name}`, writeMode: "auto", directory: ctx.directory, project: ctx.project, limits: { maxNew: 0, maxChanges: 1, maxNotes: 0 } })
    try {
      // KI-Recht „vorschlag“ (default of imported agents): Ops stages it as a proposal with diff
      await ctx.ops.update(run, "agent", { name: e.name, body: j.prompt.trim(), reason: `Verbesserung aus ${evidence.length} Belegen: ${truncate(String(j.reason ?? ""), 600)}`, evidence: truncate((Array.isArray(j.evidence) ? j.evidence : evidence).join(" · "), 2000) } as any)
      await finalizeRun(ctx, run, { ok: true })
      proposed.push(name)
    } catch (err) {
      await finalizeRun(ctx, run, { ok: false, error: String(err) })
      skipped.push(`${name} (${truncate(String(err), 80)})`)
    }
  }
  return { summary: `${proposed.length ? `Vorschläge für ${proposed.join(", ")}` : "keine Vorschläge"}${skipped.length ? ` · übersprungen: ${skipped.join(", ")}` : ""}`, status: proposed.length ? "ok" : "skipped" }
}
