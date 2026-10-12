/**
 * Ideas 6–10: semantic curator clusters, project docs RAG (docs_search),
 * contradiction check for knowledge, tag vocabulary, similar earlier sessions.
 * Every feature is tested with the fake embedding endpoint AND without it (BM25 fallback).
 */
import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { MiniIndex, rrf } from "../../src/core/bm25"
import { Curator } from "../../src/core/curator"
import { chunkMarkdown, safeDocsRoot } from "../../src/core/project-docs"
import { tagVariant } from "../../src/core/retrieval"
import { prepare, reviewSession } from "../../src/core/reviewer"
import { formatRecord, historyText, isUseful } from "../../src/core/session-history"
import { buildTranscript, type Msg } from "../../src/core/transcript"
import { handleCommand } from "../../src/host/commands"
import { createTools } from "../../src/host/tools"
import type { ErrorChain } from "../../src/types"
import { BODY, cmdRun, ERROR_BODY, fakeFetch, makeCtx, makeRun } from "./helpers"

const cmd = (ctx: ReturnType<typeof makeCtx>, name: string, args = "", sid = "ses_cmd") => handleCommand(ctx, {} as any, name, args, sid)

function writeDocs(root: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel)
    mkdirSync(join(p, ".."), { recursive: true })
    writeFileSync(p, content)
  }
}

const DEPLOY_MD = `# Betrieb

Dieses Dokument beschreibt den Betrieb des Billing-Service im Team.

## Deployment
The service is deployed with make deploy ENV=prod after the tests passed.

\`\`\`bash
# not a heading
make deploy ENV=prod
\`\`\`

### Rollback
Use make rollback to return to the previous release when something goes wrong.
`

// ---------------------------------------------------------------------------
// building blocks
// ---------------------------------------------------------------------------

describe("BM25 mini index + RRF", () => {
  test("ranks by terms, prefix expansion, fusion respects the similarity floor", () => {
    const idx = new MiniIndex([
      { id: "a", fields: [[2, "Kafka offsets"], [1, "reset consumer group offsets to earliest"]] },
      { id: "b", fields: [[1, "maven build fails with pkix"]] },
    ])
    expect(idx.search("kafka offset reset")[0]).toMatchObject({ id: "a", coverage: 1 })
    expect(idx.search("consum")[0]?.id).toBe("a")
    expect(idx.search("völlig anderes thema")).toHaveLength(0)
    const fused = rrf([{ id: "a" }], [{ id: "b", similarity: 0.3 }, { id: "c", similarity: 0.8 }, { id: "a", similarity: 0.9 }], 0.5)
    expect(fused.map((f) => f.id)).toEqual(["a", "c"])
    expect(fused[0].similarity).toBe(0.9)
  })

  test("markdown chunks: heading path, fences, long sections split by paragraph", () => {
    const chunks = chunkMarkdown("docs/betrieb.md", DEPLOY_MD)
    expect(chunks.map((c) => c.heading)).toEqual(["Betrieb", "Betrieb › Deployment", "Betrieb › Deployment › Rollback"])
    expect(chunks[1].text).toContain("# not a heading")
    expect(chunks[2].line).toBe(DEPLOY_MD.split("\n").findIndex((l) => l.startsWith("### Rollback")) + 1)
    const para = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(9).trim()
    const long = chunkMarkdown("x.md", `## Lang\n${Array.from({ length: 6 }, () => para).join("\n\n")}`)
    expect(long.length).toBeGreaterThan(1)
    for (const c of long) expect(c.text.length).toBeLessThanOrEqual(1600)
  })
})

// ---------------------------------------------------------------------------
// 7: project docs RAG
// ---------------------------------------------------------------------------

describe("project docs (docs_search, docsmith context)", () => {
  test("BM25 fallback: tool, command, evidence for background runs, review context", async () => {
    const ctx = makeCtx()
    writeDocs(ctx.worktree, {
      "docs/betrieb.md": DEPLOY_MD,
      "README.md": "# Billing\n\nThe billing service creates invoices from the order events of the shop.\n",
      "node_modules/x/README.md": "# ignored\n\nmake rollback inside node_modules must never be indexed at all.\n",
    })
    const hits = await ctx.projectDocs!.search("rollback previous release")
    expect(hits[0]).toMatchObject({ file: "docs/betrieb.md", heading: "Betrieb › Deployment › Rollback" })
    expect(hits.some((h) => h.file.includes("node_modules"))).toBe(false)
    expect(hits[0].similarity).toBeUndefined()

    const tools = createTools(ctx, null)
    expect(await tools.docs_search.execute({ query: "rollback release" }, { sessionID: "s" })).toContain("docs/betrieb.md:")
    expect(await tools.docs_search.execute({ query: "kubernetes helm chart" }, { sessionID: "s" })).toContain("No documentation passage")
    // inside a docsmith run the passages become evidence
    const run = makeRun(ctx, "reviewer", { smith: "docsmith", haystack: "" })
    ctx.runs.attach(run, "ses_agent_docs")
    await tools.docs_search.execute({ query: "rollback release" }, { sessionID: "ses_agent_docs" })
    expect(run.haystack).toContain("make rollback")
    expect(await cmd(ctx, "docs-search")).toContain("2 .md-Datei(en)")
    expect(await cmd(ctx, "docs-search", "invoices order events")).toContain("README.md:")

    // review preparation: passages related to the session's question
    const msgs: Msg[] = [
      { info: { id: "msg_1", sessionID: "ses_d", role: "user" }, parts: [{ type: "text", text: "Wie mache ich ein Rollback auf das vorherige Release?" }] },
      { info: { id: "msg_2", sessionID: "ses_d", role: "assistant", time: { created: 1, completed: 2 } }, parts: [{ type: "text", text: "Mit make rollback." }] },
    ]
    const prep = await prepare(ctx, buildTranscript(msgs, { maxChars: 10000, redact: (s) => s }), "ses_d")
    expect(prep.docs.some((d) => d.file === "docs/betrieb.md" && d.text.includes("make rollback"))).toBe(true)
    expect(prep.haystack).toContain("return to the previous release")
  })

  test("never scans / or the home directory (worktree \"/\" outside git)", () => {
    expect(safeDocsRoot("/work/proj/sub", "/work/proj", "/home/u")).toBe("/work/proj")
    expect(safeDocsRoot("/work/proj", "/", "/home/u")).toBe("/work/proj")
    expect(safeDocsRoot("/home/u", "/", "/home/u")).toBeUndefined()
    expect(safeDocsRoot("/", "/", "/home/u")).toBeUndefined()
    expect(safeDocsRoot("/work/other", "/work/proj", "/home/u")).toBe("/work/other")
  })

  test("semantic: a paraphrase finds the section, vectors are incremental", async () => {
    const ctx = makeCtx({}, {}, { fetch: fakeFetch() })
    writeDocs(ctx.worktree, { "docs/betrieb.md": DEPLOY_MD })
    expect(await ctx.projectDocs!.syncVectors()).toBe(3)
    expect(await ctx.projectDocs!.syncVectors()).toBe(0)
    const q = "Wie bringe ich die Anwendung in Produktion?"
    const hits = await ctx.projectDocs!.search(q)
    expect(hits[0]?.heading).toBe("Betrieb › Deployment")
    expect(hits[0].similarity).toBeGreaterThan(0.5)
    expect(hits[0].matched).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 8: contradiction check for knowledge
// ---------------------------------------------------------------------------

describe("knowledge: related entries, flags, doubts", () => {
  test("related entries after a change, flag → doubts → resolved by an evidenced update", async () => {
    const ctx = makeCtx({ embedding: { relatedSimilarity: 0.5, duplicateSimilarity: 0.99 } }, {}, { fetch: fakeFetch() })
    const doc = cmdRun(ctx, "docsmith")
    await ctx.ops.create(doc, "knowledge", {
      name: "customer-db",
      title: "Customer database",
      description: "Customer data is stored in the customer database of the CRM",
      tags: ["crm"],
      body: "## Überblick\n- customer data lives in Postgres `crm`",
    })
    await ctx.ops.create(doc, "knowledge", { name: "billing-ports", title: "Billing ports", description: "Ports of the billing service", tags: ["billing"], body: "## Ports\n- 8443" })
    await ctx.semantic!.sync()

    const run = makeRun(ctx, "reviewer", {
      smith: "docsmith",
      haystack: "Die Kundendaten liegen seit dem Umzug im Kundenstamm-Service (MongoDB).",
      limits: { maxNew: 2, maxChanges: 5, maxNotes: 5 },
    })
    ctx.runs.attach(run, "ses_agent_k")
    const tools = createTools(ctx, null)
    const out = await tools.docsmith_knowledge_create.execute(
      {
        name: "kundenstamm-service",
        title: "Kundenstamm-Service",
        description: "Kundendaten liegen im Kundenstamm-Service",
        tags: ["kunden"],
        body: "## Überblick\n- Kundendaten im Kundenstamm-Service (MongoDB)",
        evidence: "Die Kundendaten liegen seit dem Umzug im Kundenstamm-Service",
      },
      { sessionID: "ses_agent_k" },
    )
    expect(out).toContain("created")
    expect(out).toContain("Related entries")
    expect(out).toContain("customer-db")
    expect(out).not.toContain("billing-ports")

    const flagged = await tools.docsmith_knowledge_flag.execute(
      { name: "customer-db", note: "Kundendaten liegen laut Session im Kundenstamm-Service, nicht im CRM", related: "kundenstamm-service" },
      { sessionID: "ses_agent_k" },
    )
    expect(flagged).toContain("flagged")
    expect(ctx.store.getOwned("knowledge", "customer-db")?.meta?.doubts).toHaveLength(1)
    expect(await tools.knowledge_read.execute({ name: "customer-db" }, { sessionID: "s" })).toContain("Kundenstamm-Service, nicht im CRM")
    expect(await cmd(ctx, "knowledge")).toContain("⚠ Widerspruch?")
    expect(new Curator(ctx).planConsolidation().docsmith.problems.map((p) => p.name)).toEqual(["customer-db"])

    // an evidenced content change resolves the doubt
    await ctx.ops.update(run, "knowledge", {
      name: "customer-db",
      description: "Customer data moved to the Kundenstamm-Service",
      evidence: "seit dem Umzug im Kundenstamm-Service (MongoDB)",
    })
    expect(ctx.store.getOwned("knowledge", "customer-db")?.meta?.doubts).toBeUndefined()
  })

  test("without embeddings the related check uses BM25", async () => {
    const ctx = makeCtx()
    const doc = cmdRun(ctx, "docsmith")
    await ctx.ops.create(doc, "knowledge", { name: "billing-api", title: "Billing API", description: "Billing API port and tables", tags: ["billing"], body: "## A\n- port 8443" })
    await ctx.ops.create(doc, "knowledge", { name: "billing-api-v2", title: "Billing API v2", description: "Billing API v2 port and tables", tags: ["billing"], body: "## A\n- port 9443" })
    const rel = await ctx.retriever.related("knowledge", "billing-api-v2")
    expect(rel.map((r) => r.entry.name)).toEqual(["billing-api"])
  })
})

// ---------------------------------------------------------------------------
// 6: curator clusters by meaning, contradiction pairs
// ---------------------------------------------------------------------------

describe("curator: clusters by meaning, related pairs", () => {
  async function setup(fetch?: any) {
    const ctx = makeCtx(
      { embedding: { clusterSimilarity: 0.6, relatedSimilarity: 0.3, duplicateSimilarity: 0.999 } },
      {},
      fetch ? { fetch } : {},
    )
    const c = cmdRun(ctx)
    await ctx.ops.create(c, "skill", { name: "release-app", description: "Roll out the application to production", body: "## Steps\n1. Run the pipeline job `release`\n2. Watch the dashboard" })
    await ctx.ops.create(c, "skill", { name: "ship-service", description: "Deploy the service via make deploy", body: "## Steps\n1. `make deploy ENV=prod`\n2. Check the health endpoint" })
    await ctx.ops.create(c, "skill", { name: "kafka-offset-reset", description: "Reset Kafka consumer group offsets", body: BODY })
    const d = cmdRun(ctx, "docsmith")
    await ctx.ops.create(d, "knowledge", { name: "kunden-api", title: "Kunden-API", description: "Kunden-API liefert Kundendaten über REST", tags: ["kunden"], body: "## A\n- REST" })
    await ctx.ops.create(d, "knowledge", { name: "customer-events", title: "Customer events", description: "Customer change events on Kafka topic", tags: ["kafka"], body: "## A\n- topic" })
    if (ctx.semantic) await ctx.semantic.sync()
    return ctx
  }

  test("paraphrased skills form a cluster only with embeddings", async () => {
    const plain = new Curator(await setup()).planConsolidation()
    expect(plain.skillsmith.clusters).toEqual([])
    expect(plain.docsmith.pairs).toEqual([])
    const ctx = await setup(fakeFetch())
    const curator = new Curator(ctx)
    // with the doctor, related knowledge pairs are its job
    expect(curator.planConsolidation().docsmith.pairs).toEqual([])
    ctx.options.doctor.enabled = false
    const plan = curator.planConsolidation()
    expect(plan.skillsmith.clusters).toEqual([["release-app", "ship-service"]])
    expect(plan.docsmith.pairs).toHaveLength(1)
    const p = plan.docsmith.pairs[0]
    expect([p.a, p.b].sort()).toEqual(["customer-events", "kunden-api"])
    expect(await curator.dryRunReport()).toContain("auf Widersprüche prüfen")
    // a checked pair is skipped until one of the entries changes
    ;(curator as any).saveState({ checkedPairs: { [`${p.a}|${p.b}`]: new Date(Date.now() + 1000).toISOString() } })
    expect(curator.planConsolidation().docsmith.pairs).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 9: tag vocabulary
// ---------------------------------------------------------------------------

describe("tags: one vocabulary", () => {
  test("variants", () => {
    for (const [a, b] of [["deploy", "deployment"], ["test", "tests"], ["test", "testing"], ["query", "queries"], ["db-2", "db2"], ["api", "apis"], ["node", "nodejs"]]) {
      expect(tagVariant(a, b)).toBe(true)
    }
    for (const [a, b] of [["java", "javascript"], ["port", "portal"], ["work", "worker"], ["react", "reactor"], ["go", "gos"], ["deploy", "deploy"]]) {
      expect(tagVariant(a, b)).toBe(false)
    }
  })

  test("agents: variants are mapped, missing tags come from similar entries; commands keep their tags", async () => {
    const ctx = makeCtx()
    const c = cmdRun(ctx)
    await ctx.ops.create(c, "skill", { name: "kafka-offset-reset", description: "Reset Kafka consumer group offsets", tags: ["kafka", "deploy"], body: BODY })
    await ctx.ops.create(c, "skill", { name: "kafka-lag-check", description: "Check Kafka consumer group lag and offsets", tags: ["kafka", "monitoring"], body: BODY })
    // command: explicit tags stay as given
    await ctx.ops.create(c, "skill", { name: "manual-entry", description: "Manual entry", tags: ["deployment"], body: BODY })
    expect(ctx.store.getOwned("skill", "manual-entry")?.tags).toEqual(["deployment"])

    const run = makeRun(ctx, "reviewer", { smith: "docsmith", haystack: "Offsets der Consumer Group werden jede Nacht gesichert.", limits: { maxNew: 3, maxChanges: 5, maxNotes: 5 } })
    const msg = await ctx.ops.create(run, "knowledge", {
      name: "kafka-offset-backup",
      title: "Kafka offset backup",
      description: "Kafka consumer group offsets are backed up every night",
      tags: ["deploys"],
      body: "## Überblick\n- nightly backup of consumer group offsets",
      evidence: "Offsets der Consumer Group werden jede Nacht gesichert",
    })
    const tags = ctx.store.getOwned("knowledge", "kafka-offset-backup")!.tags
    expect(tags[0]).toBe("deploy")
    expect(tags).toContain("kafka")
    expect(msg).toContain("deploys→deploy")
    expect(msg).toContain("+kafka")
  })

  test("semantic: an unknown synonym is mapped onto the established tag", async () => {
    const ctx = makeCtx({ embedding: { tagSimilarity: 0.9 } }, {}, { fetch: fakeFetch() })
    const c = cmdRun(ctx)
    await ctx.ops.create(c, "skill", { name: "deploy-checklist", description: "Deployment checklist", tags: ["deployment", "make"], body: BODY })
    await ctx.ops.create(c, "skill", { name: "deploy-hotfix", description: "Deploy a hotfix", tags: ["deployment"], body: BODY })
    const plan = await ctx.retriever.tagPlan("skill", { name: "x", title: "x", description: "Release the app", tags: ["rollout", "gradle"], fields: {}, body: BODY } as any)
    expect(plan.tags).toEqual(["deployment", "gradle"])
    expect(plan.notes.join()).toContain("rollout→deployment")
  })

  test("curator unifies existing variants (one commit, dry run lists them)", async () => {
    const ctx = makeCtx()
    await ctx.git.init()
    const c = cmdRun(ctx)
    await ctx.ops.create(c, "skill", { name: "a-skill", description: "First", tags: ["deploy", "kafka"], body: BODY })
    await ctx.ops.create(c, "skill", { name: "b-skill", description: "Second", tags: ["deploy"], body: BODY })
    await ctx.ops.create(c, "skill", { name: "c-skill", description: "Third", tags: ["deployment", "kafka"], body: BODY })
    await ctx.ops.create(cmdRun(ctx, "errorsmith"), "error", { name: "pkix", title: "PKIX", description: "PKIX error", tags: ["deployments"], body: ERROR_BODY, fields: { status: "solved" } })
    await ctx.git.commitRun(c)
    const curator = new Curator(ctx)
    const planned = await curator.planTagMerges()
    expect(planned.map((p) => `${p.kind}:${p.name}:${p.changes.join()}`).sort()).toEqual(["error:pkix:deployments→deploy", "skill:c-skill:deployment→deploy"])
    expect(await curator.dryRunReport()).toContain("Tags vereinheitlichen (2 Einträge)")
    const res = await curator.lifecycle("test", true)
    expect(res.commits).toHaveLength(2)
    expect(ctx.store.getOwned("skill", "c-skill")?.tags).toEqual(["deploy", "kafka"])
    expect(ctx.store.getOwned("error", "pkix")?.tags).toEqual(["deploy"])
    const log = execFileSync("git", ["-C", ctx.store.root, "log", "--format=%s", "-n", "2"], { encoding: "utf8" })
    expect(log).toContain("skillsmith(curator)")
    expect(log).toContain("errorsmith(curator)")
    ctx.options.unifyTags = false
    expect(await curator.planTagMerges()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 10: similar earlier sessions
// ---------------------------------------------------------------------------

const chain = (over: Partial<ErrorChain> = {}): ErrorChain => ({
  id: "E1",
  tool: "bash",
  head: "mvn",
  command: "mvn -q package",
  error: "[ERROR] PKIX path building failed",
  signature: "mvn: PKIX path building failed",
  sigKey: "k1",
  attempts: [],
  resolved: true,
  resolution: "keytool -importcert -cacerts -file corp.pem",
  label: "E1",
  sessions: 1,
  ...over,
})

describe("session history", () => {
  test("record, merge, hint (BM25), history_search, /history, retention", async () => {
    const ctx = makeCtx()
    const h = ctx.history!
    await h.record({
      id: "ses_old",
      project: "project",
      directory: ctx.directory,
      title: "Maven Build PKIX Fehler",
      requests: ["Der Maven Build bricht mit PKIX path building failed ab"],
      chains: [chain()],
      links: [{ kind: "error", name: "maven-pkix", rel: "new" }],
      outcome: "Zertifikat importiert, der Build läuft wieder.",
    })
    // a second segment of the same session is merged
    await h.record({ id: "ses_old", project: "project", directory: ctx.directory, requests: ["Danke, und jetzt noch die Tests"], chains: [], links: [{ kind: "error", name: "maven-pkix", rel: "used" }] })
    const rec = h.get("ses_old")!
    expect(rec.requests).toHaveLength(2)
    expect(rec.links).toEqual([{ kind: "error", name: "maven-pkix", rel: "new" }])
    expect(rec.problems[0]).toMatchObject({ resolved: true, fix: "keytool -importcert -cacerts -file corp.pem" })
    expect(isUseful(rec)).toBe(true)
    expect(historyText(rec)).toContain("solved: mvn: PKIX path building failed")

    const hint = await ctx.hints.onUserMessage("ses_new", "msg_1", "Mein Maven build schlägt fehl: PKIX path building failed beim Download")
    expect(hint).toContain("Ähnliche frühere Sessions")
    expect(hint).toContain("„Maven Build PKIX Fehler“")
    expect(hint).toContain("gelöst: keytool -importcert")
    expect(hint).toContain("Fehler maven-pkix (neu)")
    // never the current session, never unrelated requests
    expect((await ctx.hints.onUserMessage("ses_old", "msg_2", "Mein Maven build schlägt fehl: PKIX path building failed beim Download")) ?? "").not.toContain("frühere Sessions")
    expect((await ctx.hints.onUserMessage("ses_new", "msg_3", "Bitte formuliere die Release Notes für Version 3 freundlicher")) ?? "").not.toContain("frühere Sessions")
    ctx.options.hints.sessions = false
    expect((await ctx.hints.onUserMessage("ses_new", "msg_4", "Maven build PKIX path building failed schon wieder")) ?? "").not.toContain("frühere Sessions")

    const tools = createTools(ctx, null)
    const found = await tools.history_search.execute({ query: "pkix maven" }, { sessionID: "ses_new" })
    expect(found).toContain("Maven Build PKIX Fehler")
    expect(found).toContain("Lösung: keytool -importcert")
    expect(await tools.history_search.execute({ query: "pkix maven" }, { sessionID: "ses_old" })).toContain("No earlier session")
    expect(await cmd(ctx, "history")).toContain("Frühere Sessions – project (1)")
    expect(await cmd(ctx, "history", "pkix")).toContain("ses_old")
    expect(formatRecord(rec, { currentProject: "other" })).toContain("Projekt project")

    // retention: newest maxRecords are kept
    ctx.options.history.maxRecords = 2
    for (const id of ["ses_a", "ses_b"]) {
      await new Promise((r) => setTimeout(r, 5))
      await h.record({ id, project: "project", directory: ctx.directory, requests: [`Anfrage ${id} mit genug Text`], chains: [], links: [] })
    }
    expect(h.all().map((r) => r.id)).toEqual(["ses_b", "ses_a"])
  })

  test("semantic hint for a paraphrase (no shared words)", async () => {
    const ctx = makeCtx({}, {}, { fetch: fakeFetch() })
    await ctx.history!.record({
      id: "ses_dep",
      project: "project",
      directory: ctx.directory,
      requests: ["Wie bringe ich den Dienst in Produktion?"],
      chains: [],
      links: [{ kind: "skill", name: "deploy-checklist", rel: "new" }],
    })
    await ctx.history!.syncVectors()
    const hint = await ctx.hints.onUserMessage("ses_now", "msg_1", "Ich muss die Anwendung heute noch ausrollen")
    expect(hint).toContain("Ähnliche frühere Sessions")
    expect(hint).toContain("Skill deploy-checklist (neu)")
  })

  test("reviews write the record (requests, solved errors, linked entries)", async () => {
    const off = { enabled: false }
    const ctx = makeCtx({ skillsmith: off, docsmith: off, errorsmith: off, toolsmith: off })
    await ctx.ops.create(cmdRun(ctx, "errorsmith"), "error", { name: "maven-pkix", title: "PKIX", description: "PKIX", body: ERROR_BODY, fields: { status: "solved" } })
    const msgs: Msg[] = [
      { info: { id: "msg_1", sessionID: "ses_rv", role: "user", agent: "build" }, parts: [{ type: "text", text: "Bau das Projekt bitte" }] },
      {
        info: { id: "msg_2", sessionID: "ses_rv", role: "assistant", time: { created: 1, completed: 2 } },
        parts: [
          { type: "tool", tool: "bash", callID: "c1", state: { status: "completed", input: { command: "mvn -q package" }, output: "[ERROR] PKIX path building failed", metadata: { exit: 1 } } },
          { type: "tool", tool: "error_lookup", callID: "c2", state: { status: "completed", input: { name: "maven-pkix" }, output: "…" } },
          { type: "tool", tool: "bash", callID: "c3", state: { status: "completed", input: { command: "keytool -importcert -file corp.pem" }, output: "ok", metadata: { exit: 0 } } },
          { type: "tool", tool: "bash", callID: "c4", state: { status: "completed", input: { command: "mvn -q package" }, output: "BUILD SUCCESS", metadata: { exit: 0 } } },
          { type: "text", text: "Das Root-Zertifikat fehlte.\n\nZertifikat importiert, der Build läuft." },
        ],
      },
    ]
    ;(ctx as any).client = {
      session: {
        get: async () => ({ data: { id: "ses_rv", title: "Build reparieren" } }),
        messages: async () => ({ data: msgs }),
      },
    }
    await reviewSession(ctx, { sessionID: "ses_rv", directory: ctx.directory, reason: "threshold", enqueuedAt: new Date().toISOString(), attempts: 0, force: true })
    const rec = ctx.history!.get("ses_rv")!
    expect(rec.title).toBe("Build reparieren")
    expect(rec.requests).toEqual(["Bau das Projekt bitte"])
    expect(rec.problems[0]).toMatchObject({ resolved: true, fix: "keytool -importcert -file corp.pem" })
    expect(rec.links).toEqual([{ kind: "error", name: "maven-pkix", rel: "used" }])
    expect(rec.outcome).toBe("Zertifikat importiert, der Build läuft.")
  })
})
