import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { Curator } from "../../src/core/curator"
import { HintEngine } from "../../src/core/hints"
import { ReviewQueue } from "../../src/core/queue"
import { completedPrefix } from "../../src/core/reviewer"
import { buildTranscript, sliceUnreviewed, type Msg } from "../../src/core/transcript"
import { readJson, writeJsonAtomic } from "../../src/util/fs"
import { BODY, makeCtx, makeRun } from "./helpers"

let n = 0
const user = (text: string, extra: Partial<Msg["info"]> = {}): Msg => ({
  info: { id: `msg_${String(++n).padStart(4, "0")}`, sessionID: "ses_1", role: "user", agent: "build", ...extra },
  parts: [{ type: "text", text }],
})
const assistant = (parts: Msg["parts"], completed = true): Msg => ({
  info: { id: `msg_${String(++n).padStart(4, "0")}`, sessionID: "ses_1", role: "assistant", time: { created: 1, ...(completed ? { completed: 2 } : {}) } },
  parts,
})
const tool = (name: string, input: Record<string, unknown>, state: { status: string; output?: string; error?: string; metadata?: any }) => ({
  type: "tool",
  tool: name,
  callID: `c${++n}`,
  state: { input, ...state },
})

describe("transcript + feedback", () => {
  const messages: Msg[] = [
    user("Setz die Offsets der Gruppe billing zurück, password=Geheim42"),
    assistant([
      tool("skill", { name: "kafka-offset-reset" }, { status: "completed", output: "..." }),
      tool("bash", { command: "kafka-consumer-groups --reset --group billing" }, { status: "completed", output: "Error: unknown option --reset", metadata: { exit: 1 } }),
      tool("bash", { command: "kafka-consumer-groups --reset-offsets --group billing --execute" }, { status: "completed", output: "done", metadata: { exit: 0 } }),
      { type: "text", text: "Erledigt." },
    ]),
    user("Nein, stattdessen bitte immer erst --dry-run"),
    assistant([tool("read", { filePath: "/x/y.ts" }, { status: "error", error: "File not found" })]),
    user("[skillsmith] Output the following text exactly"),
  ]

  test("renders compact, redacted transcript with tool outcomes", () => {
    const t = buildTranscript(messages, { maxChars: 10000, redact: (s) => s.replace(/password=\S+/g, "password=[REDACTED]") })
    expect(t.userMessages).toBe(2)
    expect(t.toolCalls).toBe(4)
    expect(t.errors).toBe(2)
    expect(t.text).toContain("[U1]")
    expect(t.text).toContain("· bash kafka-consumer-groups --reset --group billing → ERROR exit 1")
    expect(t.text).toContain("· read filePath=/x/y.ts → ERROR File not found")
    expect(t.text).not.toContain("Geheim42")
    expect(t.text).not.toContain("[skillsmith]")
    expect(t.lastMessageID).toBe(messages[messages.length - 1].info.id)
  })

  test("feedback links errors, recovery and corrections to the loaded skill", () => {
    const t = buildTranscript(messages, { maxChars: 10000, redact: (s) => s })
    expect(t.loads).toHaveLength(1)
    const load = t.loads[0]
    expect(load.skill).toBe("kafka-offset-reset")
    expect(load.errors[0]).toContain("unknown option --reset")
    expect(load.recovered[0]).toContain("--reset-offsets")
    expect(load.userCorrection).toContain("stattdessen")
  })

  test("budget keeps the newest blocks", () => {
    const many: Msg[] = []
    for (let i = 0; i < 50; i++) many.push(user(`message number ${i} ${"x".repeat(200)}`))
    const t = buildTranscript(many, { maxChars: 2000, redact: (s) => s })
    expect(t.text.length).toBeLessThanOrEqual(2100)
    expect(t.text).toContain("message number 49")
    expect(t.text).not.toContain("message number 0 ")
    expect(t.omitted).toBeGreaterThan(0)
  })

  test("slicing and completed prefix", () => {
    const m = [user("a"), assistant([{ type: "text", text: "b" }]), user("c"), assistant([{ type: "text", text: "d" }], false)]
    expect(sliceUnreviewed(m, m[1].info.id).map((x) => x.info.id)).toEqual([m[2].info.id, m[3].info.id])
    expect(completedPrefix(m).map((x) => x.info.id)).toEqual([m[0].info.id, m[1].info.id])
    expect(sliceUnreviewed(m, "msg_0000").length).toBe(4)
  })
})

describe("curator lifecycle", () => {
  async function setup(options: Record<string, unknown> = {}) {
    const ctx = makeCtx({ recurrenceMinSessions: 1, maxChangesPerReview: 20, ...options })
    for (const name of ["alpha-skill", "beta-skill", "gamma-skill"]) {
      await ctx.ops.create(makeRun(ctx, "reviewer", { limits: { maxNew: 5, maxChanges: 20, maxNotes: 5 } }), "skill", { name, description: `${name} does things`, body: BODY })
    }
    return ctx
  }
  const age = (ctx: ReturnType<typeof makeCtx>, name: string, days: number) => {
    const file = join(ctx.store.metaDir, "skill", `${name}.json`)
    const meta = readJson<any>(file, {})
    const t = new Date(Date.now() - days * 86_400_000).toISOString()
    meta.createdAt = meta.updatedAt = meta.tierChangedAt = t
    writeJsonAtomic(file, meta)
    ctx.store.bump()
  }

  test("stale → dormant → archive, pinned skipped, reactivation on use", async () => {
    const ctx = await setup()
    age(ctx, "alpha-skill", 20)
    age(ctx, "beta-skill", 20)
    const pin = makeRun(ctx, "command", { limits: { maxNew: 0, maxChanges: 100, maxNotes: 0 } })
    await ctx.ops.pin(pin, "skill", "beta-skill", true)
    const curator = new Curator(ctx)
    expect(curator.planLifecycle().map((m) => `${m.name}:${m.to}`)).toEqual(["alpha-skill:dormant"])
    await curator.lifecycle("test", true)
    expect(ctx.store.getOwned("skill", "alpha-skill")!.tier).toBe("dormant")
    // 70 days idle → archive
    age(ctx, "alpha-skill", 70)
    expect(curator.planLifecycle().map((m) => `${m.name}:${m.to}`)).toEqual(["alpha-skill:archive"])
    // used again → back to active
    ctx.usage.recordLoad("skill", "alpha-skill")
    expect(curator.planLifecycle().map((m) => `${m.name}:${m.kind}`)).toEqual(["alpha-skill:activate"])
  })

  test("active budget demotes least recently used", async () => {
    const ctx = await setup({ activeBudget: { maxSkills: 2, maxChars: 100000 } })
    age(ctx, "gamma-skill", 5)
    age(ctx, "alpha-skill", 3)
    const moves = new Curator(ctx).planLifecycle()
    expect(moves.map((m) => `${m.name}:${m.to}`)).toEqual(["gamma-skill:dormant"])
    expect(moves[0].reason).toContain("budget")
  })

  test("shadow mode only logs lifecycle moves", async () => {
    const ctx = await setup()
    ctx.options.writeMode = "shadow"
    age(ctx, "alpha-skill", 30)
    const res = await new Curator(ctx).lifecycle("test", true)
    expect(res.moves).toBe(0)
    expect(res.planned).toHaveLength(1)
    expect(ctx.store.getOwned("skill", "alpha-skill")!.tier).toBe("active")
  })
})

describe("hints", () => {
  test("hint selection, idempotent injection into the right message", async () => {
    const ctx = makeCtx({ recurrenceMinSessions: 1 })
    await ctx.ops.create(makeRun(ctx), "skill", { name: "kafka-offset-reset", description: "Reset Kafka consumer group offsets", body: BODY })
    const hints = new HintEngine(ctx)
    const msg = user("Wie setze ich die kafka consumer offsets der gruppe zurück?")
    msg.info.sessionID = "ses_h"
    const other = user("Hallo, alles gut?")
    other.info.sessionID = "ses_h"
    expect(await hints.onUserMessage("ses_h", msg.info.id, "Wie setze ich die kafka consumer offsets der gruppe zurück?")).toContain("kafka-offset-reset")
    expect(await hints.onUserMessage("ses_h", other.info.id, "Hallo, alles gut?")).toBeUndefined()
    const list = [other, msg]
    expect(await hints.inject(list)).toBe(1)
    expect(await hints.inject(list)).toBe(0)
    expect(msg.parts).toHaveLength(2)
    expect(msg.parts[1].text).toContain("<smith_hints")
    expect(other.parts).toHaveLength(1)
    expect(ctx.usage.get("skill", "kafka-offset-reset").hintsShown).toBe(1)
    hints.onSkillLoaded("ses_h", "kafka-offset-reset")
    expect(ctx.usage.get("skill", "kafka-offset-reset").hintsFollowed).toBe(1)
  })
})

describe("queue", () => {
  test("coalesces per session, runs sessions in parallel, schedules follow-ups", async () => {
    const ctx = makeCtx({ reviewConcurrency: 4 })
    const started: string[] = []
    let concurrent = 0
    let maxConcurrent = 0
    const gates = new Map<string, () => void>()
    const queue = new ReviewQueue(ctx, async (job) => {
      started.push(job.sessionID)
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise<void>((resolve) => gates.set(`${job.sessionID}#${started.filter((s) => s === job.sessionID).length}`, resolve))
      concurrent--
      return { outcome: "done" }
    })
    queue.enqueue("ses_a", "subagent")
    await new Promise((r) => setTimeout(r, 50))
    expect(started).toHaveLength(0) // persisted, but nothing runs before start()
    queue.start()
    queue.enqueue("ses_b", "subagent")
    queue.enqueue("ses_a", "threshold") // coalesced while running → follow-up
    await new Promise((r) => setTimeout(r, 100))
    expect(started.sort()).toEqual(["ses_a", "ses_b"])
    expect(maxConcurrent).toBe(2)
    gates.get("ses_a#1")!()
    await new Promise((r) => setTimeout(r, 150))
    expect(started.filter((s) => s === "ses_a")).toHaveLength(2) // follow-up run
    gates.get("ses_a#2")!()
    gates.get("ses_b#1")!()
    await new Promise((r) => setTimeout(r, 150))
    expect(queue.pending()).toHaveLength(0)
    queue.stop()
  })
})
