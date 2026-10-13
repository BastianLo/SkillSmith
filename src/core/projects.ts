/**
 * Projects (kind "project", maintained by the user only): name, home_path (the application's
 * directory, e.g. a Java/Maven repo), default agent and model, board columns and WIP limits,
 * and a pipeline of check commands that runs when a card enters a trigger column.
 */
import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve, sep } from "node:path"
import type { Options } from "../config"
import type { Entry } from "../types"
import { str, strArray } from "./frontmatter"
import { normalizeFlow, type FlowConfig } from "./workflow"
import type { Store } from "./store"

export interface PipelineStage {
  name: string
  run: string
  /** minutes */
  timeoutMin?: number
  /** glob of JUnit XML reports, relative to the work directory */
  reports?: string
  allowFailure?: boolean
}

export interface PipelineDef {
  trigger: string[]
  source: "arbeitsverzeichnis" | "branch"
  stages: PipelineStage[]
}

export interface ProjectView {
  id: string
  name: string
  title: string
  description: string
  homePath?: string
  homeExists: boolean
  agent?: string
  model?: string
  color?: string
  columns: string[]
  wip: Record<string, number>
  pipeline?: PipelineDef
  /** workflow per column (5b), validated */
  flow?: Record<string, FlowConfig>
  tier: string
  aliases: string[]
}

export function expandPath(p: string): string {
  if (p === "~") return homedir()
  if (p.startsWith("~/")) return join(homedir(), p.slice(2))
  return p
}

/** "20m", "90s", "1h", 15 → minutes */
export function parseTimeout(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(s|sek|m|min|h|std)?\s*$/i.exec(String(v))
  if (!m) return undefined
  const n = Number(m[1].replace(",", "."))
  const unit = (m[2] ?? "m").toLowerCase()
  return unit.startsWith("s") ? n / 60 : unit.startsWith("h") || unit === "std" ? n * 60 : n
}

/** Validate and normalise a pipeline definition (throws with a German message). */
export function normalizePipeline(raw: unknown, columns: string[]): PipelineDef | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("Pipeline muss ein Objekt mit trigger, source und stages sein")
  const r = raw as Record<string, unknown>
  const trigger = strArray(r.trigger ?? ["test"])
  for (const t of trigger) if (!columns.includes(t)) throw new Error(`Auslöser-Spalte „${t}“ gibt es nicht (Spalten: ${columns.join(", ")})`)
  const source = str(r.source || "arbeitsverzeichnis")
  if (source !== "arbeitsverzeichnis" && source !== "branch") throw new Error("source muss arbeitsverzeichnis oder branch sein")
  if (!Array.isArray(r.stages)) throw new Error("stages muss eine Liste sein")
  const stages: PipelineStage[] = []
  const names = new Set<string>()
  for (const s of r.stages) {
    if (!s || typeof s !== "object") throw new Error("jede Stufe braucht name und run")
    const x = s as Record<string, unknown>
    const name = str(x.name).trim()
    const run = str(x.run).trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,40}$/.test(name)) throw new Error(`Stufenname „${name}“ ungültig (Buchstaben, Ziffern, Leerzeichen, _ . -)`)
    if (names.has(name)) throw new Error(`Stufe „${name}“ doppelt`)
    names.add(name)
    if (!run || run.length > 2000 || /\n/.test(run)) throw new Error(`Stufe „${name}“: run muss eine Befehlszeile sein (höchstens 2000 Zeichen)`)
    const timeoutMin = parseTimeout(x.timeout ?? x.timeoutMin)
    if ((x.timeout !== undefined || x.timeoutMin !== undefined) && timeoutMin === undefined) throw new Error(`Stufe „${name}“: Zeitlimit wie 20m, 90s oder 1h angeben`)
    const reports = str(x.reports).trim()
    if (reports && (isAbsolute(reports) || reports.split("/").includes(".."))) throw new Error(`Stufe „${name}“: reports muss ein relativer Pfad im Projekt sein`)
    stages.push({ name, run, ...(timeoutMin ? { timeoutMin } : {}), ...(reports ? { reports } : {}), ...(x.allowFailure === true || x.allowFailure === "true" ? { allowFailure: true } : {}) })
  }
  if (stages.length > 20) throw new Error("höchstens 20 Stufen")
  return { trigger, source, stages }
}

export class Projects {
  constructor(
    private store: Store,
    private options: Options,
  ) {}

  view(e: Entry): ProjectView {
    const f = e.fields
    const columns = strArray(f.columns).length ? strArray(f.columns) : this.options.tasks.columns
    const home = str(f.home_path)
    let pipeline: PipelineDef | undefined
    try {
      pipeline = normalizePipeline(f.pipeline, columns)
    } catch {
      pipeline = undefined
    }
    let flow: Record<string, FlowConfig> | undefined
    try {
      flow = normalizeFlow(f.flow, columns)
    } catch {
      flow = undefined
    }
    const wip: Record<string, number> = { ...this.options.tasks.wipLimits }
    if (f.wip && typeof f.wip === "object") for (const [k, v] of Object.entries(f.wip as Record<string, unknown>)) if (Number(v) > 0) wip[k] = Math.round(Number(v))
    let homeExists = false
    if (home) {
      try {
        realpathSync(expandPath(home))
        homeExists = true
      } catch {
        homeExists = false
      }
    }
    return {
      id: `project:${e.name}`,
      name: e.name,
      title: e.title,
      description: e.description,
      homePath: home || undefined,
      homeExists,
      agent: str(f.agent) || undefined,
      model: str(f.model) || undefined,
      color: str(f.color) || undefined,
      columns,
      wip,
      pipeline,
      flow,
      tier: e.tier,
      aliases: strArray(f.aliases),
    }
  }

  list(includeArchived = false): ProjectView[] {
    return this.store
      .list("project")
      .filter((e) => includeArchived || e.tier === "active")
      .map((e) => this.view(e))
      .sort((a, b) => a.title.localeCompare(b.title))
  }

  get(name: string): ProjectView | undefined {
    const e = this.store.getOwned("project", name.replace(/^project:/, ""))
    return e ? this.view(e) : undefined
  }

  /** Project whose home_path contains a directory (sessions, worktrees of agent tasks). */
  forDirectory(dir: string, worktrees: Record<string, string> = {}): ProjectView | undefined {
    let real: string
    try {
      real = realpathSync(resolve(dir))
    } catch {
      real = resolve(dir)
    }
    for (const p of this.list()) {
      if (!p.homePath) continue
      let home: string
      try {
        home = realpathSync(expandPath(p.homePath))
      } catch {
        continue
      }
      if (real === home || real.startsWith(home + sep)) return p
    }
    // worktrees of agent tasks live outside the home path
    for (const [wt, project] of Object.entries(worktrees)) if (real === wt || real.startsWith(wt + sep)) return this.get(project)
    return undefined
  }

  /** Columns of a project (or the global default). */
  columns(project?: string): string[] {
    return (project ? this.get(project)?.columns : undefined) ?? this.options.tasks.columns
  }
}
