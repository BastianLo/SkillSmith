import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { commitMessage } from "../../src/core/git"
import { parseDoc, serializeDoc } from "../../src/core/frontmatter"
import { spec } from "../../src/core/kinds"
import {
  automationSignals,
  codeChanges,
  commandHead,
  detectAbbreviations,
  errorSignature,
  extractChains,
  isAbbreviation,
  normalizeError,
  scanRepoDocs,
} from "../../src/core/signals"
import { Store } from "../../src/core/store"
import type { ToolCall } from "../../src/core/transcript"
import { silentLogger } from "../../src/log"
import { writeJsonAtomic } from "../../src/util/fs"
import { cmdRun, ERROR_BODY, makeCtx, makeRun, tmp } from "./helpers"

const call = (turn: number, command: string, ok: boolean, error?: string, extra: Partial<ToolCall> = {}): ToolCall => ({
  label: `A${turn + 1}`,
  turn,
  tool: "bash",
  input: { command },
  summary: command,
  ok,
  exit: ok ? 0 : 1,
  error,
  output: "",
  ...extra,
})

describe("frontmatter + kinds", () => {
  test("round-trips every kind", () => {
    for (const kind of ["skill", "knowledge", "glossary", "error", "script"] as const) {
      const s = spec(kind)
      const content = {
        name: "some-name",
        title: kind === "glossary" ? "KWG" : "A title: with colon",
        description: 'Desc with "quotes" and: colon',
        tags: ["db2", "maven"],
        fields:
          kind === "glossary"
            ? { term: "KWG", aliases: ["K.W.G."], meanings: [{ expansion: "Kreditwesengesetz", description: "Gesetz über das Kreditwesen", context: "Recht" }] }
            : kind === "error"
              ? { status: "solved", signatures: ["mvn: PKIX path building failed"], context: ["mvn"] }
              : kind === "script"
                ? { usage: "python3 x.py IN", entry: "some_name.py", capabilities: ["filesystem-write"], requirements: [], python: "3.9" }
                : {},
        body: "## A\ntext\n\n## B\n- item",
      }
      const parsed = s.parse(s.serialize(content), "fallback")
      expect(parsed.name).toBe("some-name")
      expect(parsed.tags).toEqual(["db2", "maven"])
      expect(parsed.body).toBe(content.body)
      if (kind === "glossary") {
        expect(parsed.fields.meanings).toEqual(content.fields.meanings as any)
        expect(parsed.description).toBe("Kreditwesengesetz")
      } else {
        expect(parsed.description).toBe(content.description)
      }
      if (kind === "error") expect(parsed.fields.signatures).toEqual(["mvn: PKIX path building failed"])
      if (kind === "script") expect(parsed.fields.capabilities).toEqual(["filesystem-write"])
    }
  })

  test("reads hand-written YAML (block lists, quotes)", () => {
    const { fm, body } = parseDoc("---\nname: x\ntags:\n  - db2\n  - 'sql'\ntitle: 'It''s'\n---\nbody")
    expect(fm.tags).toEqual(["db2", "sql"])
    expect(fm.title).toBe("It's")
    expect(body).toBe("body")
    expect(serializeDoc([["name", "x"], ["empty", []], ["n", 3]], "b")).toBe("---\nname: x\nn: 3\n---\n\nb\n")
  })
})

describe("metadata: tags", () => {
  test("entries without tags get derived keywords; glossary uses contexts", async () => {
    const ctx = makeCtx({ recurrenceMinSessions: 1 })
    const msg = await ctx.ops.create(cmdRun(ctx), "skill", { name: "kafka-offset-reset", description: "Reset Kafka offsets", body: "## Steps\n1. x" })
    expect(msg).toContain("derived: kafka, offset, reset")
    expect(ctx.store.getOwned("skill", "kafka-offset-reset")?.tags).toEqual(["kafka", "offset", "reset"])
    await ctx.ops.glossaryUpsert(cmdRun(ctx, "docsmith"), { term: "SEPA", meanings: [{ expansion: "Single Euro Payments Area", description: "Euro-Zahlungsraum", context: "Zahlungsverkehr" }] })
    expect(ctx.store.glossaryByTerm("SEPA")[0].tags).toEqual(["zahlungsverkehr"])
    expect(ctx.index.search("x", { kinds: ["skill"], tags: ["kafka"] })).toHaveLength(0)
    expect((await createToolsSearch(ctx)).includes("kafka-offset-reset")).toBe(true)
  })
})

async function createToolsSearch(ctx: ReturnType<typeof makeCtx>): Promise<string> {
  const { createTools } = await import("../../src/host/tools")
  return createTools(ctx, null).skill_search.execute({ query: "", tags: ["kafka"] }, { sessionID: "s" })
}

describe("store v2 + migration", () => {
  test("v1 layout is migrated through a run", async () => {
    const root = join(tmp(), "store")
    mkdirSync(join(root, "meta"), { recursive: true })
    mkdirSync(join(root, "candidates"), { recursive: true })
    mkdirSync(join(root, "skills", "active", "old-skill"), { recursive: true })
    writeFileSync(join(root, "skills", "active", "old-skill", "SKILL.md"), '---\nname: old-skill\ndescription: "Old"\n---\n\n## Steps\n1. x\n')
    writeJsonAtomic(join(root, "meta", "old-skill.json"), { name: "old-skill", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", tierChangedAt: "2026-01-01T00:00:00Z", createdBy: "reviewer", history: [] })
    writeJsonAtomic(join(root, "candidates", "cand-1.json"), { id: "cand-1", summary: "x", keywords: [], sessions: ["a"], count: 1, createdAt: "x", updatedAt: "x" })
    const store = new Store(root, silentLogger)
    store.init()
    expect(store.storeVersion()).toBe(1)
    const ctx = makeCtx({ storeDir: root })
    const run = cmdRun(ctx)
    expect(await ctx.store.migrate(run)).toBe(2)
    expect(ctx.store.storeVersion()).toBe(2)
    expect(ctx.store.readMeta("skill", "old-skill")?.kind).toBe("skill")
    expect(ctx.store.candidate("skill", "cand-1")?.kind).toBe("skill")
    expect([...run.touched]).toContain("meta/old-skill.json")
    expect([...run.touched]).toContain("meta/skill/old-skill.json")
  })

  test("fresh store starts at v2", () => {
    const ctx = makeCtx()
    expect(ctx.store.storeVersion()).toBe(2)
  })
})

describe("docsmith: knowledge + glossary", () => {
  const KBODY = "## Überblick\n- Der Service `billing-api` läuft auf Port 8443.\n- Er liest die Tabelle `BILLING.INVOICE`."

  test("knowledge needs verbatim evidence", async () => {
    const ctx = makeCtx()
    const run = makeRun(ctx, "reviewer", { smith: "docsmith", haystack: "INFO billing-api started on port 8443 (https)", userText: "wo läuft billing?" })
    const base = { name: "billing-api", title: "billing-api Service", description: "Billing API: Port, Tabellen", tags: ["billing", "service"], body: KBODY }
    await expect(ctx.ops.create(run, "knowledge", base)).rejects.toThrow(/evidence/)
    await expect(ctx.ops.create(run, "knowledge", { ...base, evidence: "billing-api runs on port 9999" })).rejects.toThrow(/not found verbatim/)
    expect(await ctx.ops.create(run, "knowledge", { ...base, evidence: "billing-api started on port 8443" })).toContain("created")
    const rec = ctx.store.getOwned("knowledge", "billing-api")!
    expect(rec.file).toContain("knowledge/active/billing-api.md")
    expect(rec.meta?.evidence?.[0].text).toContain("8443")
    expect(rec.meta?.verifiedAt).toBeTruthy()
    // tag-only update without evidence is fine, content changes need evidence
    const r2 = makeRun(ctx, "reviewer", { smith: "docsmith", haystack: "", limits: { maxNew: 0, maxChanges: 5, maxNotes: 0 } })
    expect(await ctx.ops.update(r2, "knowledge", { name: "billing-api", tags: ["billing", "service", "https"] })).toContain("updated")
    await expect(ctx.ops.update(r2, "knowledge", { name: "billing-api", body: KBODY + "\n- neu" })).rejects.toThrow(/evidence/)
    expect(ctx.index.search("billing port", { kinds: ["knowledge"] })[0].name).toBe("billing-api")
  })

  test("glossary upsert: stated meanings only, merge, restore, candidates", async () => {
    const ctx = makeCtx()
    const hay = "Laut KWG (Kreditwesengesetz) müssen wir melden. Die MaRisk gelten auch."
    const run = makeRun(ctx, "reviewer", { smith: "docsmith", userText: hay, haystack: hay, limits: { maxNew: 3, maxChanges: 10, maxNotes: 5 } })
    // candidate first (deterministic note), then upsert promotes it
    await ctx.ops.note(run, "glossary", { summary: "KWG: Bedeutung offen", keywords: ["KWG"], fixedId: "abbr-kwg", internal: true })
    await expect(
      ctx.ops.glossaryUpsert(run, { term: "MaRisk", meanings: [{ expansion: "Mindestanforderungen an das Risikomanagement", description: "BaFin-Rundschreiben" }] }),
    ).rejects.toThrow(/not stated/)
    await expect(ctx.ops.glossaryUpsert(run, { term: "XYZ", meanings: [{ expansion: "Kreditwesengesetz", description: "x" }] })).rejects.toThrow(/does not occur/)
    expect(await ctx.ops.glossaryUpsert(run, { term: "KWG", meanings: [{ expansion: "Kreditwesengesetz", description: "Gesetz über das Kreditwesen", context: "Recht" }] })).toContain("added")
    expect(ctx.store.candidate("glossary", "abbr-kwg")?.promotedTo).toBe("kwg")
    expect(await ctx.ops.glossaryUpsert(run, { term: "kwg", meanings: [{ expansion: "Kreditwesengesetz", description: "Gesetz über das Kreditwesen", context: "Recht" }] })).toContain("unchanged")
    // second meaning via command (no transcript needed)
    const cmd = cmdRun(ctx, "docsmith")
    await ctx.ops.glossaryUpsert(cmd, { term: "KWG", meanings: [{ expansion: "Kraft-Wärme-Gekoppelt", description: "Energietechnik", context: "Facility" }] })
    const e = ctx.store.glossaryByTerm("KWG")[0]
    expect((e.fields.meanings as any[]).map((m) => m.expansion)).toEqual(["Kreditwesengesetz", "Kraft-Wärme-Gekoppelt"])
    expect(e.description).toBe("Kreditwesengesetz / Kraft-Wärme-Gekoppelt")
    // archived entries come back on upsert
    await ctx.ops.move(cmd, "glossary", { name: e.name, to: "archive", kind: "archive", approved: true })
    expect(ctx.store.getOwned("glossary", e.name)?.tier).toBe("archive")
    await ctx.ops.glossaryUpsert(cmd, { term: "KWG", meanings: [{ expansion: "Kreditwesengesetz", description: "Gesetz über das Kreditwesen", context: "Recht" }] })
    expect(ctx.store.getOwned("glossary", e.name)?.tier).toBe("active")
    // full-text search finds by expansion and description
    expect(ctx.index.search("Kreditwesen", { kinds: ["glossary"] })[0].name).toBe("kwg")
    expect(readFileSync(e.file, "utf8")).toContain('term: KWG'.replace("term: KWG", 'term: "KWG"'))
  })

  test("abbreviation detection with definitions", () => {
    const found = detectAbbreviations({
      userTexts: ["Bitte prüfe die SEPA-Datei für das KWG Reporting. Das ZKB (Zentrales Kundenbuch) ist führend.", "Die HTTP API ist ok, siehe `FOO_BAR`."],
      assistantText: "Die Mindestanforderungen an das Risikomanagement (MaRisk) gelten. RTF steht für Risikotragfähigkeit.",
      isKnown: (t) => t === "KWG",
      ignore: [],
      redact: (s) => s,
    })
    const byTerm = Object.fromEntries(found.map((f) => [f.term, f]))
    expect(byTerm.ZKB.definition?.expansion).toBe("Zentrales Kundenbuch")
    expect(byTerm.MaRisk.definition?.expansion).toBe("Mindestanforderungen an das Risikomanagement")
    expect(byTerm.RTF.definition?.expansion).toBe("Risikotragfähigkeit")
    expect(byTerm.KWG.known).toBe(true)
    expect(byTerm.HTTP).toBeUndefined()
    expect(byTerm.API).toBeUndefined()
    expect(byTerm.FOO_BAR).toBeUndefined()
    expect(isAbbreviation("Hallo")).toBe(false)
    expect(isAbbreviation("DB2")).toBe(true)
  })

  test("code changes and repo docs", () => {
    const changes = codeChanges(
      [
        call(0, "", true, undefined, { tool: "edit", input: { filePath: "/p/src/config.ts", oldString: "const BILLING_PORT = 8443", newString: "const BILLING_PORT = 9443" } }),
        call(0, "", true, undefined, { tool: "edit", input: { filePath: "/p/src/client.ts", oldString: "fetchInvoices(customerId)", newString: "loadInvoices(customerId)" } }),
      ],
      (s) => s,
      5000,
    )
    expect(changes.files).toEqual(["/p/src/config.ts", "/p/src/client.ts"])
    expect(changes.identifiers).toContain("fetchInvoices")
    expect(changes.text).toContain("- const BILLING_PORT = 8443")
    const repo = tmp()
    mkdirSync(join(repo, "docs"), { recursive: true })
    mkdirSync(join(repo, "node_modules", "x"), { recursive: true })
    writeFileSync(join(repo, "README.md"), "# App\n\nCall `fetchInvoices(id)` to get invoices.\n")
    writeFileSync(join(repo, "node_modules", "x", "README.md"), "fetchInvoices also here")
    writeFileSync(join(repo, "docs", "other.md"), "nothing relevant")
    const docs = scanRepoDocs(repo, changes.identifiers, 2000)
    expect(docs).toHaveLength(1)
    expect(docs[0].file).toBe("README.md")
    expect(docs[0].text).toContain("fetchInvoices")
  })
})

describe("errorsmith", () => {
  test("signatures normalise volatile parts", () => {
    const a = normalizeError("exit 1: [ERROR] Failed to execute goal on project app: Could not resolve /Users/max/.m2/repository/x.jar (line 42) at 2026-10-09T10:11:12Z")
    const b = normalizeError("exit 1: [ERROR] Failed to execute goal on project app: Could not resolve /home/ci/.m2/repository/y.jar (line 7) at 2026-10-10T08:00:00Z")
    expect(a).toBe(b)
    expect(a).toContain("<path>")
    expect(normalizeError("ORA-00942: table or view does not exist")).toContain("ORA-00942")
    expect(normalizeError("Traceback (most recent call last):\n  File x\nKeyError: 'customer_id'")).toBe("KeyError: 'customer_id'")
    expect(commandHead("cd app && JAVA_HOME=/x sudo mvn -q package")).toBe("mvn")
    expect(errorSignature("bash", "mvn package", "exit 1: boom").signature.startsWith("mvn: ")).toBe(true)
  })

  test("chains: resolved by a later successful call of the same command head", () => {
    const calls = [
      call(0, "mvn -q package", false, "exit 1: PKIX path building failed"),
      call(0, "keytool -importcert -file corp.pem", true),
      call(0, "mvn -q package", true),
      call(1, "grep foo bar.txt", false, "exit 1: "),
      call(1, "psql -c 'select 1'", false, "exit 2: connection refused"),
    ]
    const chains = extractChains(calls, ["build it", "now the db"], () => 1)
    expect(chains).toHaveLength(2) // grep exit 1 ignored
    expect(chains[0].resolved).toBe(true)
    expect(chains[0].resolution).toContain("mvn -q package")
    expect(chains[0].attempts[0]).toContain("keytool")
    expect(chains[1].resolved).toBe(false)
  })

  test("error gate: chain required, solved needs resolution, open needs sessions", async () => {
    const ctx = makeCtx()
    const calls = [call(0, "mvn -q package", false, "exit 1: PKIX path building failed"), call(0, "mvn -q package -Dmaven.wagon.http.ssl.insecure=true", true)]
    const chains = extractChains(calls, ["build"], () => 1)
    const run = makeRun(ctx, "reviewer", { smith: "errorsmith", chains, userText: "build", limits: { maxNew: 2, maxChanges: 4, maxNotes: 5 } })
    const base = { name: "maven-pkix-path", title: "PKIX path building failed", description: "Maven: PKIX path building failed – Root-CA fehlt", tags: ["maven", "ssl"], body: ERROR_BODY }
    await expect(ctx.ops.create(run, "error", { ...base, fields: { status: "solved" } })).rejects.toThrow(/chain_id/)
    expect(await ctx.ops.create(run, "error", { ...base, fields: { status: "solved" }, chainId: "E1" })).toContain("created")
    const rec = ctx.store.getOwned("error", "maven-pkix-path")!
    expect(rec.fields.signatures).toEqual([chains[0].signature])
    expect(rec.fields.context).toEqual(["mvn"])
    // unresolved chain → open needs ≥2 sessions
    const open = extractChains([call(0, "db2 connect to PROD", false, "exit 4: SQL30081N communication error")], ["x"], () => 1)
    const r2 = makeRun(ctx, "reviewer", { smith: "errorsmith", chains: open, limits: { maxNew: 2, maxChanges: 4, maxNotes: 5 } })
    const openBody = "## Symptom\nSQL30081N\n\n## Bisherige Versuche\n- reconnect\n\n## Vermutung\nFirewall"
    await expect(
      ctx.ops.create(r2, "error", { name: "db2-sql30081n", title: "SQL30081N", description: "DB2 Kommunikationsfehler", body: openBody, fields: { status: "solved" }, chainId: "E1" }),
    ).rejects.toThrow(/not resolved/)
    await expect(
      ctx.ops.create(r2, "error", { name: "db2-sql30081n", title: "SQL30081N", description: "DB2 Kommunikationsfehler", body: openBody, fields: { status: "open" }, chainId: "E1" }),
    ).rejects.toThrow(/1 session/)
    open[0].sessions = 2
    expect(
      await ctx.ops.create(r2, "error", { name: "db2-sql30081n", title: "SQL30081N", description: "DB2 Kommunikationsfehler", body: openBody, fields: { status: "open" }, chainId: "E1" }),
    ).toContain("created")
    // validation: solved without "## Lösung"
    const r3 = makeRun(ctx, "reviewer", { smith: "errorsmith", chains, limits: { maxNew: 2, maxChanges: 4, maxNotes: 5 } })
    await expect(ctx.ops.create(r3, "error", { ...base, name: "other", body: "## Symptom\nx", fields: { status: "solved" }, chainId: "E1" })).rejects.toThrow(/Lösung/)
  })

  test("live known-error hint is appended and its outcome recorded", async () => {
    const ctx = makeCtx()
    const sig = errorSignature("bash", "mvn -q package", "exit 1: [ERROR] PKIX path building failed: unable to find valid certification path")
    await ctx.ops.create(cmdRun(ctx, "errorsmith"), "error", {
      name: "maven-pkix-path",
      title: "PKIX path building failed",
      description: "Maven PKIX path building failed – Root-CA fehlt im Truststore",
      tags: ["maven"],
      body: ERROR_BODY,
      fields: { status: "solved", signatures: [sig.signature] },
    })
    const out = { output: "[INFO] building\n[ERROR] PKIX path building failed: unable to find valid certification path", metadata: { exit: 1 } }
    const text = await ctx.hints.onToolResult("ses_live", "bash", { command: "mvn -q package" }, out)
    expect(text).toContain('<known_error source="errorsmith" name="maven-pkix-path"')
    expect(text).toContain("keytool -importcert")
    // a second identical failure shortly after is not hinted again, but recorded
    expect(await ctx.hints.onToolResult("ses_live", "bash", { command: "mvn -q package" }, out)).toBeUndefined()
    // next call of the same command succeeds → helped
    await ctx.hints.onToolResult("ses_live", "bash", { command: "mvn -q package" }, { output: "ok", metadata: { exit: 0 } })
    const u = ctx.usage.get("error", "maven-pkix-path")
    expect(u.helped).toBe(1)
    expect(u.failed).toBe(1)
    expect(u.hintsShown).toBe(1)
    expect(ctx.occurrences.get(sig.sigKey)?.count).toBe(2)
    expect(ctx.occurrences.get(sig.sigKey)?.entry).toBe("maven-pkix-path")
    // fuzzy match via full-text search when the signature differs
    const fuzzy = await ctx.hints.onToolResult("ses_other", "bash", { command: "./mvnw clean install" }, {
      output: "PKIX path building failed: unable to find valid certification path to requested target",
      metadata: { exit: 1 },
    })
    expect(fuzzy).toContain("maven-pkix-path")
  })
})

describe("toolsmith signals", () => {
  test("automation score", () => {
    const calls = [
      call(0, "cat a.csv | cut -d; -f2 | sort | uniq -c", true),
      call(0, "python3 -c 'import csv; print(1)'", true),
      call(0, "jq '.items[]' out.json | wc -l", true),
    ]
    const a = automationSignals(calls, "Das mache ich jede Woche, kannst du das automatisieren?")
    expect(a.userRequested).toBe(true)
    expect(a.score).toBeGreaterThanOrEqual(6)
    expect(automationSignals([call(0, "ls", true)], "hallo").score).toBe(0)
  })
})

describe("git: smith subjects", () => {
  test("commit subject carries the smith and the kind", () => {
    const ctx = makeCtx()
    const run = makeRun(ctx, "reviewer", { smith: "docsmith" })
    run.actions = [
      { kind: "upsert", target: "glossary", name: "kwg", applied: true },
      { kind: "create", target: "knowledge", name: "billing-api", applied: true, reason: "facts" },
      { kind: "note", target: "glossary", name: "abbr-zkb", applied: true },
    ]
    const m = commitMessage(run)
    expect(m.split("\n")[0]).toBe("docsmith(reviewer): create knowledge billing-api (+2 more)")
    expect(m).toContain("- create knowledge billing-api: facts")
    expect(m).toContain("- upsert glossary kwg")
  })

  test("undo finds commits of every smith", async () => {
    const ctx = makeCtx()
    await ctx.git.init()
    const run = cmdRun(ctx, "docsmith")
    await ctx.ops.glossaryUpsert(run, { term: "ZKB", meanings: [{ expansion: "Zentrales Kundenbuch", description: "Stammdatensystem" }] })
    await ctx.git.commitRun(run)
    const found = await ctx.git.findRunCommit()
    expect(found?.runId).toBe(run.id)
    expect(found?.subject).toBe("docsmith(command): upsert glossary zkb")
    const files = execFileSync("git", ["-C", ctx.store.root, "show", "--name-only", "--format=", "HEAD"], { encoding: "utf8" }).trim().split("\n").sort()
    expect(files).toEqual(["glossary/active/zkb.md", "meta/glossary/zkb.json"])
  })
})
