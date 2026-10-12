/**
 * Step 4a: audit log (hash chain), metrics (two processes, daily sums, retention, no contents,
 * speed), versions and diffs, relevance (node size), links.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AuditLog, chainHash } from "../../src/core/audit"
import { finalizeRun } from "../../src/core/finalize"
import { inlineTags, parseLinks, rewriteLinks } from "../../src/core/links"
import { M, Metrics } from "../../src/core/metrics"
import { pageRank, percentileRanks } from "../../src/core/relevance"
import { loadDatabaseClass } from "../../src/core/vector-store"
import { silentLogger } from "../../src/log"
import { diffLines, parseUnifiedDiff, toHunks } from "../../src/util/diff"
import { BODY, cmdRun, makeCtx, makeRun, tmp } from "./helpers"
import { resolveOptions } from "../../src/config"

const opts = (o: Record<string, unknown> = {}) => resolveOptions({ storeDir: tmp(), ...o }, {}).options

describe("audit log", () => {
  test("every change, rejection and run is an event; the hash chain detects tampering", async () => {
    const ctx = makeCtx()
    const run = cmdRun(ctx, "skillsmith")
    await ctx.ops.create(run, "skill", { name: "kafka-reset", description: "Reset offsets", body: BODY, tags: ["kafka"] })
    run.rejections = [{ at: new Date().toISOString(), tool: "skillsmith_create", target: "dup", message: "a very similar skill entry already exists" }]
    const fin = await finalizeRun(ctx, run, { ok: true })
    expect(fin.commit).toBeTruthy()
    const events = ctx.audit!.query({ run: run.id }).events
    expect(events.map((e) => e.category).sort()).toEqual(["change", "rejected", "run"])
    const change = events.find((e) => e.category === "change")!
    expect(change).toMatchObject({ actor: "user-command", smith: "skillsmith", action: "create", targets: ["skill:kafka-reset"], result: "ok", commit: fin.commit })
    expect(change.afterHash).toBe(ctx.store.getOwned("skill", "kafka-reset")!.version)
    expect(ctx.audit!.forTarget("skill:kafka-reset").length).toBe(1)
    expect(ctx.audit!.verify()).toMatchObject({ ok: true, count: 3 })
    expect(ctx.audit!.rejectedByReason(1)[0].reason).toBe("Duplikat / existiert schon")
    // tamper: change a reason directly in the database
    const Db = loadDatabaseClass()
    const db = new Db(ctx.audit!.file)
    db.query("UPDATE events SET reason = 'manipuliert' WHERE seq = 1").run()
    db.close()
    const v = ctx.audit!.verify()
    expect(v.ok).toBe(false)
    expect(v.firstBad).toBe(1)
    expect(chainHash("", { at: "x" })).toHaveLength(64)
  })

  test("local changes carry before/after; journal import once; export as CSV and JSONL", async () => {
    const ctx = makeCtx()
    const run = makeRun(ctx, "command", { smith: "memorysmith" })
    await ctx.ops.memoryState(run, { goal: "Login", open: ["Logout"], where: ctx.scope(), approved: true } as any)
    await finalizeRun(ctx, run, { ok: true })
    const local = ctx.audit!.query({ category: ["local"] }).events[0]
    expect((local.after as any).goal).toBe("Login")
    expect(local.before).toBeUndefined()
    writeFileSync(join(ctx.store.stateDir, "journal.jsonl"), JSON.stringify({ at: "2026-01-01T00:00:00Z", run: "old-1", smith: "docsmith", actor: "reviewer", trigger: "threshold", ok: true, actions: [{ kind: "create", target: "knowledge", name: "x", applied: true }] }) + "\n")
    const audit2 = new AuditLog(ctx.store.stateDir, ctx.options, silentLogger)
    // first start of a store with an audit db that already holds the journal marker? import happens once
    const n = audit2.importJournal()
    expect(n).toBe(2)
    expect(audit2.importJournal()).toBe(0)
    expect(audit2.export({ run: "old-1" }, "csv")).toContain("knowledge:x")
    expect(audit2.export({ run: "old-1" }, "jsonl").trim().split("\n")).toHaveLength(2)
    expect(audit2.verify().ok).toBe(true)
  })

  test("journal import maps legacy 2.x actions (only `skill`) to a real target – never undefined:undefined", async () => {
    const ctx = makeCtx()
    const dir = tmp()
    writeFileSync(
      join(dir, "journal.jsonl"),
      [
        JSON.stringify({ at: "2026-01-01T00:00:00Z", run: "old-1", smith: "skillsmith", actor: "reviewer", trigger: "idle", ok: true, actions: [{ kind: "create", skill: "my-skill", reason: "r1", applied: true }] }),
        JSON.stringify({ at: "2026-01-01T00:01:00Z", run: "old-2", smith: "docsmith", actor: "reviewer", trigger: "idle", ok: true, actions: [{ kind: "create", reason: "nameless", applied: false }] }),
      ].join("\n") + "\n",
    )
    const audit = new AuditLog(dir, ctx.options, silentLogger)
    expect(audit.importJournal()).toBeGreaterThan(0)
    const events = audit.query({ limit: 100 }).events
    expect(events.some((e) => e.targets[0] === "skill:my-skill")).toBe(true)
    expect(events.every((e) => !(e.targets[0] ?? "").includes("undefined"))).toBe(true)
    expect(audit.verify().ok).toBe(true)
  })

  test("repairTargets rewrites already imported undefined:undefined rows and keeps the chain valid", async () => {
    const ctx = makeCtx()
    const dir = tmp()
    writeFileSync(join(dir, "journal.jsonl"), JSON.stringify({ at: "2026-01-01T00:00:00Z", run: "old-1", smith: "skillsmith", actor: "reviewer", trigger: "idle", ok: true, actions: [{ kind: "create", skill: "my-skill", reason: "r1", applied: true }] }) + "\n")
    const audit = new AuditLog(dir, ctx.options, silentLogger)
    audit.importJournal()
    // simulate the broken first import: overwrite the resolved target with the literal bad id
    const Db = loadDatabaseClass()
    const db = new Db(audit.file)
    db.query("UPDATE events SET targets = ? WHERE category = 'change'").run(JSON.stringify(["undefined:undefined"]))
    db.query("UPDATE event_targets SET target = 'undefined:undefined'").run()
    db.close()
    expect(audit.repairTargets()).toBe(1)
    expect(audit.forTarget("skill:my-skill").length).toBe(1)
    expect(audit.verify().ok).toBe(true)
    expect(audit.repairTargets()).toBe(0)
  })

  test("the store never crashes on an unknown kind from audit targets or links", () => {
    const ctx = makeCtx()
    expect(ctx.store.list("undefined" as any)).toEqual([])
    expect(ctx.store.getOwned("undefined" as any, "x")).toBeUndefined()
    expect(ctx.store.fresh("undefined" as any, "x")).toBeUndefined()
  })
})

describe("metrics", () => {
  test("two processes write at the same time; daily sums equal the raw events", async () => {
    const dir = tmp()
    const o = opts({ metrics: { flushMs: 200 } })
    const script = join(dir, "writer.ts")
    writeFileSync(
      script,
      `import { Metrics } from ${JSON.stringify(join(import.meta.dir, "../../src/core/metrics"))}
import { resolveOptions } from ${JSON.stringify(join(import.meta.dir, "../../src/config"))}
import { silentLogger } from ${JSON.stringify(join(import.meta.dir, "../../src/log"))}
const o = resolveOptions({ storeDir: process.argv[2], metrics: { flushMs: 200 } }, {}).options
const m = new Metrics(process.argv[2], o, silentLogger)
for (let i = 0; i < 400; i++) { m.record({ type: "entry.load", entry: "skill:x", session: "s" + (i % 7), value: 1 }); if (i % 50 === 0) await m.flush() }
await m.flush(); m.close()
`,
    )
    const procs = [0, 1].map(() => Bun.spawn(["bun", script, dir], { stdout: "pipe", stderr: "pipe" }))
    const codes = await Promise.all(procs.map((p) => p.exited))
    expect(codes).toEqual([0, 0])
    const m = new Metrics(dir, o, silentLogger)
    expect(m.events({ entry: "skill:x", limit: 10_000 })).toHaveLength(800)
    expect(m.totals("skill:x")[M.load]).toBe(800)
    const s = m.series({ entry: "skill:x", types: [M.load], days: 7 })
    expect(s.series[M.load].reduce((a, b) => a + b, 0)).toBe(800)
    m.close()
  })

  test("retention keeps daily sums; contents never reach the database; one year of data is fast", async () => {
    const dir = tmp()
    const o = opts({ metrics: { rawDays: 30 } })
    const m = new Metrics(dir, o, silentLogger)
    const now = Date.now()
    const DAY = 86_400_000
    // one year of synthetic events
    for (let d = 0; d < 365; d++) {
      for (let i = 0; i < 40; i++) {
        m.record({ at: now - d * DAY - i * 60_000, type: i % 3 ? M.toolCall : M.load, entry: i % 3 ? `tool:t${i % 9}` : `skill:s${i % 13}`, session: `ses${d}`, value: i * 10, extra: i % 5 === 0 ? { error: true } : undefined })
      }
    }
    await m.flush()
    let t = performance.now()
    m.series({ prefix: "skill:", types: [M.load], days: 365 })
    m.grouped(M.toolCall, "entry", now - 365 * DAY, now)
    m.heatmap(365)
    m.calendar(365)
    m.decayedUse(30, { [M.load]: 1 })
    const ms = performance.now() - t
    expect(ms).toBeLessThan(200)
    const before = m.totals("skill:s1")[M.load]
    const pruned = m.prune(now)
    expect(pruned).toBeGreaterThan(0)
    expect(m.totals("skill:s1")[M.load]).toBe(before)
    expect(m.events({ from: 0, to: now - 31 * DAY, limit: 10 })).toHaveLength(0)
    m.close()
    // a secret in tool arguments never reaches the metrics file (only ids, names, numbers)
    const ctx = makeCtx()
    const { MetricEvents } = await import("../../src/host/metric-events")
    const me = new MetricEvents(ctx)
    me.onEvent({ type: "message.part.updated", properties: { part: { type: "tool", callID: "c1", tool: "bash", sessionID: "ses_1", state: { status: "completed", input: { command: "curl -H 'Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789'" }, output: "secret-output-xyz", time: { start: 1, end: 5 } } } } })
    me.onEvent({ type: "message.updated", properties: { info: { id: "m1", role: "assistant", sessionID: "ses_1", mode: "build", providerID: "p", modelID: "m", cost: 0.01, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, completed: 2 } } } })
    await ctx.metrics!.flush()
    const raw = readFileSync(ctx.metrics!.file).toString("latin1")
    expect(raw).not.toContain("ghp_abcdef")
    expect(raw).not.toContain("secret-output")
    expect(ctx.metrics!.events({ types: [M.toolCall] })[0]).toMatchObject({ entry: "tool:bash", value: 4 })
    expect(ctx.metrics!.events({ types: [M.reply] })[0]).toMatchObject({ value: 15, value2: 0.01, model: "p/m" })
  })

  test("usage of entries is recorded with session; background agents never count as use", async () => {
    const ctx = makeCtx()
    ctx.usage.recordLoad("skill", "a", { session: "ses_main" })
    const run = makeRun(ctx, "reviewer")
    ctx.runs.attach(run, "ses_agent")
    ctx.usage.recordLoad("skill", "a", { session: "ses_agent" })
    await ctx.metrics!.flush()
    const ev = ctx.metrics!.events({ entry: "skill:a" })
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ session: "ses_main", origin: "main" })
    ctx.metrics!.importUsageBaseline()
  })
})

describe("versions and diff", () => {
  test("line diff, hunks and unified diff parsing", () => {
    const ops = diffLines("a\nb\nc\nd\ne\nf\ng\nh\ni", "a\nB\nc\nd\ne\nf\ng\nh\ni\nj")
    const hunks = toHunks(ops, 1)
    expect(hunks).toHaveLength(2)
    expect(hunks[0].lines.map((l) => l.type)).toEqual(["eq", "del", "add", "eq"])
    const files = parseUnifiedDiff("diff --git a/x.md b/x.md\nindex 1..2 100644\n--- a/x.md\n+++ b/x.md\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n")
    expect(files[0]).toMatchObject({ path: "x.md", additions: 1, deletions: 1, status: "modified" })
    expect(files[0].hunks[0].lines[2]).toMatchObject({ type: "add", text: "B", newNo: 2 })
  })

  test("versions follow an entry across tiers; semantic diff of fields, body and meta in words", async () => {
    const ctx = makeCtx()
    const run = cmdRun(ctx, "docsmith")
    await ctx.ops.create(run, "knowledge", { name: "t2", title: "T2 Testsystem", description: "Testsystem", body: "## Zugang\n- https://t2.example", tags: ["t2"] })
    await finalizeRun(ctx, run, { ok: true })
    const r2 = cmdRun(ctx, "docsmith")
    await ctx.ops.update(r2, "knowledge", { name: "t2", title: "T2-Testsystem", body: "## Zugang\n- https://t2.example\n- VPN nötig", tags: ["t2", "vpn"], reason: "VPN" })
    await finalizeRun(ctx, r2, { ok: true })
    const r3 = cmdRun(ctx, "docsmith")
    await ctx.ops.move(r3, "knowledge", { name: "t2", to: "archive", kind: "archive", reason: "alt" })
    await finalizeRun(ctx, r3, { ok: true })
    const log = await ctx.versions.log("knowledge", "t2")
    expect(log).toHaveLength(3)
    expect(log[2].markers).toContain("neu")
    expect(log[0].markers).toContain("Stufe")
    expect(log[0].smith).toBe("docsmith")
    const d = await ctx.versions.diff("knowledge", "t2", log[1].hash)
    expect(d.fields.find((f) => f.field === "title")).toMatchObject({ before: "T2 Testsystem", after: "T2-Testsystem" })
    expect(d.fields.find((f) => f.field === "tags")!.added).toEqual(["vpn"])
    expect(d.body.additions).toBe(1)
    expect(d.meta.some((m) => m.startsWith("Verlauf: update"))).toBe(true)
    const tier = await ctx.versions.diff("knowledge", "t2", log[0].hash)
    expect(tier.fields.find((f) => f.field === "tier")).toMatchObject({ before: "aktiv", after: "Archiv" })
    const commit = await ctx.versions.commit(log[1].hash)
    expect(commit.entries.map((e) => e.id)).toEqual(["knowledge:t2"])
    const hist = await ctx.versions.history({ smith: "docsmith" })
    expect(hist.length).toBeGreaterThanOrEqual(3)
    await expect(ctx.versions.diff("knowledge", "t2", "x; rm -rf /")).rejects.toThrow(/invalid revision/)
  })
})

describe("relevance", () => {
  test("PageRank favours nodes important nodes point to; ranks within the kind", () => {
    const pr = pageRank(["a", "b", "c", "d"], [
      { from: "a", to: "c", weight: 1 },
      { from: "b", to: "c", weight: 1 },
      { from: "d", to: "a", weight: 0.2 },
    ])
    expect(pr.get("c")!).toBeGreaterThan(pr.get("a")!)
    expect(pr.get("c")!).toBeGreaterThan(pr.get("d")!)
    const ranks = percentileRanks(new Map([["skill:a", 10], ["skill:b", 1], ["memory:c", 1], ["memory:d", 0]]), (id) => id.split(":")[0])
    expect(ranks.get("skill:a")).toBe(1)
    expect(ranks.get("memory:c")).toBe(1)
    expect(ranks.get("memory:d")).toBe(0)
  })

  test("graph nodes carry size, ring and explanation", async () => {
    const ctx = makeCtx()
    const run = cmdRun(ctx, "skillsmith")
    await ctx.ops.create(run, "skill", { name: "kafka-reset", description: "Reset", body: BODY })
    await ctx.ops.create(run, "skill", { name: "other-skill", description: "Other", body: BODY })
    for (let i = 0; i < 4; i++) ctx.usage.recordLoad("skill", "kafka-reset", { session: `s${i}` })
    await ctx.metrics!.flush()
    const g = (await ctx.web!.api("graph", new URLSearchParams())) as any
    const a = g.nodes.find((n: any) => n.id === "skill:kafka-reset")
    const b = g.nodes.find((n: any) => n.id === "skill:other-skill")
    expect(a.size).toBeGreaterThan(b.size)
    expect(a.explain).toContain("in 4 Sessions")
  })
})

describe("links", () => {
  test("parse, tags, task ids, rewrite on rename", () => {
    const links = parseLinks("Siehe [[auth-gateway]] und [[skill:git-rebase|Rebase]], [[Doku#Setup]] sowie T-12. `[[nicht]]`")
    expect(links.map((l) => l.target)).toEqual(["auth-gateway", "skill:git-rebase", "Doku", "task:T-12"])
    expect(links[1].label).toBe("Rebase")
    expect(links[2].section).toBe("Setup")
    expect(inlineTags("# Titel\nText #deploy und #kafka-ops, nicht#x")).toEqual(["deploy", "kafka-ops"])
    expect(rewriteLinks("[[a-b]] [[knowledge:a-b|x]] [[a-bc]]", "knowledge", "a-b", "neu").text).toBe("[[neu]] [[knowledge:neu|x]] [[a-bc]]")
  })

  test("resolve by name, title and alias; backlinks, mentions, broken links; derived edge", async () => {
    const ctx = makeCtx()
    const run = cmdRun(ctx, "docsmith")
    await ctx.ops.create(run, "knowledge", { name: "auth-gateway", title: "Auth-Gateway", description: "Gateway", body: "## A\n- prüft", fields: { aliases: ["Gateway"] } })
    await ctx.ops.create(run, "knowledge", { name: "login", title: "Login", description: "Login", body: "## B\nNutzt [[Auth-Gateway]] und [[gibt-es-nicht]]." })
    await ctx.ops.create(run, "knowledge", { name: "betrieb", title: "Betrieb", description: "Betrieb", body: "## C\nDas Gateway muss laufen." })
    expect(ctx.links.resolve("Gateway")?.id).toBe("knowledge:auth-gateway")
    expect(ctx.links.backlinksOf("knowledge:auth-gateway").map((b) => b.from)).toEqual(["knowledge:login"])
    expect(ctx.links.mentionsOf("knowledge:auth-gateway").map((m) => m.from)).toEqual(["knowledge:betrieb"])
    expect(ctx.links.broken().map((b) => b.target)).toEqual(["gibt-es-nicht"])
    expect(ctx.graph.between("knowledge:login", "knowledge:auth-gateway")?.type).toBe("references")
  })
})
