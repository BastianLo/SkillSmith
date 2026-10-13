/**
 * The action catalog (src/core/actions): the only write path of the web view.
 *
 *   POST /api/action {action, target, base, args, preview, force}
 *     → schema check → read-only check → version check (409 with diff) → preview or
 *       execution as one Run (actor "web", trigger "web <action>", write mode auto) →
 *       finalizeRun (one commit "<smith>(web): …", audit events, doctor queue).
 *
 * Slash commands call the same functions with actor "command".
 */
import type { Run } from "../../types"
import { errorMessage, oneLine, truncate } from "../../util/text"
import type { Ctx } from "../context"
import { finalizeRun } from "../finalize"
import { GuardError } from "../ops"
import { StoreError } from "../store"
import { ConfirmNeeded } from "../tasks"
import { AGENT_ACTIONS } from "./agents"
import { DOC_ACTIONS } from "./docs"
import { ENTRY_ACTIONS } from "./entries"
import { MEMORY_ACTIONS } from "./memory"
import { SYSTEM_ACTIONS } from "./system"
import { TASK_ACTIONS } from "./tasks"
import { OPERATION_ACTIONS } from "./operations"
import { QUALITY_ACTIONS } from "./quality"
import type { ActionDef, ActionEnv, ArgRule, ArgSchema, StrongToken } from "./types"

export * from "./types"

export const ACTIONS: ActionDef[] = [...ENTRY_ACTIONS, ...DOC_ACTIONS, ...TASK_ACTIONS, ...AGENT_ACTIONS, ...MEMORY_ACTIONS, ...SYSTEM_ACTIONS, ...OPERATION_ACTIONS, ...QUALITY_ACTIONS]
const BY_NAME = new Map(ACTIONS.map((a) => [a.name, a]))

export function actionDef(name: string): ActionDef | undefined {
  return BY_NAME.get(name)
}

/** Does this request need the token even when web.token is off? */
export function needsStrongToken(ctx: Ctx, req: ActionRequest): boolean {
  const def = BY_NAME.get(req.action)
  if (!def?.strongToken) return false
  let kind: StrongToken | undefined
  if (typeof def.strongToken === "function") {
    try {
      kind = def.strongToken({ ctx, actor: "web" }, parseArgs(def.args, { ...((req.args as Record<string, unknown>) ?? {}), ...(req.target !== undefined && "target" in def.args ? { target: req.target } : {}) }))
    } catch {
      kind = "pipeline"
    }
  } else kind = def.strongToken
  if (!kind) return false
  if (kind === "always") return true
  return kind === "tasks" ? ctx.options.tasks.requireToken : ctx.options.pipeline.requireToken
}

/** Errors with an HTTP status for the web server. */
export class ActionError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

const ID_RE = /^[a-z]+:[A-Za-z0-9][A-Za-z0-9_.:-]{0,120}$/
const HASH_RE = /^[0-9a-f]{7,40}$/

function check(name: string, rule: ArgRule, v: unknown): unknown {
  const missing = v === undefined || v === null || (v === "" && rule.t !== "string")
  if (missing) {
    if ((rule as { optional?: boolean }).optional) return undefined
    throw new ActionError(400, `Argument „${name}“ fehlt`)
  }
  switch (rule.t) {
    case "string": {
      if (typeof v !== "string") throw new ActionError(400, `„${name}“ muss Text sein`)
      if (!rule.multiline && /[\r\n]/.test(v)) throw new ActionError(400, `„${name}“ muss einzeilig sein`)
      if (rule.max !== undefined && v.length > rule.max) throw new ActionError(400, `„${name}“ ist länger als ${rule.max} Zeichen`)
      if (rule.min !== undefined && v.trim().length < rule.min) throw new ActionError(400, `„${name}“ ist zu kurz`)
      if (rule.pattern && !rule.pattern.test(v)) throw new ActionError(400, `„${name}“ hat ein ungültiges Format`)
      if (v === "" && !rule.optional && (rule.min ?? 1) > 0) throw new ActionError(400, `Argument „${name}“ fehlt`)
      return v
    }
    case "number": {
      const n = typeof v === "string" ? Number(v) : v
      if (typeof n !== "number" || !Number.isFinite(n)) throw new ActionError(400, `„${name}“ muss eine Zahl sein`)
      if (rule.int && !Number.isInteger(n)) throw new ActionError(400, `„${name}“ muss ganzzahlig sein`)
      if ((rule.min !== undefined && n < rule.min) || (rule.max !== undefined && n > rule.max)) throw new ActionError(400, `„${name}“ außerhalb des erlaubten Bereichs`)
      return n
    }
    case "boolean":
      if (typeof v !== "boolean") throw new ActionError(400, `„${name}“ muss true/false sein`)
      return v
    case "enum":
      if (typeof v !== "string" || !rule.values.includes(v)) throw new ActionError(400, `„${name}“: erlaubt sind ${rule.values.join(", ")}`)
      return v
    case "list": {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new ActionError(400, `„${name}“ muss eine Liste von Texten sein`)
      if (rule.max !== undefined && v.length > rule.max) throw new ActionError(400, `„${name}“: höchstens ${rule.max} Einträge`)
      if (rule.item !== undefined && v.some((x: string) => x.length > rule.item!)) throw new ActionError(400, `„${name}“: Einträge höchstens ${rule.item} Zeichen`)
      return v
    }
    case "object":
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new ActionError(400, `„${name}“ muss ein Objekt sein`)
      return v
    case "array":
      if (!Array.isArray(v) || v.some((x) => x === null || (typeof x !== "object" && typeof x !== "string"))) throw new ActionError(400, `„${name}“ muss eine Liste sein`)
      if (rule.max !== undefined && v.length > rule.max) throw new ActionError(400, `„${name}“: höchstens ${rule.max} Einträge`)
      return v
    case "id":
      if (typeof v !== "string" || !ID_RE.test(v)) throw new ActionError(400, `„${name}“ muss eine Id wie kind:name sein`)
      return v
    case "hash":
      if (typeof v !== "string" || !HASH_RE.test(v)) throw new ActionError(400, `„${name}“ muss ein Git-Hash sein`)
      return v
  }
}

export function parseArgs(schema: ArgSchema, raw: unknown): Record<string, unknown> {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(input)) if (!(k in schema)) throw new ActionError(400, `unbekanntes Argument „${k}“`)
  for (const [k, rule] of Object.entries(schema)) {
    const v = check(k, rule, input[k])
    if (v !== undefined) out[k] = v
  }
  return out
}

export interface ActionRequest {
  action: string
  target?: string
  base?: string
  args?: unknown
  preview?: boolean
  force?: boolean
}

export interface ActionResult {
  ok: boolean
  message: string
  preview?: unknown
  commit?: string
  run?: string
  audit?: number
  target?: string
  version?: string
  data?: unknown
  open?: string
  warnings?: string[]
}

/** Session-wide read-only switch of the web view ("Nur lesen für diese Sitzung"). */
export function sessionLock(): { locked: boolean } {
  const key = Symbol.for("skillsmith.webLock")
  return ((globalThis as any)[key] ??= { locked: false })
}

export function isReadOnly(ctx: Ctx): boolean {
  return ctx.options.web.readOnly || sessionLock().locked
}

/** Execute (or preview) an action. Throws ActionError with the HTTP status. */
export async function executeAction(env: ActionEnv, req: ActionRequest, payload?: Uint8Array): Promise<ActionResult> {
  if (payload) env = { ...env, payload }
  const def = BY_NAME.get(req.action)
  if (!def) throw new ActionError(404, `unbekannte Aktion „${req.action}“`)
  const args = parseArgs(def.args, { ...((req.args as Record<string, unknown>) ?? {}), ...(req.target !== undefined && "target" in def.args ? { target: req.target } : {}) })
  const { ctx } = env
  if (isReadOnly(ctx) && !def.readOnlySafe && !(def.name === "system.lock" && env.actor === "web")) {
    throw new ActionError(403, ctx.options.web.readOnly ? "Die Weboberfläche ist nur lesend (web.readOnly)" : "Schreiben ist für diese Sitzung gesperrt")
  }
  // version check: the user saw `base`; another run was faster → 409 with the diff
  if (req.base && def.version && !req.preview) {
    const current = def.version(env, args)
    if (current && current !== req.base && !req.force) {
      throw new ActionError(409, "Der Eintrag wurde inzwischen geändert", await conflictBody(ctx, String(args.target ?? req.target ?? ""), req.base, current))
    }
  }
  if (req.preview) {
    if (!def.preview) return { ok: true, message: "keine Vorschau für diese Aktion" }
    try {
      const p = await def.preview(env, args)
      return { ok: true, message: p.message ?? "", preview: p }
    } catch (err) {
      throw toActionError(err)
    }
  }
  const smith = typeof def.smith === "function" ? def.smith(args, env) : def.smith
  const run = ctx.runs.create({
    smith,
    actor: env.actor,
    trigger: `${env.actor === "web" ? "web " : ""}${def.name}`,
    writeMode: "auto",
    directory: ctx.directory,
    project: ctx.project,
    sessionID: env.session,
    limits: { maxNew: 10_000, maxChanges: 10_000, maxNotes: 100 },
  })
  let out: Awaited<ReturnType<ActionDef["run"]>> | undefined
  let error: unknown
  try {
    out = await def.run(env, run, args)
  } catch (err) {
    error = err
  }
  const fin = await finalizeRun(ctx, run, { ok: !error, error: error ? errorMessage(error) : undefined })
  if (error) throw toActionError(error)
  if (out?.after) {
    try {
      const note = await out.after()
      if (note) out.warnings = [...(out.warnings ?? []), note]
    } catch (err) {
      out.warnings = [...(out.warnings ?? []), errorMessage(err)]
    }
  }
  const audit = ctx.audit?.query({ run: run.id, limit: 1 }).events[0]?.seq
  const target = out?.target
  return {
    ok: true,
    message: out?.message ?? "erledigt",
    commit: fin.commit,
    run: run.id,
    audit,
    target,
    version: target ? versionOf(ctx, target) : undefined,
    data: out?.data,
    open: out?.open,
    warnings: out?.warnings,
  }
}

export function toActionError(err: unknown): ActionError {
  if (err instanceof ActionError) return err
  if (err instanceof ConfirmNeeded) return new ActionError(428, err.message, { confirm: err.message })
  if (err instanceof GuardError || err instanceof StoreError) return new ActionError(422, err.message)
  return new ActionError(500, errorMessage(err))
}

/** Content version of an entry (the "base" of the editor). */
export function versionOf(ctx: Ctx, id: string): string | undefined {
  const i = id.indexOf(":")
  if (i <= 0) return undefined
  const kind = id.slice(0, i)
  const name = id.slice(i + 1)
  try {
    return ctx.store.fresh(kind as any, name)?.version
  } catch {
    return undefined
  }
}

/** 409 body: current state and the diff from the version the user started with. */
async function conflictBody(ctx: Ctx, id: string, base: string, current: string): Promise<Record<string, unknown>> {
  const i = id.indexOf(":")
  const kind = id.slice(0, i) as any
  const name = id.slice(i + 1)
  const e = ctx.store.fresh(kind, name)
  let diff: unknown
  try {
    const log = await ctx.versions.log(kind, name, 30)
    for (const v of log) {
      const content = await ctx.versions.contentAt(kind, name, v.hash)
      if (!content.main) continue
      const { sha } = await import("../../util/text")
      if (sha(content.main) === base) {
        diff = await ctx.versions.diff(kind, name, "working", v.hash, ctx.options.web.diffMaxLines)
        break
      }
    }
  } catch {
    diff = undefined
  }
  const by = e?.meta?.history?.[e.meta.history.length - 1]
  return {
    conflict: true,
    base,
    current,
    changedBy: by ? `${by.actor} · ${by.action}${by.reason ? ` – ${truncate(oneLine(by.reason), 120)}` : ""}` : undefined,
    changedAt: by?.at,
    entry: e ? { title: e.title, description: e.description, tags: e.tags, fields: e.fields, body: e.body, version: e.version } : undefined,
    diff,
  }
}

/** Catalog for the UI (names, labels, areas, confirmations). */
export function catalog(ctx: Ctx): Array<Record<string, unknown>> {
  return ACTIONS.map((a) => ({
    name: a.name,
    label: a.label,
    area: a.area,
    confirm: a.confirm ? ctx.options.web.confirm[a.confirm] : "none",
    strongToken: typeof a.strongToken === "function" ? "depends" : a.strongToken ? (a.strongToken === "always" ? true : a.strongToken === "tasks" ? ctx.options.tasks.requireToken : ctx.options.pipeline.requireToken) : false,
    local: !!a.local,
    args: Object.fromEntries(Object.entries(a.args).map(([k, r]) => [k, { type: r.t, optional: !!(r as { optional?: boolean }).optional, ...("values" in r ? { values: r.values } : {}) }])),
  }))
}

/** Command helper: run an action as the user (actor command) and format the result. */
export async function commandAction(ctx: Ctx, session: string | undefined, req: ActionRequest): Promise<string> {
  try {
    const r = await executeAction({ ctx, actor: "command", session }, req)
    return `${r.message}${r.commit ? `\n(commit ${r.commit})` : ""}${r.warnings?.length ? `\nHinweis: ${r.warnings.join("; ")}` : ""}`
  } catch (err) {
    const e = toActionError(err)
    return e.status === 428 ? `Bestätigung nötig: ${e.message}` : `Abgelehnt: ${e.message}`
  }
}

export type { Run }
