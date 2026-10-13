/**
 * toolsmith workshop: drafts live in state/drafts/<runId>/<name>/ and are
 * checked on every draft/revise; only a passing draft can be published.
 * Publishing goes through Ops (budget, recurrence gate, write modes, forced
 * approval for risky capabilities, git commit of the run).
 */
import { rmSync } from "node:fs"
import { join } from "node:path"
import type { Run, TestStatus } from "../types"
import { nowIso, oneLine } from "../util/text"
import type { Ctx } from "./context"
import { str, strArray } from "./frontmatter"
import { normalizeTags, scriptFiles, scriptLanguage } from "./kinds"
import { checkTsDraft } from "./scripts"
import { GuardError, type PublishArgs } from "./ops"
import { checkDraft, draftFiles, draftRoot, pythonEnv, type CheckReport, type Draft, type DraftSpec } from "./pyworkshop"
import { validateDescription, validateName } from "./skill"

export type DraftPatch = Partial<Omit<DraftSpec, "name">>

export class Workshop {
  constructor(private ctx: Ctx) {}

  private drafts(run: Run): Map<string, Draft> {
    run.drafts ??= new Map()
    return run.drafts as Map<string, Draft>
  }

  private validateSpec(spec: DraftSpec): void {
    const o = this.ctx.options
    const nameErr = validateName(spec.name)
    if (nameErr) throw new GuardError(nameErr)
    const descErr = validateDescription(spec.description, o.maxDescriptionChars)
    if (descErr) throw new GuardError(descErr)
    const usage = spec.usage.trim()
    if (!usage || /\n/.test(usage) || usage.length > 300) throw new GuardError("usage must be one line (≤ 300 chars), e.g. python3 <module>.py --input <file>")
    if (!spec.docs.trim()) throw new GuardError('docs are required ("## Zweck", "## Aufruf", "## Ein- und Ausgabe", "## Grenzen")')
    if (spec.code.length > 60_000 || spec.tests.length > 60_000) throw new GuardError("code and tests must each be ≤ 60000 characters")
    const secrets = this.ctx.redactor.scan([spec.code, spec.tests, spec.docs, spec.usage, spec.description].join("\n"))
    if (secrets.length) throw new GuardError(`the script looks like it contains sensitive data (${secrets.join(", ")}); use arguments or environment variables instead`)
  }

  /** Check of a draft with the runtime of its language. */
  private async runCheck(spec: DraftSpec, dir: string) {
    if (spec.language === "typescript") return checkTsDraft({ spec, dir, options: this.ctx.options, stateDir: this.ctx.store.stateDir, log: this.ctx.log })
    const env = await pythonEnv(this.ctx.options, this.ctx.store.stateDir)
    return checkDraft({ spec, dir, env, options: this.ctx.options, log: this.ctx.log })
  }

  private async check(run: Run, spec: DraftSpec, isNew: boolean, iterations: number): Promise<string> {
    const dir = draftRoot(this.ctx.store.stateDir, run.id, spec.name)
    const report = await this.runCheck(spec, dir)
    const draft: Draft = { ...spec, isNew, iterations, dir, updatedAt: nowIso(), check: report }
    this.drafts(run).set(spec.name, draft)
    const left = this.ctx.options.toolsmith.maxIterations - iterations
    const next = report.ok
      ? `\nNext: toolsmith_publish(name="${spec.name}", reason=…${isNew ? ", candidate_id or user_quote" : ""}).`
      : left > 0
        ? `\nFix the problems with toolsmith_revise(name="${spec.name}", …) – ${left} iteration(s) left.`
        : "\nNo iterations left for this script in this run – give up on it (toolsmith_note) and finish."
    return `${isNew ? "new script" : `new version of "${spec.name}"`} – iteration ${iterations}/${this.ctx.options.toolsmith.maxIterations}\n${report.text}${next}`
  }

  async draft(run: Run, input: DraftSpec): Promise<string> {
    const o = this.ctx.options.toolsmith
    const spec: DraftSpec = {
      ...input,
      name: input.name.trim(),
      description: oneLine(input.description ?? ""),
      usage: oneLine(input.usage ?? ""),
      tags: normalizeTags(input.tags ?? []),
      capabilities: [...new Set(strArray(input.capabilities).map((c) => c.trim()))],
      requirements: [...new Set(strArray(input.requirements).map((c) => c.trim()))],
    }
    const existing = this.ctx.store.getOwned("script", spec.name)
    if (!existing && run.actor === "curator") throw new GuardError("the curator can only repair existing scripts")
    if (existing && !input.language) spec.language = scriptLanguage(existing)
    spec.language = spec.language === "typescript" ? "typescript" : "python"
    if (existing) {
      if (!spec.params && existing.fields.params) spec.params = existing.fields.params as Record<string, unknown>
      if (!spec.result && existing.fields.result) spec.result = existing.fields.result as Record<string, unknown>
      const f = scriptFiles(spec.name, scriptLanguage(existing))
      if (!spec.code.trim()) spec.code = this.ctx.store.readFileOf(existing, f.code) ?? ""
      if (!spec.tests.trim()) spec.tests = this.ctx.store.readFileOf(existing, f.test) ?? ""
      if (!spec.docs.trim()) spec.docs = existing.body
      if (!spec.description) spec.description = existing.description
      if (!spec.usage) spec.usage = str(existing.fields.usage)
      if (!spec.tags.length) spec.tags = existing.tags
      if (!input.capabilities?.length) spec.capabilities = strArray(existing.fields.capabilities)
      if (!input.requirements?.length) spec.requirements = strArray(existing.fields.requirements)
    }
    this.validateSpec(spec)
    const prev = this.drafts(run).get(spec.name)
    const iterations = (prev?.iterations ?? 0) + 1
    if (iterations > o.maxIterations) throw new GuardError(`iteration limit (${o.maxIterations}) reached for "${spec.name}"`)
    return this.check(run, spec, !existing, iterations)
  }

  async revise(run: Run, name: string, patch: DraftPatch): Promise<string> {
    const prev = this.drafts(run).get(name.trim())
    if (!prev) throw new GuardError(`no draft "${name}" in this run – start with toolsmith_draft`)
    const spec: DraftSpec = {
      name: prev.name,
      description: patch.description !== undefined && patch.description !== "" ? oneLine(patch.description) : prev.description,
      usage: patch.usage !== undefined && patch.usage !== "" ? oneLine(patch.usage) : prev.usage,
      code: patch.code !== undefined && patch.code !== "" ? patch.code : prev.code,
      tests: patch.tests !== undefined && patch.tests !== "" ? patch.tests : prev.tests,
      docs: patch.docs !== undefined && patch.docs !== "" ? patch.docs : prev.docs,
      capabilities: patch.capabilities?.length ? [...new Set(patch.capabilities)] : prev.capabilities,
      requirements: patch.requirements?.length ? [...new Set(patch.requirements)] : prev.requirements,
      tags: patch.tags?.length ? normalizeTags(patch.tags) : prev.tags,
      language: prev.language,
      params: patch.params ?? prev.params,
      result: patch.result ?? prev.result,
    }
    this.validateSpec(spec)
    const iterations = prev.iterations + 1
    if (iterations > this.ctx.options.toolsmith.maxIterations) {
      throw new GuardError(`iteration limit (${this.ctx.options.toolsmith.maxIterations}) reached for "${spec.name}"`)
    }
    return this.check(run, spec, prev.isNew, iterations)
  }

  async publish(run: Run, a: { name: string; reason?: string; candidateId?: string; userQuote?: string }): Promise<string> {
    const draft = this.drafts(run).get(a.name.trim())
    if (!draft) throw new GuardError(`no draft "${a.name}" in this run – start with toolsmith_draft`)
    if (!draft.check?.ok) throw new GuardError(`the last check of "${draft.name}" did not pass – fix it with toolsmith_revise first:\n${draft.check?.text ?? ""}`)
    if (draft.isNew) {
      if (run.actor === "curator") throw new GuardError("the curator cannot publish new scripts")
      this.ctx.ops.recurrenceGate(run, "script", this.ctx.options.toolsmith.recurrenceMinSessions, a.candidateId, a.userQuote)
    }
    const args = toPublishArgs(draft, draft.check, this.ctx.options.toolsmith.pythonTarget, a)
    return this.ctx.ops.publishScript(run, args)
  }

  /** Re-check of a staged script right before an approved publish. */
  recheck = async (args: PublishArgs): Promise<{ ok: boolean; message: string; test?: TestStatus }> => {
    const spec = fromPublishArgs(args)
    const dir = join(this.ctx.store.stateDir, "drafts", `approve-${Date.now()}`, spec.name)
    try {
      const report = await this.runCheck(spec, dir)
      return { ok: report.ok, message: report.text, test: report.test }
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true })
    }
  }
}

export function toPublishArgs(draft: DraftSpec & { isNew: boolean }, check: CheckReport, pythonTarget: string, a: { reason?: string; candidateId?: string }): PublishArgs {
  const ts = draft.language === "typescript"
  const f = scriptFiles(draft.name, draft.language)
  return {
    name: draft.name,
    isNew: draft.isNew,
    content: {
      name: draft.name,
      title: draft.name,
      description: draft.description,
      tags: normalizeTags(draft.tags),
      fields: {
        usage: draft.usage,
        entry: f.code,
        capabilities: [...new Set([...draft.capabilities, ...check.detected])].sort(),
        requirements: draft.requirements,
        python: ts ? "" : pythonTarget,
        language: ts ? "typescript" : "python",
        ...(draft.params ? { params: draft.params } : {}),
        ...(draft.result ? { result: draft.result } : {}),
      },
      body: draft.docs.trim(),
    },
    files: draftFiles(draft),
    test: check.test,
    capabilities: [...new Set([...draft.capabilities, ...check.detected])].sort(),
    reason: a.reason,
    candidateId: a.candidateId,
    needsApproval: check.needsApproval,
  }
}

export function fromPublishArgs(args: PublishArgs): DraftSpec {
  const language = str(args.content.fields.language) === "typescript" ? "typescript" : "python"
  const f = scriptFiles(args.content.name, language)
  return {
    name: args.content.name,
    description: args.content.description,
    usage: str(args.content.fields.usage),
    code: args.files[f.code] ?? "",
    tests: args.files[f.test] ?? "",
    capabilities: strArray(args.content.fields.capabilities),
    requirements: strArray(args.content.fields.requirements),
    tags: args.content.tags,
    docs: args.content.body,
    language,
    params: args.content.fields.params as Record<string, unknown> | undefined,
    result: args.content.fields.result as Record<string, unknown> | undefined,
  }
}
