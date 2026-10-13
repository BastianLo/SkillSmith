/** Step 5f (minimal): bundling of review comments, confirm as convention, pre-PR check. */
import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { executeAction } from "../../src/core/actions"
import { sessionSignals } from "../../src/core/agent-runner"
import { makeCtx, tmp } from "./helpers"

const c = (id: string, author: string, body: string) => ({ id, repo: "acme/shop", pr: 1, author, body, path: "src/A.java", line: 3, url: `https://github.com/acme/shop/pull/1#${id}`, at: "2026-10-01T00:00:00Z" })

describe("review knowledge", () => {
  test("3 similar comments of 2 people become a candidate; confirm → convention with comment sources", async () => {
    const ctx = makeCtx()
    await ctx.git.init()
    await ctx.reviews!.add([
      c("1", "anna", "Bitte keine Field Injection mit @Autowired, nimm Constructor Injection."),
      c("2", "ben", "Constructor Injection statt @Autowired Field Injection bitte."),
      c("3", "anna", "Auch hier: Field Injection @Autowired vermeiden, Constructor Injection."),
      c("4", "ben", "Tippfehler im Log-Text."),
    ])
    expect(await ctx.reviews!.bundle()).toBe(1)
    const cand = ctx.reviews!.candidates("offen")[0]
    expect(cand.comments).toHaveLength(3)
    expect(cand.persons).toBe(2)
    const r = await executeAction({ ctx, actor: "web" }, { action: "review.confirm", args: { id: cand.id, as: "vorgabe", title: "Constructor Injection", text: "Abhängigkeiten per Konstruktor injizieren, kein @Autowired an Feldern." } })
    expect(r.target).toStartWith("memory:")
    const e = ctx.store.getOwned("memory", r.target!.slice(7))!
    expect(e.fields.type).toBe("vorgabe")
    expect(Object.values(e.meta!.provenance!).flat().filter((s) => s.type === "comment")).toHaveLength(3)
    expect(ctx.reviews!.rules().map((x) => x.id)).toEqual([r.target!])
    // a confirmed candidate is not proposed again
    expect(await ctx.reviews!.bundle()).toBe(0)
  })

  test("pre-PR check: findings at file and line from the read-only session", async () => {
    const dir = tmp("pr-")
    const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })
    g("init", "-q", "-b", "main")
    writeFileSync(join(dir, "A.java"), "class A {}\n")
    g("add", "-A")
    g("commit", "-qm", "init")
    g("checkout", "-qb", "feature")
    writeFileSync(join(dir, "A.java"), "class A {\n  @Autowired B b;\n}\n")
    const client: any = {
      config: { providers: async () => ({ data: { providers: [] } }) },
      session: {
        create: async () => ({ data: { id: "s1" } }),
        promptAsync: async ({ path }: any) => (setTimeout(() => sessionSignals().idle(path.id), 5), { data: {} }),
        messages: async () => ({ data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: '```json\n[{"file": "A.java", "line": 2, "rule": "R1", "text": "Field Injection"}]\n```' }] }] }),
        status: async () => ({ data: {} }),
        delete: async () => ({ data: true }),
      },
    }
    const ctx = makeCtx({}, client)
    await ctx.reviews!.add([c("1", "anna", "Constructor Injection statt @Autowired."), c("2", "ben", "Bitte Constructor Injection statt @Autowired."), c("3", "anna", "@Autowired am Feld vermeiden, Constructor Injection.")])
    await ctx.reviews!.bundle()
    await executeAction({ ctx, actor: "web" }, { action: "review.confirm", args: { id: ctx.reviews!.candidates()[0].id, as: "vorgabe", title: "Constructor Injection", text: "Kein @Autowired an Feldern." } })
    const r = await ctx.reviews!.prCheck(dir, "main")
    expect(r.findings).toEqual([{ file: "A.java", line: 2, rule: ctx.reviews!.rules()[0].id, text: "Field Injection", comments: expect.any(Array) }])
    expect(r.findings[0].comments).toHaveLength(3)
  }, 30_000)
})
