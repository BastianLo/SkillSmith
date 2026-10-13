#!/usr/bin/env node
/**
 * smith – skillsmith from any terminal, without opening opencode (5g).
 *
 *   smith ask "…"                      question to the knowledge chat (answer with sources)
 *   smith note "…"                     quick note (current directory, project, branch as context)
 *   smith task neu "…"                 new task in the project of the current directory
 *   smith task T-12 [spalte]           show a task / move it to a column
 *   smith find "…"                     search over all kinds
 *   smith run <skript> [--param k=v]… [--params '{…}'] [-- args]   script through call_script
 *   smith snippet <name> [k=v …]       snippet with filled placeholders into the clipboard
 *   smith prompt <name> [k=v …] [text] run a prompt of the library (--copy: only fill)
 *   smith import <datei>               hand a file to the import page
 *   smith pr-check [basis]             pre-PR check of the current branch
 *   smith status                       waiting approvals, running agents, red pipelines, jobs
 *
 * Options: --json (machine-readable), --store <dir>.
 *
 * The CLI talks to the running instance through the web API; the token comes from
 * state/web.json (readable only by the user). Without an instance it opens the store directly
 * for notes, tasks and search (this needs Bun: BUN_BE_BUN=1 opencode …/bin/smith.ts); ask and
 * prompts need a model, i.e. a running opencode.
 *
 *   alias smith='BUN_BE_BUN=1 opencode ~/.config/opencode/plugins/skillsmith/bin/smith.ts'
 *   (or node ≥ 22.18: alias smith='node ~/.config/opencode/plugins/skillsmith/bin/smith.ts')
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { realpathSync } from "node:fs"

const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)))
// the service CLI (bin/skillsmith.ts) resolves the store the same way as the plugin
const cli: { resolveStore(flag?: string): { dir: string }; webInfo(store: string): { url: string; token: string } | undefined } = await import(pathToFileURL(join(HERE, "skillsmith.ts")).href)
const { resolveStore, webInfo } = cli

interface Opts {
  json: boolean
  store?: string
  rest: string[]
}

type Result = { ok: boolean; message?: string; data?: any; open?: string; error?: string; target?: string }

function parse(argv: string[]): Opts {
  const rest: string[] = []
  let json = false
  let store: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--json") json = true
    else if (a === "--store") store = argv[++i]
    else if (a.startsWith("--store=")) store = a.slice(8)
    else rest.push(a)
  }
  return { json, store, rest }
}

const out = (o: Opts, text: string, data?: unknown) => {
  if (o.json) process.stdout.write(`${JSON.stringify(data ?? { text }, null, 2)}\n`)
  else process.stdout.write(`${text}\n`)
}

/** key=value pairs and the remaining words. */
export function pairs(words: string[]): { values: Record<string, string>; rest: string[] } {
  const values: Record<string, string> = {}
  const rest: string[] = []
  for (const w of words) {
    const m = /^([A-Za-z_][\w-]*)=(.*)$/s.exec(w)
    if (m) values[m[1]] = m[2]
    else rest.push(w)
  }
  return { values, rest }
}

function clipboard(text: string): boolean {
  for (const [cmd, args] of [["pbcopy", []], ["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]], ["clip.exe", []]] as Array<[string, string[]]>) {
    const r = spawnSync(cmd, args, { input: text })
    if (r.status === 0) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// backends: the running instance (web API) or the store directly
// ---------------------------------------------------------------------------

interface Backend {
  kind: "api" | "local"
  action(action: string, args?: Record<string, unknown>, target?: string): Promise<Result>
  get(path: string, q?: Record<string, string>): Promise<any>
  upload?(name: string, body: Uint8Array): Promise<Result>
}

function apiBackend(url: string, token: string): Backend {
  const base = url.replace(/#.*$/, "").replace(/\/$/, "")
  const origin = new URL(base).origin
  const headers = (extra: Record<string, string> = {}) => ({ "x-smith-token": token, origin, "sec-fetch-site": "same-origin", ...extra })
  const parseRes = async (r: Response): Promise<any> => {
    const body = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`)
    return body
  }
  return {
    kind: "api",
    async action(action, args = {}, target) {
      return parseRes(await fetch(`${base}/api/action`, { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ action, args, ...(target ? { target } : {}) }) }))
    },
    async get(path, q = {}) {
      const qs = new URLSearchParams(q).toString()
      return parseRes(await fetch(`${base}/api/${path}${qs ? `?${qs}` : ""}`, { headers: headers() }))
    },
    async upload(name, body) {
      return parseRes(await fetch(`${base}/api/import?name=${encodeURIComponent(name)}`, { method: "POST", headers: headers({ "content-type": "application/octet-stream" }), body }))
    },
  }
}

async function localBackend(store: string): Promise<Backend> {
  const here = HERE
  let mod: typeof import("../src/core/local-ctx")
  let actions: typeof import("../src/core/actions")
  try {
    mod = await import(pathToFileURL(join(here, "..", "src", "core", "local-ctx.ts")).href)
    actions = await import(pathToFileURL(join(here, "..", "src", "core", "actions", "index.ts")).href)
  } catch (err) {
    throw new Error(`Keine laufende skillsmith-Instanz und der Store lässt sich ohne Bun nicht direkt öffnen (${err instanceof Error ? err.message.split("\n")[0] : err}). Starten Sie skillsmith (skillsmith start) oder nutzen Sie BUN_BE_BUN=1 opencode …/bin/smith.ts`)
  }
  const ctx = mod.createLocalCtx(store, process.cwd())
  const { ReadApi } = await import(pathToFileURL(join(here, "..", "src", "web", "api.ts")).href)
  const api = new ReadApi(ctx)
  return {
    kind: "local",
    async action(action, args = {}, target) {
      const r = await actions.executeAction({ ctx, actor: "command" }, { action, args, ...(target ? { target } : {}) })
      return r as Result
    },
    async get(path, q = {}) {
      return api.get(path, new URLSearchParams(q))
    },
  }
}

async function backend(o: Opts): Promise<Backend> {
  const { dir } = resolveStore(o.store)
  const info = webInfo(dir)
  if (info?.url && info.token) {
    try {
      const b = apiBackend(info.url, info.token)
      await b.get("ping")
      return b
    } catch {
      // stale web.json – fall back to the store
    }
  }
  return localBackend(dir)
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

const HELP = `smith – skillsmith im Terminal

  smith ask "Frage"                      Wissens-Chat (Antwort mit Quellen)
  smith note "Text"                      Schnellnotiz (mit Verzeichnis, Projekt, Branch)
  smith task neu "Titel"                 Aufgabe im Projekt des aktuellen Verzeichnisses
  smith task T-12 [spalte]               Aufgabe anzeigen bzw. verschieben
  smith find "Suche"                     Suche über alle Arten
  smith run <skript> [--param k=v] [--params JSON] [-- args]
  smith snippet <name> [k=v …]           Snippet ausfüllen, in die Zwischenablage
  smith prompt <name> [k=v …] [text]     Prompt ausführen (--copy: nur ausfüllen)
  smith import <datei>                   Datei an die Import-Seite übergeben
  smith pr-check [basis]                 Vor-PR-Prüfung des aktuellen Branches
  smith status                           Freigaben, Agenten, rote Pipelines, Jobs

  --json  maschinenlesbare Ausgabe   --store <dir>  anderer Store`

async function projectOfCwd(b: Backend): Promise<string | undefined> {
  const projects = (await b.get("projects").catch(() => [])) as Array<{ name: string; homePath?: string }>
  const cwd = resolve(process.cwd())
  const hit = projects.filter((p) => p.homePath).find((p) => cwd === resolve(p.homePath!.replace(/^~/, process.env.HOME ?? "~")) || cwd.startsWith(`${resolve(p.homePath!.replace(/^~/, process.env.HOME ?? "~"))}/`))
  return hit?.name
}

function gitBranch(): string | undefined {
  const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" })
  return r.status === 0 ? r.stdout.trim() : undefined
}

export async function run(argv: string[]): Promise<number> {
  const o = parse(argv)
  const [cmd, ...args] = o.rest
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    out(o, HELP)
    return 0
  }
  const b = await backend(o)
  switch (cmd) {
    case "ask": {
      const q = args.join(" ").trim()
      if (!q) throw new Error("Frage fehlt")
      if (b.kind === "local") throw new Error("ask braucht ein Modell – skillsmith start")
      const r = await b.action("chat.ask", { question: q })
      out(o, `${r.data.answer}${r.data.sources?.length ? `\n\nQuellen: ${r.data.sources.join(", ")}` : ""}`, r.data)
      return 0
    }
    case "note": {
      const text = args.join(" ").trim()
      if (!text) throw new Error("Text fehlt")
      const branch = gitBranch()
      const r = await b.action("note.quick", { text: `${text}\n\n_${basename(process.cwd())}${branch ? ` · ${branch}` : ""} · ${process.cwd()}_` })
      out(o, r.message ?? "notiert", r)
      return 0
    }
    case "task": {
      if (args[0] === "neu" || args[0] === "new") {
        const title = args.slice(1).join(" ").trim()
        if (!title) throw new Error("Titel fehlt")
        const project = await projectOfCwd(b)
        const branch = gitBranch()
        const r = await b.action("task.create", { title, ...(project ? { project } : {}), ...(branch && branch !== "HEAD" && !/^(main|master)$/.test(branch) ? { branch } : {}) })
        out(o, `${r.message}${project ? ` (Projekt ${project})` : ""}`, r)
        return 0
      }
      const id = args[0]
      if (!id) throw new Error("smith task neu \"Titel\" | smith task T-12 [spalte]")
      const target = `task:${id.toLowerCase()}`
      if (args[1]) {
        const r = await b.action("task.move", { to: args[1] }, target)
        out(o, r.message ?? "verschoben", r)
        return 0
      }
      const t = await b.get("task", { id: id.toLowerCase() })
      const v = t.task ?? t
      out(o, [`${v.id ?? id.toUpperCase()} ${v.title ?? ""}`, `Spalte: ${v.status ?? "?"}${v.project ? ` · Projekt ${v.project}` : ""}${v.priority ? ` · ${v.priority}` : ""}`, v.description ?? "", v.body ? `\n${v.body}` : ""].filter(Boolean).join("\n"), t)
      return 0
    }
    case "find": {
      const q = args.join(" ").trim()
      if (!q) throw new Error("Suchbegriff fehlt")
      const hits = (await b.get("search", { q })) as Array<{ id: string; title: string; label: string; score?: number; snippet?: string }>
      out(o, hits.length ? hits.slice(0, 20).map((h) => `${h.id}\t${h.title}${h.score !== undefined ? `\t${h.score}` : ""}`).join("\n") : "keine Treffer", hits)
      return 0
    }
    case "run": {
      const name = args[0]
      if (!name) throw new Error("Skriptname fehlt")
      const dash = args.indexOf("--")
      const own = dash >= 0 ? args.slice(1, dash) : args.slice(1)
      const cli = dash >= 0 ? args.slice(dash + 1) : []
      let params: Record<string, unknown> | undefined
      for (let i = 0; i < own.length; i++) {
        if (own[i] === "--params") params = { ...(params ?? {}), ...JSON.parse(own[++i]) }
        else if (own[i] === "--param") {
          const [k, ...v] = own[++i].split("=")
          const raw = v.join("=")
          let val: unknown = raw
          try {
            val = JSON.parse(raw)
          } catch {
            val = raw
          }
          params = { ...(params ?? {}), [k]: val }
        }
      }
      const r = await b.action("script.run", { ...(params ? { params } : {}), ...(cli.length ? { args: cli } : {}) }, `script:${name}`)
      const d = r.data ?? {}
      out(o, d.data !== undefined ? JSON.stringify(d.data, null, 2) : (d.stdout ?? r.message ?? ""), d)
      return d.ok === false ? 1 : 0
    }
    case "snippet": {
      const name = args[0]
      if (!name) throw new Error("Snippet-Name fehlt")
      const { values } = pairs(args.slice(1))
      const r = await b.action("snippet.fill", { values }, `snippet:${name}`)
      const text = r.data?.text ?? ""
      const copied = !o.json && clipboard(text)
      out(o, `${text}${r.data?.missing?.length ? `\n\n(offen: ${r.data.missing.join(", ")})` : ""}${copied ? "\n\n✓ in der Zwischenablage" : ""}`, r.data)
      return 0
    }
    case "prompt": {
      const name = args[0]
      if (!name) throw new Error("Prompt-Name fehlt")
      const copyOnly = args.includes("--copy")
      const { values, rest } = pairs(args.slice(1).filter((x) => x !== "--copy"))
      const r = await b.action("prompt.fill", { values, ...(rest.length ? { text: rest.join(" ") } : {}) }, `prompt:${name}`)
      if (r.data?.missing?.length) throw new Error(`es fehlen ${r.data.missing.map((m: string) => `${m}=…`).join(" ")}`)
      if (copyOnly || b.kind === "local") {
        const copied = !o.json && clipboard(r.data.text)
        out(o, `${r.data.text}${copied ? "\n\n✓ in der Zwischenablage" : ""}`, r.data)
        return 0
      }
      const a = await b.action("chat.ask", { question: r.data.text })
      out(o, a.data.answer, a.data)
      return 0
    }
    case "import": {
      const file = args[0]
      if (!file || !existsSync(file)) throw new Error("Datei fehlt oder existiert nicht")
      if (!b.upload) throw new Error("import braucht die laufende Instanz – skillsmith start")
      let body: Uint8Array = readFileSync(file)
      if (/\.pdf$/i.test(file)) {
        // PDF: text per page through pdftotext (poppler) when available, else the import page
        const r = spawnSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8", maxBuffer: 200 * 1024 * 1024 })
        if (r.status !== 0) throw new Error("PDF: pdftotext nicht gefunden – die Datei in der Weboberfläche (Wissen → Import) hineinziehen")
        body = new TextEncoder().encode(JSON.stringify({ pages: r.stdout.split("\f").map((text, i) => ({ n: i + 1, text })).filter((p) => p.text.trim()) }))
      }
      const r = await b.upload(basename(file), body)
      const info = webInfo(resolveStore(o.store).dir)
      out(o, `${r.message}${r.open && info ? `\n${info.url.replace(/#.*$/, "")}${r.open}` : ""}`, r)
      return 0
    }
    case "pr-check": {
      if (b.kind === "local") throw new Error("pr-check braucht ein Modell – skillsmith start")
      const r = await b.action("review.prCheck", { dir: resolve(process.cwd()), ...(args[0] ? { base: args[0] } : {}) })
      const d = r.data
      out(o, d.findings.length ? `${d.summary}\n${d.findings.map((f: any) => `${f.file ?? ""}${f.line ? `:${f.line}` : ""}\t${f.text}\t(${f.rule})`).join("\n")}` : d.summary, d)
      return d.findings.length ? 2 : 0
    }
    case "status": {
      const st = await b.get("stats")
      const ib = await b.get("inbox").catch(() => ({ items: [] }))
      const waiting = (ib.items as Array<{ type: string }>).filter((i) => ["agent-proposal", "agent-done", "permission", "proposal", "staged", "conflict"].includes(i.type)).length
      const red = (ib.items as Array<{ type: string }>).filter((i) => i.type === "pipeline").length
      const lines = [`Store ${resolveStore(o.store).dir} · ${b.kind === "api" ? "Instanz läuft" : "keine Instanz (Store direkt)"}`, `Eingang: ${st.inbox} · wartende Freigaben: ${waiting}`, `Aufgaben offen: ${st.tasks?.open ?? 0} · Agenten aktiv: ${st.tasks?.agents ?? 0} · Pipelines rot: ${red}`, `Jobs: ${st.jobs?.running ?? 0} laufend, ${st.jobs?.failed ?? 0} fehlgeschlagen`]
      out(o, lines.join("\n"), { ...st, waiting, red, backend: b.kind })
      return 0
    }
    default:
      out(o, `unbekannter Befehl „${cmd}“\n\n${HELP}`)
      return 1
  }
}

const entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : ""
if (entry === import.meta.url) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`Fehler: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    })
}
