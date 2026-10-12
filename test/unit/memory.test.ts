import { describe, expect, test } from "bun:test"
import { Curator } from "../../src/core/curator"
import { commitMessage } from "../../src/core/git"
import { canonicalEdge } from "../../src/core/graph"
import { stateId } from "../../src/core/memory-db"
import { formatStand, standParts } from "../../src/core/memory-format"
import { buildMemoryJob, DOCTOR_AGENT, isSmithAgent } from "../../src/core/prompts"
import { prepare, route } from "../../src/core/reviewer"
import { normalizeRemote, ticketOf } from "../../src/core/scope"
import { buildTranscript, type Msg } from "../../src/core/transcript"
import { handleCommand } from "../../src/host/commands"
import { createTools, READ_TOOLS, WRITE_TOOL_PREFIXES } from "../../src/host/tools"
import { cmdRun, makeCtx, makeRun, TEST_SCOPE } from "./helpers"

const USER = "Wir speichern das Token ab jetzt im HttpOnly-Cookie statt im localStorage, wegen XSS. In diesem Projekt bitte kein Lombok verwenden."
const TOOL = "curl -v https://t2.example/api → 401 unless header X-T2-Auth is set; the test system T2 needs X-T2-Auth since the last release"

function memRun(ctx: ReturnType<typeof makeCtx>, extra: Record<string, unknown> = {}) {
  return makeRun(ctx, "reviewer", {
    smith: "memorysmith",
    userText: USER,
    haystack: `${USER}\n${TOOL}`,
    limits: { maxNew: 8, maxChanges: 12, maxNotes: 0 },
    scope: { ...TEST_SCOPE },
    ...extra,
  })
}

const where = { ...TEST_SCOPE }

describe("scope", () => {
  test("git remotes normalize to one project id", () => {
    expect(normalizeRemote("git@github.com:Acme/shop.git")).toBe("github.com/Acme/shop")
    expect(normalizeRemote("https://user@GitHub.com/Acme/shop.git")).toBe("github.com/Acme/shop")
    expect(normalizeRemote("ssh://git@git.corp.local:7999/team/shop.git")).toBe("git.corp.local/team/shop")
    expect(normalizeRemote("https://git.corp.local:8443/team/shop/")).toBe("git.corp.local/team/shop")
    expect(normalizeRemote("")).toBeUndefined()
    expect(ticketOf("feature/T2-123-login", "[A-Z][A-Z0-9]+-\\d+")).toBe("T2-123")
    expect(ticketOf("main", "[A-Z][A-Z0-9]+-\\d+")).toBeUndefined()
    expect(ticketOf("x", "([")).toBeUndefined()
  })
})

describe("memory database", () => {
  test("work states keep their history, results and captures", () => {
    const ctx = makeCtx()
    const mem = ctx.mem!
    expect(mem.available).toBe(true)
    const base = { project: "p", projectName: "P", branch: "feature/x", goal: "Login", done: [], open: ["Tests"], next: [], files: [], summary: "Login halb fertig" }
    const a = mem.upsertState(base, 1000)
    expect(a.created).toBe(true)
    expect(a.state.id).toBe(stateId("p", "feature/x"))
    const b = mem.upsertState({ ...base, done: ["Tests"], open: [], summary: "Login fertig" }, 2000)
    expect(b.created).toBe(false)
    expect(b.state.history[0].summary).toBe("Login halb fertig")
    expect(mem.state("p", "feature/x")?.summary).toBe("Login fertig")
    mem.setStateStatus(b.state.id, "abgelaufen")
    expect(mem.state("p", "feature/x")).toBeUndefined()

    const r = mem.addResult({ project: "p", projectName: "P", title: "Wo wird X konfiguriert", question: "", answer: "In config/x.yml", files: [], sources: [], tags: [] })
    expect(r.id).toMatch(/^result:\d{8}-/)
    mem.markResultUsed(r.id)
    expect(mem.getResult(r.id)?.used).toBe(1)

    mem.capture("ses1", "p", "find X", "X is in config/x.yml")
    mem.capture("ses1", "p", "find Y", "Y is in config/y.yml")
    const caps = mem.captures("ses1")
    expect(caps).toHaveLength(2)
    mem.consumeCaptures([caps[0].id])
    expect(mem.captures("ses1").map((c) => c.prompt)).toEqual(["find Y"])
  })

  test("conflicts are unique per pair and judged pairs are remembered with hashes", () => {
    const ctx = makeCtx()
    const mem = ctx.mem!
    const id = mem.openConflict("memory:b", "memory:a", "Duplikat-Verdacht", 0.95, "hb", "ha")!
    expect(mem.openConflict("memory:a", "memory:b", "Duplikat-Verdacht", 0.96, "ha", "hb")).toBe(id)
    expect(mem.conflicts("open")).toHaveLength(1)
    expect(mem.conflict(id)?.a).toBe("memory:a")
    mem.markChecked("memory:b", "memory:a", "hb", "ha", "not_related")
    expect(mem.isChecked("memory:a", "memory:b", "ha", "hb")).toBe(true)
    expect(mem.isChecked("memory:a", "memory:b", "ha", "CHANGED")).toBe(false)
    mem.updateConflict(id, { status: "resolved", resolution: "x" })
    expect(mem.conflict(id)?.resolvedAt).toBeGreaterThan(0)
  })
})

describe("memorysmith operations", () => {
  test("decision with the user's words is valid, the same topic updates, a newer one supersedes", async () => {
    const ctx = makeCtx()
    const run = memRun(ctx)
    const msg = await ctx.ops.memorySave(run, {
      type: "entscheidung",
      topic: "Token Speicherung",
      title: "Token im HttpOnly-Cookie",
      summary: "Auth-Token wird im HttpOnly-Cookie gespeichert, nicht im localStorage",
      body: "## Entscheidung\nHttpOnly-Cookie.\n\n## Begründung\nXSS.\n\n## Alternativen\n- localStorage (verworfen: XSS)",
      tags: ["auth", "token"],
      evidence: "im HttpOnly-Cookie statt im localStorage",
      where,
    })
    expect(msg).toContain("memory:shop-entscheidung-token-speicherung")
    const e = ctx.store.getOwned("memory", "shop-entscheidung-token-speicherung")!
    expect(e.fields.status).toBe("gueltig")
    expect(e.fields.decided_by).toBe("user")
    expect(e.fields.project).toBe(TEST_SCOPE.project)
    expect(e.fields.ticket).toBe("T2-123")
    expect(e.meta?.evidence?.[0].source).toBe("user")

    // same topic → update, not a second entry
    await ctx.ops.memorySave(run, {
      type: "entscheidung",
      topic: "entscheidung/token-speicherung",
      title: "Token im HttpOnly-Cookie (SameSite=Strict)",
      summary: "Auth-Token im HttpOnly-Cookie mit SameSite=Strict",
      body: "## Entscheidung\nHttpOnly-Cookie, SameSite=Strict.",
      evidence: "im HttpOnly-Cookie statt im localStorage",
      where,
    })
    expect(ctx.store.list("memory")).toHaveLength(1)

    // newer decision supersedes the old one
    const cmd = cmdRun(ctx, "memorysmith")
    await ctx.ops.memorySave(cmd, {
      type: "entscheidung",
      topic: "session-tokens",
      title: "Server-Session statt Token",
      summary: "Server-seitige Session ersetzt das Token im Cookie",
      body: "## Entscheidung\nServer-Session.",
      supersedes: "shop-entscheidung-token-speicherung",
      where,
    })
    const old = ctx.store.getOwned("memory", "shop-entscheidung-token-speicherung")!
    expect(old.fields.status).toBe("abgeloest")
    expect(old.fields.superseded_by).toBe("shop-entscheidung-session-tokens")
    expect(old.tier).toBe("archive")
    const edge = ctx.graph.between("memory:shop-entscheidung-session-tokens", "memory:shop-entscheidung-token-speicherung")
    expect(edge?.type).toBe("supersedes")
    expect(edge?.from).toBe("memory:shop-entscheidung-session-tokens")
  })

  test("gates: conventions need the user's words, agent decisions are only proposed, no evidence no memory", async () => {
    const ctx = makeCtx()
    const run = memRun(ctx)
    const base = { title: "T2 braucht X-T2-Auth", summary: "Testsystem T2 verlangt den Header X-T2-Auth", body: "Header X-T2-Auth setzen.", where }
    await expect(ctx.ops.memorySave(run, { ...base, type: "vorgabe", topic: "t2-auth", evidence: "T2 needs X-T2-Auth since the last release" })).rejects.toThrow(/user's own words/)
    await expect(ctx.ops.memorySave(run, { ...base, type: "erfahrung", topic: "t2-auth" })).rejects.toThrow(/evidence/)
    await expect(ctx.ops.memorySave(run, { ...base, type: "erfahrung", topic: "t2-auth", evidence: "T2 rejects everything without auth" })).rejects.toThrow(/not found verbatim/)
    await expect(ctx.ops.memorySave(run, { ...base, type: "notiz", topic: "x", evidence: "T2 needs X-T2-Auth" })).rejects.toThrow(/type must be/)
    await ctx.ops.memorySave(run, { ...base, type: "erfahrung", topic: "t2-auth", evidence: "T2 needs X-T2-Auth since the last release" })
    const agentDecision = await ctx.ops.memorySave(run, {
      type: "entscheidung",
      topic: "auth-header",
      title: "Header zentral im Interceptor setzen",
      summary: "X-T2-Auth wird im HTTP-Interceptor gesetzt",
      body: "## Entscheidung\nInterceptor.",
      evidence: "unless header X-T2-Auth is set",
      where,
    })
    expect(agentDecision).toContain("vorgeschlagen")
    const d = ctx.store.getOwned("memory", "shop-entscheidung-auth-header")!
    expect(d.fields.status).toBe("vorgeschlagen")
    expect(d.fields.decided_by).toBe("agent")
    await ctx.ops.memorySave(run, { type: "vorgabe", topic: "lombok", title: "Kein Lombok", summary: "In diesem Projekt kein Lombok verwenden", body: "Kein Lombok.", evidence: "In diesem Projekt bitte kein Lombok verwenden", where })
    expect(ctx.store.getOwned("memory", "shop-vorgabe-lombok")?.fields.status).toBe("gueltig")
  })

  test("the same topic in another project is a different memory", async () => {
    const ctx = makeCtx()
    const cmd = cmdRun(ctx, "memorysmith")
    await ctx.ops.memorySave(cmd, { type: "vorgabe", topic: "lombok", title: "Kein Lombok", summary: "kein Lombok", body: "x", where })
    await ctx.ops.memorySave(cmd, { type: "vorgabe", topic: "lombok", title: "Lombok erlaubt", summary: "Lombok erlaubt", body: "y", where: { ...where, project: "github.com/other/shop" } })
    const all = ctx.store.list("memory")
    expect(all).toHaveLength(2)
    expect(new Set(all.map((e) => e.fields.project))).toEqual(new Set([TEST_SCOPE.project, "github.com/other/shop"]))
  })

  test("work states and results are local: no commit, but in the journal", async () => {
    const ctx = makeCtx()
    const run = memRun(ctx)
    const s = await ctx.ops.memoryState(run, { goal: "Login umbauen", done: ["Cookie-Variante"], open: ["Tests für Logout"], next: ["PR"], files: ["src/auth.ts"], where })
    expect(s).toContain("state:")
    const r = await ctx.ops.memoryResult(run, { title: "Wo T2 die Auth prüft", answer: "Im Gateway: T2 needs X-T2-Auth since the last release.", evidence: "T2 needs X-T2-Auth since the last release", where })
    expect(r).toContain("result:")
    expect(run.actions.every((a) => a.local)).toBe(true)
    expect(run.touched.size).toBe(0)
    expect(commitMessage(run)).not.toContain("state")
    const st = ctx.mem!.state(TEST_SCOPE.project, TEST_SCOPE.branch!)!
    expect(st.open).toEqual(["Tests für Logout"])
    await expect(ctx.ops.memoryState(run, { where })).rejects.toThrow(/needs at least/)
  })
})

describe("relations and graph", () => {
  test("one relation per pair, symmetric on the smaller id, volatile ends in the local db", async () => {
    const ctx = makeCtx()
    const cmd = cmdRun(ctx, "docsmith")
    await ctx.ops.create(cmd, "knowledge", { name: "auth-gateway", title: "Auth-Gateway", description: "Gateway prüft Tokens", body: "## A\n- prüft Tokens" })
    await ctx.ops.create(cmd, "knowledge", { name: "token-format", title: "Token-Format", description: "Aufbau der Tokens", body: "## A\n- JWT" })
    const run = memRun(ctx)
    await ctx.ops.relate(run, { from: "knowledge:token-format", to: "knowledge:auth-gateway", type: "related", strength: 4, description: "Beide beschreiben die Token-Prüfung." })
    expect(canonicalEdge("knowledge:token-format", "knowledge:auth-gateway", "related").from).toBe("knowledge:auth-gateway")
    expect(ctx.store.getOwned("knowledge", "auth-gateway")?.meta?.relations?.[0]).toMatchObject({ to: "knowledge:token-format", type: "related", strength: 0.8 })
    // new judgement replaces the old one
    await ctx.ops.relate(run, { from: "knowledge:token-format", to: "knowledge:auth-gateway", type: "depends_on", strength: 5, description: "Das Format setzt das Gateway voraus." })
    const stored = ctx.graph.storedEdges().filter((e) => [e.from, e.to].includes("knowledge:auth-gateway"))
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ from: "knowledge:token-format", type: "depends_on", strength: 1 })
    await expect(ctx.ops.relate(run, { from: "knowledge:token-format", to: "knowledge:nope", type: "related", description: "x is related" })).rejects.toThrow(/not found/)
    await expect(ctx.ops.relate(run, { from: "knowledge:token-format", to: "knowledge:auth-gateway", type: "related" })).rejects.toThrow(/description/)
    await expect(ctx.ops.relate(run, { from: "knowledge:token-format", to: "knowledge:auth-gateway", type: "liebt", description: "x is related" })).rejects.toThrow(/type must be/)

    // volatile end
    await ctx.ops.memoryState(run, { goal: "Login", open: ["Gateway anpassen"], where })
    const sid = stateId(TEST_SCOPE.project, TEST_SCOPE.branch!)
    await ctx.ops.relate(run, { from: sid, to: "knowledge:auth-gateway", type: "depends_on", strength: 3, description: "Die Arbeit ändert das Gateway." })
    expect(ctx.mem!.relationsOf(sid)).toHaveLength(1)
    expect(ctx.graph.edgesOf("knowledge:auth-gateway").map((e) => e.type).sort()).toEqual(["depends_on", "depends_on"])
    const nb = ctx.graph.neighbourhood(sid, 2)
    expect(nb.nodes.map((n) => n.id).sort()).toEqual([sid, "knowledge:auth-gateway", "knowledge:token-format"].sort())
  })

  test("derived edges: scripts mentioned in errors solve them, superseded memories", async () => {
    const ctx = makeCtx()
    const cmd = cmdRun(ctx, "toolsmith")
    await ctx.ops.publishScript(cmd, {
      name: "fix-truststore",
      isNew: true,
      content: { name: "fix-truststore", title: "fix-truststore", description: "Imports the corporate CA into the JDK truststore", tags: ["java", "tls"], fields: { usage: "python fix_truststore.py" }, body: "## Usage\nrun it" },
      files: { "fix_truststore.py": "print('ok')\n" },
      test: { status: "passed", at: new Date().toISOString() },
      capabilities: [],
      approved: true,
    })
    const e = cmdRun(ctx, "errorsmith")
    await ctx.ops.create(e, "error", { name: "pkix-maven", title: "PKIX bei Maven", description: "PKIX path building failed", fields: { status: "solved" }, body: "## Symptom\nPKIX path building failed\n\n## Ursache\nCA fehlt\n\n## Lösung\n`python fix_truststore.py`" })
    const derived = ctx.graph.derivedEdges()
    expect(derived.find((d) => d.from === "script:fix-truststore" && d.to === "error:pkix-maven")?.type).toBe("solves")
  })
})

describe("doctor", () => {
  async function twoSimilar(ctx: ReturnType<typeof makeCtx>) {
    const cmd = cmdRun(ctx, "docsmith")
    await ctx.ops.create(cmd, "knowledge", {
      name: "t2-auth-header",
      title: "T2 Auth Header",
      description: "Testsystem T2 verlangt den Header X-T2-Auth bei jedem Request",
      tags: ["t2", "auth"],
      body: "## Fakten\n- Testsystem T2 verlangt den Header X-T2-Auth bei jedem Request an das Gateway",
    })
    const m = cmdRun(ctx, "memorysmith")
    await ctx.ops.memorySave(m, {
      type: "erfahrung",
      topic: "t2-header",
      title: "T2 verlangt X-T2-Auth Header",
      summary: "Testsystem T2 verlangt den Header X-T2-Auth bei jedem Request",
      body: "Testsystem T2 verlangt den Header X-T2-Auth bei jedem Request an das Gateway seit dem letzten Release",
      tags: ["t2", "auth"],
      where,
    })
    return m
  }

  test("changes are queued, the scan opens a conflict (BM25 fallback), verdicts close it and are remembered", async () => {
    const ctx = makeCtx()
    const m = await twoSimilar(ctx)
    const doctor = ctx.doctor!
    expect(doctor.enabled).toBe(true)
    // the command runs were not finalized; queue by hand like finalizeRun does
    doctor.onRunFinished(m)
    expect(ctx.mem!.queueSize()).toBe(1)
    expect(await doctor.scan(10)).toBe(1)
    const [c] = ctx.mem!.conflicts("open")
    expect([c.a, c.b].sort()).toEqual(["knowledge:t2-auth-header", "memory:shop-erfahrung-t2-header"])

    // the agent judges through its tools
    const pairs = doctor.openPairs(5)
    const run = makeRun(ctx, "curator", { smith: "doctor", limits: { maxNew: 0, maxChanges: 20, maxNotes: 0 } })
    run.doctorPairs = { P1: { conflict: c.id, a: pairs[0].a.id, b: pairs[0].b.id, aHash: pairs[0].a.hash, bHash: pairs[0].b.hash } }
    run.haystack = `${pairs[0].a.text}\n${pairs[0].b.text}`
    ctx.runs.attach(run, "ses_doctor")
    const tools = createTools(ctx, null)
    expect(await tools.memorysmith_relate.execute({ from: "a", to: "b", type: "related", strength: 3, description: "xx" }, { sessionID: "ses_doctor" })).toContain("belongs to memorysmith")
    const out = await tools.doctor_relate.execute({ pair: "P1", type: "supplements", strength: 4, description: "Die Erfahrung ergänzt das Wissen um den Zeitpunkt der Änderung." }, { sessionID: "ses_doctor" })
    expect(out).toContain("supplements")
    expect(ctx.mem!.conflict(c.id)?.status).toBe("resolved")
    expect(run.doctorPairs.P1.decided).toBe("relate:supplements")
    // judged pair with unchanged content is not opened again
    ctx.mem!.enqueue("memory:shop-erfahrung-t2-header", "x")
    expect(await doctor.scan(10)).toBe(0)
  })

  test("conflicts go to the user; resolve via command supersedes", async () => {
    const ctx = makeCtx()
    const cmd = cmdRun(ctx, "memorysmith")
    await ctx.ops.memorySave(cmd, { type: "entscheidung", topic: "db", title: "Postgres als Datenbank", summary: "Wir nutzen Postgres", body: "## Entscheidung\nPostgres", where })
    await ctx.ops.memorySave(cmd, { type: "entscheidung", topic: "datenbank", title: "DB2 als Datenbank", summary: "Wir nutzen DB2", body: "## Entscheidung\nDB2", where })
    const id = ctx.mem!.openConflict("memory:shop-entscheidung-db", "memory:shop-entscheidung-datenbank", "zwei Entscheidungen", 0.9, "x", "y")!
    const run = makeRun(ctx, "curator", { smith: "doctor", limits: { maxNew: 0, maxChanges: 20, maxNotes: 0 } })
    const c = ctx.mem!.conflict(id)!
    run.doctorPairs = { P1: { conflict: id, a: c.a, b: c.b, aHash: "x", bHash: "y" } }
    ctx.runs.attach(run, "ses_doc2")
    const tools = createTools(ctx, null)
    // decisions cannot be corrected by the doctor
    const corr = await tools.doctor_correct.execute({ pair: "P1", target: "A", old_text: "Postgres", new_text: "DB2", evidence: "DB2 als Datenbank", reason: "neuer" }, { sessionID: "ses_doc2" })
    expect(corr).toContain("belong to the user")
    await tools.doctor_conflict.execute({ pair: "P1", note: "Zwei Entscheidungen nennen verschiedene Datenbanken." }, { sessionID: "ses_doc2" })
    expect(ctx.mem!.conflict(id)?.status).toBe("needs_user")

    const deps = { queue: { enqueue() {} } as any, curator: {} as any }
    const listing = await handleCommand(ctx, deps, "smith-doctor", "", "ses_user")
    expect(listing).toContain("Bitte entscheiden")
    expect(listing).toContain(id)
    const res = await handleCommand(ctx, deps, "smith-doctor", `resolve ${id} b`, "ses_user")
    expect(res).toContain("entschieden")
    // B wins → A is superseded by B
    const a = ctx.store.getOwned("memory", c.a.slice(7))!
    expect(a.fields.status).toBe("abgeloest")
    expect(a.fields.superseded_by).toBe(c.b.slice(7))
    expect(a.tier).toBe("archive")
    expect(ctx.mem!.conflict(id)?.status).toBe("resolved")
  })
})

describe("stand block, hints, review routing", () => {
  test("the stand block opens a session once and lists state, conventions and decisions", async () => {
    const ctx = makeCtx({ hints: { enabled: true } })
    const cmd = cmdRun(ctx, "memorysmith")
    await ctx.ops.memorySave(cmd, { type: "vorgabe", topic: "lombok", title: "Kein Lombok", summary: "Kein Lombok in diesem Projekt", body: "x", where })
    await ctx.ops.memorySave(cmd, { type: "vorgabe", topic: "commits", title: "Commits auf Deutsch", summary: "Commit-Messages auf Deutsch", body: "x", scope: "global", where: { ...where, project: "github.com/other/x" } })
    await ctx.ops.memorySave(cmd, { type: "vorgabe", topic: "fremd", title: "Nur im anderen Projekt", summary: "fremd", body: "x", where: { ...where, project: "github.com/other/x" } })
    await ctx.ops.memoryState(cmd, { goal: "Login umbauen", open: ["Logout testen"], next: ["PR öffnen"], where })
    const parts = standParts(ctx.store.list("memory"), TEST_SCOPE, ctx.mem!.state(TEST_SCOPE.project, TEST_SCOPE.branch!))
    const block = formatStand(parts, TEST_SCOPE, 1500)!
    expect(block).toContain("<smith_memory")
    expect(block).toContain("offen: Logout testen")
    expect(block).toContain("Kein Lombok")
    expect(block).toContain("Commits auf Deutsch (global)")
    expect(block).not.toContain("Nur im anderen Projekt")
    const short = formatStand(parts, TEST_SCOPE, 250)!
    expect(short.length).toBeLessThan(block.length)
    expect(short).toContain("…")
    expect(short.endsWith("</smith_memory>")).toBe(true)

    const first = await ctx.hints.onUserMessage("ses_s", "msg1", "Wie war nochmal der Stand?")
    expect(first).toContain("<smith_memory")
    const second = await ctx.hints.onUserMessage("ses_s", "msg2", "Wie war nochmal der Stand?")
    expect(second ?? "").not.toContain("<smith_memory")
    // subagent sessions get no stand block
    const sub = await ctx.hints.onUserMessage("ses_child", "m1", "Wie war nochmal der Stand?", { topLevel: false })
    expect(sub ?? "").not.toContain("<smith_memory")
  })

  test("captures of subagents reach memorysmith of the parent only", async () => {
    const ctx = makeCtx()
    ctx.mem!.capture("ses_p", TEST_SCOPE.project, "Finde die Auth-Konfiguration", "Die Auth-Konfiguration liegt in config/auth.yml (Schlüssel t2.header).")
    const msgs: Msg[] = [
      { info: { id: "m1", role: "user", sessionID: "ses_p", time: { created: 1 } }, parts: [{ id: "p1", type: "text", text: "Wo ist die Auth-Konfiguration? Bitte merk dir das." }] } as any,
      { info: { id: "m2", role: "assistant", sessionID: "ses_p", time: { created: 2, completed: 3 } }, parts: [{ id: "p2", type: "text", text: "In config/auth.yml." }] } as any,
    ]
    const t = buildTranscript(msgs, { maxChars: 20000, redact: (s) => s })
    const prep = await prepare(ctx, t, "ses_p", { rememberNotes: ["T2-Header heißt X-T2-Auth"] })
    expect(prep.captures).toHaveLength(1)
    expect(prep.haystack).toContain("config/auth.yml (Schlüssel t2.header)")
    expect(prep.userText).toContain("T2-Header heißt X-T2-Auth")
    expect(route(ctx, prep)).toContain("memorysmith")
    const child = await prepare(ctx, t, "ses_p", { isChild: true })
    expect(child.captures).toHaveLength(0)
    expect(route(ctx, child)).not.toContain("memorysmith")
    const job = buildMemoryJob({
      runId: "r1",
      options: ctx.options,
      session: { id: "ses_p", project: "shop", trigger: "idle" },
      transcript: t,
      scope: prep.scope,
      memories: "",
      captures: prep.captures,
      rememberNotes: prep.rememberNotes,
      chains: [],
      changes: prep.changes,
      limits: { maxChanges: 8 },
    })
    expect(job).toContain("## THE USER ASKED TO REMEMBER")
    expect(job).toContain("## SUBAGENT RESULTS")
    expect(job).toContain("branch: feature/T2-123-login")
  })

  test("agents and permissions: memorysmith and doctor are background agents, their tools are write tools", () => {
    expect(isSmithAgent("memorysmith-reviewer")).toBe(true)
    expect(isSmithAgent(DOCTOR_AGENT)).toBe(true)
    expect(WRITE_TOOL_PREFIXES).toContain("memorysmith_")
    expect(WRITE_TOOL_PREFIXES).toContain("doctor_")
    expect(READ_TOOLS).toContain("memory_read")
    for (const t of ["skill_list", "knowledge_list", "glossary_list", "error_list", "script_list", "memory_list"]) expect(READ_TOOLS).toContain(t)
    expect(READ_TOOLS.some((t) => WRITE_TOOL_PREFIXES.some((p) => t.startsWith(p)))).toBe(false)
  })
})

describe("read tools and commands", () => {
  test("memory_search, memory_read with relations, graph_neighbors", async () => {
    const ctx = makeCtx()
    const cmd = cmdRun(ctx, "memorysmith")
    await ctx.ops.memorySave(cmd, { type: "entscheidung", topic: "token", title: "Token im HttpOnly-Cookie", summary: "Auth-Token liegt im HttpOnly-Cookie", body: "## Entscheidung\nCookie", tags: ["auth"], where })
    const d = cmdRun(ctx, "docsmith")
    await ctx.ops.create(d, "knowledge", { name: "auth-gateway", title: "Auth-Gateway", description: "Gateway prüft Cookies und Tokens", body: "## A\n- prüft" })
    await ctx.ops.relate(cmd, { from: "memory:shop-entscheidung-token", to: "knowledge:auth-gateway", type: "depends_on", strength: 4, description: "Das Gateway muss Cookies lesen können." })
    await ctx.ops.memoryResult(cmd, { title: "Cookie-Flags im Gateway", answer: "Das Gateway setzt Secure und HttpOnly für das Token-Cookie.", where })
    const tools = createTools(ctx, null)
    const found = await tools.memory_search.execute({ query: "Token Cookie" }, { sessionID: "ses_main" })
    expect(found).toContain("memory:shop-entscheidung-token")
    expect(found).toContain("result:")
    const read = await tools.memory_read.execute({ id: "shop-entscheidung-token" }, { sessionID: "ses_main" })
    expect(read).toContain("Verknüpfungen")
    expect(read).toContain("setzt voraus knowledge:auth-gateway")
    expect(read).toContain("Das Gateway muss Cookies lesen können.")
    const back = await tools.memory_read.execute({ id: "knowledge:auth-gateway" }, { sessionID: "ses_main" })
    expect(back).toContain("(eingehend)")
    const nb = await tools.graph_neighbors.execute({ id: "knowledge:auth-gateway" }, { sessionID: "ses_main" })
    expect(nb).toContain("memory:shop-entscheidung-token")
    expect(ctx.usage.get("memory", "shop-entscheidung-token").loads).toBe(1)
  })

  test("/remember, /forget, /resume, /memory", async () => {
    const ctx = makeCtx()
    const enqueued: unknown[][] = []
    const deps = { queue: { enqueue: (...a: unknown[]) => enqueued.push(a) } as any, curator: {} as any }
    const r = await handleCommand(ctx, deps, "remember", "Deployments nur dienstags", "ses_u")
    expect(r).toContain("Wird gemerkt")
    expect(enqueued[0]).toEqual(["ses_u", "remember", true])
    expect(ctx.sessions.peek("ses_u")?.rememberNotes).toEqual(["Deployments nur dienstags"])
    const cmd = cmdRun(ctx, "memorysmith")
    await ctx.ops.memorySave(cmd, { type: "vorgabe", topic: "deploy-tag", title: "Deployments nur dienstags", summary: "Deployments nur dienstags", body: "x", where })
    await ctx.ops.memoryState(cmd, { goal: "Login umbauen", open: ["Logout testen"], where })
    const overview = await handleCommand(ctx, deps, "memory", "", "ses_u")
    expect(overview).toContain("Deployments nur dienstags")
    expect(overview).toContain("Logout testen")
    const resume = await handleCommand(ctx, deps, "resume", "", "ses_u")
    expect(resume).toContain("Ziel: Login umbauen")
    expect(resume).toContain("Vorgaben und Entscheidungen")
    const f = await handleCommand(ctx, deps, "forget", "memory:shop-vorgabe-deploy-tag", "ses_u")
    expect(f).toContain("archive")
    expect(ctx.store.getOwned("memory", "shop-vorgabe-deploy-tag")?.tier).toBe("archive")
    expect(await handleCommand(ctx, deps, "forget", stateId(TEST_SCOPE.project, TEST_SCOPE.branch!), "ses_u")).toContain("verworfen")
    expect(ctx.mem!.state(TEST_SCOPE.project, TEST_SCOPE.branch!)).toBeUndefined()
  })
})

describe("list tools", () => {
  test("private entries stay hidden, tags filter is AND, archive is opt-in, memory is project filtered", async () => {
    const ctx = makeCtx()
    const doc = cmdRun(ctx, "docsmith")
    await ctx.ops.create(doc, "knowledge", { name: "public-doc", title: "Public", description: "sichtbar", tags: ["a", "b"], body: "x" })
    await ctx.ops.create(doc, "knowledge", { name: "tag-a-only", title: "A", description: "nur a", tags: ["a"], body: "x" })
    await ctx.ops.create(doc, "knowledge", { name: "geheim", title: "Geheim", description: "privat", tags: ["a", "b"], body: "x", fields: { ai: "privat" } })
    await ctx.ops.create(doc, "knowledge", { name: "alt", title: "Alt", description: "archiviert", body: "x" })
    await ctx.ops.move(cmdRun(ctx, "docsmith"), "knowledge", { name: "alt", to: "archive", kind: "archive", reason: "test" })

    const cmd = cmdRun(ctx, "memorysmith")
    await ctx.ops.memorySave(cmd, { type: "vorgabe", topic: "hier", title: "Hier gilt es", summary: "hier", body: "x", where })
    await ctx.ops.memorySave(cmd, { type: "vorgabe", topic: "global", title: "Global gilt es", summary: "global", body: "x", scope: "global", where })
    await ctx.ops.memorySave(cmd, { type: "vorgabe", topic: "fremd", title: "Nur im anderen Projekt", summary: "fremd", body: "x", where: { ...where, project: "github.com/other/x" } })

    const tools = createTools(ctx, null)
    const tc = { sessionID: "ses_main" }

    // (a) AI-Recht privat never reaches a list tool
    const kl = await tools.knowledge_list.execute({}, tc)
    expect(kl).toContain("public-doc")
    expect(kl).not.toContain("geheim")

    // (c) tags filter is an AND
    const tagged = await tools.knowledge_list.execute({ tags: ["a", "b"] }, tc)
    expect(tagged).toContain("public-doc")
    expect(tagged).not.toContain("tag-a-only")

    // (d) archive only with include_archived
    expect(kl).not.toContain("alt")
    const withArchive = await tools.knowledge_list.execute({ include_archived: true }, tc)
    expect(withArchive).toContain("alt")
    expect(withArchive).toContain("archiviert")

    // (b) memory_list: current project + global, not a foreign project; with all_projects: true it appears
    const ml = await tools.memory_list.execute({}, tc)
    expect(ml).toContain("Hier gilt es")
    expect(ml).toContain("Global gilt es")
    expect(ml).not.toContain("Nur im anderen Projekt")
    const mlAll = await tools.memory_list.execute({ all_projects: true }, tc)
    expect(mlAll).toContain("Nur im anderen Projekt")
    // volatile states/results are not listed
    expect(ml).not.toContain("state:")
    expect(ml).not.toContain("result:")
  })
})

describe("curator: memory lifecycle", () => {
  test("superseded memories are archived, old states expire, unused results are deleted", async () => {
    const ctx = makeCtx()
    const cmd = cmdRun(ctx, "memorysmith")
    await ctx.ops.memorySave(cmd, { type: "erfahrung", topic: "alt", title: "Alte Erfahrung", summary: "alt", body: "x", status: "abgeloest", where })
    await ctx.ops.memorySave(cmd, { type: "vorgabe", topic: "bleibt", title: "Vorgabe bleibt", summary: "bleibt", body: "x", where })
    const curator = new Curator(ctx)
    const moves = curator.planMemory()
    expect(moves.map((m) => `${m.name}:${m.kind}`)).toEqual(["shop-erfahrung-alt:archive"])
    // experiences unused for long are archived, conventions never
    expect(curator.planMemory(new Date(Date.now() + 400 * 86_400_000)).map((m) => m.name).sort()).toEqual(["shop-erfahrung-alt"])

    const mem = ctx.mem!
    const old = Date.now() - 30 * 86_400_000
    mem.upsertState({ project: "other", projectName: "o", branch: "b", goal: "g", done: [], open: [], next: [], files: [], summary: "s" }, old)
    const unused = mem.addResult({ project: "other", projectName: "o", title: "t", question: "", answer: "a", files: [], sources: [], tags: [] }, old)
    const used = mem.addResult({ project: "other", projectName: "o", title: "t2", question: "", answer: "a", files: [], sources: [], tags: [] }, old)
    mem.markResultUsed(used.id)
    const r = curator.cleanVolatile()
    expect(r).toEqual({ expired: 1, deleted: 1 })
    expect(mem.getResult(unused.id)).toBeUndefined()
    expect(mem.getResult(used.id)).toBeDefined()
  })
})

describe("review jobs for memories", () => {
  test("/remember without new messages runs memorysmith alone", async () => {
    const { reviewSession } = await import("../../src/core/reviewer")
    const ctx = makeCtx()
    const msgs: Msg[] = [
      { info: { id: "m1", sessionID: "ses_rm", role: "user", agent: "build" }, parts: [{ type: "text", text: "Hallo" }] } as any,
      { info: { id: "m2", sessionID: "ses_rm", role: "assistant", time: { created: 1, completed: 2 } }, parts: [{ type: "text", text: "Hi" }] } as any,
    ]
    ;(ctx as any).client = { session: { get: async () => ({ data: { id: "ses_rm", title: "x" } }), messages: async () => ({ data: msgs }) } }
    ctx.sessions.update("ses_rm", ctx.directory, (s) => {
      s.lastReviewedMessageID = "m2"
      s.rememberNotes = ["Deployments nur dienstags"]
    })
    const job = { sessionID: "ses_rm", directory: ctx.directory, reason: "remember" as const, enqueuedAt: new Date().toISOString(), attempts: 0, force: true }
    await reviewSession(ctx, job)
    const { readFileSync, existsSync } = await import("node:fs")
    const { join } = await import("node:path")
    const file = join(ctx.store.stateDir, "journal.jsonl")
    const runs = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []
    // the fake client cannot run an agent – but exactly memorysmith was attempted
    expect(runs.map((r: any) => r.smith)).toEqual(["memorysmith"])
    // without notes and without new messages nothing runs
    ctx.sessions.update("ses_rm", ctx.directory, (s) => {
      s.rememberNotes = []
    })
    expect((await reviewSession(ctx, job)).outcome).toBe("skipped")
  })
})
