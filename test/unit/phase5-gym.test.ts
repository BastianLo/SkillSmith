/** Step 5d (minimal): cross-check gate in Ops, gym checks / verdicts, one A/B round with a fake client. */
import { describe, expect, test } from "bun:test"
import { executeAction } from "../../src/core/actions"
import { sessionSignals } from "../../src/core/agent-runner"
import { parseVerdicts } from "../../src/core/crosscheck"
import { evaluate, leaks, verdictOf } from "../../src/core/gym"
import { GuardError } from "../../src/core/ops"
import { cmdRun, makeCtx, makeRun } from "./helpers"

const HAY = "Nutzer: Der Export läuft jede Nacht um 2 Uhr über den Cronjob export-nightly."

describe("cross-check", () => {
  test("gestützt writes, nicht gestützt stages, widersprochen rejects", async () => {
    const ctx = makeCtx({ crosscheck: { model: "mock/checker" } })
    let verdict = "gestuetzt"
    ctx.ops.setCrossCheck({ applies: () => true, check: async (_r, _k, _n, ps) => ({ model: "mock/checker", verdicts: ps.map((p) => ({ index: p.index, verdict: verdict as any, reason: "r" })) }) })
    const run = () => makeRun(ctx, "reviewer", { smith: "docsmith", userText: HAY, haystack: HAY, limits: { maxNew: 5, maxChanges: 5, maxNotes: 1 } })
    const args = (name: string) => ({ name, title: "Export", description: "Export", body: "## A\nDer Export läuft jede Nacht um 2 Uhr.", evidence: "Der Export läuft jede Nacht um 2 Uhr" })
    expect(await ctx.ops.create(run(), "knowledge", args("a"))).toContain("created")
    verdict = "nicht_gestuetzt"
    expect(await ctx.ops.create(run(), "knowledge", args("b"))).toContain("Kreuzprüfung")
    expect(ctx.ops.staged().some((s) => s.name === "b")).toBe(true)
    verdict = "widersprochen"
    await expect(ctx.ops.create(run(), "knowledge", args("c"))).rejects.toThrow(GuardError)
    // the user's own writes are never checked
    expect(await ctx.ops.create(cmdRun(ctx, "docsmith"), "knowledge", args("d"))).toContain("created")
  })

  test("verdict parsing: unjudged paragraphs count as not supported", () => {
    const v = parseVerdicts('```json\n[{"p": 1, "verdict": "gestützt", "reason": "ok"}]\n```', 2)!
    expect(v.map((x) => x.verdict)).toEqual(["gestuetzt", "nicht_gestuetzt"])
  })
})

describe("gym", () => {
  test("checks, leak guard, verdicts", () => {
    const t = { answer: "Erst Consumer stoppen, dann Offsets zurücksetzen", calls: [{ tool: "bash", command: "mvn -U verify", exit: 0 }] }
    expect(evaluate([{ type: "contains", text: "offsets" }, { type: "order", items: ["stoppen", "zurücksetzen"] }, { type: "exit0", text: "mvn -U" }], t).ok).toBe(true)
    expect(evaluate([{ type: "order", items: ["zurücksetzen", "stoppen"] }], t).ok).toBe(false)
    expect(leaks({ prompt: "Setze die Offsets zurück", checks: [{ type: "contains", text: "Offsets" }] })).toEqual(["Offsets"])
    expect(verdictOf({ runs: 3, passed: 0, used: 0, errors: 0 }, { runs: 3, passed: 3, used: 3, errors: 0 })).toBe("hilft")
    expect(verdictOf({ runs: 3, passed: 3, used: 0, errors: 0 }, { runs: 3, passed: 1, used: 2, errors: 0 })).toBe("schadet")
    expect(verdictOf({ runs: 3, passed: 1, used: 0, errors: 0 }, { runs: 3, passed: 1, used: 0, errors: 0 })).toBe("ungenutzt")
  })

  test("A/B round with a fake agent: the hint block makes arm B pass", async () => {
    const msgs = new Map<string, any[]>()
    let n = 0
    const client: any = {
      config: { providers: async () => ({ data: { providers: [{ id: "mock", models: { m1: { id: "m1" } } }] } }) },
      session: {
        create: async () => ({ data: { id: `s${++n}` } }),
        promptAsync: async ({ path, body }: any) => {
          const text = body.parts[0].text as string
          const answer = text.includes("<smith_hints") ? "Zuerst den Consumer stoppen, dann REVOKED_AT setzen." : "Keine Ahnung."
          msgs.set(path.id, [{ info: { role: "assistant", time: { completed: Date.now() } }, parts: [{ type: "text", text: answer }] }])
          setTimeout(() => sessionSignals().idle(path.id), 5)
          return { data: {} }
        },
        messages: async ({ path }: any) => ({ data: msgs.get(path.id) ?? [] }),
        status: async () => ({ data: {} }),
        get: async ({ path }: any) => ({ data: { id: path.id } }),
        delete: async () => ({ data: true }),
      },
    }
    const ctx = makeCtx({ gym: { model: "mock/m1", runsPerArm: 2, timeoutMin: 1 } }, client)
    await ctx.git.init()
    const d = await executeAction({ ctx, actor: "web" }, { action: "doc.create", args: { title: "Token sperren", body: "Setze REVOKED_AT beim Logout." } })
    const s = await executeAction({ ctx, actor: "web" }, { action: "gym.task.save", args: { entry: d.target, prompt: "Wie sperre ich ein Refresh-Token beim Logout?", mode: "fragen", checks: [{ type: "contains", text: "REVOKED_AT" }] } })
    const id = (s.data as any).id
    expect(s.commit).toBeTruthy()
    const r = await ctx.gym!.runTask(id)
    expect(r.a.passed).toBe(0)
    expect(r.b.passed).toBe(2)
    expect(r.verdict).toBe("hilft")
    expect(ctx.gym!.verdict(d.target!)?.verdict).toBe("hilft")
    expect(ctx.quality!.of(ctx.store.getOwned("knowledge", d.target!.slice(10))!).parts.some((p) => p.id === "gym")).toBe(true)
  }, 60_000)
})
