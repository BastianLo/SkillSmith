import { describe, expect, test } from "bun:test"
import { EmbeddingClient, pickEmbeddingModel } from "../../src/core/embeddings"
import { buildEvalSet, formatEval, runEval } from "../../src/core/embed-eval"
import { resolveOptions } from "../../src/config"
import { silentLogger } from "../../src/log"
import { BODY, cmdRun, ERROR_BODY, fakeFetch, fakeVector, makeCtx, makeRun } from "./helpers"

const embOpts = (over: Record<string, unknown> = {}) => resolveOptions({ embedding: { baseURL: "http://e.test/v1", ...over } }, {}).options.embedding

describe("embedding client", () => {
  test("auto-detects the embedding model, truncates (MRL) and normalises, instructs only queries", async () => {
    const bodies: any[] = []
    const base = fakeFetch()
    const f = async (url: string, init?: any) => {
      if (init?.body) bodies.push(JSON.parse(init.body))
      return base(url, init)
    }
    const c = new EmbeddingClient(embOpts({ dimensions: 32 }), silentLogger, f as any, {})
    const [doc] = (await c.embed(["Kafka offsets zurücksetzen"], "document"))!
    expect(c.modelId).toBe("qwen3-embedding-8b")
    expect(doc.length).toBe(32)
    expect(Math.abs(doc.reduce((s, x) => s + x * x, 0) - 1)).toBeLessThan(1e-5)
    await c.embed(["wie setze ich offsets zurück"], "query", "hint")
    expect(bodies[0].input[0]).toBe("Kafka offsets zurücksetzen")
    expect(bodies[1].input[0]).toStartWith("Instruct: ")
    expect(bodies[1].input[0]).toContain("\nQuery:wie setze ich offsets zurück")
    expect(bodies[1].model).toBe("qwen3-embedding-8b")
    expect(pickEmbeddingModel(["gpt-x", "text-embedding-3-small", "Qwen/Qwen3-Embedding-8B"])).toBe("Qwen/Qwen3-Embedding-8B")
    expect(pickEmbeddingModel(["gpt-x"])).toBeUndefined()
  })

  test("batches, and pauses after repeated failures (BM25 fallback)", async () => {
    const calls = { n: 0 }
    let failing = false
    const c = new EmbeddingClient(embOpts({ batchSize: 2, model: "emb" }), silentLogger, fakeFetch({ calls, fail: () => failing }) as any, {})
    expect((await c.embed(["a1", "b2", "c3", "d4", "e5"], "document"))!.length).toBe(5)
    expect(calls.n).toBe(3)
    failing = true
    for (let i = 0; i < 3; i++) expect(await c.embed(["x"], "document")).toBeUndefined()
    expect(c.available()).toBe(false)
    expect(c.status.state).toBe("paused")
  })

  test("endpoint and key from the opencode provider config", async () => {
    const opts = resolveOptions({}, {}).options.embedding
    const c = new EmbeddingClient(opts, silentLogger, fakeFetch() as any, { LITELLM_API_KEY: "sk-env" })
    c.configureFromOpencode({ provider: { anthropic: {}, litellm: { options: { baseURL: "http://litellm.local:4000/v1/" }, models: { "DeepSeek-V41-Flash": {} } } } })
    expect(c.status.baseURL).toBe("http://litellm.local:4000/v1")
    expect(c.status.provider).toBe("litellm")
    expect((c as any).apiKey).toBe("sk-env")
    const c2 = new EmbeddingClient(opts, silentLogger, fakeFetch() as any, {})
    c2.configureFromOpencode({ provider: { litellm: { options: { baseURL: "http://x/v1", apiKey: "sk-cfg" } } } })
    expect((c2 as any).apiKey).toBe("sk-cfg")
    const none = new EmbeddingClient(opts, silentLogger, fakeFetch() as any, {})
    none.configureFromOpencode({ provider: {} })
    expect(none.configured).toBe(false)
    expect(await none.embed(["x"], "document")).toBeUndefined()
  })
})

describe("semantic index + hybrid search", () => {
  async function library(over: Record<string, unknown> = {}) {
    const ctx = makeCtx({ recurrenceMinSessions: 1, embedding: { model: "qwen3-embedding-8b", ...over } }, {}, { fetch: fakeFetch() })
    const cmd = cmdRun(ctx)
    await ctx.ops.create(cmd, "skill", {
      name: "deploy-checklist",
      description: "Team deployment checklist: make test before make deploy",
      body: "## Steps\n1. `make test`\n2. `make deploy ENV=<env>`",
    })
    await ctx.ops.create(cmd, "skill", { name: "kafka-offset-reset", description: "Reset Kafka consumer group offsets", body: BODY })
    await ctx.ops.create(cmdRun(ctx, "errorsmith"), "error", {
      name: "maven-pkix",
      title: "PKIX path building failed",
      description: "Maven: PKIX path building failed – Root-CA fehlt im Truststore",
      body: ERROR_BODY,
      fields: { status: "solved" },
    })
    await ctx.semantic!.sync()
    return ctx
  }

  test("sync is incremental", async () => {
    const ctx = await library()
    expect(await ctx.semantic!.sync()).toBe(0)
    await ctx.ops.update(cmdRun(ctx), "skill", { name: "deploy-checklist", description: "Deployment checklist for the team" })
    expect(await ctx.semantic!.sync()).toBe(1)
    const counts = ctx.semantic!.status().counts
    expect(counts["entry-skill"]).toBe(2)
    expect(counts["entry-error"]).toBe(1)
  })

  test("paraphrase without word overlap: BM25 misses, hybrid finds", async () => {
    const ctx = await library()
    const q = "Wie bringe ich unseren Dienst in Produktion?"
    expect(ctx.index.search(q, { kinds: ["skill"] }).map((h) => h.name)).not.toContain("deploy-checklist")
    const hits = await ctx.retriever.search(q, { kinds: ["skill"] })
    expect(hits[0]?.name).toBe("deploy-checklist")
    expect(hits[0].similarity).toBeGreaterThan(0.4)
    expect(hits[0].confidence).toBe(0)
    // tools show it as well
    const { createTools } = await import("../../src/host/tools")
    expect(await createTools(ctx, null).skill_search.execute({ query: q }, { sessionID: "s" })).toContain("deploy-checklist")
  })

  test("hint for a paraphrased request", async () => {
    const ctx = await library({ hintMinSimilarity: 0.4 })
    const hint = await ctx.hints.onUserMessage("ses_p", "msg_1", "Ich muss die Anwendung heute noch in Produktion ausrollen")
    expect(hint).toContain("deploy-checklist")
  })

  test("falls back to BM25 when the endpoint fails", async () => {
    let fail = false
    const ctx = makeCtx({ recurrenceMinSessions: 1, embedding: { model: "emb" } }, {}, { fetch: fakeFetch({ fail: () => fail }) })
    await ctx.ops.create(cmdRun(ctx), "skill", { name: "kafka-offset-reset", description: "Reset Kafka consumer group offsets", body: BODY })
    await ctx.semantic!.sync()
    fail = true
    const hits = await ctx.retriever.search("kafka offsets reset", { kinds: ["skill"] })
    expect(hits[0].name).toBe("kafka-offset-reset")
    expect(hits[0].similarity).toBeUndefined()
  })

  test("duplicate gate for background agents (commands are exempt)", async () => {
    const ctx = await library()
    const run = makeRun(ctx, "reviewer", { userText: "bitte als skill merken: deployment checkliste", limits: { maxNew: 3, maxChanges: 5, maxNotes: 5 } })
    await expect(
      ctx.ops.create(run, "skill", {
        name: "team-deploy-steps",
        description: "Team deployment checklist: make test before make deploy",
        body: "## Steps\n1. `make test`\n2. `make deploy ENV=<env>`",
        userQuote: "bitte als skill merken",
      }),
    ).rejects.toThrow(/very similar .*"deploy-checklist"/)
    expect(
      await ctx.ops.create(cmdRun(ctx), "skill", {
        name: "team-deploy-steps",
        description: "Team deployment checklist: make test before make deploy",
        body: "## Steps\n1. `make test`\n2. `make deploy ENV=<env>`",
      }),
    ).toContain("created")
  })

  test("candidates: the same pattern in other words is recognised", async () => {
    const ctx = await library({ candidateSimilarity: 0.6 })
    const r1 = makeRun(ctx, "reviewer", { sessionID: "ses_a" })
    await ctx.ops.note(r1, "skill", { summary: "Release the payment service to production with gradle", keywords: ["release", "gradle"] })
    await ctx.semantic!.sync()
    const r2 = makeRun(ctx, "reviewer", { sessionID: "ses_b" })
    const msg = await ctx.ops.note(r2, "skill", { summary: "Deploy payments app to prod via gradle task", keywords: ["deploy", "prod"] })
    expect(msg).toContain("same pattern")
    expect(msg).toContain("seen in 2 session")
    expect(ctx.store.candidates("skill")).toHaveLength(1)
  })

  test("live error hint via semantic similarity", async () => {
    const ctx = await library({ errorSimilarity: 0.4 })
    const text = await ctx.hints.onToolResult("ses_e", "bash", { command: "gradle build" }, {
      output: "Could not resolve dependencies: SSL certificate rejected by the truststore (certification problem)",
      metadata: { exit: 1 },
    })
    expect(text).toContain('name="maven-pkix"')
  })

  test("evaluation with real session data", async () => {
    const msgs = (q: string, name: string) => [
      { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: q }] },
      { info: { id: "m2", role: "assistant" }, parts: [{ type: "tool", tool: "skill_read", state: { status: "completed", input: { name } } }] },
    ]
    const sessions: Record<string, any[]> = {
      s1: msgs("Wie bringe ich den Dienst in Produktion?", "deploy-checklist"),
      s2: msgs("Kafka consumer offsets zurücksetzen", "kafka-offset-reset"),
      s3: msgs("Anwendung ausrollen, was muss ich beachten", "deploy-checklist"),
      s4: msgs("Position der consumer gruppe ändern", "kafka-offset-reset"),
      s5: msgs("release der app vorbereiten", "deploy-checklist"),
      s6: msgs("make test vor make deploy?", "deploy-checklist"),
    }
    const client = {
      session: {
        list: async () => ({ data: Object.keys(sessions).map((id, i) => ({ id, title: "x", time: { updated: i } })) }),
        messages: async ({ path }: any) => ({ data: sessions[path.id] }),
      },
    }
    const ctx = await library()
    ;(ctx as any).client = client
    const { pairs, sessions: used } = await buildEvalSet(ctx, 50)
    expect(pairs).toHaveLength(6)
    expect(used).toBe(6)
    const r = await runEval(ctx, pairs, used)
    expect(r.hybrid).toBeDefined()
    expect(r.hybrid!.hit1).toBeGreaterThanOrEqual(r.bm25.hit1)
    expect(r.hybrid!.hit1).toBeGreaterThan(0.8)
    expect(formatEval(r, 0.55)).toContain("| hybrid |")
  })
})

test("fake vector sanity", () => {
  expect(fakeVector("deploy")[0]).toBe(3)
})
