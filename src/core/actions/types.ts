/**
 * Shared types of the action catalog: every write of the web view (and the shared logic
 * of the slash commands) is an action with an argument schema, an optional preview and
 * an execution that runs as one Run (at most one commit).
 */
import type { Smith } from "../../types"
import type { Run } from "../../types"
import type { Ctx } from "../context"

export type ArgRule =
  | { t: "string"; max?: number; min?: number; optional?: boolean; pattern?: RegExp; multiline?: boolean }
  | { t: "number"; min?: number; max?: number; optional?: boolean; int?: boolean }
  | { t: "boolean"; optional?: boolean }
  | { t: "enum"; values: readonly string[]; optional?: boolean }
  | { t: "list"; max?: number; item?: number; optional?: boolean }
  | { t: "object"; optional?: boolean }
  | { t: "array"; max?: number; optional?: boolean }
  | { t: "id"; optional?: boolean }
  | { t: "hash"; optional?: boolean }

export type ArgSchema = Record<string, ArgRule>

export type ActionArea =
  | "eintrag"
  | "neu"
  | "dokument"
  | "aufgabe"
  | "agent"
  | "projekt"
  | "erinnerung"
  | "verknuepfung"
  | "doktor"
  | "glossar"
  | "freigabe"
  | "system"

export interface ActionEnv {
  ctx: Ctx
  actor: "web" | "command"
  session?: string
  /** binary payload (attachment upload) */
  payload?: Uint8Array
}

export interface ActionOutput {
  message: string
  /** id of the changed entry (the UI reloads it) */
  target?: string
  data?: unknown
  /** link to open afterwards (#/…) */
  open?: string
  warnings?: string[]
  /** follow-up after the run is finalized (its commit is done, its claims are released) */
  after?: () => Promise<string | undefined>
}

export interface ActionPreview {
  message?: string
  diff?: unknown
  affected?: Array<{ id: string; title: string; detail?: string }>
  data?: unknown
  /** "type the name" confirmation */
  confirmName?: string
}

export type StrongToken = "tasks" | "pipeline" | "always"

export interface ActionDef<A = any> {
  name: string
  label: string
  area: ActionArea
  smith: Smith | ((args: A, env: ActionEnv) => Smith)
  args: ArgSchema
  /** confirmation from web.confirm */
  confirm?: "delete" | "undo" | "restore" | "merge" | "rename"
  /** needs the token even when web.token is off (tasks.requireToken / pipeline.requireToken; "always" = security settings) */
  strongToken?: StrongToken | ((env: ActionEnv, args: A) => StrongToken | undefined)
  /** local data only (no commit expected) */
  local?: boolean
  /** allowed in read-only mode (starts nothing that writes, e.g. a simulation) */
  readOnlySafe?: boolean
  /** version of the target the user saw (conflict check, 409) */
  version?(env: ActionEnv, args: A): string | undefined
  preview?(env: ActionEnv, args: A): Promise<ActionPreview>
  run(env: ActionEnv, run: Run, args: A): Promise<ActionOutput>
}

export function defineAction<A = any>(def: ActionDef<A>): ActionDef<A> {
  return def
}
