/**
 * toolsmith workshop: Python environment detection, sandboxed test runs and
 * the deterministic check pipeline for script drafts.
 *
 *   draft files → static check (checker.py: syntax for the target version,
 *   imports, capabilities, test count) → declared capabilities → requirements
 *   (optional pip install) → unit tests (unittest, temp dir, timeout,
 *   sandbox) → `--help` smoke test.
 *
 * Nothing here is decided by the model; it only receives the report.
 */
import { spawn } from "node:child_process"
import { copyFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { CAPABILITIES, type Options } from "../config"
import type { Logger } from "../log"
import type { TestStatus } from "../types"
import { ensureDir, exists, readJson, writeFileAtomic, writeJsonAtomic } from "../util/fs"
import { nowIso, oneLine, truncate } from "../util/text"
import { scriptFiles } from "./kinds"

export const CHECKER_PATH = fileURLToPath(new URL("../py/checker.py", import.meta.url))

// ---------------------------------------------------------------------------
// process helper
// ---------------------------------------------------------------------------

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export function execCapture(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBytes?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const max = opts.maxBytes ?? 200_000
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] })
    } catch (err) {
      resolve({ code: 127, stdout: "", stderr: String(err), timedOut: false })
      return
    }
    const kill = () => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL")
        else child.kill("SIGKILL")
      } catch {
        try {
          child.kill("SIGKILL")
        } catch {
          // ignore
        }
      }
    }
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          kill()
        }, opts.timeoutMs)
      : undefined
    child.stdout?.on("data", (d) => {
      if (stdout.length < max) stdout += String(d)
    })
    child.stderr?.on("data", (d) => {
      if (stderr.length < max) stderr += String(d)
    })
    child.on("error", (err) => {
      if (timer) clearTimeout(timer)
      resolve({ code: 127, stdout, stderr: stderr + String(err), timedOut })
    })
    child.on("close", (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? (timedOut ? 124 : 1), stdout, stderr, timedOut })
    })
  })
}

// ---------------------------------------------------------------------------
// environment
// ---------------------------------------------------------------------------

export interface PyEnv {
  ok: boolean
  python: string
  executable?: string
  version?: string
  /** full sandbox (network denied, writes only into the temp dir) */
  sandbox?: "sandbox-exec"
  /** partial isolation (network only) */
  partial?: "unshare"
  error?: string
  pipAvailable?: boolean
  checkedAt: string
  setting: string
}

function profile(writable: string): string {
  const q = (s: string) => JSON.stringify(s)
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny file-write*)",
    `(allow file-write* (subpath ${q(writable)}) (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/") (regex #"^/dev/ttys"))`,
  ].join("\n")
}

async function sandboxSelfTest(python: string): Promise<boolean> {
  if (process.platform !== "darwin" || !exists("/usr/bin/sandbox-exec")) return false
  const a = realpathSync(mkdtempSync(join(tmpdir(), "toolsmith-sbx-")))
  const b = realpathSync(mkdtempSync(join(tmpdir(), "toolsmith-sbx-")))
  try {
    const okRun = await execCapture(
      "/usr/bin/sandbox-exec",
      ["-p", profile(a), python, "-c", `open(${JSON.stringify(join(a, "x"))},"w").write("1"); print("ok")`],
      { timeoutMs: 20_000 },
    )
    if (okRun.code !== 0 || !okRun.stdout.includes("ok")) return false
    const denied = await execCapture("/usr/bin/sandbox-exec", ["-p", profile(a), python, "-c", `open(${JSON.stringify(join(b, "y"))},"w").write("1")`], {
      timeoutMs: 20_000,
    })
    return denied.code !== 0 && !exists(join(b, "y"))
  } catch {
    return false
  } finally {
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  }
}

async function unshareSelfTest(python: string): Promise<boolean> {
  if (process.platform !== "linux") return false
  const r = await execCapture("unshare", ["-rn", python, "-c", "print('ok')"], { timeoutMs: 10_000 })
  return r.code === 0 && r.stdout.includes("ok")
}

/** Does `python` resolve to Apple's /usr/bin shim? */
async function isCltShim(python: string): Promise<boolean> {
  if (python === "/usr/bin/python3") return true
  if (python.includes("/")) return false
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue
    const candidate = join(dir, python)
    if (exists(candidate)) return candidate === "/usr/bin/python3"
  }
  return false
}

const envCache = new Map<string, Promise<PyEnv>>()

/** Detect python + sandbox; cached in state/python.json for 24 h. */
export function pythonEnv(o: Options, stateDir: string, refresh = false): Promise<PyEnv> {
  const setting = `${o.toolsmith.python}|${o.toolsmith.sandbox}`
  const file = join(stateDir, "python.json")
  if (!refresh) {
    const cached = readJson<PyEnv | null>(file, null)
    if (cached && cached.setting === setting && Date.now() - Date.parse(cached.checkedAt) < 86_400_000) return Promise.resolve(cached)
    const inflight = envCache.get(setting)
    if (inflight) return inflight
  }
  const p = (async (): Promise<PyEnv> => {
    const python = o.toolsmith.python
    const env: PyEnv = { ok: false, python, checkedAt: nowIso(), setting }
    if (process.platform === "darwin" && (await isCltShim(python))) {
      // /usr/bin/python3 without the Command Line Tools opens an installer dialog – never trigger that
      const sel = await execCapture("/usr/bin/xcode-select", ["-p"], { timeoutMs: 5000 })
      if (sel.code !== 0) {
        env.error = `${python} needs the Command Line Tools (xcode-select --install) or set toolsmith.python`
        try {
          ensureDir(stateDir)
          writeJsonAtomic(file, env)
        } catch {
          // ignore
        }
        return env
      }
    }
    const r = await execCapture(python, ["-c", "import sys,json;print(json.dumps({'v':'%d.%d.%d'%sys.version_info[:3],'exe':sys.executable}))"], {
      timeoutMs: 20_000,
    })
    if (r.code !== 0) {
      env.error = `${python} not usable: ${truncate(oneLine(r.stderr || r.stdout || `exit ${r.code}`), 200)}`
    } else {
      try {
        const info = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}")
        env.version = info.v
        env.executable = info.exe
        env.ok = true
      } catch {
        env.error = `unexpected output of ${python}`
      }
    }
    if (env.ok) {
      const exe = env.executable || python
      if (o.toolsmith.sandbox !== "off") {
        if (await sandboxSelfTest(exe)) env.sandbox = "sandbox-exec"
        else if (await unshareSelfTest(exe)) env.partial = "unshare"
      }
      const pip = await execCapture(exe, ["-m", "pip", "--version"], { timeoutMs: 20_000 })
      env.pipAvailable = pip.code === 0
    }
    try {
      ensureDir(stateDir)
      writeJsonAtomic(file, env)
    } catch {
      // ignore
    }
    return env
  })()
  envCache.set(setting, p)
  void p.finally(() => envCache.delete(setting))
  return p
}

// ---------------------------------------------------------------------------
// drafts and checks
// ---------------------------------------------------------------------------

export interface DraftSpec {
  name: string
  description: string
  usage: string
  code: string
  tests: string
  capabilities: string[]
  requirements: string[]
  tags: string[]
  docs: string
}

export interface CheckReport {
  ok: boolean
  errors: string[]
  warnings: string[]
  detected: string[]
  undeclared: string[]
  risky: string[]
  testCount: number
  test: TestStatus
  needsApproval?: string
  text: string
}

export interface Draft extends DraftSpec {
  isNew: boolean
  iterations: number
  dir: string
  updatedAt: string
  check?: CheckReport
}

interface CheckerOutput {
  errors: string[]
  warnings: string[]
  imports: { stdlib: string[]; third_party: string[]; missing: string[] }
  capabilities: string[]
  tests: number
  has_main_guard: boolean
  uses_argparse: boolean
  python: string
}

function minimalEnv(home: string, keepHome: boolean): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: keepHome ? (process.env.HOME ?? home) : home,
    TMPDIR: home,
    TMP: home,
    TEMP: home,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONHASHSEED: "0",
  }
}

function writeDraftFiles(dir: string, spec: DraftSpec): { code: string; test: string } {
  const f = scriptFiles(spec.name)
  ensureDir(dir)
  writeFileAtomic(join(dir, f.code), spec.code.replace(/\r\n/g, "\n").trimEnd() + "\n")
  writeFileAtomic(join(dir, f.test), spec.tests.replace(/\r\n/g, "\n").trimEnd() + "\n")
  return { code: join(dir, f.code), test: join(dir, f.test) }
}

/** Files of a script entry as written into the store. */
export function draftFiles(spec: DraftSpec): Record<string, string> {
  const f = scriptFiles(spec.name)
  return {
    [f.code]: spec.code.replace(/\r\n/g, "\n").trimEnd() + "\n",
    [f.test]: spec.tests.replace(/\r\n/g, "\n").trimEnd() + "\n",
  }
}

function parseUnittest(out: string): { ran: number; ok: boolean; summary: string } {
  const ran = Number(/Ran (\d+) tests?/.exec(out)?.[1] ?? 0)
  const ok = /\n\s*OK\b/.test(out) || /^OK\b/m.test(out)
  const failed = /FAILED \(([^)]*)\)/.exec(out)?.[1]
  return { ran, ok, summary: ok ? `${ran} tests OK` : failed ? `${ran} tests, FAILED (${failed})` : `${ran} tests, not OK` }
}

function tail(text: string, lines = 25, chars = 2500): string {
  const t = text.split("\n").slice(-lines).join("\n")
  return t.length > chars ? t.slice(t.length - chars) : t
}

/**
 * Run the complete check pipeline for a draft. `dir` receives the draft files;
 * tests run in a throw-away copy.
 */
export async function checkDraft(input: {
  spec: DraftSpec
  dir: string
  env: PyEnv
  options: Options
  log: Logger
}): Promise<CheckReport> {
  const { spec, env, options: o } = input
  const t = o.toolsmith
  const errors: string[] = []
  const warnings: string[] = []
  const files = scriptFiles(spec.name)
  const report = (partial: Partial<CheckReport> & { test: TestStatus }): CheckReport => {
    const r: CheckReport = {
      ok: false,
      errors,
      warnings,
      detected: [],
      undeclared: [],
      risky: [],
      testCount: 0,
      text: "",
      ...partial,
    }
    r.ok = r.errors.length === 0 && r.test.status !== "failed"
    r.text = formatReport(r, env)
    return r
  }
  if (!env.ok) {
    errors.push(env.error ?? `python (${t.python}) is not available`)
    return report({ test: { status: "untested", at: nowIso(), summary: "python unavailable" } })
  }
  if (!spec.code.trim()) errors.push("code is empty")
  if (!spec.tests.trim()) errors.push("tests are empty")
  if (errors.length) return report({ test: { status: "untested", at: nowIso() } })
  const paths = writeDraftFiles(input.dir, spec)
  const exe = env.executable || t.python

  // 1. static check
  const chk = await execCapture(exe, ["-E", "-s", "-B", CHECKER_PATH, "--target", t.pythonTarget, "--module", files.module, paths.code, paths.test], {
    timeoutMs: 60_000,
    cwd: input.dir,
  })
  let out: CheckerOutput | undefined
  try {
    out = JSON.parse(chk.stdout.trim().split("\n").pop() ?? "")
  } catch {
    errors.push(`static check failed: ${truncate(oneLine(chk.stderr || chk.stdout), 400)}`)
  }
  if (!out) return report({ test: { status: "untested", at: nowIso() } })
  errors.push(...out.errors)
  warnings.push(...out.warnings)
  if (!out.has_main_guard) errors.push(`${files.code} needs an  if __name__ == "__main__":  guard (tests import the module)`)
  if (!out.uses_argparse) warnings.push("the script does not use argparse; `--help` must still work")

  // 2. capabilities
  const declared = spec.capabilities.filter((c) => (CAPABILITIES as readonly string[]).includes(c))
  const unknown = spec.capabilities.filter((c) => !(CAPABILITIES as readonly string[]).includes(c))
  if (unknown.length) errors.push(`unknown capabilities: ${unknown.join(", ")} (allowed: ${CAPABILITIES.join(", ")})`)
  const detected = out.capabilities
  const undeclared = detected.filter((c) => !declared.includes(c))
  if (undeclared.length) errors.push(`the code uses capabilities that are not declared: ${undeclared.join(", ")} – add them to capabilities (or remove the code)`)
  const risky = [...new Set([...declared, ...detected])].filter((c) => t.requireApprovalFor.includes(c))

  // 3. requirements
  let missing = out.imports.missing
  if (missing.length && spec.requirements.length && t.allowPipInstall) {
    if (!env.pipAvailable) {
      errors.push(`packages missing (${missing.join(", ")}) and pip is not available`)
    } else {
      const pip = await execCapture(exe, ["-m", "pip", "install", "--user", "--disable-pip-version-check", "--no-input", ...spec.requirements], {
        timeoutMs: 300_000,
      })
      if (pip.code !== 0) {
        errors.push(
          `pip install ${spec.requirements.join(" ")} failed (the package index may not offer it): ${truncate(oneLine(tail(pip.stderr || pip.stdout, 6)), 400)} – prefer the standard library`,
        )
      } else {
        const again = await execCapture(exe, ["-E", "-B", CHECKER_PATH, "--target", t.pythonTarget, "--module", files.module, paths.code, paths.test], {
          timeoutMs: 60_000,
          cwd: input.dir,
        })
        try {
          missing = (JSON.parse(again.stdout.trim().split("\n").pop() ?? "") as CheckerOutput).imports.missing
        } catch {
          // keep previous list
        }
      }
    }
  }
  if (missing.length) {
    errors.push(
      `module(s) not installed: ${missing.join(", ")}. Use the Python ${t.pythonTarget} standard library instead${
        t.allowPipInstall ? " or list the pip package in requirements" : " (installing packages is disabled: toolsmith.allowPipInstall=false)"
      }`,
    )
  }
  const third = out.imports.third_party
  if (third.length && !spec.requirements.length) warnings.push(`third-party imports (${third.join(", ")}) – list them in requirements`)

  // 4. tests
  if (out.tests < t.minTests) errors.push(`${files.test} has ${out.tests} test method(s); at least ${t.minTests} are required (unittest.TestCase, methods named test_*)`)
  const base: Partial<CheckReport> = { detected, undeclared, risky, testCount: out.tests }
  if (errors.length) return report({ ...base, test: { status: "untested", at: nowIso(), python: env.version, summary: "static check failed" } })

  const fullSandbox = env.sandbox && t.sandbox !== "off" ? env.sandbox : undefined
  let needsApproval: string | undefined = risky.length ? `capabilities ${risky.join(", ")}` : undefined
  if (!fullSandbox && (t.sandbox === "required" || risky.length)) {
    const why = t.sandbox === "required" ? "toolsmith.sandbox=required but no sandbox is available" : `risky capabilities (${risky.join(", ")}) are only executed in a sandbox`
    warnings.push(`tests were NOT run: ${why}`)
    needsApproval = `${needsApproval ? needsApproval + "; " : ""}not tested (${why})`
    return report({ ...base, needsApproval, test: { status: "untested", at: nowIso(), python: env.version, sandbox: "none", summary: why } })
  }

  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "toolsmith-run-")))
  try {
    copyFileSync(paths.code, join(tmp, files.code))
    copyFileSync(paths.test, join(tmp, files.test))
    const pyFlags = ["-B", ...(spec.requirements.length ? [] : ["-E", "-s"])]
    const wrap = (args: string[]): [string, string[]] => {
      if (fullSandbox) return ["/usr/bin/sandbox-exec", ["-p", profile(tmp), exe, ...args]]
      if (env.partial === "unshare" && t.sandbox !== "off") return ["unshare", ["-rn", exe, ...args]]
      return [exe, args]
    }
    const sandboxLabel = fullSandbox ?? (env.partial && t.sandbox !== "off" ? `${env.partial} (network only)` : "none")
    const runEnv = minimalEnv(tmp, spec.requirements.length > 0)
    const [cmd, args] = wrap([...pyFlags, "-m", "unittest", "-v", `test_${files.module}`])
    const res = await execCapture(cmd, args, { cwd: tmp, env: runEnv, timeoutMs: t.testTimeoutSec * 1000 })
    const combined = `${res.stdout}\n${res.stderr}`
    const parsed = parseUnittest(combined)
    let status: TestStatus["status"] = res.code === 0 && parsed.ok ? "passed" : "failed"
    let summary = res.timedOut ? `timeout after ${t.testTimeoutSec}s` : parsed.summary
    if (status === "passed" && parsed.ran < t.minTests) {
      status = "failed"
      summary = `only ${parsed.ran} test(s) ran; ${t.minTests} required`
    }
    if (status === "failed") errors.push(`tests failed: ${summary}\n${tail(combined)}`)
    else {
      const [hcmd, hargs] = wrap([...pyFlags, files.code, "--help"])
      const help = await execCapture(hcmd, hargs, { cwd: tmp, env: runEnv, timeoutMs: 30_000 })
      if (help.code !== 0) {
        errors.push(`\`python ${files.code} --help\` failed (exit ${help.code}): ${truncate(oneLine(tail(help.stderr || help.stdout, 5)), 400)}`)
        status = "failed"
        summary += "; --help failed"
      } else if (!/usage/i.test(help.stdout + help.stderr)) {
        warnings.push("`--help` printed no usage text")
      }
    }
    return report({ ...base, needsApproval, test: { status, at: nowIso(), python: env.version, sandbox: sandboxLabel, summary } })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

export function formatReport(r: CheckReport, env: PyEnv): string {
  const lines = [
    `CHECK ${r.ok ? "PASSED" : "FAILED"} – python ${env.version ?? "?"}, tests: ${r.test.status}${r.test.summary ? ` (${r.test.summary})` : ""}${
      r.test.sandbox ? `, sandbox: ${r.test.sandbox}` : ""
    }`,
  ]
  if (r.detected.length) lines.push(`capabilities detected: ${r.detected.join(", ")}`)
  if (r.needsApproval) lines.push(`publishing will require user approval: ${r.needsApproval}`)
  if (r.errors.length) lines.push("errors:", ...r.errors.map((e) => `- ${e}`))
  if (r.warnings.length) lines.push("warnings:", ...r.warnings.map((w) => `- ${w}`))
  return lines.join("\n")
}

export function draftRoot(stateDir: string, runId: string, name: string): string {
  return join(stateDir, "drafts", runId, name)
}

export function cleanupDrafts(stateDir: string, runId: string): void {
  try {
    rmSync(join(stateDir, "drafts", runId), { recursive: true, force: true })
  } catch {
    // ignore
  }
}
