/**
 * Steps 4d–4g: tasks and board, projects and pipeline, agent tasks with the write guard
 * (fake opencode client), inbox, hint simulator, semantic map, graph path.
 */
import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { executeAction } from "../../src/core/actions"
import { agentHub, checkTool } from "../../src/core/agent-hub"
import { parseProposal } from "../../src/core/agent-tasks"
import { finalizeRun } from "../../src/core/finalize"
import { BODY, cmdRun, makeCtx, makeRun, tmp } from "./helpers"
import { createTools } from "../../src/host/tools"

const web = (ctx: ReturnType<typeof makeCtx>, action: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => executeAction({ ctx, actor: "web" }, { action, args, ...extra })

function gitRepo(): string {
  const dir = tmp("skillsmith-home-")
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "u", GIT_AUTHOR_EMAIL: "u@x", GIT_COMMITTER_NAME: "u", GIT_COMMITTER_EMAIL: "u@x" } })
  g("init", "-q", "-b", "main")
  writeFileSync(join(dir, "app.txt"), "v1\n")
  g("add", "-A")
  g("commit", "-q", "-m", "init")
  return dir
}

async function waitFor(fn: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const start = Date.now()
  while (!(await fn())) {
    if (Date.now() - start > ms) throw new Error("timeout")
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe("tasks and board", () => {
  test("ids across projects, columns, WIP limit, subtasks with depth, done with open subtasks needs confirmation", async () => {
    const ctx = makeCtx({ tasks: { wipLimits: { in_umsetzung: 1 } } })
    await web(ctx, "project.save", { title: "Shop", name: "shop" })
    const a = await web(ctx, "task.create", { title: "Logout absichern", project: "shop", priority: "hoch", labels: ["auth"] })
    const b = await web(ctx, "task.create", { title: "Zweite Aufgabe", project: "shop" })
    expect((a.data as any).id).toBe("T-1")
    expect((b.data as any).id).toBe("T-2")
    const sub = await web(ctx, "task.subtask", { target: "task:t-1", title: "Test schreiben" })
    expect(ctx.tasks.require("t-3").fields.parent).toBe("T-1")
    await expect(web(ctx, "task.subtask", { target: "task:t-3", title: "zu tief" })).rejects.toMatchObject({ status: 422 })
    await web(ctx, "task.move", { target: "task:t-1", to: "in_umsetzung" })
    await expect(web(ctx, "task.move", { target: "task:t-2", to: "in_umsetzung" })).rejects.toMatchObject({ status: 428 })
    const forced = await web(ctx, "task.move", { target: "task:t-2", to: "in_umsetzung", force: true })
    expect(forced.warnings?.[0]).toContain("WIP-Limit")
    await expect(web(ctx, "task.move", { target: "task:t-1", to: "erledigt" })).rejects.toMatchObject({ status: 428 })
    await web(ctx, "task.move", { target: "task:t-1", to: "erledigt", force: true })
    const board = (await ctx.web!.api("board", new URLSearchParams({ project: "shop" }))) as any
    expect(board.columns).toEqual(["neu", "eingeplant", "in_umsetzung", "test", "erledigt"])
    const t1 = board.tasks.find((t: any) => t.id === "T-1")
    expect(t1.progress).toEqual({ done: 0, total: 1 })
    expect(t1.labels).toEqual(["auth"])
    // re-sorting is local (no commit)
    const before = (await ctx.git.git(["rev-list", "--count", "HEAD"])).stdout.trim()
    const r = await web(ctx, "task.reorder", { target: "task:t-2", position: 0 })
    expect(r.commit).toBeUndefined()
    expect((await ctx.git.git(["rev-list", "--count", "HEAD"])).stdout.trim()).toBe(before)
    expect(sub.ok).toBe(true)
    // links: T-12 short ids resolve, backlinks show on the task
    await web(ctx, "doc.create", { title: "Notiz", body: "Betrifft T-2 und [[task:T-1|Logout]]" })
    expect(ctx.links.backlinksOf("task:t-1").map((x) => x.from)).toEqual(["knowledge:notiz"])
    expect(ctx.links.backlinksOf("task:t-2").map((x) => x.from)).toEqual(["knowledge:notiz"])
  })

  test("checklist item → subtask; memorysmith suggestions only in the first column; /task command", async () => {
    const ctx = makeCtx()
    await web(ctx, "task.create", { title: "Release", body: "- [ ] Changelog\n- [ ] Tag setzen" })
    await web(ctx, "task.fromChecklist", { target: "task:t-1", line: 1 })
    const t1 = ctx.tasks.require("t-1")
    expect(t1.body).toBe("- [ ] Changelog\n- [[task:T-2|Tag setzen]]")
    const run = cmdRun(ctx, "memorysmith")
    run.actor = "command"
    const s = await ctx.tasks.create(run, { title: "Später: Cache", suggested: true })
    await finalizeRun(ctx, run, { ok: true })
    expect(s.fields.suggested).toBe(true)
    expect(s.fields.status).toBe("neu")
    await web(ctx, "task.acceptSuggestion", { target: `task:${s.name}` })
    const acc = ctx.tasks.require(s.name)
    expect(acc.fields.status).toBe("eingeplant")
    expect(acc.fields.suggested).toBeUndefined()
    const { handleCommand } = await import("../../src/host/commands")
    const out = await handleCommand(ctx, { queue: {} as any, curator: {} as any }, "task", "neu Neue Karte aus opencode", "ses_1")
    expect(out).toContain("T-4 angelegt")
    expect(await handleCommand(ctx, { queue: {} as any, curator: {} as any }, "task", "", "ses_1")).toContain("T-4 Neue Karte aus opencode")
    expect(await handleCommand(ctx, { queue: {} as any, curator: {} as any }, "note", "Merkzettel", "ses_1")).toContain("Eingang")
  })
})

describe("memorysmith task suggestions", () => {
  test("only with the user's words, at most two per run, no duplicates, first column of the matching project", async () => {
    const home = gitRepo()
    const ctx = makeCtx()
    await web(ctx, "project.save", { title: "Shop", name: "shop", home_path: home })
    await web(ctx, "task.create", { title: "Logout absichern", project: "shop" })
    const run = makeRun(ctx, "reviewer", { smith: "memorysmith", directory: home })
    run.userText = "Gut, die Migration der Tabellen machen wir später, erst mal den Login fertig."
    ctx.runs.attach(run, "ses_mem")
    const tools = createTools(ctx, null)
    const call = (a: Record<string, unknown>) => tools.memorysmith_task.execute(a, { sessionID: "ses_mem" })
    expect(await call({ title: "Tabellen migrieren", body: "x", evidence: "erfunden und nicht im Text" })).toContain("Rejected")
    expect(await call({ title: "Logout absichern", body: "x", evidence: "die Migration der Tabellen machen wir später" })).toContain("already on the board: T-1")
    const ok = await call({ title: "Migration der Tabellen", body: "Tabellen auf das neue Schema migrieren.", evidence: "die Migration der Tabellen machen wir später", reason: "vom Nutzer vertagt" })
    expect(ok).toContain("suggested T-2")
    const t = ctx.tasks.require("t-2")
    expect(t.fields).toMatchObject({ suggested: true, status: "neu", project: "shop", author: "agent" })
    expect(t.body).toContain("> die Migration der Tabellen machen wir später")
    await call({ title: "Login fertig bauen und testen", body: "x", evidence: "erst mal den Login fertig" })
    expect(await call({ title: "Noch etwas ganz anderes", body: "x", evidence: "erst mal den Login fertig" })).toContain("at most 2")
    // the main agent cannot use it; disabled → not offered
    expect(await tools.memorysmith_task.execute({ title: "x" }, { sessionID: "ses_main" })).toContain("only available inside")
    expect(createTools(makeCtx({ memorysmith: { proposeTasks: false } }), null).memorysmith_task).toBeUndefined()
    // other agents still cannot create tasks
    const other = makeRun(ctx, "reviewer", { smith: "docsmith" })
    await expect(ctx.ops.create(other, "task", { name: "t-99", description: "", body: "", fields: { suggested: true } })).rejects.toThrow("created by the user only")
  })
})

describe("pipeline", () => {
  test("stages in order, JUnit reports, red stops the run, logs are redacted, runs are local data", async () => {
    const home = gitRepo()
    mkdirSync(join(home, "target", "surefire-reports"), { recursive: true })
    // a secret in the build output (not in the command: commands with secrets are refused)
    writeFileSync(join(home, "leak.sh"), `echo token=ghp_${"abcdefghij".repeat(3)}012345\n`)
    writeFileSync(join(home, "target", "surefire-reports", "TEST-a.xml"), `<testsuite tests="2" failures="1"><testcase classname="a.B" name="ok"/><testcase classname="a.B" name="bad"><failure message="expected 1">x</failure></testcase></testsuite>`)
    const ctx = makeCtx()
    await web(ctx, "project.save", {
      title: "App",
      name: "app",
      home_path: home,
      pipeline: { trigger: ["test"], stages: [{ name: "build", run: "echo build ok; sh leak.sh" }, { name: "verify", run: "echo testing; exit 3", reports: "target/surefire-reports/*.xml" }, { name: "lint", run: "echo lint" }] },
    })
    await web(ctx, "task.create", { title: "Feature", project: "app" })
    const before = (await ctx.git.git(["rev-list", "--count", "HEAD"])).stdout.trim()
    const r = await web(ctx, "task.move", { target: "task:t-1", to: "test" })
    expect(r.warnings).toContain("Pipeline gestartet")
    await waitFor(() => ["failed", "success", "error"].includes(ctx.pipeline.lastOfTask("t-1")?.status ?? ""))
    const run = ctx.pipeline.lastOfTask("t-1")!
    expect(run.status).toBe("failed")
    expect(run.stages.map((s) => s.status)).toEqual(["success", "failed", "skipped"])
    expect(run.tests).toMatchObject({ total: 2, failures: 1 })
    expect(run.tests!.failed[0]).toMatchObject({ suite: "a.B", name: "bad", message: "expected 1" })
    const log = ctx.pipeline.log("app", run.id).text
    expect(log).toContain("build ok")
    expect(log).not.toContain("ghp_abcdef")
    // one commit for the move, none for the run
    expect(Number((await ctx.git.git(["rev-list", "--count", "HEAD"])).stdout.trim())).toBe(Number(before) + 1)
    expect(ctx.audit!.query({ category: ["pipeline"] }).events.map((e) => e.action).sort()).toEqual(["end", "start"])
    // red pipeline: done needs confirmation (requireGreen warn)
    await expect(web(ctx, "task.move", { target: "task:t-1", to: "erledigt" })).rejects.toMatchObject({ status: 428 })
    expect((ctx.web!.api("board", new URLSearchParams({ project: "app" })) as Promise<any>).then((b) => b.tasks[0].pipeline.status)).resolves.toBe("failed")
  })

  test("time limit, abort, one run per project in parallel, pipeline changes need the token", async () => {
    const home = gitRepo()
    const ctx = makeCtx()
    await web(ctx, "project.save", { title: "Slow", name: "slow", home_path: home, pipeline: { stages: [{ name: "wait", run: "sleep 30", timeout: "1s" }] } })
    const p1 = ctx.pipeline.start({ project: "slow", trigger: "manual", by: "test" })
    const p2 = ctx.pipeline.start({ project: "slow", trigger: "manual", by: "test" })
    await waitFor(() => ctx.pipeline.status().running.length === 1)
    expect(ctx.pipeline.status().queued).toHaveLength(1)
    const r1 = await p1
    expect(r1.status).toBe("timeout")
    const queued = ctx.pipeline.status()
    if (queued.running[0]) ctx.pipeline.abort("slow", queued.running[0].id)
    const r2 = await p2
    expect(["aborted", "timeout"]).toContain(r2.status)
    // changing pipeline commands needs the token even when web.token is off
    const ctx2 = makeCtx({ web: { token: false, port: 47490 } })
    const req = (args: unknown) =>
      ctx2.web!.handle(new Request("http://127.0.0.1:47490/api/action", { method: "POST", headers: { host: "127.0.0.1:47490", origin: "http://127.0.0.1:47490", "content-type": "application/json" }, body: JSON.stringify({ action: "project.save", args }) }), 47490, "d".repeat(48))
    expect((await req({ title: "Ohne", name: "ohne" })).status).toBe(200)
    expect((await req({ title: "Ohne", name: "ohne", pipeline: { stages: [{ name: "x", run: "rm -rf /" }] } })).status).toBe(401)
    expect(ctx.pipeline.log("slow", r1.id).text).toContain("Zeitlimit 1 s")
  }, 30_000)
})

/** Fake opencode server: sessions in directories, prompts answered by phase, tool calls by subagents. */
function fakeClient() {
  const sessions = new Map<string, { id: string; directory?: string; parentID?: string; title: string; status: "idle" | "busy"; messages: any[] }>()
  let n = 0
  const prompts: Array<{ id: string; text: string; tools?: Record<string, boolean>; agent?: string; model?: { providerID: string; modelID: string } }> = []
  const reply = (s: { messages: any[]; status: string }, text: string) => {
    s.messages.push({ info: { id: `m${++n}`, role: "assistant", mode: "build", providerID: "p", modelID: "m", cost: 0.01, tokens: { input: 100, output: 50, reasoning: 0 }, time: { created: Date.now(), completed: Date.now() } }, parts: [{ type: "text", text }] })
    s.status = "idle"
  }
  const client = {
    // "hera" is configured with a router combo without provider (opencode reads it as provider "Hermes")
    app: { agents: async () => ({ data: [{ name: "build", mode: "primary" }, { name: "orchestrator", mode: "primary" }, { name: "hera", mode: "primary", model: { providerID: "Hermes", modelID: "" } }, { name: "explore", mode: "subagent" }] }) },
    config: {
      providers: async () => ({ data: { providers: [{ id: "9router", models: { Hermes: { id: "Hermes" }, Athene: { id: "Athene" } } }, { id: "p", models: { m: { id: "m" } } }], default: { "9router": "Hermes" } } }),
      get: async () => ({ data: { model: "Hermes" } }),
    },
    session: {
      create: async ({ body, query }: any) => {
        const id = `ses_${++n}`
        sessions.set(id, { id, directory: query?.directory, parentID: body?.parentID, title: body?.title ?? "", status: "idle", messages: [] })
        return { data: { id, title: body?.title } }
      },
      get: async ({ path }: any) => ({ data: sessions.get(path.id) }),
      promptAsync: async ({ path, body, query }: any) => {
        const s = sessions.get(path.id)!
        const text = body.parts[0].text as string
        prompts.push({ id: path.id, text, tools: body.tools, agent: body.agent, model: body.model })
        s.messages.push({ info: { id: `u${++n}`, role: "user", time: { created: Date.now() } }, parts: [{ type: "text", text }] })
        s.status = "busy"
        setTimeout(async () => {
          const dir = query?.directory ?? s.directory
          if (/^Du prüfst die Umsetzung/.test(text)) return reply(s, 'Passt.\n```json\n[{"file": "impl.txt", "line": 1, "severity": "info", "text": "ok"}]\n```')
          if (/PHASE 1|überarbeitet haben/.test(text)) {
            // a subagent tries to write during the proposal → the guard rejects it
            const child = `ses_${++n}`
            sessions.set(child, { id: child, directory: dir, parentID: s.id, title: "explore", status: "idle", messages: [] })
            agentHub().parents.set(child, s.id)
            try {
              await checkTool(child, "edit", async () => s.id)
              ;(client as any).guardResult = "allowed"
            } catch (err) {
              ;(client as any).guardResult = String(err)
            }
            return reply(s, 'Plan:\n```json\n{"approach": "Datei impl.txt anlegen", "files": ["impl.txt"], "steps": ["anlegen"], "risks": [], "questions": ["Inhalt?"], "tests": ["verify"]}\n```')
          }
          if (/PHASE 2/.test(text)) {
            writeFileSync(join(dir, "impl.txt"), "umgesetzt\n")
            return reply(s, "Umgesetzt: impl.txt angelegt.")
          }
          if (/Prüfbefehle des Projekts sind rot/.test(text)) {
            writeFileSync(join(dir, "fixed.txt"), "ok\n")
            return reply(s, "Nachgebessert: fixed.txt.")
          }
          return reply(s, "ok")
        }, 20)
        return { data: undefined }
      },
      status: async () => ({ data: Object.fromEntries([...sessions.values()].map((s) => [s.id, { type: s.status }])) }),
      children: async ({ path }: any) => ({ data: [...sessions.values()].filter((s) => s.parentID === path.id).map((s) => ({ id: s.id, title: s.title, time: { created: Date.now() } })) }),
      messages: async ({ path }: any) => ({ data: sessions.get(path.id)?.messages ?? [] }),
      abort: async () => ({ data: true }),
      revert: async () => ({ data: true }),
      diff: async () => ({ data: [] }),
      delete: async () => ({ data: true }),
    },
    postSessionIdPermissionsPermissionId: async () => ({ data: true }),
  }
  return { client, prompts, sessions }
}

describe("agent tasks", () => {
  test("proposal (write guard over the session tree) → approval → implementation → pipeline with one fix round → review → merge", async () => {
    const home = gitRepo()
    const fake = fakeClient()
    const ctx = makeCtx({ tasks: { autoFixRounds: 1 } }, fake.client)
    await web(ctx, "project.save", { title: "App", name: "app", home_path: home, pipeline: { trigger: ["test"], stages: [{ name: "verify", run: "test -f fixed.txt && test -f impl.txt" }] } })
    await web(ctx, "doc.create", { title: "Konvention", body: "Immer kleine Commits." })
    await web(ctx, "task.create", { title: "Datei anlegen", project: "app", body: "Siehe [[konvention]]" })
    const brief = await web(ctx, "agent.brief", { target: "task:t-1" })
    expect((brief.data as any).brief).toContain("### knowledge:konvention – Konvention")
    const a = await web(ctx, "agent.assign", { target: "task:t-1", agent: "build", workplace: "worktree" })
    const jobId = (a.data as any).job
    const job0 = ctx.agentTasks.get(jobId)!
    expect(existsSync(job0.workdir)).toBe(true)
    expect(job0.branch).toMatch(/^skillsmith\/t-1-/)
    // no `tools` on the main session (opencode would keep them as session permissions) – the guard enforces the phase
    expect(fake.prompts[0].tools).toBeUndefined()
    await waitFor(async () => {
      await ctx.agentTasks.tick()
      return ctx.agentTasks.get(jobId)!.phase === "awaiting_approval"
    })
    expect((fake.client as any).guardResult).toContain("gesperrt")
    expect(ctx.audit!.query({ category: ["rejected"] }).events[0]).toMatchObject({ actor: "agent", action: "edit" })
    const job1 = ctx.agentTasks.get(jobId)!
    expect(job1.proposals[0]).toMatchObject({ approach: "Datei impl.txt anlegen", files: ["impl.txt"], questions: ["Inhalt?"] })
    expect(ctx.tasks.view(ctx.tasks.require("t-1")).agentStatus?.label).toBe("wartet auf Freigabe")
    // revise once (the reason becomes a rule candidate), then approve
    await web(ctx, "agent.revise", { job: jobId, comments: "Bitte immer zuerst die Tests schreiben, dann den Code." })
    expect(ctx.agentTasks.rules()[0].text).toContain("zuerst die Tests")
    await waitFor(async () => {
      await ctx.agentTasks.tick()
      return ctx.agentTasks.get(jobId)!.phase === "awaiting_approval"
    })
    await web(ctx, "agent.approve", { job: jobId, answers: "Inhalt egal" })
    const task = ctx.tasks.require("t-1")
    expect(task.fields.status).toBe("in_umsetzung")
    expect(task.body).toContain("<!-- vorschlag:start -->")
    expect(fake.prompts.at(-1)!.tools).toBeUndefined()
    await waitFor(async () => {
      await ctx.agentTasks.tick()
      return ctx.agentTasks.get(jobId)!.phase === "in_test"
    }, 30_000)
    const done = ctx.agentTasks.get(jobId)!
    expect(done.fixRounds).toBe(1)
    expect(done.pipelineFirstGreen).toBe(false)
    expect(done.pipelineRuns).toHaveLength(2)
    expect(ctx.tasks.require("t-1").fields.status).toBe("test")
    expect(done.review!.findings.some((f) => f.source === "ai")).toBe(true)
    expect(fake.prompts.find((p) => p.text.startsWith("Du prüfst die Umsetzung"))!.tools).toMatchObject({ write: false, edit: false, bash: false })
    expect(done.diffStat!.files).toBe(2)
    const diff = await ctx.agentTasks.diff(jobId)
    expect(diff.map((f) => f.path).sort()).toEqual(["fixed.txt", "impl.txt"])
    // the agent never sets done; the user accepts and merges
    const acc = await web(ctx, "agent.accept", { job: jobId, mode: "merge" })
    expect(acc.message).toContain("gemergt")
    expect(readFileSync(join(home, "impl.txt"), "utf8")).toBe("umgesetzt\n")
    expect(ctx.tasks.require("t-1").fields.status).toBe("erledigt")
    // a confirmed rule becomes a convention the next agent gets
    await web(ctx, "rule.decide", { id: ctx.agentTasks.rules()[0].id, decision: "confirm" })
    expect(ctx.store.list("memory").some((m) => m.fields.type === "vorgabe")).toBe(true)
    const stats = ctx.agentTasks.stats(30)
    expect(stats[0]).toMatchObject({ agent: "build", jobs: 1, revisions: 1, fixRounds: 1, withPipeline: 1, firstGreen: 0 })
  }, 60_000)

  test("model: a bare router combo (agent model „Hermes“) is repaired, every prompt carries it, unknown models are refused", async () => {
    const home = gitRepo()
    const fake = fakeClient()
    const ctx = makeCtx({}, fake.client)
    await web(ctx, "project.save", { title: "App", name: "app", home_path: home })
    await web(ctx, "task.create", { title: "Etwas planen", project: "app" })
    // the dialog sees the broken agent model and the offered models
    const agents = await ctx.agentTasks.agents()
    expect(agents.find((a) => a.name === "hera")).toMatchObject({ model: "Hermes", modelValid: false, modelFix: "9router/Hermes" })
    expect((await ctx.agentTasks.models()).models).toContain("9router/Athene")
    // without a chosen model: the agent's „Hermes“ → 9router/Hermes, explicit in the prompt (opencode would fail with "Hermes/.")
    const a = await web(ctx, "agent.assign", { target: "task:t-1", agent: "hera", workplace: "home" })
    const job = ctx.agentTasks.get((a.data as any).job)!
    expect(job.model).toBe("9router/Hermes")
    expect(job.modelNote).toContain("„Hermes“ → 9router/Hermes")
    expect(fake.prompts[0].model).toEqual({ providerID: "9router", modelID: "Hermes" })
    await web(ctx, "agent.abort", { job: job.id }).catch(() => undefined)
    // a chosen model must exist; a bare name is repaired, a wrong one refused with the offered models
    await web(ctx, "task.create", { title: "Noch etwas", project: "app" })
    const b = await web(ctx, "agent.assign", { target: "task:t-2", agent: "build", model: "athene", workplace: "home" })
    expect(ctx.agentTasks.get((b.data as any).job)!.model).toBe("9router/Athene")
    await web(ctx, "task.create", { title: "Drittes", project: "app" })
    await expect(web(ctx, "agent.assign", { target: "task:t-3", agent: "build", model: "litellm/gibtsnicht", workplace: "home" })).rejects.toThrow(/gibt es in opencode nicht.*9router\/Hermes/)
  }, 30_000)

  test("proposal parsing falls back to markdown sections", () => {
    expect(parseProposal("## Ansatz\nKurz.\n## Dateien\n- a.ts\n- b.ts\n## Fragen\n1. Warum?")).toMatchObject({ approach: "Kurz.", files: ["a.ts", "b.ts"], questions: ["Warum?"] })
  })
})

describe("productivity and extras", () => {
  test("inbox collects proposals, conflicts, open decisions, broken links; simulator explains hints", async () => {
    const ctx = makeCtx()
    const run = cmdRun(ctx, "skillsmith")
    await ctx.ops.create(run, "skill", { name: "kafka-reset", description: "Kafka consumer group offsets reset", body: BODY, tags: ["kafka"] })
    await finalizeRun(ctx, run, { ok: true })
    await web(ctx, "doc.create", { title: "Mit Link", body: "[[fehlt-noch]]" })
    ctx.mem!.openConflict("skill:kafka-reset", "knowledge:mit-link", "?", 0.8, "a", "b")
    const box = (await ctx.web!.api("inbox", new URLSearchParams())) as any
    const groups = new Set(box.items.map((i: any) => i.group))
    expect(groups.has("Konflikte")).toBe(true)
    expect(groups.has("Defekte Links")).toBe(true)
    const sim = (await ctx.web!.api("simulate", new URLSearchParams({ text: "kafka consumer offsets reset bitte", minScore: "0.2" }))) as any
    expect(sim.block).toContain("kafka-reset")
    expect(sim.candidates.find((c: any) => c.id === "skill:kafka-reset").shown).toBe(true)
    const strict = (await ctx.web!.api("simulate", new URLSearchParams({ text: "kafka cluster heute neu aufsetzen mit terraform", minScore: "0.99" }))) as any
    expect(strict.candidates.find((c: any) => c.id === "skill:kafka-reset").why).toContain("zu schwach")
  })

  test("semantic map (BM25 fallback), graph path, statistics endpoints answer", async () => {
    const ctx = makeCtx()
    const run = cmdRun(ctx, "docsmith")
    await ctx.ops.create(run, "knowledge", { name: "a-doc", title: "Kafka Offsets", description: "Kafka", body: "## A\nkafka consumer offsets reset [[b-doc]]" })
    await ctx.ops.create(run, "knowledge", { name: "b-doc", title: "Kafka Lag", description: "Kafka", body: "## B\nkafka consumer lag [[c-doc]]" })
    await ctx.ops.create(run, "knowledge", { name: "c-doc", title: "Datenbank", description: "DB2", body: "## C\ndb2 explain plan index" })
    await finalizeRun(ctx, run, { ok: true })
    const map = (await ctx.web!.api("map", new URLSearchParams())) as any
    expect(map.mode).toBe("bm25")
    expect(map.points).toHaveLength(3)
    const path = (await ctx.web!.api("graph/path", new URLSearchParams({ a: "knowledge:a-doc", b: "knowledge:c-doc" }))) as any
    expect(path.found).toBe(true)
    expect(path.edges).toHaveLength(2)
    for (const p of ["stats/overview", "stats/knowledge", "stats/hints", "stats/errors", "stats/smiths", "stats/tools", "stats/heatmap", "stats/tasks", "stats/pipeline", "stats/agents", "audit", "audit/verify", "history", "inbox", "templates", "folders", "info", "catalog"]) {
      expect(await ctx.web!.api(p, new URLSearchParams())).toBeTruthy()
    }
    const at = (await ctx.web!.api("graph/at", new URLSearchParams({ date: new Date().toISOString().slice(0, 10) }))) as any
    expect(at.nodes.length).toBe(3)
  })
})
