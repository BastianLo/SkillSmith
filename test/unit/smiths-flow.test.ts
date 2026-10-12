import { describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isConfigError, runAgentSession, sessionSignals } from "../../src/core/agent-runner"
import { Curator } from "../../src/core/curator"
import { ReviewQueue } from "../../src/core/queue"
import { prepare, resolveModel, route } from "../../src/core/reviewer"
import { modelErrorHint } from "../../src/core/models"
import { buildTranscript, type Msg } from "../../src/core/transcript"
import { glossaryRows, handleCommand, parseCsv, parseMarkdownTable } from "../../src/host/commands"
import { createTools } from "../../src/host/tools"
import { silentLogger } from "../../src/log"
import { readJson, writeJsonAtomic } from "../../src/util/fs"
import { BODY, cmdRun, ERROR_BODY, makeCtx, makeRun, tmp } from "./helpers"

// ---------------------------------------------------------------------------
// toolsmith workshop (runs the real python3 of this machine)
// ---------------------------------------------------------------------------

const CODE = `"""Count lines per value of a CSV column."""
from __future__ import annotations

import argparse
import csv
import sys
from collections import Counter


def count_values(lines: list[str], column: int, delimiter: str = ";") -> dict[str, int]:
    reader = csv.reader(lines, delimiter=delimiter)
    return dict(Counter(row[column] for row in reader if len(row) > column))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Count values of a CSV column")
    parser.add_argument("file")
    parser.add_argument("--column", type=int, default=0)
    parser.add_argument("--delimiter", default=";")
    args = parser.parse_args(argv)
    with open(args.file, encoding="utf-8") as fh:
        for value, n in sorted(count_values(fh.read().splitlines(), args.column, args.delimiter).items()):
            print(f"{value}\\t{n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
`

const TESTS = `import os
import tempfile
import unittest

import count_csv_values as m


class CountTest(unittest.TestCase):
    def test_counts(self):
        self.assertEqual(m.count_values(["a;1", "b;2", "a;3"], 0), {"a": 2, "b": 1})

    def test_other_column(self):
        self.assertEqual(m.count_values(["a;1", "b;1"], 1), {"1": 2})

    def test_main_reads_file(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "x.csv")
            with open(p, "w", encoding="utf-8") as fh:
                fh.write("x;1\\nx;2\\n")
            self.assertEqual(m.main([p]), 0)
`

const DOCS = "## Zweck\nZählt Werte einer CSV-Spalte.\n\n## Aufruf\n`python3 count_csv_values.py daten.csv --column 2`\n\n## Ein- und Ausgabe\nCSV rein, TSV raus.\n\n## Grenzen\nNur UTF-8."

const PY = process.env.SKILLSMITH_TEST_PYTHON ?? "python3"

const draftSpec = (over: Record<string, unknown> = {}) => ({
  name: "count-csv-values",
  description: "Zählt die Werte einer CSV-Spalte (Häufigkeiten)",
  usage: "python3 count_csv_values.py FILE [--column N] [--delimiter ;]",
  code: CODE,
  tests: TESTS,
  docs: DOCS,
  capabilities: [] as string[],
  requirements: [] as string[],
  tags: ["csv", "report"],
  ...over,
})

describe("toolsmith workshop", () => {
  test("draft → check → publish (recurrence gate) → files + meta in the store", async () => {
    const ctx = makeCtx({ toolsmith: { sandbox: "off", python: PY } })
    const run = makeRun(ctx, "reviewer", { smith: "toolsmith", userText: "Kannst du daraus ein Skript machen, das brauche ich jede Woche?", limits: { maxNew: 1, maxChanges: 3, maxNotes: 5 } })
    const report = await ctx.workshop.draft(run, draftSpec())
    expect(report).toContain("CHECK PASSED")
    expect(report).toContain("3 tests OK")
    await expect(ctx.workshop.publish(run, { name: "count-csv-values", reason: "weekly report" })).rejects.toThrow(/recurrence/)
    const msg = await ctx.workshop.publish(run, { name: "count-csv-values", reason: "weekly report", userQuote: "Kannst du daraus ein Skript machen" })
    expect(msg).toContain("published")
    const rec = ctx.store.getOwned("script", "count-csv-values")!
    expect(rec.file).toContain("scripts/active/count-csv-values/SCRIPT.md")
    expect(readFileSync(join(rec.dir, "count_csv_values.py"), "utf8")).toContain("def count_values")
    expect(readFileSync(join(rec.dir, "test_count_csv_values.py"), "utf8")).toContain("unittest")
    expect(rec.meta?.test?.status).toBe("passed")
    expect(rec.fields.capabilities).toEqual(["filesystem-write"].filter(() => false))
    expect(rec.fields.python).toBe("3.9")
    expect(ctx.index.search("csv spalte werte zählen", { kinds: ["script"] })[0].name).toBe("count-csv-values")
  }, 60_000)

  test("static check: python 3.9 syntax, undeclared capabilities, too few tests, failing tests", async () => {
    const ctx = makeCtx({ toolsmith: { sandbox: "off", python: PY } })
    const run = makeRun(ctx, "reviewer", { smith: "toolsmith", limits: { maxNew: 1, maxChanges: 3, maxNotes: 5 } })
    const pep604 = CODE.replace("from __future__ import annotations\n", "")
    let r = await ctx.workshop.draft(run, draftSpec({ code: pep604 }))
    expect(r).toContain("CHECK FAILED")
    expect(r).toContain("needs Python 3.10")
    r = await ctx.workshop.revise(run, "count-csv-values", { code: CODE.replace("import csv\n", "import csv\nimport subprocess\n") })
    expect(r).toContain("not declared: subprocess")
    r = await ctx.workshop.revise(run, "count-csv-values", { code: CODE, tests: TESTS.replace(/    def test_other_column[\s\S]*?(?=    def test_main)/, "") })
    expect(r).toContain("at least 3 are required")
    r = await ctx.workshop.revise(run, "count-csv-values", { tests: TESTS.replace('{"a": 2, "b": 1}', '{"a": 3}') })
    expect(r).toContain("tests failed")
    expect(r).toContain("iteration 4/5")
    r = await ctx.workshop.revise(run, "count-csv-values", { tests: TESTS })
    expect(r).toContain("CHECK PASSED")
    await expect(ctx.workshop.revise(run, "count-csv-values", { tests: TESTS })).rejects.toThrow(/iteration limit/)
  }, 90_000)

  test("risky capabilities are not executed without sandbox and need approval", async () => {
    const ctx = makeCtx({ toolsmith: { sandbox: "off", python: PY, requireApprovalFor: ["delete"] } })
    const code = CODE.replace("import sys\n", "import os\nimport sys\n").replace("    return 0\n\n\nif", "    if args.file.endswith('.tmp'):\n        os.remove(args.file)\n    return 0\n\n\nif")
    const run = makeRun(ctx, "reviewer", { smith: "toolsmith", userText: "bitte als Skript", limits: { maxNew: 1, maxChanges: 3, maxNotes: 5 } })
    const r = await ctx.workshop.draft(run, draftSpec({ code, capabilities: ["delete"] }))
    expect(r).toContain("approval")
    const msg = await ctx.workshop.publish(run, { name: "count-csv-values", reason: "x", userQuote: "bitte als Skript" })
    expect(msg).toContain("staged")
    expect(ctx.store.getOwned("script", "count-csv-values")).toBeUndefined()
    const staged = ctx.ops.staged()
    expect(staged).toHaveLength(1)
    expect(staged[0].reason).toContain("Freigabe nötig")
    // approval re-checks and publishes
    const out = await ctx.ops.applyStaged(cmdRun(ctx, "toolsmith"), staged[0])
    expect(out).toContain("published")
    expect(ctx.store.getOwned("script", "count-csv-values")?.fields.capabilities).toEqual(["delete"])
  }, 60_000)
})

// ---------------------------------------------------------------------------
// background agent runner: model, errors
// ---------------------------------------------------------------------------

function mockClient(opts: { providers?: any; failPrompt?: string; emitError?: string; idleAfterMs?: number; agents?: any[]; cfgModel?: string; cfgProvider?: Record<string, unknown> }) {
  const calls: any[] = []
  const id = `ses_mock_${Math.random().toString(36).slice(2, 8)}`
  return {
    calls,
    id,
    client: {
      config: {
        providers: async () => ({ data: opts.providers ?? { providers: [{ id: "litellm", models: { "DeepSeek-V41-Flash": { id: "DeepSeek-V41-Flash" } } }] } }),
        get: async () => ({ data: { ...(opts.cfgModel ? { model: opts.cfgModel } : {}), ...(opts.cfgProvider ? { provider: opts.cfgProvider } : {}) } }),
      },
      app: { agents: async () => ({ data: opts.agents ?? [] }) },
      session: {
        create: async () => ({ data: { id } }),
        promptAsync: async (req: any) => {
          calls.push(req)
          if (opts.emitError) setTimeout(() => sessionSignals().error(id, opts.emitError!, "UnknownError"), 30)
          if (opts.idleAfterMs !== undefined) setTimeout(() => sessionSignals().idle(id), opts.idleAfterMs)
          return { data: undefined }
        },
        status: async () => ({ data: {} }),
        messages: async () => ({ data: [] }),
        abort: async () => ({}),
        delete: async () => ({}),
      },
    },
  }
}

describe("agent runner", () => {
  test("passes the model explicitly to prompt_async", async () => {
    const m = mockClient({ idleAfterMs: 20 })
    const res = await runAgentSession({
      client: m.client,
      agent: "docsmith-reviewer",
      title: "t",
      prompt: "p",
      model: { providerID: "litellm", modelID: "DeepSeek-V41-Flash" },
      timeoutMs: 10_000,
      keepSession: false,
      log: silentLogger,
    })
    expect(res.ok).toBe(true)
    expect(m.calls[0].body.model).toEqual({ providerID: "litellm", modelID: "DeepSeek-V41-Flash" })
    expect(m.calls[0].body.agent).toBe("docsmith-reviewer")
  })

  test("unknown model is a configuration error before any session is created", async () => {
    const m = mockClient({})
    const res = await runAgentSession({
      client: m.client,
      agent: "skillsmith-reviewer",
      title: "t",
      prompt: "p",
      model: { providerID: "litellm", modelID: "google/gemma-4-31b-it" },
      timeoutMs: 10_000,
      keepSession: false,
      log: silentLogger,
    })
    expect(res.ok).toBe(false)
    expect(res.configError).toBe(true)
    expect(m.calls).toHaveLength(0)
  })

  test("a session error ends the wait immediately (no timeout)", async () => {
    const m = mockClient({ providers: { providers: [] }, emitError: "ProviderModelNotFoundError: Model not found: litellm/google/gemma-4-31b-it" })
    const started = Date.now()
    const res = await runAgentSession({ client: m.client, agent: "skillsmith-reviewer", title: "t", prompt: "p", timeoutMs: 600_000, keepSession: false, log: silentLogger })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(res.ok).toBe(false)
    expect(res.configError).toBe(true)
    expect(isConfigError("rate limit exceeded")).toBe(false)
  })

  test("a model name without provider (router combo „Hermes“) is repaired before the session starts", async () => {
    const providers = { providers: [{ id: "9router", models: { Hermes: { id: "Hermes" } } }, { id: "litellm", models: { x: { id: "x" } } }], default: { litellm: "x" } }
    // no explicit model, the agent and opencode.json name „Hermes“ (opencode would fail with "Model not found: Hermes/.")
    const a = mockClient({ idleAfterMs: 20, providers, agents: [{ name: "smith-assistant", model: { providerID: "Hermes", modelID: "" } }], cfgModel: "Hermes" })
    expect((await runAgentSession({ client: a.client, agent: "smith-assistant", title: "t", prompt: "p", timeoutMs: 10_000, keepSession: false, log: silentLogger })).ok).toBe(true)
    expect(a.calls[0].body.model).toEqual({ providerID: "9router", modelID: "Hermes" })
    // reviewerModel "Hermes" (option without provider) → repaired, too
    const ctx = makeCtx({ reviewerModel: "Hermes" })
    expect(resolveModel(ctx, "skillsmith", "reviewer")).toEqual({ providerID: "", modelID: "Hermes" })
    const b = mockClient({ idleAfterMs: 20, providers })
    await runAgentSession({ client: b.client, agent: "skillsmith-reviewer", title: "t", prompt: "p", model: resolveModel(ctx, "skillsmith", "reviewer"), timeoutMs: 10_000, keepSession: false, log: silentLogger })
    expect(b.calls[0].body.model).toEqual({ providerID: "9router", modelID: "Hermes" })
    // nothing usable configured → opencode's default model, still explicit
    const c = mockClient({ idleAfterMs: 20, providers, agents: [{ name: "x", model: { providerID: "Nope", modelID: "" } }] })
    await runAgentSession({ client: c.client, agent: "x", title: "t", prompt: "p", timeoutMs: 10_000, keepSession: false, log: silentLogger })
    expect(c.calls[0].body.model).toEqual({ providerID: "litellm", modelID: "x" })
    expect(modelErrorHint("ProviderModelNotFoundError: Model not found: Hermes/.", { specs: ["9router/Hermes"], defaults: [] })).toContain("9router/Hermes")
    // the fallback is a provider from opencode.json, not one opencode enabled through an environment variable
    const envFirst = { providers: [{ id: "github-copilot", models: { g: { id: "g" } } }, { id: "9router", models: { Hermes: { id: "Hermes" } } }], default: { "github-copilot": "g", "9router": "Hermes" } }
    const d = mockClient({ idleAfterMs: 20, providers: envFirst, cfgProvider: { "9router": {} } })
    await runAgentSession({ client: d.client, agent: "x", title: "t", prompt: "p", timeoutMs: 10_000, keepSession: false, log: silentLogger })
    expect(d.calls[0].body.model).toEqual({ providerID: "9router", modelID: "Hermes" })
  })

  test("model resolution: smith option → reviewerModel → session → last model", () => {
    const ctx = makeCtx({ reviewerModel: "litellm/DeepSeek-V41-Flash", docsmith: { model: "litellm/other" } })
    expect(resolveModel(ctx, "docsmith", "reviewer")).toEqual({ providerID: "litellm", modelID: "other" })
    expect(resolveModel(ctx, "skillsmith", "reviewer")).toEqual({ providerID: "litellm", modelID: "DeepSeek-V41-Flash" })
    const plain = makeCtx()
    const msgs: Msg[] = [{ info: { id: "m1", role: "assistant", providerID: "litellm", modelID: "google/gemma-4-31b-it" }, parts: [] }]
    expect(resolveModel(plain, "skillsmith", "reviewer", msgs)).toEqual({ providerID: "litellm", modelID: "google/gemma-4-31b-it" })
    expect(resolveModel(plain, "skillsmith", "reviewer")).toBeUndefined()
  })
})

describe("queue: configuration errors never drop jobs", () => {
  test("config-error reschedules in 10 minutes, failures back off", async () => {
    const ctx = makeCtx()
    let outcome: any = { outcome: "config-error", error: "Model not found: x/y" }
    const queue = new ReviewQueue(ctx, async () => outcome)
    queue.start()
    queue.enqueue("ses_cfg", "threshold")
    await new Promise((r) => setTimeout(r, 100))
    let job = queue.pending()[0]
    expect(job.lastError).toContain("Model not found")
    expect(job.attempts).toBe(0)
    expect(Date.parse(job.notBefore!) - Date.now()).toBeGreaterThan(9 * 60_000)
    // force a retry now: a plain failure backs off and is kept
    outcome = { outcome: "failed", error: "boom" }
    writeJsonAtomic(join(queue.dir, "ses_cfg.json"), { ...job, notBefore: undefined })
    queue.pump()
    await new Promise((r) => setTimeout(r, 100))
    job = queue.pending()[0]
    expect(job.attempts).toBe(1)
    expect(job.notBefore).toBeTruthy()
    queue.stop()
  })
})

// ---------------------------------------------------------------------------
// review preparation and routing
// ---------------------------------------------------------------------------

let n = 0
const user = (text: string): Msg => ({ info: { id: `msg_${String(++n).padStart(4, "0")}`, sessionID: "ses_r", role: "user", agent: "build" }, parts: [{ type: "text", text }] })
const assistant = (parts: Msg["parts"]): Msg => ({ info: { id: `msg_${String(++n).padStart(4, "0")}`, sessionID: "ses_r", role: "assistant", time: { created: 1, completed: 2 } }, parts })
const bash = (command: string, exit: number, output: string) => ({ type: "tool", tool: "bash", callID: `c${++n}`, state: { status: "completed", input: { command }, output, metadata: { exit } } })

describe("review preparation", () => {
  test("signals and routing to the smiths", async () => {
    const ctx = makeCtx()
    const msgs = [
      user("Bau das Projekt. Das ZKB (Zentrales Kundenbuch) liefert die Daten, das XKB kenne ich nicht."),
      assistant([
        bash("mvn -q package", 1, "[ERROR] PKIX path building failed"),
        bash("keytool -importcert -file corp.pem", 0, "ok"),
        bash("mvn -q package", 0, "BUILD SUCCESS"),
        { type: "text", text: "Fertig." },
      ]),
      user("Das mache ich jede Woche, kannst du das automatisieren?"),
      assistant([bash("cat a.csv | cut -d';' -f2 | sort | uniq -c", 0, "3 x"), { type: "text", text: "ok" }]),
    ]
    const t = buildTranscript(msgs, { maxChars: 10000, redact: (s) => s })
    const prep = await prepare(ctx, t, "ses_r")
    expect(prep.chains).toHaveLength(1)
    expect(prep.chains[0].resolved).toBe(true)
    expect(prep.abbreviations.map((a) => a.term).sort()).toEqual(["XKB", "ZKB"])
    expect(prep.automation.userRequested).toBe(true)
    expect(route(ctx, prep)).toEqual(["skillsmith", "docsmith", "errorsmith", "toolsmith", "memorysmith"])
    ctx.options.toolsmith.enabled = false
    ctx.options.memorysmith.enabled = false
    expect(route(ctx, prep)).toEqual(["skillsmith", "docsmith", "errorsmith"])
  })
})

// ---------------------------------------------------------------------------
// curator per kind
// ---------------------------------------------------------------------------

describe("curator", () => {
  const age = (ctx: ReturnType<typeof makeCtx>, kind: string, name: string, days: number) => {
    const file = join(ctx.store.metaDir, kind, `${name}.json`)
    const meta = readJson<any>(file, {})
    meta.createdAt = meta.updatedAt = meta.tierChangedAt = new Date(Date.now() - days * 86_400_000).toISOString()
    writeJsonAtomic(file, meta)
    ctx.store.bump()
  }

  test("lifecycle per kind with own thresholds; knowledge never moves; one commit per smith", async () => {
    const ctx = makeCtx()
    await ctx.git.init()
    const cmd = cmdRun(ctx)
    await ctx.ops.create(cmd, "skill", { name: "old-skill", description: "Old skill", body: BODY })
    await ctx.ops.create(cmdRun(ctx, "errorsmith"), "error", { name: "old-error", title: "PKIX", description: "PKIX error", body: ERROR_BODY, fields: { status: "solved" } })
    await ctx.ops.create(cmdRun(ctx, "docsmith"), "knowledge", { name: "old-doc", title: "Old", description: "Old doc", body: "## A\n- fact" })
    await ctx.git.commitRun(cmd)
    for (const [k, nme] of [["skill", "old-skill"], ["error", "old-error"], ["knowledge", "old-doc"]]) age(ctx, k, nme, 30)
    const curator = new Curator(ctx)
    // skills: stale after 14 days; errors only after 90
    expect(curator.planLifecycle().map((m) => `${m.target}:${m.name}:${m.to}`)).toEqual(["skill:old-skill:dormant"])
    age(ctx, "error", "old-error", 100)
    expect(curator.planLifecycle().map((m) => `${m.target}:${m.name}:${m.to}`)).toEqual(["skill:old-skill:dormant", "error:old-error:dormant"])
    const res = await curator.lifecycle("test", true)
    expect(res.commits).toHaveLength(2)
    expect(ctx.store.getOwned("error", "old-error")?.tier).toBe("dormant")
    expect(ctx.store.getOwned("knowledge", "old-doc")?.tier).toBe("active")
  })

  test("duplicate glossary terms are merged deterministically", async () => {
    const ctx = makeCtx()
    const cmd = cmdRun(ctx, "docsmith")
    await ctx.ops.glossaryUpsert(cmd, { term: "ZKB", meanings: [{ expansion: "Zentrales Kundenbuch", description: "Stammdaten" }] })
    // a second file for the same term (e.g. manual edit / concurrent processes)
    const file = join(ctx.store.tierDir("glossary", "active"), "zkb-2.md")
    writeFileSync(file, '---\nname: zkb-2\nterm: "zkb"\nmeanings: [{"expansion":"Zürcher Kantonalbank","description":"Bank","context":"Zahlungsverkehr"}]\n---\n')
    ctx.store.bump()
    const curator = new Curator(ctx)
    expect(curator.planGlossaryMerges().map((g) => g.map((e) => e.name))).toEqual([["zkb", "zkb-2"]])
    await curator.lifecycle("test", true)
    const e = ctx.store.glossaryByTerm("ZKB").find((x) => x.tier === "active")!
    expect((e.fields.meanings as any[]).map((m) => m.expansion)).toEqual(["Zentrales Kundenbuch", "Zürcher Kantonalbank"])
    expect(ctx.store.getOwned("glossary", "zkb-2")?.tier).toBe("archive")
  })
})

// ---------------------------------------------------------------------------
// tools + commands
// ---------------------------------------------------------------------------

describe("read tools", () => {
  test("glossary_lookup, knowledge_read, error_lookup, script_search", async () => {
    const ctx = makeCtx()
    await ctx.ops.glossaryUpsert(cmdRun(ctx, "docsmith"), { term: "KWG", meanings: [{ expansion: "Kreditwesengesetz", description: "Gesetz über das Kreditwesen" }] })
    await ctx.ops.create(cmdRun(ctx, "docsmith"), "knowledge", { name: "billing-api", title: "billing-api", description: "Billing API Port und Tabellen", tags: ["billing"], body: "## Überblick\n- Port 8443" })
    await ctx.ops.create(cmdRun(ctx, "errorsmith"), "error", { name: "maven-pkix", title: "PKIX path building failed", description: "Maven PKIX Fehler", body: ERROR_BODY, fields: { status: "solved" } })
    const tools = createTools(ctx, null)
    const tc = { sessionID: "ses_main" }
    expect(await tools.glossary_lookup.execute({ query: "kwg" }, tc)).toContain("Kreditwesengesetz: Gesetz über das Kreditwesen")
    expect(await tools.glossary_lookup.execute({ query: "Kreditwesen" }, tc)).toContain("KWG")
    expect(await tools.glossary_lookup.execute({ query: "ABC" }, tc)).toContain("No glossary entry")
    expect(await tools.knowledge_search.execute({ query: "billing port" }, tc)).toContain("billing-api")
    expect(await tools.knowledge_read.execute({ name: "billing-api" }, tc)).toContain("Port 8443")
    expect(ctx.usage.get("knowledge", "billing-api").loads).toBe(1)
    const err = await tools.error_lookup.execute({ query: "PKIX path building failed maven" }, tc)
    expect(err).toContain("maven-pkix")
    expect(err).toContain("keytool")
    expect(await tools.script_search.execute({ query: "csv" }, tc)).toContain("No Skripte")
    // write tools refuse outside background runs and across smiths
    expect(await tools.docsmith_glossary_upsert.execute({ term: "X", expansion: "y", description: "z" }, tc)).toContain("only available")
    const run = makeRun(ctx, "reviewer", { smith: "errorsmith" })
    ctx.runs.attach(run, "ses_agent")
    expect(await tools.docsmith_glossary_upsert.execute({ term: "X", expansion: "y", description: "z" }, { sessionID: "ses_agent" })).toContain("belongs to docsmith")
  })
})

describe("commands", () => {
  test("glossary-add, import (csv + markdown), export, open, ignore", async () => {
    const ctx = makeCtx()
    const deps = { queue: {} as any, curator: new Curator(ctx) }
    expect(await handleCommand(ctx, deps, "glossary-add", "SEPA | Single Euro Payments Area | Einheitlicher Euro-Zahlungsverkehrsraum | Zahlungsverkehr", "ses")).toContain("added glossary SEPA")
    expect(await handleCommand(ctx, deps, "glossary-add", "nur zwei | teile", "ses")).toContain("Format")
    const dir = tmp()
    writeFileSync(join(dir, "g.csv"), 'Abkürzung;Bedeutung;Beschreibung;Kontext\nKWG;Kreditwesengesetz;"Gesetz; über das Kreditwesen";Recht\nZKB;Zentrales Kundenbuch;Stammdaten;\n')
    writeFileSync(join(dir, "g.md"), "| Abk | Bedeutung | Beschreibung |\n|---|---|---|\n| BaFin | Bundesanstalt für Finanzdienstleistungsaufsicht | Aufsicht |\n")
    expect(await handleCommand(ctx, deps, "glossary-import", join(dir, "g.csv"), "ses")).toContain("2 Bedeutung(en) importiert")
    expect(await handleCommand(ctx, deps, "glossary-import", join(dir, "g.md"), "ses")).toContain("1 Bedeutung(en) importiert")
    expect(await handleCommand(ctx, deps, "glossary", "KWG", "ses")).toContain("Gesetz; über das Kreditwesen")
    const list = await handleCommand(ctx, deps, "glossary", "", "ses")
    expect(list).toContain("Glossar (4)")
    const out = join(dir, "export.md")
    expect(await handleCommand(ctx, deps, "glossary-export", out, "ses")).toContain("4 Begriffe exportiert")
    expect(readFileSync(out, "utf8")).toContain("| KWG | Kreditwesengesetz | Gesetz; über das Kreditwesen | Recht |")
    // open + ignore
    const run = makeRun(ctx, "reviewer", { smith: "docsmith" })
    await ctx.ops.note(run, "glossary", { summary: "XKB: Bedeutung offen", keywords: ["XKB"], fixedId: "abbr-xkb", internal: true })
    expect(await handleCommand(ctx, deps, "glossary-open", "", "ses")).toContain("XKB")
    expect(await handleCommand(ctx, deps, "glossary-ignore", "XKB", "ses")).toContain("ignored: XKB")
    expect(await handleCommand(ctx, deps, "glossary-open", "", "ses")).toContain("Keine offenen")
    expect(ctx.store.ignoredTerms()).toEqual(["XKB"])
  })

  test("parsers", () => {
    expect(parseCsv('a,b\n"x, y",z\n')).toEqual([["a", "b"], ["x, y", "z"]])
    expect(parseMarkdownTable("| A | B \\| C |\n|---|---|\n| 1 | 2 |")).toEqual([["A", "B | C"], ["1", "2"]])
    expect(glossaryRows([["ABK", "Langform"]]).length).toBe(0) // header only
    expect(glossaryRows([["KWG", "Kreditwesengesetz"]])).toEqual([{ term: "KWG", meaning: { expansion: "Kreditwesengesetz", description: "Kreditwesengesetz" } }])
  })

  test("smith-list / pin with kind resolution / tags / report", async () => {
    const ctx = makeCtx()
    const deps = { queue: { pending: () => [], runningCount: () => 0 } as any, curator: new Curator(ctx) }
    await ctx.ops.create(cmdRun(ctx), "skill", { name: "kafka-offset-reset", description: "Reset Kafka offsets", tags: ["kafka"], body: BODY })
    await ctx.ops.create(cmdRun(ctx, "errorsmith"), "error", { name: "maven-pkix", title: "PKIX", description: "Maven PKIX", tags: ["maven"], body: ERROR_BODY, fields: { status: "solved" } })
    expect(await handleCommand(ctx, deps, "smith-list", "fehler", "ses")).toContain("maven-pkix")
    expect(await handleCommand(ctx, deps, "smith-pin", "maven-pkix", "ses")).toContain("pinned")
    expect(ctx.store.getOwned("error", "maven-pkix")?.meta?.pinned).toBe(true)
    expect(await handleCommand(ctx, deps, "smith-tags", "", "ses")).toContain("kafka (1)")
    const report = await handleCommand(ctx, deps, "smith-report", "", "ses")
    expect(report).toContain("Fehler: 1 gelöst")
    expect(report).toContain("Skills: 1 aktiv")
  })
})
