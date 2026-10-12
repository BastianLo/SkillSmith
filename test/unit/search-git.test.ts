import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { commitMessage, parsePorcelain } from "../../src/core/git"
import { BODY, makeCtx, makeRun } from "./helpers"

async function library() {
  const ctx = makeCtx({ recurrenceMinSessions: 1, maxChangesPerReview: 10 })
  const skills = [
    ["kafka-offset-reset", "Reset Kafka consumer group offsets with kafka-consumer-groups", BODY],
    ["db2-explain-plan", "Analyse DB2 Zugriffspfade mit EXPLAIN und db2exfmt", "## Steps\n1. `db2 explain plan for <sql>`\n2. `db2exfmt -d DB -1 -o plan.txt`\n\n## Pitfalls\n- Explain-Tabellen müssen existieren (EXPLAIN.DDL)."],
    ["react-form-validation", "Validate React forms with react-hook-form and zod", "## Steps\n1. useForm with zodResolver\n2. register fields"],
    ["sparkasse-ueberweisung-api", "Überweisungsschnittstelle (SEPA) der Sparkassen-API aufrufen", "## Steps\n1. POST /ueberweisungen mit IBAN-Platzhalter <IBAN>"],
  ] as const
  for (const [name, description, body] of skills) {
    await ctx.ops.create(makeRun(ctx), "skill", { name, description, body })
  }
  return ctx
}

describe("search", () => {
  test("ranks relevant skills first (DE/EN, umlauts, compounds)", async () => {
    const ctx = await library()
    expect(ctx.index.search("how do I reset kafka offsets")[0].name).toBe("kafka-offset-reset")
    expect(ctx.index.search("DB2 Zugriffspfad analysieren explain")[0].name).toBe("db2-explain-plan")
    expect(ctx.index.search("Überweisung über die API")[0].name).toBe("sparkasse-ueberweisung-api")
    expect(ctx.index.search("ueberweisungen")[0].name).toBe("sparkasse-ueberweisung-api")
    const hit = ctx.index.search("react hook form zod validation")[0]
    expect(hit.name).toBe("react-form-validation")
    expect(hit.confidence).toBeGreaterThan(0.5)
    expect(ctx.index.search("completely unrelated banana")).toHaveLength(0)
  })

  test("tier filters, archive opt-in and live updates", async () => {
    const ctx = await library()
    const cmd = makeRun(ctx, "command", { limits: { maxNew: 0, maxChanges: 100, maxNotes: 0 } })
    await ctx.ops.move(cmd, "skill", { name: "kafka-offset-reset", to: "archive", kind: "archive" })
    expect(ctx.index.search("kafka offsets").map((h) => h.name)).not.toContain("kafka-offset-reset")
    const withArchive = ctx.index.search("kafka offsets", { includeArchived: true })
    expect(withArchive[0].name).toBe("kafka-offset-reset")
    expect(withArchive[0].tier).toBe("archive")
  })

  test("clusters similar skills", async () => {
    const ctx = makeCtx({ recurrenceMinSessions: 1, maxChangesPerReview: 10 })
    const a = BODY
    const b = BODY.replace("--to-earliest", "--to-latest") + "\n- Use --dry-run first."
    await ctx.ops.create(makeRun(ctx), "skill", { name: "kafka-offset-reset", description: "Reset Kafka consumer offsets", body: a })
    await ctx.ops.create(makeRun(ctx), "skill", { name: "kafka-offsets-latest", description: "Reset Kafka consumer offsets to latest", body: b })
    await ctx.ops.create(makeRun(ctx), "skill", { name: "react-form-validation", description: "Validate React forms", body: "## Steps\n1. useForm" })
    const clusters = ctx.index.clusters(["kafka-offset-reset", "kafka-offsets-latest", "react-form-validation"], 0.45)
    expect(clusters).toEqual([["kafka-offset-reset", "kafka-offsets-latest"]])
  })
})

describe("git", () => {
  test("one commit per run with only the touched paths; manual edits separate", async () => {
    const ctx = makeCtx({ recurrenceMinSessions: 1 })
    expect(await ctx.git.init()).toBe(true)
    const run = makeRun(ctx, "reviewer", { sessionID: "ses_x", sessionAgent: "build" })
    await ctx.ops.create(run, "skill", { name: "kafka-offset-reset", description: "Reset Kafka offsets", body: BODY, reason: "user asked" })
    // a manual edit elsewhere in the store
    writeFileSync(join(ctx.store.root, "NOTES.md"), "manual notes\n")
    const hash = await ctx.git.commitRun(run)
    expect(hash).toBeTruthy()
    const log = execFileSync("git", ["-C", ctx.store.root, "log", "--format=%s"], { encoding: "utf8" }).trim().split("\n")
    expect(log[0]).toBe("skillsmith(reviewer): create kafka-offset-reset")
    expect(log[1]).toBe("manual: external changes")
    expect(log[2]).toBe("skillsmith: init store")
    const files = execFileSync("git", ["-C", ctx.store.root, "show", "--name-only", "--format=", "HEAD"], { encoding: "utf8" }).trim().split("\n")
    expect(files.sort()).toEqual(["meta/skill/kafka-offset-reset.json", "skills/active/kafka-offset-reset/SKILL.md"])
    const body = execFileSync("git", ["-C", ctx.store.root, "log", "-1", "--format=%b"], { encoding: "utf8" })
    expect(body).toContain(`Run: ${run.id}`)
    expect(body).toContain("Trigger: test · session ses_x · agent build · project project")
    expect(body).toContain("- create kafka-offset-reset: user asked")
    // state/ is never tracked
    const tracked = execFileSync("git", ["-C", ctx.store.root, "ls-files"], { encoding: "utf8" })
    expect(tracked).not.toContain("state/")
  })

  test("no commit when nothing changed; revert of a run", async () => {
    const ctx = makeCtx({ recurrenceMinSessions: 1 })
    await ctx.git.init()
    const empty = makeRun(ctx)
    expect(await ctx.git.commitRun(empty)).toBeUndefined()
    const run = makeRun(ctx)
    await ctx.ops.create(run, "skill", { name: "temp-skill", description: "Temporary skill", body: BODY })
    await ctx.git.commitRun(run)
    const target = await ctx.git.findRunCommit(run.id)
    expect(target?.runId).toBe(run.id)
    const res = await ctx.git.revertToIndex(target!.hash)
    expect(res.ok).toBe(true)
    const undo = makeRun(ctx, "command")
    undo.subject = `skillsmith(command): undo ${run.id}`
    for (const p of res.paths) undo.touched.add(p)
    ctx.store.bump()
    const h = await ctx.git.commitRun(undo)
    expect(h).toBeTruthy()
    expect(ctx.store.getOwned("skill", "temp-skill")).toBeUndefined()
    const subject = execFileSync("git", ["-C", ctx.store.root, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim()
    expect(subject).toBe(`skillsmith(command): undo ${run.id}`)
  })

  test("commit message is deterministic and sorted", () => {
    const ctx = makeCtx()
    const run = makeRun(ctx, "curator")
    run.id = "cur-20260101-000000-abcd"
    run.actions = [
      { kind: "archive", target: "skill", name: "b", applied: true, reason: "old" },
      { kind: "patch", target: "skill", name: "z", applied: true },
      { kind: "create", target: "skill", name: "a", applied: true },
      { kind: "note", target: "skill", name: "cand-1", applied: true },
      { kind: "patch", target: "skill", name: "skipped", applied: false },
    ]
    const m1 = commitMessage(run)
    const m2 = commitMessage({ ...run, actions: [...run.actions].reverse() })
    expect(m1).toBe(m2)
    expect(m1.split("\n")[0]).toBe("skillsmith(curator): create a; patch z; archive b; note cand-1")
    expect(m1).not.toContain("skipped")
  })

  test("porcelain parsing", () => {
    expect(parsePorcelain(" M meta/a.json\0?? skills/active/b/SKILL.md\0R  new.md\0old.md\0")).toEqual([
      "meta/a.json",
      "skills/active/b/SKILL.md",
      "new.md",
    ])
  })
})

describe("git init vs. active runs", () => {
  test("init commit excludes paths of a run that has not committed yet", async () => {
    const ctx = makeCtx({ recurrenceMinSessions: 1 })
    const run = makeRun(ctx, "reviewer", { sessionID: "ses_early" })
    await ctx.ops.create(run, "skill", { name: "early-skill", description: "Created before git was initialised", body: BODY, reason: "early" })
    expect(await ctx.git.init()).toBe(true)
    const initFiles = execFileSync("git", ["-C", ctx.store.root, "show", "--name-only", "--format=", "HEAD"], { encoding: "utf8" })
    expect(initFiles).not.toContain("early-skill")
    expect(await ctx.git.commitRun(run)).toBeTruthy()
    const subject = execFileSync("git", ["-C", ctx.store.root, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim()
    expect(subject).toBe("skillsmith(reviewer): create early-skill")
  })
})
