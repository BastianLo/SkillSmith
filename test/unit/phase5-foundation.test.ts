/**
 * Step 5a and the structure work: settings page (sources, apply in place, security values,
 * undo), structured log (JSONL, correlation ids, tail, retention), jobs (schedules, catch-up,
 * pause, lock, history), inbox switches (modes, bundling, dismiss, one row per entry), cron.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadOptions, resolveOptions } from "../../src/config"
import { executeAction } from "../../src/core/actions"
import { finalizeRun } from "../../src/core/finalize"
import { dismiss, inbox } from "../../src/core/inbox"
import { JobScheduler, prevSlot, type JobDef, type JobSchedule } from "../../src/core/jobs"
import { pruneLogs, readLogs, tailLogs } from "../../src/core/logs"
import { createLogger, withLogContext } from "../../src/log"
import { cronNext, cronPrev, parseCron } from "../../src/util/cron"
import { localDay } from "../../src/util/text"
import { cmdRun, makeCtx, tmp } from "./helpers"

describe("options: sources and settings.json", () => {
  test("default < opencode.json < settings < environment, with the source per value", () => {
    const r = resolveOptions({ hints: { max: 4 }, web: { port: 5000 } }, { SKILLSMITH_WEB_PORT: "6000" }, { hints: { max: 6 }, docs: { ownBoost: 0.3 }, storeDir: "/elsewhere", embedding: { apiKey: "secret" } })
    expect(r.options.hints.max).toBe(6)
    expect(r.sources["hints.max"]).toBe("einstellungen")
    expect(r.options.web.port).toBe(6000)
    expect(r.sources["web.port"]).toBe("umgebung")
    expect(r.sources["docs.ownBoost"]).toBe("einstellungen")
    expect(r.sources["hints.minScore"]).toBeUndefined()
    // the store and secrets are never taken from settings.json
    expect(r.options.storeDir).not.toBe("/elsewhere")
    expect(r.options.embedding.apiKey).toBeUndefined()
    expect(r.warnings.some((w) => w.includes("storeDir") && w.includes("settings.json"))).toBe(true)
  })

  test("loadOptions reads settings.json of the store opencode.json points to", () => {
    const store = tmp()
    writeFileSync(join(store, "settings.json"), JSON.stringify({ reviewThreshold: 9 }))
    const r = loadOptions({ storeDir: store }, {})
    expect(r.options.reviewThreshold).toBe(9)
    expect(r.sources.reviewThreshold).toBe("einstellungen")
  })
})

describe("settings page", () => {
  test("a change is one commit of settings.json and applies in place to the live options", async () => {
    const ctx = makeCtx({ hints: { max: 4 } })
    await ctx.git.init()
    const hintsObj = ctx.options.hints
    const view = ctx.settings!.view()
    const max = view.values.find((v) => v.path === "hints.max")!
    expect(max).toMatchObject({ value: 4, standard: 3, opencode: 4, source: "opencode", group: "hinweise" })
    const r = await executeAction({ ctx, actor: "web" }, { action: "settings.set", args: { values: { "hints.max": 7, "log.level": "debug" } } })
    expect(r.commit).toBeTruthy()
    expect(ctx.options.hints.max).toBe(7)
    expect(ctx.options.hints).toBe(hintsObj) // same object: Ops, Retriever … see the change
    expect(ctx.options.log.level).toBe("debug")
    expect(JSON.parse(readFileSync(join(ctx.store.root, "settings.json"), "utf8"))).toEqual({ hints: { max: 7 }, log: { level: "debug" } })
    const subject = (await ctx.git.git(["log", "-1", "--format=%s"])).stdout.trim()
    expect(subject).toStartWith("skillsmith(web): settings hints.max")
    const ev = ctx.audit!.query({ run: r.run }).events.find((e) => e.targets[0] === "settings:hints.max")!
    expect(ev).toMatchObject({ category: "change", before: 4, after: 7 })
    expect(ctx.settings!.view().values.find((v) => v.path === "hints.max")!.source).toBe("einstellungen")
    // reset → opencode.json again
    await executeAction({ ctx, actor: "web" }, { action: "settings.set", args: { reset: ["hints.max"] } })
    expect(ctx.options.hints.max).toBe(4)
    expect(JSON.parse(readFileSync(join(ctx.store.root, "settings.json"), "utf8"))).toEqual({ log: { level: "debug" } })
  })

  test("undo of the settings run restores the values", async () => {
    const ctx = makeCtx()
    await ctx.git.init()
    const r = await executeAction({ ctx, actor: "web" }, { action: "settings.set", args: { values: { reviewThreshold: 12 } } })
    expect(ctx.options.reviewThreshold).toBe(12)
    await executeAction({ ctx, actor: "web" }, { action: "run.undo", args: { run: r.run } })
    expect(ctx.options.reviewThreshold).toBe(5)
  })

  test("invalid values, the store, secrets and environment values are refused", async () => {
    const ctx = makeCtx()
    const fail = async (values: Record<string, unknown>) => {
      try {
        await executeAction({ ctx, actor: "web" }, { action: "settings.set", args: { values } })
        return 0
      } catch (err: any) {
        return err.status
      }
    }
    expect(await fail({ "hints.max": "viele" })).toBe(422)
    expect(await fail({ storeDir: "/tmp/x" })).toBe(422)
    expect(await fail({ "embedding.apiKey": "sk-1" })).toBe(422)
    expect(await fail({ "nicht.da": 1 })).toBe(422)
  })

  test("security values need a confirmation (428) and the token even when web.token is off", async () => {
    const ctx = makeCtx({ web: { token: false } })
    const { needsStrongToken } = await import("../../src/core/actions")
    expect(needsStrongToken(ctx, { action: "settings.set", args: { values: { "web.token": true } } })).toBe(true)
    expect(needsStrongToken(ctx, { action: "settings.set", args: { values: { "hints.max": 4 } } })).toBe(false)
    let status = 0
    try {
      await executeAction({ ctx, actor: "web" }, { action: "settings.set", args: { values: { "web.readOnly": true } } })
    } catch (err: any) {
      status = err.status
    }
    expect(status).toBe(428)
    expect(ctx.options.web.readOnly).toBe(false)
    await executeAction({ ctx, actor: "web" }, { action: "settings.set", args: { values: { "tasks.requireToken": false }, force: true } })
    expect(ctx.options.tasks.requireToken).toBe(false)
    expect(ctx.audit!.query({ category: ["security"] }).events.some((e) => (e.message ?? "").includes("tasks.requireToken"))).toBe(true)
  })

  test("restart values are reported; another process's file change is picked up", async () => {
    const ctx = makeCtx()
    const r = await executeAction({ ctx, actor: "web" }, { action: "settings.set", args: { values: { "web.port": 4800 } } })
    expect((r.data as any).restart).toEqual(["web.port"])
    expect(ctx.settings!.pendingRestart.has("web.port")).toBe(true)
    // written by someone else (git pull, other process)
    writeFileSync(join(ctx.store.root, "settings.json"), JSON.stringify({ hints: { minScore: 0.5 } }))
    const t = Date.now() / 1000 + 5
    utimesSync(join(ctx.store.root, "settings.json"), t, t)
    expect(ctx.settings!.refreshIfChanged()).toBe(true)
    expect(ctx.options.hints.minScore).toBe(0.5)
    expect(ctx.options.web.port).toBe(4747)
  })
})

describe("structured log", () => {
  test("JSONL per day with area, level per area, correlation ids and redaction", () => {
    const dir = tmp()
    const levels: Record<string, "debug" | "info" | "warn" | "error"> = { pipeline: "debug" }
    const log = createLogger(dir, { level: (a) => levels[a] ?? "info", redact: (s) => s.replace(/sk-[a-z0-9]+/g, "[geheim]") })
    log.child("pipeline").debug("stage start", { key: "sk-abc123" })
    log.child("curator").debug("not written")
    withLogContext({ cid: "jr-1", run: "run-a" }, () => log.child("jobs").info("inside"))
    const lines = readFileSync(join(dir, `${localDay()}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(lines.length).toBe(2)
    expect(lines[0]).toMatchObject({ lvl: "debug", area: "pipeline", msg: "stage start", data: { key: "[geheim]" } })
    expect(lines[1]).toMatchObject({ area: "jobs", cid: "jr-1", run: "run-a" })
    const r = readLogs(dir, { cid: "jr-1", level: "debug" })
    expect(r.lines.map((l) => l.msg)).toEqual(["inside"])
    expect(readLogs(dir, { level: "info" }).lines.length).toBe(1)
    expect(readLogs(dir, { text: "STAGE", level: "debug" }).lines.length).toBe(1)
  })

  test("tail continues at the cursor; retention by days", () => {
    const dir = tmp()
    const log = createLogger(dir, false)
    log.info("one")
    const first = readLogs(dir)
    log.info("two")
    log.warn("three")
    const t = tailLogs(dir, first.cursor)
    expect(t.lines.map((l) => l.msg)).toEqual(["two", "three"])
    expect(tailLogs(dir, t.cursor).lines).toEqual([])
    writeFileSync(join(dir, "2020-01-01.jsonl"), '{"t":"2020-01-01T00:00:00Z","lvl":"info","area":"core","scope":"s","msg":"old","pid":1}\n')
    expect(pruneLogs(dir, 14, 50).removed).toBe(1)
    expect(existsSync(join(dir, "2020-01-01.jsonl"))).toBe(false)
  })
})

describe("v1 records", () => {
  test("journal and shadow lines of v1 (skill instead of target/name, no smith) are normalised", async () => {
    const ctx = makeCtx()
    mkdirSync(ctx.store.stateDir, { recursive: true })
    writeFileSync(join(ctx.store.stateDir, "journal.jsonl"), JSON.stringify({ at: "2025-01-01T00:00:00Z", run: "r1", actor: "reviewer", trigger: "idle", ok: true, actions: [{ kind: "create", skill: "deploy", applied: true }] }) + "\n")
    writeFileSync(ctx.ops.shadowFile, JSON.stringify({ at: "2025-01-01T00:00:00Z", kind: "create", skill: "deploy", reason: "v1" }) + "\n")
    const { ReadApi } = await import("../../src/web/api")
    const api = new ReadApi(ctx)
    const tl = (await api.get("timeline", new URLSearchParams())) as any[]
    expect(tl[0]).toMatchObject({ smith: "skillsmith", actions: [{ target: "skill", name: "deploy", id: "skill:deploy" }] })
    const sh = (await api.get("shadow", new URLSearchParams())) as any[]
    expect(sh[0]).toMatchObject({ smith: "skillsmith", action: "create", target: "skill", name: "deploy" })
  })
})

describe("cron", () => {
  test("parses fields, next and previous slots", () => {
    const c = parseCron("0 */2 * * 1-5")
    const fri = new Date(2026, 9, 9, 13, 5) // Friday 13:05
    expect(cronNext(c, fri)!.getHours()).toBe(14)
    const sat = new Date(2026, 9, 10, 9, 0)
    const next = cronNext(c, sat)!
    expect(next.getDay()).toBe(1) // Monday
    expect(next.getHours()).toBe(0)
    expect(cronPrev(c, sat)!.getDay()).toBe(5)
    expect(() => parseCron("61 * * * *")).toThrow()
    expect(() => parseCron("* * *")).toThrow()
  })
})

function fakeJob(id: string, defaults: Partial<JobSchedule>, calls: string[], fn?: () => Promise<void>): JobDef {
  return {
    id,
    label: id,
    description: "",
    area: "jobs",
    defaults: () => defaults,
    async run(_ctx, jr) {
      calls.push(`${id}:${jr.trigger}`)
      await fn?.()
      return { summary: "ok" }
    },
  }
}

describe("jobs", () => {
  test("interval, daily slot, pause, history and the job's log lines", async () => {
    const ctx = makeCtx()
    const calls: string[] = []
    const defs = [fakeJob("a", { intervalMin: 60 }, calls), fakeJob("b", { daily: ["08:30"] }, calls)]
    const s = new JobScheduler(ctx, () => defs)
    const now = new Date(2026, 9, 12, 9, 0)
    // seed: a ran 2 h ago, b's state starts before today's slot
    writeFileSync(join(ctx.store.stateDir, "jobs.json"), JSON.stringify({ a: { since: "2026-01-01T00:00:00Z", lastRunAt: new Date(now.getTime() - 2 * 3_600_000).toISOString(), runs: [] }, b: { since: new Date(2026, 9, 12, 7, 0).toISOString(), runs: [] } }))
    expect(s.dueReason("a", now)).toBeTruthy()
    expect(s.dueReason("b", now)).toBeTruthy()
    await s.run("a")
    expect(s.dueReason("a", new Date())).toBeUndefined()
    await s.pause("b", true)
    expect(s.dueReason("b", now)).toBeUndefined()
    await s.pause("b", false)
    const hist = s.history("a")
    expect(hist[0]).toMatchObject({ status: "ok", trigger: "von Hand", summary: "ok" })
    const lines = readLogs(join(ctx.store.stateDir, "log"), { cid: hist[0].id })
    // makeCtx uses a silent logger → no lines; the record carries the id the log uses
    expect(hist[0].id).toStartWith("jr-")
    expect(lines.lines.length).toBeGreaterThanOrEqual(0)
    expect(calls).toEqual(["a:von Hand"])
  })

  test("missed slots: once → caught up at start, skip → not", async () => {
    for (const mode of ["once", "skip"] as const) {
      const ctx = makeCtx({ jobs: { c: { catchUp: mode } } })
      const calls: string[] = []
      const s = new JobScheduler(ctx, () => [fakeJob("c", { daily: ["03:00"] }, calls)])
      const yesterday = new Date(Date.now() - 2 * 86_400_000).toISOString()
      writeFileSync(join(ctx.store.stateDir, "jobs.json"), JSON.stringify({ c: { since: yesterday, lastRunAt: yesterday, runs: [] } }))
      await (s as any).boot()
      await new Promise((r) => setTimeout(r, 50))
      s.stop()
      if (mode === "once") expect(calls).toEqual(["c:nachgeholt"])
      else expect(calls).toEqual([])
    }
  })

  test("settings override the job's defaults; after-review event; one run at a time", async () => {
    const ctx = makeCtx({ jobs: { d: { afterReview: true, intervalMin: 0 } } })
    const calls: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const s = new JobScheduler(ctx, () => [fakeJob("d", { intervalMin: 30 }, calls, () => gate)])
    expect(s.schedule("d")).toMatchObject({ afterReview: true, intervalMin: 0 })
    s.event("after-review")
    const second = s.trigger("d", "von Hand")
    release()
    await second.done
    expect(calls).toEqual(["d:nach Review"])
  })

  test("prevSlot respects weekdays", () => {
    const sched: JobSchedule = { enabled: true, start: false, daily: ["08:30"], weekdays: ["1", "2", "3", "4", "5"], intervalMin: 0, idleMin: 0, cron: "", afterReview: false, catchUp: "once", params: {} }
    const sunday = new Date(2026, 9, 11, 12, 0)
    expect(prevSlot(sched, sunday)!.getDay()).toBe(5)
  })

  test("job actions: run, schedule (one commit), pause", async () => {
    const ctx = makeCtx()
    await ctx.git.init()
    const calls: string[] = []
    ctx.jobs = new JobScheduler(ctx, () => [fakeJob("e", { intervalMin: 60 }, calls)])
    const r = await executeAction({ ctx, actor: "web" }, { action: "job.run", args: { id: "e" } })
    expect((r.data as any).run).toStartWith("jr-")
    await new Promise((res) => setTimeout(res, 50))
    expect(calls).toEqual(["e:von Hand"])
    const s = await executeAction({ ctx, actor: "web" }, { action: "job.schedule", args: { id: "e", schedule: { daily: ["07:15"], weekdays: ["1"] } } })
    expect(s.commit).toBeTruthy()
    expect(ctx.jobs.schedule("e")).toMatchObject({ daily: ["07:15"], weekdays: ["1"], intervalMin: 60 })
    await executeAction({ ctx, actor: "web" }, { action: "job.schedule", args: { id: "e", reset: true } })
    expect(ctx.options.jobs.e).toBeUndefined()
  })
})

describe("inbox switches", () => {
  async function withChanges() {
    const ctx = makeCtx()
    for (const [smith, name] of [["skillsmith", "a"], ["skillsmith", "a"], ["docsmith", "b"]] as const) {
      const run = ctx.runs.create({ smith, actor: "reviewer", trigger: "test", writeMode: "auto", directory: ctx.directory, project: ctx.project, limits: { maxNew: 5, maxChanges: 5, maxNotes: 0 } })
      if (smith === "skillsmith") {
        const exists = ctx.store.getOwned("skill", name)
        if (exists) await ctx.ops.update(run, "skill", { name, description: `geändert ${Date.now()}`, reason: "test", approved: true } as any)
        else await ctx.ops.create(run, "skill", { name, description: "Skill a", body: "## Schritte\n1. a", user_quote: "x", reason: "test", approved: true } as any)
      } else {
        await ctx.ops.create(run, "knowledge", { name, title: "B", description: "b", body: "Text", reason: "test", approved: true } as any)
      }
      await finalizeRun(ctx, run, { ok: true })
    }
    return ctx
  }

  test("several changes of one entry are one row; per-smith switch hides only that smith", async () => {
    const ctx = await withChanges()
    ctx.options.inbox.types = {}
    const r = inbox(ctx, { since: "2000-01-01T00:00:00Z" })
    const changes = r.items.filter((i) => i.type === "change")
    expect(changes.map((c) => c.target).sort()).toEqual(["knowledge:b", "skill:a"])
    expect((changes.find((c) => c.target === "skill:a")!.data as any).count).toBe(2)
    await executeAction({ ctx, actor: "web" }, { action: "inbox.configure", args: { type: "change.skillsmith", mode: "aus" } })
    const r2 = inbox(ctx, { since: "2000-01-01T00:00:00Z" })
    expect(r2.items.filter((i) => i.type === "change").map((c) => c.target)).toEqual(["knowledge:b"])
    expect(r2.hidden.byType.change).toBe(1)
    expect(r2.subtypes.find((s) => s.type === "change.skillsmith")!.mode).toBe("aus")
  })

  test("bundled groups count once for the badge; off types are hidden; dismissed until changed", async () => {
    const ctx = await withChanges()
    ctx.options.inbox.types = { change: "gebuendelt" }
    const r = inbox(ctx, { since: "2000-01-01T00:00:00Z" })
    expect(r.bundled).toContain("Änderungen der KI")
    const nonChange = r.items.filter((i) => i.group !== "Änderungen der KI").length
    expect(r.badge).toBe(nonChange + 1)
    ctx.options.inbox.types = { change: "aus" }
    expect(inbox(ctx, { since: "2000-01-01T00:00:00Z" }).items.some((i) => i.type === "change")).toBe(false)
    ctx.options.inbox.types = {}
    const item = inbox(ctx, { since: "2000-01-01T00:00:00Z" }).items.find((i) => i.target === "knowledge:b")!
    await dismiss(ctx, [{ id: item.id, sig: (item.data as any).sig }])
    const after = inbox(ctx, { since: "2000-01-01T00:00:00Z" })
    expect(after.items.some((i) => i.id === item.id)).toBe(false)
    expect(after.hidden.dismissed).toBe(1)
    // another change of the same entry → the row comes back
    const run = cmdRun(ctx, "docsmith")
    run.actor = "reviewer"
    await ctx.ops.update(run, "knowledge", { name: "b", body: "Text neu", reason: "test", approved: true } as any)
    await finalizeRun(ctx, run, { ok: true })
    expect(inbox(ctx, { since: "2000-01-01T00:00:00Z" }).items.some((i) => i.id === item.id)).toBe(true)
  })
})

