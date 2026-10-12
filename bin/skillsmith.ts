#!/usr/bin/env node
/**
 * skillsmith CLI – runs the knowledge workplace as a standalone application.
 *
 * skillsmith itself is an opencode plugin: the background smiths, the web view and the
 * pipeline only run inside an opencode process. This CLI therefore starts `opencode serve`
 * headless (no TUI) and lets the plugin bring up the web workplace, so you do not have to
 * keep an opencode window open.
 *
 *   skillsmith run       start in the foreground (Ctrl-C stops it)
 *   skillsmith start     start in the background (detached, writes a pid file)
 *   skillsmith stop      stop the background instance
 *   skillsmith restart   stop then start
 *   skillsmith status    show whether it runs and where the web view is
 *   skillsmith url       print the web view link (with token)
 *   skillsmith logs      follow the skillsmith log
 *   skillsmith enable    register a launchd agent so it survives a reboot
 *   skillsmith disable   remove the launchd agent
 *
 * Options: --store <dir>, --port <n>, --host <h>, --opencode <bin>, --verbose
 *
 * Environment: SKILLSMITH_HOME / SKILLSMITH_STORE_DIR (store), SKILLSMITH_WEB_PORT,
 * SKILLSMITH_WEB_HOST, SKILLSMITH_OPENCODE_BIN (opencode binary/wrapper).
 *
 * Requires Node >= 22.6 (native TypeScript type stripping). No dependencies.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// ---------------------------------------------------------------------------
// types and constants
// ---------------------------------------------------------------------------

interface WebInfo {
  url: string
  port: number
  token: string
  pid: number
  directory: string
  startedAt: string
  host?: string
}

/** what the CLI wrote when it started a background instance */
interface CliState {
  pid: number
  store: string
  opencode: string
  startedAt: string
}

interface Flags {
  command: string
  store?: string
  port?: number
  host?: string
  opencode?: string
  verbose: boolean
  help: boolean
}

const LABEL = "com.skillsmith.agent"
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`)

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function expandHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return path
}

function alive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n")
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Remove // and /* *\/ comments and trailing commas from JSONC, respecting strings. */
function stripJsonc(text: string): string {
  let out = ""
  let inStr = false
  let esc = false
  let i = 0
  while (i < text.length) {
    const c = text[i]
    const n = text[i + 1]
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === "\\") esc = true
      else if (c === '"') inStr = false
      i++
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      i++
      continue
    }
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++
      continue
    }
    if (c === "/" && n === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  // drop trailing commas before } or ]
  let clean = ""
  inStr = false
  esc = false
  for (let j = 0; j < out.length; j++) {
    const c = out[j]
    if (inStr) {
      clean += c
      if (esc) esc = false
      else if (c === "\\") esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      clean += c
      continue
    }
    if (c === ",") {
      let k = j + 1
      while (k < out.length && /\s/.test(out[k])) k++
      if (out[k] === "}" || out[k] === "]") continue
    }
    clean += c
  }
  return clean
}

/** Find an executable in PATH. */
function findOnPath(bin: string): string | undefined {
  const path = process.env.PATH ?? ""
  for (const dir of path.split(":")) {
    if (!dir) continue
    const full = join(dir, bin)
    try {
      if (existsSync(full)) return full
    } catch {
      // ignore
    }
  }
  return undefined
}

/** How to run the opencode launcher: `bin` + `prepend` are passed to spawn; `path` is the launcher itself. */
interface OpencodeExec {
  bin: string
  prepend: string[]
  path: string
}

/** Read the first bytes of a file (for shebang / binary-magic detection). */
function head(file: string, n = 256): Buffer {
  try {
    const fd = openSync(file, "r")
    try {
      const buf = Buffer.alloc(n)
      const read = readSync(fd, buf, 0, n, 0)
      return buf.subarray(0, read)
    } finally {
      closeSync(fd)
    }
  } catch {
    return Buffer.alloc(0)
  }
}

const BINARY_MAGIC: Array<[number, ...number[]]> = [
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O 64 LE (arm64/x86_64)
  [0xce, 0xfa, 0xed, 0xfe], // Mach-O 32 LE
  [0xfe, 0xed, 0xfa, 0xcf], // Mach-O 64 BE
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O universal
  [0x4d, 0x5a], // PE/COFF
]

function isBinary(buf: Buffer): boolean {
  return BINARY_MAGIC.some((m) => m.every((byte, i) => buf[i] === byte))
}

/**
 * Turn a launcher path into something Node's spawn can run.
 * Handles the two traps of hand-rolled `opencode` wrappers on macOS:
 *  - a file without a shebang (zsh runs it via its ENOEXEC fallback, spawn refuses),
 *  - a "pointer" file whose whole content is the path of the real launcher (args would be lost).
 * Returns undefined when the path is not a usable file.
 */
function classifyLauncher(file: string): OpencodeExec | undefined {
  let stat: { isFile(): boolean; isDirectory(): boolean }
  try {
    stat = statSync(file)
  } catch {
    return undefined
  }
  if (stat.isDirectory()) {
    // a directory may hold the real binary in bin/ (like an opencode install dir)
    const inner = join(file, "package", "bin", "opencode")
    if (existsSync(inner)) return classifyLauncher(inner)
    return undefined
  }
  const buf = head(file)
  if (!buf.length) return { bin: file, prepend: [], path: file }
  const text = buf.toString("utf8")
  // shebang or real binary → spawn can run it directly
  if (text.startsWith("#!") || isBinary(buf)) return { bin: file, prepend: [], path: file }
  // no shebang: a small single-line text file is either a pointer to another launcher or a shell script
  const firstLine = text.split("\n")[0].trim()
  const singleLine = !text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n") + 1).trim().includes(" ")
  if (singleLine && firstLine && !firstLine.startsWith("#")) {
    const target = isAbsolute(expandHome(firstLine)) ? expandHome(firstLine) : resolve(dirname(file), expandHome(firstLine))
    if (existsSync(target)) {
      const inner = classifyLauncher(target)
      if (inner) return inner
    }
  }
  // otherwise run it through the shell (ENOEXEC fallback like zsh does)
  return { bin: "/bin/sh", prepend: [file], path: file }
}

// ---------------------------------------------------------------------------
// store resolution: the CLI must agree with the plugin about the store
// ---------------------------------------------------------------------------

function defaultStoreDir(): string {
  if (process.env.SKILLSMITH_HOME) return expandHome(process.env.SKILLSMITH_HOME)
  const base = process.env.XDG_DATA_HOME && isAbsolute(process.env.XDG_DATA_HOME) ? process.env.XDG_DATA_HOME : join(homedir(), ".local", "share")
  return join(base, "skillsmith")
}

function configCandidates(): string[] {
  const out: string[] = []
  if (process.env.OPENCODE_CONFIG) out.push(expandHome(process.env.OPENCODE_CONFIG))
  const dir = process.env.XDG_CONFIG_HOME ? expandHome(process.env.XDG_CONFIG_HOME) : join(homedir(), ".config")
  const oc = join(dir, "opencode")
  out.push(join(oc, "opencode.jsonc"), join(oc, "opencode.json"), join(oc, "config.json"))
  return out
}

/** Read the storeDir the user configured for the skillsmith plugin in opencode's config. */
function storeFromConfig(): string | undefined {
  for (const file of configCandidates()) {
    if (!existsSync(file)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(stripJsonc(readFileSync(file, "utf8")))
    } catch {
      continue
    }
    const plugins = (parsed as { plugin?: unknown }).plugin
    if (!Array.isArray(plugins)) continue
    for (const entry of plugins) {
      if (!Array.isArray(entry)) continue
      const [path, options] = entry as [unknown, unknown]
      if (typeof path !== "string" || !/skillsmith/i.test(path)) continue
      const store = options && typeof options === "object" ? (options as { storeDir?: unknown }).storeDir : undefined
      if (typeof store === "string" && store) return expandHome(store)
    }
  }
  return undefined
}

function resolveStore(flag: string | undefined): { dir: string; source: string } {
  if (flag) return { dir: resolve(expandHome(flag)), source: "--store" }
  if (process.env.SKILLSMITH_STORE_DIR) return { dir: resolve(expandHome(process.env.SKILLSMITH_STORE_DIR)), source: "SKILLSMITH_STORE_DIR" }
  if (process.env.SKILLSMITH_HOME) return { dir: resolve(expandHome(process.env.SKILLSMITH_HOME)), source: "SKILLSMITH_HOME" }
  const fromConfig = storeFromConfig()
  if (fromConfig) return { dir: resolve(fromConfig), source: "opencode config" }
  return { dir: resolve(defaultStoreDir()), source: "default" }
}

function resolveOpencode(flag: string | undefined): OpencodeExec | undefined {
  const candidate = flag ?? process.env.SKILLSMITH_OPENCODE_BIN
  const full = candidate ? (candidate.includes("/") ? resolve(expandHome(candidate)) : findOnPath(candidate)) : findOnPath("opencode")
  if (!full || !existsSync(full)) return undefined
  return classifyLauncher(full)
}

// ---------------------------------------------------------------------------
// paths inside the store
// ---------------------------------------------------------------------------

const stateDir = (store: string) => join(store, "state")
const pidFile = (store: string) => join(stateDir(store), "cli.json")
const webFile = (store: string) => join(stateDir(store), "web.json")
const logFile = (store: string) => join(stateDir(store), "log", "skillsmith.log")
const outFile = (store: string) => join(stateDir(store), "log", "opencode.out")

function webInfo(store: string): WebInfo | undefined {
  const info = readJson<WebInfo | null>(webFile(store), null)
  if (info && alive(info.pid)) return info
  return undefined
}

// ---------------------------------------------------------------------------
// starting / stopping
// ---------------------------------------------------------------------------

function childEnv(store: string, flags: Flags): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, SKILLSMITH_WEB_AUTOSTART: "1" }
  // pass the store through only when the user chose it explicitly – otherwise the plugin's
  // configured storeDir wins and both sides agree (we resolved the same value for our bookkeeping)
  if (flags.store || process.env.SKILLSMITH_STORE_DIR || process.env.SKILLSMITH_HOME) env.SKILLSMITH_STORE_DIR = store
  if (flags.host) env.SKILLSMITH_WEB_HOST = flags.host
  if (flags.port) env.SKILLSMITH_WEB_PORT = String(flags.port)
  return env
}

function opencodeArgs(flags: Flags): string[] {
  // port 0 → opencode picks a free port and prints it; we need it to poke the lazy plugin load
  const args = ["serve", "--port", "0"]
  if (flags.verbose) args.push("--print-logs", "--log-level", "INFO")
  return args
}

const LISTEN_RE = /listening on (https?:\/\/[^\s]+)/

/**
 * opencode loads plugins lazily: `serve` alone never runs the skillsmith server hook.
 * A plain API request (GET /agent) makes opencode instantiate the plugin, which then
 * brings up the web view. Returns the opencode base URL once it is listening.
 */
async function triggerPluginLoad(baseUrl: string): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`${baseUrl}/agent`, { signal: AbortSignal.timeout(3000) })
      if (r.ok) return true
    } catch {
      // server not ready yet
    }
    await sleep(500)
  }
  return false
}

/** Wait until the web view answers (or the child dies), return its info. */
async function waitForWeb(store: string, child: ChildProcess | undefined, timeoutMs: number, notPid?: number): Promise<WebInfo | undefined> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const info = webInfo(store)
    // after a restart the old web.json may still be alive for a moment – wait for the new pid
    if (info && info.pid !== notPid) return info
    if (child && child.exitCode !== null) return undefined
    await sleep(500)
  }
  return undefined
}

/**
 * Start `opencode serve`, capture its URL from stdout (and mirror it to the log file),
 * trigger the lazy plugin load, then wait for the web view. `forward` mirrors opencode's
 * output to this process' stdout (foreground mode).
 */
async function spawnServe(
  store: string,
  flags: Flags,
  opencode: OpencodeExec,
  opts: { detached: boolean; forward: boolean },
): Promise<{ child: ChildProcess; baseUrl?: string }> {
  mkdirSync(dirname(outFile(store)), { recursive: true })
  // foreground: forward to our stdout and let the caller (terminal or launchd's
  // StandardOutPath) own the file – writing it here as well would duplicate every line.
  // background: nobody reads our stdout, so mirror opencode's output into the log file.
  const logFd = opts.forward ? undefined : openSync(outFile(store), "a")
  const child = spawn(opencode.bin, [...opencode.prepend, ...opencodeArgs(flags)], {
    detached: opts.detached,
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv(store, flags),
  })
  if (opts.detached) child.unref()

  let baseUrl: string | undefined
  const onChunk = (buf: Buffer) => {
    if (logFd !== undefined) {
      try {
        writeFileSync(logFd, buf)
      } catch {
        // ignore
      }
    }
    if (opts.forward) process.stdout.write(buf)
    const m = LISTEN_RE.exec(buf.toString())
    if (m && !baseUrl) baseUrl = m[1].replace(/\/$/, "")
  }
  child.stdout?.on("data", onChunk)
  child.stderr?.on("data", onChunk)
  child.on("close", () => {
    if (logFd === undefined) return
    try {
      closeSync(logFd)
    } catch {
      // already closed
    }
  })
  // wait for the "listening on …" line (or the process to die) so the caller gets the URL
  const started = Date.now()
  while (!baseUrl && child.exitCode === null && Date.now() - started < 20_000) await sleep(200)
  return { child, baseUrl }
}

async function commandRun(store: string, flags: Flags, opencode: OpencodeExec): Promise<number> {
  console.log(`skillsmith – Store: ${store}`)
  console.log(`startet im Vordergrund (opencode serve)`)
  const { child, baseUrl } = await spawnServe(store, flags, opencode, { detached: false, forward: true })
  if (baseUrl) await triggerPluginLoad(baseUrl)
  const web = await waitForWeb(store, child, 45_000)
  if (web) {
    console.log("")
    console.log(`  Weboberfläche: ${web.url}`)
    console.log("")
    console.log("  (Strg-C beendet skillsmith)")
  } else {
    console.log("Weboberfläche noch nicht bereit – Log: " + logFile(store))
  }
  const stop = () => {
    if (child.pid) killTree(child.pid)
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  return await new Promise<number>((resolveExit) => {
    child.on("exit", (code, signal) => resolveExit(signal ? 130 : code ?? 0))
  })
}

async function commandStart(store: string, flags: Flags, opencode: OpencodeExec): Promise<number> {
  const existing = webInfo(store)
  if (existing) {
    console.log(`skillsmith läuft bereits (Weboberfläche PID ${existing.pid}).`)
    console.log(`  Weboberfläche: ${existing.url}`)
    return 0
  }
  const state = readJson<CliState | null>(pidFile(store), null)
  if (state && alive(state.pid)) {
    console.log(`skillsmith läuft bereits (PID ${state.pid}). Nutze "skillsmith status".`)
    return 0
  }
  const { child, baseUrl } = await spawnServe(store, flags, opencode, { detached: true, forward: false })
  if (!child.pid) {
    console.error("Fehler: opencode konnte nicht gestartet werden.")
    return 1
  }
  writeJson(pidFile(store), { pid: child.pid, store, opencode: opencode.path, startedAt: new Date().toISOString() } satisfies CliState)
  if (baseUrl) await triggerPluginLoad(baseUrl)
  const web = await waitForWeb(store, child, 45_000)
  if (web) {
    console.log(`skillsmith gestartet (PID ${child.pid}).`)
    console.log(`  Weboberfläche: ${web.url}`)
    return 0
  }
  if (child.exitCode !== null) {
    console.error(`skillsmith beendete sich sofort (Code ${child.exitCode}). Log: ${outFile(store)}`)
    rmSync(pidFile(store), { force: true })
    return 1
  }
  console.log(`skillsmith gestartet (PID ${child.pid}), Weboberfläche noch nicht bereit.`)
  console.log(`  Log: ${logFile(store)}`)
  return 0
}

async function commandStop(store: string): Promise<number> {
  // a launchd service owns this store: killing its process only triggers KeepAlive
  if (launchdLoaded() && launchdStore() === store) {
    console.log(`Der launchd-Dienst ist aktiv und startet skillsmith sofort neu. Nutze "skillsmith disable" zum Beenden.`)
    return 0
  }
  const state = readJson<CliState | null>(pidFile(store), null)
  if (!state || !alive(state.pid)) {
    // a web view started by an interactive opencode is not ours to stop
    const other = webInfo(store)
    if (other) {
      console.log(`Keine vom CLI verwaltete Instanz. Eine Weboberfläche läuft unter PID ${other.pid} (aus einem anderen opencode).`)
      return 0
    }
    console.log("skillsmith läuft nicht.")
    rmSync(pidFile(store), { force: true })
    return 0
  }
  console.log(`stoppe skillsmith (PID ${state.pid}) …`)
  killTree(state.pid)
  const started = Date.now()
  while (Date.now() - started < 10_000 && alive(state.pid)) await sleep(200)
  if (alive(state.pid)) {
    try {
      process.kill(-state.pid, "SIGKILL")
    } catch {
      try {
        process.kill(state.pid, "SIGKILL")
      } catch {
        // gone
      }
    }
  }
  rmSync(pidFile(store), { force: true })
  // the web view lives in the same process; clean up its file if it points at the dead pid
  const web = readJson<WebInfo | null>(webFile(store), null)
  if (web && web.pid === state.pid) rmSync(webFile(store), { force: true })
  console.log("skillsmith gestoppt.")
  return 0
}

/** SIGTERM the whole process group, then the process itself as a fallback. */
function killTree(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM")
  } catch {
    // no own process group – kill the process directly
  }
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    // already gone
  }
}

// ---------------------------------------------------------------------------
// status / url / logs
// ---------------------------------------------------------------------------

function commandStatus(store: string): number {
  const state = readJson<CliState | null>(pidFile(store), null)
  const web = webInfo(store)
  const service = launchdLoaded()
  console.log(`Store: ${store}`)
  console.log(`launchd: ${service ? "aktiviert (" + LABEL + ")" : "nicht aktiviert"}`)
  if (state && alive(state.pid)) {
    const since = new Date(state.startedAt).toLocaleString()
    console.log(`Status: läuft (PID ${state.pid}, seit ${since})`)
  } else if (web && service) {
    console.log(`Status: läuft als launchd-Dienst (PID ${web.pid})`)
  } else if (web) {
    console.log(`Status: Weboberfläche läuft (PID ${web.pid}, aus einem anderen opencode)`)
  } else {
    console.log("Status: gestoppt")
  }
  if (web) console.log(`Weboberfläche: ${web.url}`)
  else console.log("Weboberfläche: nicht erreichbar")
  return web ? 0 : 3
}

function commandUrl(store: string): number {
  const web = webInfo(store)
  if (!web) {
    console.error("skillsmith läuft nicht – zuerst \"skillsmith start\".")
    return 1
  }
  console.log(web.url)
  return 0
}

function commandLogs(store: string, flags: Flags): number {
  const file = existsSync(logFile(store)) ? logFile(store) : outFile(store)
  if (!existsSync(file)) {
    console.error(`Kein Log gefunden (${file}).`)
    return 1
  }
  const r = spawnSync("tail", ["-n", "100", "-f", file], { stdio: "inherit" })
  return r.status ?? 0
}

// ---------------------------------------------------------------------------
// launchd (enable / disable)
// ---------------------------------------------------------------------------

function launchdLoaded(): boolean {
  if (process.platform !== "darwin") return false
  const r = spawnSync("launchctl", ["list", LABEL], { stdio: "ignore" })
  return r.status === 0
}

/** The store the launchd service manages (from the plist we wrote). */
function launchdStore(): string | undefined {
  try {
    const xml = readFileSync(PLIST, "utf8")
    const m = /<key>SKILLSMITH_STORE_DIR<\/key>\s*<string>([^<]+)<\/string>/.exec(xml)
    return m ? m[1] : undefined
  } catch {
    return undefined
  }
}

/** Restart the launchd service in place (KeepAlive would just revive a killed process). */
function launchdRestart(): boolean {
  const r = spawnSync("launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? 0}/${LABEL}`], { stdio: "ignore" })
  return r.status === 0
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function plistBody(store: string, flags: Flags, opencode: OpencodeExec): string {
  const env: Record<string, string> = {
    HOME: homedir(),
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    SKILLSMITH_WEB_AUTOSTART: "1",
    SKILLSMITH_STORE_DIR: store,
    // the resolved launcher (never a shebang-less pointer file – the CLI wraps it in /bin/sh)
    SKILLSMITH_OPENCODE_BIN: opencode.path,
  }
  if (flags.host) env.SKILLSMITH_WEB_HOST = flags.host
  if (flags.port) env.SKILLSMITH_WEB_PORT = String(flags.port)
  // launchd supervises this CLI (not opencode directly): only the CLI triggers the lazy
  // plugin load that brings up the web view. `run` blocks in the foreground – exactly what
  // launchd wants – and KeepAlive restarts it after a crash.
  const self = fileURLToPath(import.meta.url)
  const args = [process.execPath, self, "run", "--store", store]
  if (flags.host) args.push("--host", flags.host)
  if (flags.port) args.push("--port", String(flags.port))
  args.push("--opencode", opencode.path)
  const envXml = Object.entries(env)
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`)
    .join("\n")
  const argXml = args.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n")
  const out = outFile(store)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(homedir())}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(out)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(out)}</string>
</dict>
</plist>
`
}

function commandEnable(store: string, flags: Flags, opencode: OpencodeExec): number {
  if (process.platform !== "darwin") {
    console.error("enable wird nur unter macOS (launchd) unterstützt.")
    return 1
  }
  mkdirSync(dirname(PLIST), { recursive: true })
  mkdirSync(dirname(outFile(store)), { recursive: true })
  if (launchdLoaded()) {
    spawnSync("launchctl", ["unload", PLIST], { stdio: "ignore" })
  }
  writeFileSync(PLIST, plistBody(store, flags, opencode))
  const r = spawnSync("launchctl", ["load", "-w", PLIST], { stdio: "inherit" })
  if (r.status !== 0) {
    console.error("launchctl load fehlgeschlagen.")
    return 1
  }
  console.log(`skillsmith als Dienst registriert (${LABEL}).`)
  console.log(`  Plist:  ${PLIST}`)
  console.log(`  Store:  ${store}`)
  console.log(`  Log:    ${outFile(store)}`)
  console.log("Er startet jetzt und nach jedem Login automatisch. Beenden: skillsmith disable")
  return 0
}

function commandDisable(): number {
  if (process.platform !== "darwin") {
    console.error("disable wird nur unter macOS (launchd) unterstützt.")
    return 1
  }
  if (launchdLoaded()) spawnSync("launchctl", ["unload", "-w", PLIST], { stdio: "inherit" })
  rmSync(PLIST, { force: true })
  console.log(`skillsmith-Dienst entfernt (${LABEL}).`)
  return 0
}

// ---------------------------------------------------------------------------
// argument parsing and entry point
// ---------------------------------------------------------------------------

const COMMANDS = new Set(["run", "start", "stop", "restart", "status", "url", "logs", "enable", "disable", "help"])

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { command: argv[0] ?? "help", verbose: false, help: false }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--verbose" || a === "-v") flags.verbose = true
    else if (a === "--help" || a === "-h") flags.help = true
    else if (a === "--store") flags.store = argv[++i]
    else if (a.startsWith("--store=")) flags.store = a.slice(8)
    else if (a === "--port") flags.port = Number(argv[++i])
    else if (a.startsWith("--port=")) flags.port = Number(a.slice(7))
    else if (a === "--host") flags.host = argv[++i]
    else if (a.startsWith("--host=")) flags.host = a.slice(7)
    else if (a === "--opencode") flags.opencode = argv[++i]
    else if (a.startsWith("--opencode=")) flags.opencode = a.slice(11)
    else if (a === "--") break
    else if (!a.startsWith("-")) flags.command = a
  }
  return flags
}

function usage(): void {
  console.log(`skillsmith – Wissensarbeitsplatz als eigenständige Anwendung

Verwendung: skillsmith <Befehl> [Optionen]

Befehle:
  run        im Vordergrund starten (Strg-C beendet)
  start      im Hintergrund starten
  stop       Hintergrund-Instanz beenden
  restart    stop, dann start
  status     Status und Adresse der Weboberfläche
  url        Link zur Weboberfläche (mit Zugangsschlüssel)
  logs       skillsmith-Log verfolgen
  enable     als launchd-Dienst registrieren (überlebt Neustart)
  disable    launchd-Dienst entfernen

Optionen:
  --store <dir>      Store-Verzeichnis (Standard: aus opencode-Config bzw. ~/.local/share/skillsmith)
  --port <n>         Port der Weboberfläche (Standard 4747)
  --host <h>         Adresse der Weboberfläche (Standard 127.0.0.1)
  --opencode <bin>   opencode-Binary/Wrapper (Standard: "opencode" aus PATH)
  --verbose, -v      opencode-Logs zusätzlich ausgeben
  --help, -h         diese Hilfe

Beispiele:
  skillsmith start
  skillsmith enable --store ~/.config/opencode/skillsmith
  skillsmith url`)
}

export async function main(argv: string[]): Promise<number> {
  const flags = parseArgs(argv)
  if (flags.help || flags.command === "help" || !COMMANDS.has(flags.command)) {
    usage()
    return flags.command === "help" || flags.help ? 0 : 1
  }
  const { dir: store, source } = resolveStore(flags.store)
  if (flags.verbose) console.error(`Store: ${store} (${source})`)

  if (flags.command === "status") return commandStatus(store)
  if (flags.command === "url") return commandUrl(store)
  if (flags.command === "logs") return commandLogs(store, flags)
  if (flags.command === "disable") return commandDisable()
  if (flags.command === "stop") return commandStop(store)

  const opencode = resolveOpencode(flags.opencode)
  if (!opencode) {
    console.error('opencode nicht gefunden. Setze --opencode <pfad> oder SKILLSMITH_OPENCODE_BIN.')
    return 1
  }
  if (flags.verbose) console.error(`opencode: ${opencode.bin}${opencode.prepend.length ? ` (wrapper: ${opencode.prepend.join(" ")})` : ""}`)

  switch (flags.command) {
    case "run":
      return commandRun(store, flags, opencode)
    case "start":
      return commandStart(store, flags, opencode)
    case "restart": {
      // launchd owns the process: restart it in place (a stop would be undone by KeepAlive)
      if (launchdLoaded() && launchdStore() === store) {
        const previous = webInfo(store)?.pid
        if (!launchdRestart()) {
          console.error("launchctl kickstart fehlgeschlagen.")
          return 1
        }
        const web = await waitForWeb(store, undefined, 45_000, previous)
        if (web) {
          console.log(`skillsmith als Dienst neu gestartet (PID ${web.pid}).`)
          console.log(`  Weboberfläche: ${web.url}`)
        } else {
          console.log(`skillsmith als Dienst neu gestartet, Weboberfläche noch nicht bereit.`)
          console.log(`  Log: ${outFile(store)}`)
        }
        return 0
      }
      const stopped = await commandStop(store)
      if (stopped !== 0) return stopped
      return commandStart(store, flags, opencode)
    }
    case "enable":
      return commandEnable(store, flags, opencode)
    default:
      usage()
      return 1
  }
}

// run only when this module is the entry point (the `bin/skillsmith` launcher imports it and
// calls main itself – matching on the file name would run everything twice)
const entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : ""
if (entry === import.meta.url) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`Fehler: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    })
}
