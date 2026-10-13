/** opencode 2 adapter (minimal, without the binary): message translation and the v1 client facade. */
import { describe, expect, test } from "bun:test"
import { toV1Messages, V2Client } from "../../src/host/v2"
import { buildTranscript } from "../../src/core/transcript"

describe("opencode 2: messages → v1 shape", () => {
  test("user, synthetic, assistant with text, shell (exit) and subagent", () => {
    const msgs = toV1Messages("ses_1", [
      { id: "m1", type: "user", text: "Wie deploye ich?", time: { created: 1 } },
      {
        id: "m2",
        type: "assistant",
        agent: "build",
        model: { id: "mock-1", providerID: "mock" },
        time: { created: 2, completed: 3 },
        content: [
          { type: "text", text: "Ich prüfe das." },
          { type: "tool", id: "c1", name: "shell", state: { status: "completed", input: { command: "ls /x" }, content: [{ type: "text", text: "ls: cannot access '/x'" }], metadata: { exit: 2 } }, time: { created: 2 } },
          { type: "tool", id: "c2", name: "subagent", state: { status: "completed", input: { prompt: "lies" }, content: [{ type: "text", text: '<subagent sessionID="ses_child" state="completed">\nZusammenfassung\n</subagent>' }], metadata: { sessionID: "ses_child" } }, time: { created: 2 } },
        ],
      },
      { id: "m3", type: "synthetic", text: "Ausgabe", time: { created: 4 } },
    ])
    expect(msgs.map((m) => m.info.role)).toEqual(["user", "assistant", "user"])
    expect(msgs[1].info).toMatchObject({ providerID: "mock", modelID: "mock-1", agent: "build", time: { completed: 3 } })
    const [text, shell, task] = msgs[1].parts
    expect(text).toMatchObject({ type: "text", text: "Ich prüfe das." })
    expect(shell).toMatchObject({ type: "tool", tool: "bash", state: { status: "completed", input: { command: "ls /x" }, metadata: { exit: 2 } } })
    expect(task.tool).toBe("task")
    expect(task.state.output).toBe('<task id="ses_child" state="completed">\n<task_result>Zusammenfassung</task_result>\n</task>')
    expect(task.state.metadata.sessionId).toBe("ses_child")
    expect(msgs[2].parts[0].synthetic).toBe(true)
    // the transcript of the core reads it like a v1 session (shell failure as error chain)
    const t = buildTranscript(msgs as any, { maxChars: 10_000, redact: (s: string) => s })
    expect(t.text).toContain("Wie deploye ich?")
    expect(t.text).toContain("ls /x")
  })
})

describe("opencode 2: v1 client facade", () => {
  test("create + promptAsync = create, switchAgent, switchModel, prompt; tools off per session", async () => {
    const calls: any[] = []
    const ctx: any = {
      session: {
        create: async (i: any) => (calls.push(["create", i]), { id: "ses_9", title: i.title, location: i.location, time: { created: 1 } }),
        switchAgent: async (i: any) => calls.push(["agent", i]),
        switchModel: async (i: any) => calls.push(["model", i]),
        prompt: async (i: any) => calls.push(["prompt", i]),
        context: async () => [{ id: "a", type: "assistant", content: [{ type: "text", text: "ok" }], time: { created: 1, completed: 2 } }],
      },
      catalog: {
        provider: { list: async () => ({ data: [{ id: "opencode", integrationID: "opencode", settings: { baseURL: "https://zen" } }, { id: "litellm", package: "aisdk:@ai-sdk/openai-compatible", settings: { baseURL: "http://proxy/v1" } }] }) },
        model: { list: async () => ({ data: [{ id: "m1", providerID: "litellm" }, { id: "z", providerID: "opencode" }] }) },
      },
    }
    const c = new V2Client(ctx, "/proj")
    const s = (await c.session.create({ body: { title: "skillsmith-agent · x" }, query: { directory: "/wt" } })).data
    expect(s).toMatchObject({ id: "ses_9", directory: "/wt" })
    await c.session.promptAsync({ path: { id: "ses_9" }, body: { agent: "docsmith-reviewer", model: { providerID: "litellm", modelID: "m1" }, tools: { edit: false, read: true }, parts: [{ type: "text", text: "job" }] } })
    expect(calls.map((x) => x[0])).toEqual(["create", "agent", "model", "prompt"])
    expect(calls[2][1]).toEqual({ sessionID: "ses_9", model: { id: "m1", providerID: "litellm" } })
    expect([...c.disabledTools.get("ses_9")!]).toEqual(["edit"])
    const msgs = (await c.session.messages({ path: { id: "ses_9" } })).data
    expect(msgs[0].parts[0].text).toBe("ok")
    // embedding detection sees only the configured providers, the model check sees all
    expect(Object.keys(await c.v1Providers())).toEqual(["litellm"])
    expect((await c.v1Providers()).litellm.npm).toBe("@ai-sdk/openai-compatible")
    expect((await c.config.providers()).data.providers.map((p: any) => p.id).sort()).toEqual(["litellm", "opencode"])
  })
})
