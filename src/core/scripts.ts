/**
 * Scripts beyond Python (5e): a second runtime for TypeScript (node ≥ 22.18 runs .ts without
 * a build because type stripping is on by default; without such a node the script runs with
 * the Bun inside opencode – BUN_BE_BUN=1 <opencode> – no extra installation), and the uniform
 * call `call_script(name, params)`:
 *
 *   SCRIPT.md describes params and result as JSON schema; parameters go as JSON to stdin,
 *   the result comes back as JSON on stdout in the envelope {ok, data, error}, logs on stderr.
 *   Helpers (src/py/smith_script.py, src/ts/smith-script.ts) are copied next to the script.
 *
 * Node only strips types and checks nothing: enum, namespace with runtime code and parameter
 * properties are not allowed, relative imports need the ".ts" ending – the check rejects such
 * code before publishing. Tests: node --test / bun test, capabilities from the imports, the
 * same sandbox as Python, risky capabilities only with approval.
 */
import { spawn } from "node:child_process"
import { copyFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Options } from "../config"
import { CAPABILITIES } from "../config"
import type { Logger } from "../log"
import type { Entry, TestStatus } from "../types"
import { ensureDir, readJson, writeFileAtomic, writeJsonAtomic } from "../util/fs"
import { nowIso, oneLine, truncate } from "../util/text"
import type { Ctx } from "./context"
import { str, strArray } from "./frontmatter"
import { scriptFiles, scriptLanguage } from "./kinds"
import { M } from "./metrics"
import { GuardError } from "./ops"
import { execCapture, formatReport, profile, pythonEnv, type CheckReport, type DraftSpec, type PyEnv } from "./pyworkshop"

export const PY_HELPER = fileURLToPath(new URL("../py/smith_script.py", import.meta.url))
export const TS_HELPER = fileURLToPath(new URL("../ts/smith-script.ts", import.meta.url))

// ---------------------------------------------------------------------------
// runtime
// ---------------------------------------------------------------------------

export interface NodeEnv {
  ok: boolean
  /** node (type stripping) or bun (inside opencode or standalone) */
  runtime?: "node" | "bun"
  executable?: string
  version?: string
  env?: Record<string, string>
  error?: string
  checkedAt: string
}

/** node ≥ 22.18 (or ≥ 23.6) strips types by default. */
export function nodeStrips(version: string): boolean {
  const m = /^v?(\d+)\.(\d+)/.exec(version.trim())
  if (!m) return false
  const [maj, min] = [Number(m[1]), Number(m[2])]
  return maj > 23 || (maj === 23 && min >= 6) || (maj === 22 && min >= 18)
}

let nodeCache: Promise<NodeEnv> | undefined

/** node with type stripping, else Bun (the opencode binary with BUN_BE_BUN=1, or bun itself). */
export function nodeEnv(stateDir: string, refresh = false): Promise<NodeEnv> {
  const file = join(stateDir, "node.json")
  if (!refresh && nodeCache) return nodeCache
  if (!refresh) {
    const c = readJson<NodeEnv | null>(file, null)
    if (c && Date.now() - Date.parse(c.checkedAt) < 86_400_000) return (nodeCache = Promise.resolve(c))
  }
  nodeCache = (async (): Promise<NodeEnv> => {
    const at = nowIso()
    const node = await execCapture("node", ["--version"], { timeoutMs: 10_000 })
    let r: NodeEnv
    if (node.code === 0 && nodeStrips(node.stdout)) r = { ok: true, runtime: "node", executable: "node", version: node.stdout.trim(), checkedAt: at }
    else {
      // the process itself: opencode (a Bun executable) or bun
      const exe = process.execPath
      const bun = await execCapture(exe, ["--version"], { env: { ...process.env, BUN_BE_BUN: "1" }, timeoutMs: 10_000 })
      if (bun.code === 0 && /^\d+\.\d+/.test(bun.stdout.trim())) r = { ok: true, runtime: "bun", executable: exe, version: bun.stdout.trim(), env: { BUN_BE_BUN: "1" }, checkedAt: at }
      else r = { ok: false, error: `node ≥ 22.18 not found (${node.code === 0 ? node.stdout.trim() : "no node"}) and Bun is not available`, checkedAt: at }
    }
    try {
      ensureDir(stateDir)
      writeJsonAtomic(file, r)
    } catch {
      // cache only
    }
    return r
  })()
  return nodeCache
}

// ---------------------------------------------------------------------------
// static check of TypeScript (type stripping limits, capabilities, tests)
// ---------------------------------------------------------------------------

const mask = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length))
    .replace(/`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (m) => (/^["']\.{1,2}\//.test(m) ? m : `"${" ".repeat(Math.max(0, m.length - 2))}"`))

export interface TsCheck {
  errors: string[]
  warnings: string[]
  capabilities: string[]
  tests: number
}

export function checkTsSource(code: string, tests: string, module: string): TsCheck {
  const errors: string[] = []
  const warnings: string[] = []
  for (const [file, src] of [[`${module}.ts`, code], [`${module}.test.ts`, tests]] as const) {
    const m = mask(src)
    const at = (i: number) => `${file}:${m.slice(0, i).split("\n").length}`
    for (const x of m.matchAll(/(^|[^\w$.])(?:const\s+)?enum\s+[A-Za-z_$]/g)) errors.push(`${at(x.index ?? 0)}: enum is not supported by type stripping – use a const object (as const) and a union type`)
    for (const x of m.matchAll(/(^|[^\w$.])(?:namespace|module)\s+[A-Za-z_$][\w$.]*\s*\{/g)) {
      const before = m.slice(Math.max(0, (x.index ?? 0) - 20), x.index ?? 0)
      if (!/declare\s*$/.test(before)) errors.push(`${at(x.index ?? 0)}: namespace with code is not supported by type stripping – use a module`)
    }
    for (const x of m.matchAll(/constructor\s*\(([^)]*)\)/g)) if (/\b(public|private|protected|readonly)\s+[A-Za-z_$]/.test(x[1])) errors.push(`${at(x.index ?? 0)}: parameter properties (constructor(private x)) are not supported by type stripping – assign fields explicitly`)
    for (const x of m.matchAll(/\bimport\s+[A-Za-z_$][\w$]*\s*=\s*require\(/g)) errors.push(`${at(x.index ?? 0)}: import = require is not supported – use import … from`)
    for (const x of m.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g)) {
      if (!/\.(ts|mts|js|mjs|json)$/.test(x[1])) errors.push(`${at(x.index ?? 0)}: relative import "${x[1]}" needs the file ending (.ts)`)
    }
    for (const x of m.matchAll(/<([A-Z][\w$]*)>\s*[A-Za-z_$(]/g)) if (!/\bfunction\b|=>|\bclass\b|extends|\(/.test(m.slice(Math.max(0, (x.index ?? 0) - 15), x.index ?? 0))) warnings.push(`${at(x.index ?? 0)}: angle-bracket cast <${x[1]}> – prefer "as"`)
  }
  const caps = new Set<string>()
  const all = `${mask(code)}`
  const imports = [...code.matchAll(/(?:from\s*|import\s*\(\s*|require\(\s*)["']([^"']+)["']/g)].map((x) => x[1].replace(/^node:/, ""))
  if (imports.some((i) => ["child_process", "worker_threads", "cluster"].includes(i)) || /\bBun\.spawn|\bspawnSync\b|\bexecSync\b/.test(all)) caps.add("subprocess")
  if (imports.some((i) => ["net", "http", "https", "http2", "dgram", "tls", "dns"].includes(i)) || /\bfetch\s*\(|\bWebSocket\b/.test(all)) caps.add("network")
  if (/\b(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|createWriteStream|copyFile|copyFileSync|rename|renameSync|Bun\.write)\b/.test(all)) caps.add("filesystem-write")
  if (/\b(rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\s*\(/.test(all)) caps.add("delete")
  if (/\bprocess\.env\b|\bBun\.env\b/.test(all)) caps.add("env")
  // test names are strings – count on the source with comments removed
  const testCount = [...tests.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").matchAll(/(^|[^\w$.])(?:test|it)\s*\(\s*["'`]/g)].length
  if (!/["']node:test["']|["']bun:test["']/.test(tests)) warnings.push(`${module}.test.ts: use node:test (runs in node and bun)`)
  return { errors, warnings, capabilities: [...caps].filter((c) => (CAPABILITIES as readonly string[]).includes(c)), tests: testCount }
}

function minimalEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: home, LANG: process.env.LANG ?? "en_US.UTF-8", NODE_NO_WARNINGS: "1", ...extra }
}

/** node --test / bun test output → count and success. */
export function parseTestOutput(out: string, runtime: "node" | "bun"): { ran: number; failed: number } {
  if (runtime === "node") {
    const pass = Number(/^# pass (\d+)/m.exec(out)?.[1] ?? 0)
    const fail = Number(/^# fail (\d+)/m.exec(out)?.[1] ?? 0)
    return { ran: pass + fail, failed: fail }
  }
  const pass = Number(/^\s*(\d+) pass/m.exec(out)?.[1] ?? 0)
  const fail = Number(/^\s*(\d+) fail/m.exec(out)?.[1] ?? 0)
  return { ran: pass + fail, failed: fail }
}

/** Command for a .ts file with the detected runtime. */
function tsCommand(env: NodeEnv, args: string[]): [string, string[], Record<string, string>] {
  return [env.executable!, env.runtime === "node" ? ["--experimental-strip-types", "--no-warnings", ...args] : args, env.env ?? {}]
}

/** The check pipeline of a TypeScript draft (same report as Python). */
export async function checkTsDraft(input: { spec: DraftSpec; dir: string; options: Options; stateDir: string; log: Logger }): Promise<CheckReport> {
  const { spec, options: o } = input
  const t = o.toolsmith
  const f = scriptFiles(spec.name, "typescript")
  const errors: string[] = []
  const warnings: string[] = []
  const env = await nodeEnv(input.stateDir)
  const pyEnv: PyEnv | undefined = await pythonEnv(o, input.stateDir).catch(() => undefined)
  const fakeEnv = { version: env.version ? `${env.runtime} ${env.version}` : undefined } as PyEnv
  const report = (partial: Partial<CheckReport> & { test: TestStatus }): CheckReport => {
    const r: CheckReport = { ok: false, errors, warnings, detected: [], undeclared: [], risky: [], testCount: 0, text: "", ...partial }
    r.ok = r.errors.length === 0 && r.test.status !== "failed"
    r.text = formatReport(r, fakeEnv)
    return r
  }
  if (!env.ok) {
    errors.push(env.error ?? "no TypeScript runtime")
    return report({ test: { status: "untested", at: nowIso(), summary: "runtime unavailable" } })
  }
  if (!spec.code.trim()) errors.push("code is empty")
  if (!spec.tests.trim()) errors.push("tests are empty")
  if (errors.length) return report({ test: { status: "untested", at: nowIso() } })
  ensureDir(input.dir)
  writeFileAtomic(join(input.dir, f.code), spec.code.replace(/\r\n/g, "\n").trimEnd() + "\n")
  writeFileAtomic(join(input.dir, f.test), spec.tests.replace(/\r\n/g, "\n").trimEnd() + "\n")
  const st = checkTsSource(spec.code, spec.tests, f.module)
  errors.push(...st.errors)
  warnings.push(...st.warnings)
  const declared = spec.capabilities.filter((c) => (CAPABILITIES as readonly string[]).includes(c))
  const unknown = spec.capabilities.filter((c) => !(CAPABILITIES as readonly string[]).includes(c))
  if (unknown.length) errors.push(`unknown capabilities: ${unknown.join(", ")} (allowed: ${CAPABILITIES.join(", ")})`)
  const undeclared = st.capabilities.filter((c) => !declared.includes(c))
  if (undeclared.length) errors.push(`the code uses capabilities that are not declared: ${undeclared.join(", ")} – add them to capabilities (or remove the code)`)
  const risky = [...new Set([...declared, ...st.capabilities])].filter((c) => t.requireApprovalFor.includes(c))
  if (spec.requirements.length) errors.push("npm packages are not supported for TypeScript scripts – use node:* modules")
  if (st.tests < t.minTests) errors.push(`${f.test} has ${st.tests} test(s); at least ${t.minTests} are required (node:test, test("…", …))`)
  const base: Partial<CheckReport> = { detected: st.capabilities, undeclared, risky, testCount: st.tests }
  if (errors.length) return report({ ...base, test: { status: "untested", at: nowIso(), summary: "static check failed" } })
  const sandbox = pyEnv?.sandbox && t.sandbox !== "off" ? pyEnv.sandbox : undefined
  let needsApproval: string | undefined = risky.length ? `capabilities ${risky.join(", ")}` : undefined
  if (!sandbox && (t.sandbox === "required" || risky.length)) {
    const why = t.sandbox === "required" ? "toolsmith.sandbox=required but no sandbox is available" : `risky capabilities (${risky.join(", ")}) are only executed in a sandbox`
    warnings.push(`tests were NOT run: ${why}`)
    needsApproval = `${needsApproval ? `${needsApproval}; ` : ""}not tested (${why})`
    return report({ ...base, needsApproval, test: { status: "untested", at: nowIso(), sandbox: "none", summary: why } })
  }
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "toolsmith-ts-")))
  try {
    copyFileSync(join(input.dir, f.code), join(tmp, f.code))
    copyFileSync(join(input.dir, f.test), join(tmp, f.test))
    copyFileSync(TS_HELPER, join(tmp, "smith-script.ts"))
    const wrap = (cmd: string, args: string[]): [string, string[]] => (sandbox ? ["/usr/bin/sandbox-exec", ["-p", profile(tmp), cmd, ...args]] : pyEnv?.partial === "unshare" && t.sandbox !== "off" ? ["unshare", ["-rn", cmd, ...args]] : [cmd, args])
    const [exe, testArgs, extra] = tsCommand(env, env.runtime === "node" ? ["--test", f.test] : ["test", `./${f.test}`])
    const [cmd, args] = wrap(exe, testArgs)
    const res = await execCapture(cmd, args, { cwd: tmp, env: minimalEnv(tmp, extra), timeoutMs: t.testTimeoutSec * 1000 })
    const out = `${res.stdout}\n${res.stderr}`
    const parsed = parseTestOutput(out, env.runtime!)
    let status: TestStatus["status"] = res.code === 0 && parsed.failed === 0 && parsed.ran > 0 ? "passed" : "failed"
    let summary = res.timedOut ? `timeout after ${t.testTimeoutSec}s` : `${parsed.ran} tests, ${parsed.failed} failed`
    if (status === "passed" && parsed.ran < t.minTests) {
      status = "failed"
      summary = `only ${parsed.ran} test(s) ran; ${t.minTests} required`
    }
    if (status === "failed") errors.push(`tests failed: ${summary}\n${out.split("\n").slice(-25).join("\n")}`)
    else {
      const [he, ha, hx] = tsCommand(env, [f.code, "--help"])
      const [hc, hargs] = wrap(he, ha)
      const help = await execCapture(hc, hargs, { cwd: tmp, env: minimalEnv(tmp, hx), timeoutMs: 30_000 })
      if (help.code !== 0) {
        errors.push(`\`${f.code} --help\` failed (exit ${help.code}): ${truncate(oneLine(help.stderr || help.stdout), 400)}`)
        status = "failed"
        summary += "; --help failed"
      }
    }
    return report({ ...base, needsApproval, test: { status, at: nowIso(), python: `${env.runtime} ${env.version}`, sandbox: sandbox ?? "none", summary } })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// JSON schema (subset) for the parameters
// ---------------------------------------------------------------------------

/** Validate a value against a JSON schema subset (type, properties, required, enum, items, min/max, additionalProperties). */
export function validateSchema(schema: Record<string, unknown> | undefined, value: unknown, path = "params"): string[] {
  if (!schema || typeof schema !== "object") return []
  const errs: string[] = []
  const type = schema.type as string | string[] | undefined
  const is = (t: string) => {
    if (t === "integer") return Number.isInteger(value)
    if (t === "number") return typeof value === "number" && Number.isFinite(value)
    if (t === "array") return Array.isArray(value)
    if (t === "object") return !!value && typeof value === "object" && !Array.isArray(value)
    if (t === "null") return value === null
    return typeof value === t
  }
  if (type && !(Array.isArray(type) ? type : [type]).some(is)) return [`${path}: expected ${Array.isArray(type) ? type.join(" | ") : type}`]
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) errs.push(`${path}: one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`)
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errs.push(`${path}: ≥ ${schema.minimum}`)
    if (typeof schema.maximum === "number" && value > schema.maximum) errs.push(`${path}: ≤ ${schema.maximum}`)
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errs.push(`${path}: at least ${schema.minLength} characters`)
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errs.push(`${path}: at most ${schema.maxLength} characters`)
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === "object") value.forEach((v, i) => errs.push(...validateSchema(schema.items as Record<string, unknown>, v, `${path}[${i}]`)))
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
    for (const r of strArray(schema.required)) if (!(r in (value as object))) errs.push(`${path}.${r}: required`)
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (props[k]) errs.push(...validateSchema(props[k], v, `${path}.${k}`))
      else if (schema.additionalProperties === false) errs.push(`${path}.${k}: not allowed`)
    }
  }
  return errs
}

// ---------------------------------------------------------------------------
// call_script
// ---------------------------------------------------------------------------

export interface CallResult {
  ok: boolean
  data?: unknown
  error?: string
  /** stderr (log output), shortened */
  log?: string
  ms: number
  exit: number
  /** scripts without schema: raw stdout */
  stdout?: string
}

/**
 * Run a published script: params as JSON on stdin (scripts with a params schema) or `args` on
 * the command line (older scripts without schema keep their CLI). Time limit, sandbox like the
 * tests (risky scripts only with a full sandbox or after the user's approval of the entry).
 */
export async function callScript(ctx: Ctx, name: string, input: { params?: unknown; args?: string[]; cwd?: string; origin?: "agent" | "web" | "cli"; session?: string }): Promise<CallResult> {
  const e: Entry | undefined = ctx.store.getOwned("script", name)
  if (!e || e.tier === "archive") throw new GuardError(`Skript „${name}“ nicht gefunden`)
  if (e.meta?.test?.status === "failed") throw new GuardError(`Skript „${name}“: letzter Test fehlgeschlagen – erst reparieren (Werkstatt)`)
  const lang = scriptLanguage(e)
  const f = scriptFiles(name, lang)
  const schema = e.fields.params as Record<string, unknown> | undefined
  const withJson = !!schema || input.params !== undefined
  if (schema) {
    const errs = validateSchema(schema, input.params ?? {})
    if (errs.length) throw new GuardError(`Parameter passen nicht zum Schema: ${errs.slice(0, 6).join("; ")}`)
  }
  const code = ctx.store.readFileOf(e, f.code)
  if (!code) throw new GuardError(`Skript „${name}“: ${f.code} fehlt`)
  const t = ctx.options.toolsmith
  const py = await pythonEnv(ctx.options, ctx.store.stateDir).catch(() => undefined)
  const caps = strArray(e.fields.capabilities)
  const sandbox = py?.sandbox && t.sandbox !== "off" ? py.sandbox : undefined
  const risky = caps.filter((c) => t.requireApprovalFor.includes(c))
  // risky scripts were approved by the user when published; without a sandbox they still run outside the temp dir
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "call-script-")))
  const started = Date.now()
  try {
    writeFileAtomic(join(tmp, f.code), code)
    let cmd: string
    let args: string[]
    let extra: Record<string, string> = {}
    if (lang === "typescript") {
      copyFileSync(TS_HELPER, join(tmp, "smith-script.ts"))
      const env = await nodeEnv(ctx.store.stateDir)
      if (!env.ok) throw new GuardError(env.error ?? "keine TypeScript-Laufzeit")
      ;[cmd, args, extra] = tsCommand(env, [join(tmp, f.code), ...(withJson ? [] : (input.args ?? []))])
    } else {
      copyFileSync(PY_HELPER, join(tmp, "smith_script.py"))
      if (!py?.ok) throw new GuardError(py?.error ?? "python nicht verfügbar")
      cmd = py.executable || t.python
      args = ["-B", join(tmp, f.code), ...(withJson ? [] : (input.args ?? []))]
    }
    if (sandbox && risky.length) [cmd, args] = ["/usr/bin/sandbox-exec", ["-p", profile(tmp), cmd, ...args]]
    const res = await execWithStdin(cmd, args, withJson ? JSON.stringify(input.params ?? {}) : "", { cwd: input.cwd ?? tmp, env: { ...process.env, ...extra, PYTHONPATH: tmp, PYTHONDONTWRITEBYTECODE: "1" }, timeoutMs: t.testTimeoutSec * 1000 })
    const ms = Date.now() - started
    let out: CallResult
    if (withJson) {
      const last = res.stdout.trim().split("\n").pop() ?? ""
      let env: { ok?: boolean; data?: unknown; error?: string } | undefined
      try {
        env = JSON.parse(last)
      } catch {
        env = undefined
      }
      out = env && typeof env.ok === "boolean" ? { ok: env.ok, data: env.data, error: env.error, ms, exit: res.code } : { ok: false, error: res.timedOut ? `Zeitlimit (${t.testTimeoutSec}s)` : `keine JSON-Hülle auf stdout (exit ${res.code})`, ms, exit: res.code, stdout: truncate(res.stdout, 4000) }
    } else out = { ok: res.code === 0, stdout: truncate(res.stdout, 20_000), ms, exit: res.code, ...(res.code ? { error: truncate(res.stderr || `exit ${res.code}`, 1000) } : {}) }
    out.log = truncate(res.stderr, 4000) || undefined
    out.data = out.data === undefined ? undefined : JSON.parse(ctx.redactor.redact(JSON.stringify(out.data)))
    ctx.usage.recordLoad("script", name, { session: input.session, origin: input.origin === "agent" ? undefined : "web" } as any)
    ctx.metrics?.record({ type: M.scriptRun, entry: `script:${name}`, session: input.session, origin: input.origin === "agent" ? "main" : "web", value: ms, extra: out.ok ? {} : { error: true } } as any)
    ctx.log.info(`call_script ${name}: ${out.ok ? "ok" : "failed"} (${ms} ms)`, { origin: input.origin, exit: out.exit })
    return out
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function execWithStdin(cmd: string, args: string[], stdin: string, opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, opts.timeoutMs)
    child.stdout.on("data", (d) => stdout.length < 2_000_000 && (stdout += String(d)))
    child.stderr.on("data", (d) => stderr.length < 200_000 && (stderr += String(d)))
    child.on("error", (err) => {
      clearTimeout(timer)
      resolve({ code: 127, stdout, stderr: stderr + String(err), timedOut })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr, timedOut })
    })
    child.stdin.end(stdin)
  })
}

/** Text form of the parameters of a script (tool description, CLI help). */
export function paramsHelp(e: Entry): string {
  const s = e.fields.params as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] } | undefined
  if (!s?.properties) return str(e.fields.usage)
  return Object.entries(s.properties)
    .map(([k, v]) => `${k}${s.required?.includes(k) ? "" : "?"}: ${v.type ?? "any"}${v.description ? ` – ${v.description}` : ""}`)
    .join("; ")
}
