/**
 * End-to-end test against opencode 2 (`opencode2 serve`, plugin API 2.x preview) with a
 * scripted mock LLM.
 *
 *   OPENCODE2_BIN=/path/to/opencode2 bun test/e2e/run-v2.ts
 *
 * Isolated HOME, the plugin directory itself as local plugin (opencode2 loads server.ts),
 * a mock OpenAI-compatible provider. Checks the v2 adapter (src/host/v2.ts): agents with
 * permissions, commands with output, tools, hints in the user message, live error capture,
 * a memorysmith review with a commit, subagent capture, the web view.
 * Exit code 0 = all checks passed.
 */
import { spawn } from "node:child_process"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { Database } from "bun:sqlite"
import { startMock, textOf, type MockReply, type MockRequest } from "./mock-llm"

const PLUGIN_SRC = resolve(import.meta.dir, "..", "..")
const BIN = process.env.OPENCODE2_BIN ?? "opencode2"
const ROOT = resolve(process.env.E2E_DIR ?? join(PLUGIN_SRC, ".e2e-v2"))
rmSync(ROOT, { recursive: true, force: true })
const HOME = join(ROOT, "home")
const PROJECT = join(ROOT, "project")
const CONFIG = join(HOME, ".config", "opencode")
const STORE = join(HOME, ".local", "share", "skillsmith")
const PORT = 47900 + Math.floor(Math.random() * 90)
mkdirSync(CONFIG, { recursive: true })
mkdirSync(PROJECT, { recursive: true })

let failures = 0
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✔" : "✘"} ${name}${detail ? ` – ${detail}` : ""}`)
  if (!ok) failures++
}
async function waitFor<T>(label: string, fn: () => T | Promise<T>, timeoutMs = 60_000, every = 500): Promise<T | undefined> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn()
      if (v) return v
    } catch {
      // retry
    }
    await Bun.sleep(every)
  }
  console.log(`  (timeout waiting for ${label})`)
  return undefined
}
const subjects = () => {
  try {
    return execFileSync("git", ["-C", STORE, "log", "--format=%s"], { encoding: "utf8" }).trim().split("\n")
  } catch {
    return []
  }
}

// --- mock model ----------------------------------------------------------------------------------------
const sys = (r: MockRequest) => r.messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n")
const users = (r: MockRequest) => r.messages.filter((m) => m.role === "user").map((m) => textOf(m.content))
const toolsAfterLastUser = (r: MockRequest) => {
  let idx = -1
  r.messages.forEach((m, i) => {
    if (m.role === "user") idx = i
  })
  return r.messages.slice(idx + 1).filter((m) => m.role === "tool").length
}
const smithOf = (r: MockRequest) => /You are (skillsmith|docsmith|errorsmith|toolsmith|memorysmith)-(reviewer|curator)/.exec(sys(r))?.slice(1, 3).join("-") ?? (/You are smith-doctor\b/.test(sys(r)) ? "doctor" : undefined)
const toolNames = (r: MockRequest) => (r.tools ?? []).map((t) => t.function.name)

const mock = startMock({
  respond(r) {
    const who = smithOf(r)
    const s = toolsAfterLastUser(r)
    const job = users(r)[0] ?? ""
    if (who) {
      const smith = who.split("-")[0]
      const done = (summary: string): MockReply => ({ tools: [{ name: `${smith === "doctor" ? "doctor" : smith}_done`, args: { summary } }] })
      if (who === "memorysmith-reviewer" && job.includes("dienstags") && s === 0) {
        return {
          tools: [
            {
              name: "memorysmith_save",
              args: {
                type: "vorgabe",
                topic: "deploy-tage",
                title: "Deployments nur dienstags",
                summary: "Deployments nur dienstags, nie freitags",
                body: "Vorgabe des Nutzers: Deployments nur dienstags, nie freitags.",
                tags: ["deployment"],
                evidence: "Deployments nur dienstags, nie freitags",
                reason: "the user asked to remember it",
              },
            },
          ],
        }
      }
      return s === 0 ? done("nothing to do") : { text: "done" }
    }
    const last = textOf([...r.messages].reverse().find((m) => m.role === "user")?.content)
    if (s > 0) return { text: "fertig" }
    // command output (v1 and v2): the agent repeats the text
    if (last.startsWith("[skillsmith] Output the following text exactly")) return { text: last.slice(last.indexOf("\n\n") + 2) }
    if (/SHELLTEST/.test(last)) return { tools: [{ name: "shell", args: { command: "ls /nonexistent-gateway-dir" } }] }
    if (/SUBTEST/.test(last)) return { tools: [{ name: "subagent", args: { description: "Gateway lesen", prompt: "Lies die README und fasse den Gateway-Deploy zusammen", agent: "explore" } }] }
    if (/SKILLSEARCH/.test(last)) return { tools: [{ name: "skill_search", args: { query: "gateway deploy" } }] }
    return { text: `Antwort: ${last.slice(0, 80)}` }
  },
})
const isMain = (r: MockRequest) => !smithOf(r) && !/You are a subagent|file search specialist/i.test(sys(r) + users(r).join(" "))

// --- store seed: a knowledge entry (hints) and an error entry (live hint) --------------------------------
mkdirSync(join(STORE, "knowledge", "active"), { recursive: true })
writeFileSync(
  join(STORE, "knowledge", "active", "gateway-deploy.md"),
  `---\nname: gateway-deploy\ntitle: "Gateway-Service nach Produktion deployen"\ndescription: "Deploy des Gateway-Service nach Produktion mit make deploy"\ntags: ["gateway","deploy"]\n---\n\nDer Gateway-Service wird mit \`make deploy ENV=prod\` nach Produktion deployt.\n`,
)
mkdirSync(join(STORE, "errors", "active"), { recursive: true })
writeFileSync(
  join(STORE, "errors", "active", "gateway-dir-fehlt.md"),
  `---\nname: gateway-dir-fehlt\ntitle: "ls nonexistent gateway dir: cannot access"\ndescription: "ls cannot access nonexistent gateway dir – Verzeichnis fehlt"\nstatus: "solved"\nsignatures: []\ncontext: []\ntags: ["gateway"]\n---\n\n## Symptom\nls: cannot access '/nonexistent-gateway-dir': No such file or directory\n\n## Lösung\nDas Gateway-Verzeichnis zuerst mit \`make checkout\` anlegen.\n`,
)
writeFileSync(join(PROJECT, "README.md"), "# Projekt\n\nDer Gateway wird mit make deploy ausgeliefert.\n")
execFileSync("git", ["init", "-q"], { cwd: PROJECT })
execFileSync("git", ["-c", "user.email=e2e@x", "-c", "user.name=e2e", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: PROJECT })

writeFileSync(
  join(CONFIG, "opencode.json"),
  JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      model: "mock/mock-1",
      providers: {
        mock: { package: "@opencode-ai/ai/providers/openai-compatible", name: "Mock", settings: { baseURL: mock.url, apiKey: "test" }, models: { "mock-1": { name: "Mock 1" } } },
      },
      plugins: [{ package: PLUGIN_SRC, options: { debug: true, idleReview: true, idleDelayMin: 0.02, idleMinNewMessages: 1, reviewSubagents: false, catchUpOnStart: false, web: { autostart: false, port: PORT + 1000 } } }],
    },
    null,
    2,
  ),
)

// --- server ----------------------------------------------------------------------------------------------
const proc = spawn(BIN, ["serve", "--hostname", "127.0.0.1", "--port", String(PORT)], { cwd: PROJECT, env: { ...process.env, HOME, XDG_CONFIG_HOME: join(HOME, ".config"), XDG_DATA_HOME: join(HOME, ".local", "share") }, stdio: ["ignore", "pipe", "pipe"] })
let serverOut = ""
proc.stdout.on("data", (d) => (serverOut += d))
proc.stderr.on("data", (d) => (serverOut += d))
const password = await waitFor("server", () => /server password (\S+)/.exec(serverOut)?.[1], 60_000, 200)
const base = `http://127.0.0.1:${PORT}`
const auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64")
async function api(method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(base + path, { method, headers: { authorization: auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
  const t = await r.text()
  let j: any
  try {
    j = JSON.parse(t)
  } catch {
    j = t
  }
  return j?.data ?? j
}
const messages = async (id: string) => ((await api("GET", `/api/session/${id}/message`)) as any[]).slice().reverse()

try {
  await api("POST", "/api/plugin/await-activation")
  const plugins = (await api("GET", "/api/plugin")) as any[]
  const plug = plugins.find((p) => p.id === "skillsmith")
  check("plugin loaded from the directory (server.ts) and active", plug?.state?.status === "active" && /server\.ts$/.test(plug?.source?.path ?? ""), JSON.stringify(plug?.state))

  const agents = (await api("GET", "/api/agent")) as any[]
  const internal = agents.filter((a) => /-(reviewer|curator)$|^smith-(doctor|assistant)$/.test(a.id))
  check("11 internal agents, hidden", internal.length === 12 && internal.every((a) => a.hidden), internal.map((a) => a.id).join(","))
  const reviewer = agents.find((a) => a.id === "memorysmith-reviewer")
  const rules = (reviewer?.permissions ?? []).map((p: any) => `${p.action}:${p.effect}`)
  check("smith agent: everything denied, read tools and own tools allowed", rules[0] === "*:deny" && rules.includes("memorysmith_*:allow") && rules.includes("skill_search:allow"), rules.slice(0, 4).join(" "))
  const build = agents.find((a) => a.id === "build")
  const buildRules = (build?.permissions ?? []).map((p: any) => `${p.action}:${p.effect}`)
  check("user agents: write tools of the smiths denied", ["skillsmith_*", "docsmith_*", "memorysmith_*", "doctor_*"].every((t) => buildRules.includes(`${t}:deny`)))
  const commands = ((await api("GET", "/api/command")) as any[]).map((c) => c.name)
  check("41 commands registered", ["smith-help", "smith-report", "smith-web", "remember", "prompt", "smith-pr-check"].every((c) => commands.includes(c)) && commands.filter((c) => /^(smith-|skills-|knowledge|glossary|errors|scripts|docs-search|history|task|note|doc|memory|remember|forget|resume|prompt)/.test(c)).length >= 41, String(commands.length))

  const session = await api("POST", "/api/session", { title: "e2e", location: { directory: PROJECT } })
  const sid = session.id
  // command output as a message, no model turn
  await api("POST", `/api/session/${sid}/command`, { command: "smith-report", text: "" })
  const report = await waitFor("report", async () => (await messages(sid)).find((m) => m.type === "assistant" && m.content?.some((c: any) => c.type === "text" && /skillsmith Report/.test(c.text))))
  check("/smith-report: the output is shown (as in v1 through the agent)", !!report)

  // hint in the user message + tools of the main agent
  await api("POST", `/api/session/${sid}/prompt`, { text: "Wie deploye ich den Gateway-Service nach Produktion?" })
  await api("POST", `/api/session/${sid}/wait`, {})
  const req = [...mock.requests].reverse().find((r) => isMain(r) && users(r).some((u) => u.includes("Gateway-Service nach Produktion")))
  const lastUserText = req ? users(req).slice(-1)[0] : ""
  check("hint block in the user message (context hook)", /<smith_hints/.test(lastUserText) && /gateway-deploy/.test(lastUserText), lastUserText.slice(0, 160))
  const names = req ? toolNames(req) : []
  check("main agent sees the read tools, not the write tools", names.includes("skill_search") && names.includes("knowledge_search") && !names.some((n) => /^(docsmith|memorysmith|skillsmith)_/.test(n)), `${names.length} tools`)

  // read tool call through the adapter
  await api("POST", `/api/session/${sid}/prompt`, { text: "SKILLSEARCH bitte" })
  await api("POST", `/api/session/${sid}/wait`, {})
  const msgs = await messages(sid)
  const call = msgs.flatMap((m) => (m.type === "assistant" ? m.content : [])).find((c: any) => c.type === "tool" && c.name === "skill_search")
  check("read tool runs in the main session", call?.state?.status === "completed", JSON.stringify(call?.state?.content ?? call?.state?.error ?? "").slice(0, 120))

  // live error capture and known-error hint on the shell output
  await api("POST", `/api/session/${sid}/prompt`, { text: "SHELLTEST" })
  await api("POST", `/api/session/${sid}/wait`, {})
  const occ = await waitFor("occurrence", () => existsSync(join(STORE, "state", "errors.json")) && /nonexistent-gateway-dir|ls/.test(readFileSync(join(STORE, "state", "errors.json"), "utf8")), 10_000)
  check("failed shell command recorded as error occurrence (exit code from v2 metadata)", !!occ)
  const shellResult = [...mock.requests].reverse().find((r) => isMain(r) && r.messages.some((m) => m.role === "tool" && /cannot access/.test(textOf(m.content))))
  const toolText = shellResult ? textOf([...shellResult.messages].reverse().find((m) => m.role === "tool")?.content) : ""
  check("known-error hint appended to the shell output", /<known_error/.test(toolText), toolText.slice(0, 200))

  // subagent answer captured (memorysmith)
  await api("POST", `/api/session/${sid}/prompt`, { text: "SUBTEST" })
  await api("POST", `/api/session/${sid}/wait`, {})
  const captured = await waitFor("capture", () => {
    const db = new Database(join(STORE, "state", "memory.sqlite"), { readonly: true })
    try {
      return (db.query("select count(*) as n from captures").get() as any)?.n > 0
    } finally {
      db.close()
    }
  }, 10_000)
  check("subagent answer captured for memorysmith", !!captured)

  // "merk dir" → memorysmith review right after the turn, one commit
  await api("POST", `/api/session/${sid}/prompt`, { text: "Danke. Merk dir: Deployments nur dienstags, nie freitags." })
  await api("POST", `/api/session/${sid}/wait`, {})
  const saved = await waitFor("memory", () => existsSync(join(STORE, "memories", "active")) && readdirSync(join(STORE, "memories", "active")).find((f) => f.includes("deploy-tage")), 90_000)
  check("memorysmith review saved the rule (Vorgabe with the user's words)", !!saved, saved ?? "")
  const committed = await waitFor("commit", () => subjects().some((s) => s.startsWith("memorysmith(reviewer):")), 30_000)
  check("one commit memorysmith(reviewer)", !!committed, subjects().slice(0, 4).join(" | "))
  const bg = mock.requests.find((r) => smithOf(r) === "memorysmith-reviewer")
  const bgTools = bg ? toolNames(bg) : []
  check("background agent: own tools + read tools only (no shell, no edit)", bgTools.includes("memorysmith_save") && bgTools.includes("memory_search") && !bgTools.some((n) => /^(shell|edit|write|patch|docsmith_)/.test(n)), bgTools.join(","))
  check("background agent got the session's model", bg?.model === "mock-1", String(bg?.model))

  // embeddings: endpoint and model detected from the v2 provider catalog (mock lists qwen3-embedding-8b)
  const vectors = await waitFor("vectors", () => {
    const f = join(STORE, "state", "embeddings", "vectors.sqlite")
    if (!existsSync(f)) return false
    const db = new Database(f, { readonly: true })
    try {
      return (db.query("select count(*) as n from vectors").get() as any)?.n > 0
    } finally {
      db.close()
    }
  }, 30_000)
  check("embeddings from the provider catalog (vectors written)", !!vectors)

  // web view through the command
  await api("POST", `/api/session/${sid}/command`, { command: "smith-web", text: "" })
  const web = await waitFor("web", async () => (await messages(sid)).find((m) => m.type === "assistant" && m.content?.some((c: any) => c.type === "text" && /http:\/\/127\.0\.0\.1:\d+\/#t=/.test(c.text))))
  const webText = (web?.content ?? []).map((c: any) => c.text ?? "").join("\n")
  const link = /http:\/\/127\.0\.0\.1:(\d+)\/#t=([\w-]+)/.exec(webText)
  const ping = link ? await fetch(`http://127.0.0.1:${link[1]}/api/ping`, { headers: { "x-smith-token": link[2] } }).then((r) => r.status) : 0
  check("/smith-web starts the web view (token link)", ping === 200, link?.[0]?.replace(/#t=.*/, "") ?? "")
} catch (err) {
  check("no exception", false, String((err as Error)?.stack ?? err))
} finally {
  proc.kill()
  mock.server.stop(true)
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed")
if (failures) console.log(serverOut.split("\n").filter((l) => /skillsmith|ERROR/.test(l)).slice(-20).join("\n"))
process.exit(failures ? 1 : 0)
