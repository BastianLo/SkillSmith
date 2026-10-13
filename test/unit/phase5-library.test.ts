/** Step 5j (minimal): snippets and prompts – placeholders, /prompt, candidates, live templates. */
import { describe, expect, test } from "bun:test"
import { executeAction } from "../../src/core/actions"
import { fillSnippet, liveTemplates, parsePromptArgs, placeholders } from "../../src/core/library"
import { promptCommand } from "../../src/host/library-commands"
import { makeCtx } from "./helpers"

describe("library", () => {
  test("snippet placeholders and live templates", async () => {
    const ctx = makeCtx()
    const r = await executeAction({ ctx, actor: "web" }, { action: "entry.create", args: { kind: "snippet", title: "Logger", body: "```java\nprivate static final Logger ${name:log} = LoggerFactory.getLogger(${klasse}.class);\n```" } })
    expect(placeholders("${a} ${b:x} ${a}")).toEqual([{ name: "a" }, { name: "b", default: "x" }])
    const f = await executeAction({ ctx, actor: "web" }, { action: "snippet.fill", target: r.target, args: { values: { klasse: "TokenStore" } } })
    expect((f.data as any).text).toBe("private static final Logger log = LoggerFactory.getLogger(TokenStore.class);")
    expect(fillSnippet("${x}", {}).missing).toEqual(["x"])
    expect(liveTemplates(ctx.store.list("snippet"))).toContain("$KLASSE$")
    expect(ctx.store.getOwned("snippet", r.target!.slice(8))!.fields.language).toBe("java")
  })

  test("/prompt fills variables from arguments and context", async () => {
    const ctx = makeCtx()
    await executeAction({ ctx, actor: "web" }, { action: "entry.create", args: { kind: "prompt", name: "review", title: "Review", body: "Prüfe {{auswahl}} für {{ticket}} ({{sprache}})." } })
    expect(parsePromptArgs('review sprache="Java 17" den Diff')).toEqual({ name: "review", values: { sprache: "Java 17" }, rest: "den Diff" })
    const r = await promptCommand(ctx, 'review sprache=Java den Logout-Code')
    expect(r).toEqual({ ok: true, text: "Prüfe den Logout-Code für T2-123 (Java)." })
    expect((await promptCommand(ctx, "review")).text).toContain("{{sprache}}")
    expect(ctx.library!.promptStats("review")[0].uses).toBe(1)
  })

  test("repeated code in two sessions becomes a candidate", async () => {
    const ctx = makeCtx()
    const code = "a = 1\nb = 2\nc = 3\nd = 4\ne = 5\n"
    await ctx.library!.recordCode("s1", code, "py")
    expect(ctx.library!.candidates()).toHaveLength(0)
    await ctx.library!.recordCode("s2", code, "py")
    const c = ctx.library!.candidates()
    expect(c).toHaveLength(1)
    const r = await executeAction({ ctx, actor: "web" }, { action: "snippet.adopt", args: { id: c[0].id, title: "Fünf Zuweisungen" } })
    expect(r.target).toStartWith("snippet:")
    expect(ctx.library!.candidates()).toHaveLength(0)
  })
})
