import { describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BODY, makeCtx, makeRun, tmp } from "./helpers"

const DESC = "Reset Kafka consumer group offsets safely (kafka-consumer-groups)"

describe("ops: create + recurrence gate", () => {
  test("create requires evidence", async () => {
    const ctx = makeCtx()
    const run = makeRun(ctx)
    await expect(ctx.ops.create(run, "skill", { name: "kafka-offset-reset", description: DESC, body: BODY })).rejects.toThrow(/evidence/)
  })

  test("user_quote must appear verbatim in user text", async () => {
    const ctx = makeCtx()
    const run = makeRun(ctx, "reviewer", { userText: "Bitte merk dir das als Skill: Offsets immer mit --execute zurücksetzen." })
    await expect(
      ctx.ops.create(run, "skill", { name: "kafka-offset-reset", description: DESC, body: BODY, userQuote: "make this a skill please" }),
    ).rejects.toThrow(/does not appear/)
    const msg = await ctx.ops.create(run, "skill", {
      name: "kafka-offset-reset",
      description: DESC,
      body: BODY,
      reason: "user asked",
      userQuote: "merk dir das als Skill",
    })
    expect(msg).toContain("created")
    const rec = ctx.store.getOwned("skill", "kafka-offset-reset")!
    expect(rec.tier).toBe("active")
    expect(rec.meta?.createdBy).toBe("reviewer")
    expect(rec.meta?.origin?.sessionID).toBe("ses_test_1")
    expect(readFileSync(rec.file, "utf8")).toContain('description: "Reset Kafka consumer group offsets safely (kafka-consumer-groups)"')
    expect([...run.touched].sort()).toEqual(["meta/skill/kafka-offset-reset.json", "skills/active/kafka-offset-reset"])
  })

  test("candidate gate counts distinct sessions", async () => {
    const ctx = makeCtx()
    const r1 = makeRun(ctx, "reviewer", { sessionID: "ses_a" })
    const note = await ctx.ops.note(r1, "skill", { summary: "Reset Kafka offsets with the CLI and --execute", keywords: ["kafka", "offset"] })
    expect(note).toContain("seen in 1 session")
    const id = ctx.store.candidates("skill")[0].id
    const r2 = makeRun(ctx, "reviewer", { sessionID: "ses_a" })
    await expect(ctx.ops.create(r2, "skill", { name: "kafka-offset-reset", description: DESC, body: BODY, candidateId: id })).rejects.toThrow(/1 session/)
    const r3 = makeRun(ctx, "reviewer", { sessionID: "ses_b" })
    const again = await ctx.ops.note(r3, "skill", { summary: "Kafka offsets reset with CLI using --execute", keywords: ["kafka", "offset", "reset"] })
    expect(again).toContain("qualifies")
    const msg = await ctx.ops.create(r3, "skill", { name: "kafka-offset-reset", description: DESC, body: BODY, candidateId: id })
    expect(msg).toContain("created")
    expect(ctx.store.candidate("skill", id)?.promotedTo).toBe("kafka-offset-reset")
  })

  test("limits, duplicates, validation and secret scan", async () => {
    const ctx = makeCtx({ recurrenceMinSessions: 1 })
    const run = makeRun(ctx)
    await ctx.ops.create(run, "skill", { name: "first-skill", description: DESC, body: BODY })
    await expect(ctx.ops.create(run, "skill", { name: "second-skill", description: DESC, body: BODY })).rejects.toThrow(/new-entry limit/)
    const run2 = makeRun(ctx)
    await expect(ctx.ops.create(run2, "skill", { name: "first-skill", description: DESC, body: BODY })).rejects.toThrow(/already exists/)
    await expect(ctx.ops.create(run2, "skill", { name: "Bad Name", description: DESC, body: BODY })).rejects.toThrow(/kebab/)
    await expect(
      ctx.ops.create(run2, "skill", { name: "leaky-skill", description: DESC, body: BODY + "\n\npassword=Sommer2024!" }),
    ).rejects.toThrow(/sensitive/)
  })

  test("curator cannot create", async () => {
    const ctx = makeCtx({ recurrenceMinSessions: 1 })
    await expect(ctx.ops.create(makeRun(ctx, "curator"), "skill", { name: "x-y", description: DESC, body: BODY })).rejects.toThrow(/curator/)
  })
})

describe("ops: patch / rewrite / move / merge / pin", () => {
  async function seeded() {
    const ctx = makeCtx({ recurrenceMinSessions: 1 })
    const r = makeRun(ctx)
    await ctx.ops.create(r, "skill", { name: "kafka-offset-reset", description: DESC, body: BODY })
    return ctx
  }

  test("patch replaces exactly once and checks concurrency", async () => {
    const ctx = await seeded()
    const run = makeRun(ctx)
    await ctx.ops.patch(run, "skill", { name: "kafka-offset-reset", oldText: "stop consumers first", newText: "stop all consumers first", reason: "clarify" })
    expect(ctx.store.getOwned("skill", "kafka-offset-reset")!.body).toContain("stop all consumers first")
    await expect(ctx.ops.patch(run, "skill", { name: "kafka-offset-reset", oldText: "does not exist", newText: "x" })).rejects.toThrow(/not found/)
    await expect(ctx.ops.patch(run, "skill", { name: "kafka-offset-reset", oldText: "--", newText: "x" })).rejects.toThrow(/occurs/)
    const meta = ctx.store.readMeta("skill", "kafka-offset-reset")!
    expect(meta.history.map((h) => h.action)).toEqual(["create", "patch"])
  })

  test("rewrite honours base_version", async () => {
    const ctx = await seeded()
    const run = makeRun(ctx)
    await expect(
      ctx.ops.update(run, "skill", { name: "kafka-offset-reset", body: BODY + "\n- extra", baseVersion: "deadbeef0000" }, "rewrite"),
    ).rejects.toThrow(/changed since/)
    const v = ctx.store.getOwned("skill", "kafka-offset-reset")!.version
    await ctx.ops.update(run, "skill", { name: "kafka-offset-reset", body: BODY + "\n- extra pitfall", baseVersion: v, description: "New desc for kafka offsets" }, "rewrite")
    const rec = ctx.store.getOwned("skill", "kafka-offset-reset")!
    expect(rec.description).toBe("New desc for kafka offsets")
    expect(rec.body).toContain("extra pitfall")
  })

  test("move between tiers and pin protection", async () => {
    const ctx = await seeded()
    const run = makeRun(ctx, "command", { limits: { maxNew: 0, maxChanges: 100, maxNotes: 0 } })
    await ctx.ops.pin(run, "skill", "kafka-offset-reset", true)
    await expect(ctx.ops.move(run, "skill", { name: "kafka-offset-reset", to: "archive", kind: "archive" })).rejects.toThrow(/pinned/)
    await ctx.ops.pin(run, "skill", "kafka-offset-reset", false)
    await ctx.ops.move(run, "skill", { name: "kafka-offset-reset", to: "dormant", kind: "dormant", reason: "test" })
    expect(ctx.store.getOwned("skill", "kafka-offset-reset")!.tier).toBe("dormant")
    expect([...run.touched]).toContain("skills/dormant/kafka-offset-reset")
    expect([...run.touched]).toContain("skills/active/kafka-offset-reset")
    await ctx.ops.move(run, "skill", { name: "kafka-offset-reset", to: "active", kind: "restore" })
    expect(ctx.store.getOwned("skill", "kafka-offset-reset")!.tier).toBe("active")
  })

  test("merge archives absorbed skills", async () => {
    const ctx = makeCtx({ recurrenceMinSessions: 1 })
    for (const name of ["kafka-offset-reset", "kafka-lag-check"]) {
      await ctx.ops.create(makeRun(ctx), "skill", { name, description: DESC, body: BODY })
    }
    const run = makeRun(ctx, "curator", { limits: { maxNew: 0, maxChanges: 5, maxNotes: 0 } })
    const msg = await ctx.ops.merge(run, "skill", {
      sources: ["kafka-offset-reset", "kafka-lag-check"],
      target: "kafka-consumer-operations",
      description: "Kafka consumer group operations: offsets and lag",
      body: BODY,
      reason: "overlap",
    })
    expect(msg).toContain("merged")
    expect(ctx.store.getOwned("skill", "kafka-consumer-operations")!.tier).toBe("active")
    expect(ctx.store.getOwned("skill", "kafka-offset-reset")!.tier).toBe("archive")
    expect(ctx.store.getOwned("skill", "kafka-offset-reset")!.meta?.absorbedInto).toBe("kafka-consumer-operations")
  })

  test("stage and shadow modes do not write", async () => {
    const ctx = makeCtx({ recurrenceMinSessions: 1, writeMode: "stage" })
    const run = makeRun(ctx)
    const msg = await ctx.ops.create(run, "skill", { name: "staged-skill", description: DESC, body: BODY })
    expect(msg).toContain("staged")
    expect(ctx.store.getOwned("skill", "staged-skill")).toBeUndefined()
    const staged = ctx.ops.staged()
    expect(staged).toHaveLength(1)
    const cmd = makeRun(ctx, "command", { limits: { maxNew: 0, maxChanges: 100, maxNotes: 0 } })
    await ctx.ops.applyStaged(cmd, staged[0])
    expect(ctx.store.getOwned("skill", "staged-skill")?.tier).toBe("active")
    expect(ctx.ops.staged()).toHaveLength(0)

    const shadow = makeCtx({ recurrenceMinSessions: 1, writeMode: "shadow" })
    const sr = makeRun(shadow)
    expect(await shadow.ops.create(sr, "skill", { name: "shadow-skill", description: DESC, body: BODY })).toContain("shadow")
    expect(shadow.store.getOwned("skill", "shadow-skill")).toBeUndefined()
    expect(readFileSync(shadow.ops.shadowFile, "utf8")).toContain("shadow-skill")
  })
})

describe("foreign skills", () => {
  test("indexed read-only and adoptable from global folders", async () => {
    const ctx = makeCtx({ recurrenceMinSessions: 1 })
    const globalDir = join(tmp(), "agents-skills")
    const projectDir = join(tmp(), "project-skills")
    mkdirSync(join(globalDir, "team-conventions"), { recursive: true })
    writeFileSync(join(globalDir, "team-conventions", "SKILL.md"), "---\nname: team-conventions\ndescription: Team code conventions\n---\nUse spaces.")
    mkdirSync(join(projectDir, "repo-build"), { recursive: true })
    writeFileSync(join(projectDir, "repo-build", "SKILL.md"), "---\nname: repo-build\ndescription: Build this repo with gradle\n---\nRun gradle.")
    ctx.store.setForeignRoots(() => [
      { root: globalDir, label: "~/.agents/skills", adoptable: true },
      { root: projectDir, label: "project", adoptable: false },
    ])
    expect(ctx.store.listForeign().map((s) => s.name)).toEqual(["repo-build", "team-conventions"])
    const run = makeRun(ctx)
    await expect(ctx.ops.patch(run, "skill", { name: "team-conventions", oldText: "Use", newText: "Prefer" })).rejects.toThrow(/foreign/)
    const cmd = makeRun(ctx, "command", { limits: { maxNew: 0, maxChanges: 100, maxNotes: 0 } })
    await expect(ctx.ops.adopt(cmd, "repo-build")).rejects.toThrow(/cannot be adopted/)
    await ctx.ops.adopt(cmd, "team-conventions")
    expect(ctx.store.getOwned("skill", "team-conventions")?.tier).toBe("active")
    expect(ctx.store.listForeign().map((s) => s.name)).toEqual(["repo-build"])
  })
})

describe("concurrent runs", () => {
  test("a run waits for another run's uncommitted change on the same candidate/skill", async () => {
    const ctx = makeCtx({ recurrenceMinSessions: 1, maxChangesPerReview: 10 }, {}, { checkClaims: true, claimWait: { agent: 3000, command: 200 } })
    await ctx.git.init()
    const a = makeRun(ctx, "reviewer", { sessionID: "ses_a" })
    const b = makeRun(ctx, "reviewer", { sessionID: "ses_b" })
    await ctx.ops.note(a, "skill", { summary: "Reset Kafka offsets with the CLI and --execute", keywords: ["kafka", "offset"] })
    let bDone = false
    const pending = ctx.ops.note(b, "skill", { summary: "Kafka offsets reset with CLI using --execute", keywords: ["kafka", "offset", "reset"] }).then((m) => {
      bDone = true
      return m
    })
    await new Promise((r) => setTimeout(r, 300))
    expect(bDone).toBe(false) // blocked by a's uncommitted candidate
    const commitA = await ctx.git.commitRun(a)
    ctx.store.unregisterRun(a)
    expect(await pending).toContain("seen in 2 session")
    const commitB = await ctx.git.commitRun(b)
    ctx.store.unregisterRun(b)
    expect(commitA).toBeTruthy()
    expect(commitB).toBeTruthy()
    expect(commitA).not.toBe(commitB)

    // commands give up quickly with a clear message
    const c = makeRun(ctx, "reviewer", { sessionID: "ses_c" })
    await ctx.ops.create(c, "skill", { name: "kafka-offset-reset", description: DESC, body: BODY })
    const cmd = makeRun(ctx, "command", { limits: { maxNew: 0, maxChanges: 100, maxNotes: 0 } })
    await expect(ctx.ops.pin(cmd, "skill", "kafka-offset-reset", true)).rejects.toThrow(/concurrent run/)
    ctx.store.unregisterRun(c)
    expect(await ctx.ops.pin(cmd, "skill", "kafka-offset-reset", true)).toContain("pinned")
  })
})
