/**
 * Settings page (5a): overrides in settings.json of the store – versioned like every entry,
 * with undo – on top of opencode.json. Every value shows where it comes from.
 *
 *   default < opencode.json < settings.json < environment (SKILLSMITH_*)
 *
 * A change validates against the option schema, writes settings.json in one run (one commit)
 * and applies the new values in place to the options of every plugin instance of this store
 * in this process (`syncInto` keeps object identity – Ops, Retriever, … hold references).
 * Other processes pick the file up through `refreshIfChanged()` (job scheduler tick).
 */
import { statSync } from "node:fs"
import { join } from "node:path"
import { defaults, optionLeaves, readSettingsFile, resolveOptions, SETTINGS_DENY, SETTINGS_FILE, validateOption, valueAt, type OptionSource, type Options, type ValueSpec } from "../config"
import type { Run } from "../types"
import { stableStringify, writeFileAtomic } from "../util/fs"
import type { Ctx } from "./context"
import { GuardError } from "./ops"
import { groupOf, isSecurity, metaOf, needsRestart, SETTINGS_GROUPS } from "./settings-meta"

interface Instance {
  raw: unknown
  options: Options
  env: NodeJS.ProcessEnv
}

function registry(storeRoot: string): Set<Instance> {
  const key = Symbol.for(`skillsmith.options:${storeRoot}`)
  return ((globalThis as any)[key] ??= new Set<Instance>())
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

/** Make `target` structurally equal to `source` while keeping the identity of nested objects. */
export function syncInto(target: Record<string, any>, source: Record<string, any>): void {
  for (const k of Object.keys(target)) if (!(k in source)) delete target[k]
  for (const [k, v] of Object.entries(source)) {
    if (isPlain(v) && isPlain(target[k])) syncInto(target[k], v)
    else target[k] = isPlain(v) ? structuredClone(v) : Array.isArray(v) ? [...v] : v
  }
}

function setAt(obj: Record<string, any>, path: string, value: unknown): void {
  const parts = path.split(".")
  let cur = obj
  for (const p of parts.slice(0, -1)) {
    if (!isPlain(cur[p])) cur[p] = {}
    cur = cur[p]
  }
  cur[parts[parts.length - 1]] = value
}

function deleteAt(obj: Record<string, any>, path: string): void {
  const parts = path.split(".")
  const stack: Array<[Record<string, any>, string]> = []
  let cur: any = obj
  for (const p of parts.slice(0, -1)) {
    if (!isPlain(cur[p])) return
    stack.push([cur, p])
    cur = cur[p]
  }
  delete cur[parts[parts.length - 1]]
  // drop empty parents
  for (let i = stack.length - 1; i >= 0; i--) {
    const [parent, key] = stack[i]
    if (isPlain(parent[key]) && !Object.keys(parent[key]).length) delete parent[key]
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export interface SettingView {
  path: string
  group: string
  label: string
  help?: string
  spec: ValueSpec
  value: unknown
  standard: unknown
  opencode?: unknown
  settings?: unknown
  source: OptionSource
  restart: boolean
  security: boolean
  /** cannot be changed here (secret, store, or the environment wins) */
  locked?: string
}

export interface SettingChange {
  path: string
  /** new value; `reset: true` removes the override (back to opencode.json / default) */
  value?: unknown
  reset?: boolean
}

export class Settings {
  private mtime = 0
  private instance: Instance
  /** values changed in this process that need a restart */
  readonly pendingRestart = new Set<string>()

  constructor(
    private ctx: Ctx,
    private raw: unknown = {},
    private env: NodeJS.ProcessEnv = process.env,
  ) {
    this.instance = { raw, options: ctx.options, env }
    registry(ctx.store.root).add(this.instance)
    this.mtime = this.fileMtime()
  }

  get file(): string {
    return join(this.ctx.store.root, SETTINGS_FILE)
  }

  private fileMtime(): number {
    try {
      return statSync(this.file).mtimeMs
    } catch {
      return 0
    }
  }

  /** Overrides of settings.json. */
  values(): Record<string, unknown> {
    return readSettingsFile(this.ctx.store.root).values
  }

  /** Every value with its source, for the settings page. */
  view(): { groups: Array<{ id: string; label: string }>; values: SettingView[]; warnings: string[]; pendingRestart: string[]; file: string } {
    const settings = this.values()
    const resolved = resolveOptions(this.raw, this.env, settings)
    const std = defaults(this.env)
    const values: SettingView[] = []
    for (const { path, spec } of optionLeaves()) {
      const meta = metaOf(path)
      const src = resolved.sources[path] ?? "standard"
      const locked = SETTINGS_DENY.has(path) ? (path === "storeDir" ? "nur in opencode.json oder über die Umgebung" : "Geheimnis – nie in den Einstellungen") : src === "umgebung" ? "von einer Umgebungsvariable gesetzt" : undefined
      values.push({
        path,
        group: groupOf(path).id,
        label: meta.label,
        help: meta.help,
        spec,
        value: path === "embedding.apiKey" ? (valueAt(resolved.options, path) ? "••••" : undefined) : valueAt(resolved.options, path),
        standard: path === "storeDir" ? undefined : valueAt(std, path),
        opencode: path === "embedding.apiKey" ? undefined : valueAt(this.raw, path),
        settings: valueAt(settings, path),
        source: src,
        restart: needsRestart(path),
        security: isSecurity(path),
        locked,
      })
    }
    return { groups: SETTINGS_GROUPS.map((g) => ({ id: g.id, label: g.label })), values, warnings: resolved.warnings, pendingRestart: [...this.pendingRestart], file: SETTINGS_FILE }
  }

  /** Paths of a change request that are security relevant (token + confirmation). */
  securityPaths(changes: SettingChange[]): string[] {
    return changes.map((c) => c.path).filter(isSecurity)
  }

  /** Validate, write settings.json (run → one commit), apply in place. */
  async change(run: Run, changes: SettingChange[], reason?: string): Promise<{ message: string; changed: Array<{ path: string; before: unknown; after: unknown }>; restart: string[] }> {
    if (!changes.length) throw new GuardError("Keine Änderung")
    const leaves = new Set(optionLeaves().map((l) => l.path))
    const settings = structuredClone(this.values())
    const resolvedBefore = resolveOptions(this.raw, this.env, settings)
    for (const c of changes) {
      if (!leaves.has(c.path)) throw new GuardError(`Unbekannte Einstellung „${c.path}“`)
      if (SETTINGS_DENY.has(c.path)) throw new GuardError(`„${c.path}“ lässt sich hier nicht setzen (${c.path === "storeDir" ? "nur opencode.json/Umgebung" : "Geheimnisse liegen nie im Store"})`)
      if (resolvedBefore.sources[c.path] === "umgebung") throw new GuardError(`„${c.path}“ wird von einer Umgebungsvariable gesetzt – die gewinnt`)
      if (c.reset) {
        deleteAt(settings, c.path)
        continue
      }
      let v: unknown
      try {
        v = validateOption(c.path, c.value)
      } catch (err) {
        throw new GuardError(`${metaOf(c.path).label} (${c.path}): ${(err as Error).message}`)
      }
      setAt(settings, c.path, v)
    }
    const after = resolveOptions(this.raw, this.env, settings)
    const changed: Array<{ path: string; before: unknown; after: unknown }> = []
    for (const c of changes) {
      const b = valueAt(resolvedBefore.options, c.path)
      const a = valueAt(after.options, c.path)
      if (!same(b, a) || (c.reset && valueAt(this.values(), c.path) !== undefined)) changed.push({ path: c.path, before: b, after: a })
    }
    if (!changed.length) return { message: "Keine Änderung – die Werte gelten schon", changed, restart: [] }
    writeFileAtomic(this.file, stableStringify(settings))
    run.touched.add(SETTINGS_FILE)
    const label = changed.map((c) => c.path).join(", ")
    run.subject = `skillsmith(${run.actor}): settings ${label}`.slice(0, 72)
    run.summary = reason ? `${reason}: ${label}` : label
    for (const c of changed) {
      run.actions.push({ kind: "update", target: "settings", name: c.path, reason: reason ?? metaOf(c.path).label, detail: `${JSON.stringify(c.before) ?? "–"} → ${JSON.stringify(c.after) ?? "–"}`, applied: true })
      ;(run.localChanges ??= []).push({ id: `settings:${c.path}`, before: c.before, after: c.after })
    }
    this.applyAll()
    const restart = changed.map((c) => c.path).filter(needsRestart)
    for (const p of restart) this.pendingRestart.add(p)
    this.ctx.bus?.emit("settings.changed", { paths: changed.map((c) => c.path), restart })
    return {
      message: `${changed.length} Einstellung(en) gespeichert${restart.length ? ` – wirkt nach einem Neustart von opencode: ${restart.join(", ")}` : ""}`,
      changed,
      restart,
    }
  }

  /** Re-resolve and apply to every instance of this store in the process. */
  applyAll(): string[] {
    const values = this.values()
    const warnings: string[] = []
    for (const inst of registry(this.ctx.store.root)) {
      const r = resolveOptions(inst.raw, inst.env, values)
      // the store of a running instance never moves
      r.options.storeDir = inst.options.storeDir
      syncInto(inst.options as unknown as Record<string, any>, r.options as unknown as Record<string, any>)
      warnings.push(...r.warnings)
    }
    this.mtime = this.fileMtime()
    return [...new Set(warnings)]
  }

  /** settings.json changed (other process, undo, git pull) → apply. */
  refreshIfChanged(): boolean {
    const m = this.fileMtime()
    if (m === this.mtime) return false
    const warnings = this.applyAll()
    for (const w of warnings) this.ctx.log.warn(w)
    this.ctx.bus?.emit("settings.changed", { paths: [], restart: [] })
    return true
  }

  dispose(): void {
    registry(this.ctx.store.root).delete(this.instance)
  }
}
