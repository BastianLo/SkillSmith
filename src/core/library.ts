/**
 * Snippet and prompt library (5j). Two kinds in the store:
 *
 *   snippet  code with language, description, tags, placeholders ${name} / ${name:default}
 *            and its origin (session, commit or file with code anchor); optional test
 *            (a script run through call_script)
 *   prompt   text with variables {{ticket}}, {{auswahl}}, {{datei}} …, recommended agent
 *            and model; one opencode command /prompt <name> <werte> fills it in (new
 *            prompts work without a restart, only this one command is registered)
 *
 * Usage per prompt version (entry version) and its outcome are kept locally
 * (state/library.json); repeated code in several sessions becomes a snippet candidate.
 */
import { join } from "node:path"
import type { Entry } from "../types"
import { readJson, withLock, writeJsonAtomic } from "../util/fs"
import { nowIso, sha, truncate } from "../util/text"
import type { Ctx } from "./context"
import { str } from "./frontmatter"
import { fenceLanguage } from "./kinds"

const PLACEHOLDER_RE = /\$\{([A-Za-z_][\w-]*)(?::([^}]*))?\}/g
const VAR_RE = /\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g

/** Code of a snippet: the first fenced block, else the whole body. */
export function snippetCode(e: Pick<Entry, "body">): string {
  const m = /```[^\n]*\n([\s\S]*?)```/.exec(e.body)
  return (m ? m[1] : e.body).replace(/\n$/, "")
}

export function placeholders(code: string): Array<{ name: string; default?: string }> {
  const out: Array<{ name: string; default?: string }> = []
  for (const m of code.matchAll(PLACEHOLDER_RE)) if (!out.some((p) => p.name === m[1])) out.push({ name: m[1], ...(m[2] !== undefined ? { default: m[2] } : {}) })
  return out
}

export function fillSnippet(code: string, values: Record<string, string>): { text: string; missing: string[] } {
  const missing: string[] = []
  const text = code.replace(PLACEHOLDER_RE, (_m, name: string, def?: string) => {
    if (values[name] !== undefined) return values[name]
    if (def !== undefined) return def
    if (!missing.includes(name)) missing.push(name)
    return `\${${name}}`
  })
  return { text, missing }
}

export function promptVariables(text: string): string[] {
  return [...new Set([...text.matchAll(VAR_RE)].map((m) => m[1]))]
}

export function fillPrompt(text: string, values: Record<string, string>): { text: string; missing: string[] } {
  const missing: string[] = []
  const out = text.replace(VAR_RE, (m, name: string) => {
    if (values[name] !== undefined && values[name] !== "") return values[name]
    if (!missing.includes(name)) missing.push(name)
    return m
  })
  return { text: out, missing }
}

/**
 * Arguments of /prompt: "<name> key=value key2="mit Leerzeichen" rest of text".
 * Text that is not key=value fills the first missing variable (usually {{auswahl}}).
 */
export function parsePromptArgs(raw: string): { name: string; values: Record<string, string>; rest: string } {
  const s = raw.trim()
  const name = s.split(/\s+/)[0] ?? ""
  let rest = s.slice(name.length).trim()
  const values: Record<string, string> = {}
  const re = /^([A-Za-z_][\w-]*)=(?:"([^"]*)"|'([^']*)'|(\S+))\s*/
  for (let m = re.exec(rest); m; m = re.exec(rest)) {
    values[m[1]] = m[2] ?? m[3] ?? m[4] ?? ""
    rest = rest.slice(m[0].length)
  }
  return { name, values, rest: rest.trim() }
}

/** Values from the context: branch, ticket, project, date, current task of the branch. */
export function contextValues(ctx: Ctx): Record<string, string> {
  const out: Record<string, string> = { datum: new Date().toISOString().slice(0, 10) }
  try {
    const s = ctx.scope()
    if (s.branch) out.branch = s.branch
    if (s.ticket) out.ticket = s.ticket
    out.projekt = s.projectName
    const task = ctx.tasks?.list({ project: "*" }).find((t) => (s.branch && t.branch === s.branch) || (s.ticket && t.ticket === s.ticket))
    if (task) out.aufgabe = `${task.id} ${task.title}`
  } catch {
    // no scope
  }
  return out
}

interface LibraryState {
  /** prompt name → version → usage */
  prompts: Record<string, Record<string, { uses: number; good: number; bad: number; last?: string }>>
  /** hash of normalized code → candidate */
  snippets: Record<string, { code: string; language: string; sessions: string[]; first: string; last: string; dismissed?: boolean }>
}

const norm = (code: string) =>
  code
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n")

export class Library {
  constructor(private ctx: Ctx) {}

  private get file(): string {
    return join(this.ctx.store.stateDir, "library.json")
  }

  state(): LibraryState {
    return readJson<LibraryState>(this.file, { prompts: {}, snippets: {} })
  }

  private async update(fn: (s: LibraryState) => void): Promise<void> {
    await withLock(this.ctx.store.locksDir, "library", () => {
      const s = this.state()
      fn(s)
      writeJsonAtomic(this.file, s)
    })
  }

  /** A prompt was used (version = entry version). */
  async promptUsed(e: Entry): Promise<void> {
    await this.update((s) => {
      const v = ((s.prompts[e.name] ??= {})[e.version] ??= { uses: 0, good: 0, bad: 0 })
      v.uses++
      v.last = nowIso()
    })
  }

  /** Outcome of a prompt use: good (kept) or bad (reworked / discarded). */
  async promptFeedback(e: Entry, good: boolean): Promise<void> {
    await this.update((s) => {
      const v = ((s.prompts[e.name] ??= {})[e.version] ??= { uses: 0, good: 0, bad: 0 })
      if (good) v.good++
      else v.bad++
    })
  }

  promptStats(name: string): Array<{ version: string; uses: number; good: number; bad: number; last?: string }> {
    return Object.entries(this.state().prompts[name] ?? {}).map(([version, v]) => ({ version, ...v }))
  }

  /**
   * Code written in a session (edit/write): blocks of ≥ 5 lines are remembered by hash; seen in
   * ≥ recurrenceMinSessions sessions they become a snippet candidate (same gate as skills).
   */
  async recordCode(session: string, code: string, language: string): Promise<void> {
    const lines = norm(code).split("\n")
    if (lines.length < 5 || lines.length > 80 || this.ctx.redactor.scan(code).length) return
    const key = sha(norm(code), 12)
    await this.update((s) => {
      const c = (s.snippets[key] ??= { code: truncate(code, 6000), language, sessions: [], first: nowIso(), last: nowIso() })
      if (!c.sessions.includes(session)) c.sessions.push(session)
      c.last = nowIso()
      // bounded
      const keys = Object.keys(s.snippets)
      if (keys.length > 500) for (const k of keys.sort((a, b) => s.snippets[a].last.localeCompare(s.snippets[b].last)).slice(0, keys.length - 500)) delete s.snippets[k]
    })
  }

  candidates(): Array<{ id: string; code: string; language: string; sessions: string[]; last: string }> {
    const min = this.ctx.options.recurrenceMinSessions
    return Object.entries(this.state().snippets)
      .filter(([, c]) => !c.dismissed && c.sessions.length >= min)
      .map(([id, c]) => ({ id, code: c.code, language: c.language, sessions: c.sessions, last: c.last }))
      .sort((a, b) => b.sessions.length - a.sessions.length)
  }

  async dismissCandidate(id: string): Promise<void> {
    await this.update((s) => {
      if (s.snippets[id]) s.snippets[id].dismissed = true
    })
  }
}

/** IntelliJ live templates (XML) of all active snippets: ${name} → $NAME$. */
export function liveTemplates(snippets: Entry[]): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "&#10;")
  const items = snippets.map((e) => {
    const code = snippetCode(e)
    const vars = placeholders(code)
    const value = code.replace(PLACEHOLDER_RE, (_m, n: string) => `$${n.toUpperCase().replace(/-/g, "_")}$`)
    return [
      `  <template name="${esc(e.name)}" value="${esc(value)}" description="${esc(e.description || e.title)}" toReformat="true" toShortenFQNames="true">`,
      ...vars.map((v) => `    <variable name="${esc(v.name.toUpperCase().replace(/-/g, "_"))}" expression="" defaultValue="${esc(v.default !== undefined ? JSON.stringify(v.default) : "")}" alwaysStopAt="true" />`),
      `    <context><option name="OTHER" value="true" /></context>`,
      "  </template>",
    ].join("\n")
  })
  return `<templateSet group="skillsmith">\n${items.join("\n")}\n</templateSet>\n`
}

export { fenceLanguage, str }

/** Prompts of the library as building blocks: {{prompt:name}} in an agent prompt is replaced by the prompt text (one level). */
export function expandPromptRefs(list: Entry[], text: string): string {
  return text.replace(/\{\{\s*prompt:([a-z0-9][a-z0-9-]*)\s*\}\}/g, (m, name: string) => {
    const p = list.find((e) => e.name === name && e.tier === "active")
    return p ? p.body.trim() : m
  })
}

/**
 * Job "prompt-review": prompts whose current version was reworked or discarded at least twice
 * (and not more often good than bad) get an improved version as a proposal with diff – the
 * user decides (stage, like the agent review).
 */
export async function reviewPrompts(ctx: Ctx, ask: (prompt: string, title: string) => Promise<string>): Promise<{ summary: string; status: "ok" | "skipped" }> {
  const { finalizeRun } = await import("./finalize")
  const proposed: string[] = []
  for (const e of ctx.store.list("prompt")) {
    if (e.tier !== "active" || str(e.fields.ai) === "privat" || str(e.fields.ai) === "lesen") continue
    if (ctx.ops.staged().some((s) => s.target === "prompt" && s.name === e.name)) continue
    const v = ctx.library?.promptStats(e.name).find((x) => x.version === e.version)
    if (!v || v.bad < 2 || v.good > v.bad) continue
    const answer = await ask(
      `Der folgende Prompt aus der Bibliothek wurde in ${v.uses} Einsätzen ${v.bad}× nachgebessert oder verworfen und ${v.good}× als gut bewertet. Verbessere ihn behutsam (Variablen {{…}} beibehalten, Sprache und Aufbau beibehalten).\n\n\`\`\`\n${truncate(e.body, 12_000)}\n\`\`\`\n\nAntworte mit dem vollständigen neuen Prompt zwischen <prompt> und </prompt> und danach "Begründung:".`,
      `Prompt ${e.name} verbessern`,
    )
    const next = /<prompt>\s*([\s\S]*?)\s*<\/prompt>/.exec(answer)?.[1]
    if (!next || next.trim() === e.body.trim()) continue
    const run = ctx.runs.create({ smith: "skillsmith", actor: "curator", trigger: `prompt-review ${e.name}`, writeMode: "stage", directory: ctx.directory, project: ctx.project, limits: { maxNew: 0, maxChanges: 1, maxNotes: 0 } })
    try {
      await ctx.ops.update(run, "prompt", { name: e.name, body: next.trim(), reason: `${v.bad} von ${v.uses} Einsätzen nachgebessert: ${truncate((/Begründung:\s*([\s\S]*)$/.exec(answer)?.[1] ?? "").trim(), 400)}`, approved: true })
      await finalizeRun(ctx, run, { ok: true })
      proposed.push(e.name)
    } catch (err) {
      await finalizeRun(ctx, run, { ok: false, error: String(err) })
    }
  }
  return { summary: proposed.length ? `Vorschläge für ${proposed.join(", ")}` : "keine Prompts mit wiederholten Nachbesserungen", status: proposed.length ? "ok" : "skipped" }
}
