/** Step 5e (minimal): TypeScript check, a TS draft through the workshop, call_script contract. */
import { describe, expect, test } from "bun:test"
import { checkTsSource, nodeStrips, validateSchema } from "../../src/core/scripts"
import { callScript } from "../../src/core/scripts"
import { executeAction } from "../../src/core/actions"
import { makeCtx, makeRun } from "./helpers"

const CODE = `/** Adds two numbers. */
import { run } from "./smith-script.ts"

export function add(a: number, b: number): number {
  return a + b
}

export function main(params: { a: number; b: number }) {
  return { sum: add(params.a, params.b) }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) await run(main)
`
const TESTS = `import { test } from "node:test"
import assert from "node:assert/strict"
import { add, main } from "./add_numbers.ts"

test("add", () => assert.equal(add(2, 3), 5))
test("main", () => assert.deepEqual(main({ a: 1, b: 2 }), { sum: 3 }))
`

describe("typescript scripts", () => {
  test("type stripping limits are rejected", () => {
    const r = checkTsSource('enum A { x }\nnamespace N { export const y = 1 }\nclass C { constructor(private a: string) {} }\nimport { f } from "./other"\n', 'import { test } from "node:test"\ntest("a", () => {})', "m")
    expect(r.errors.length).toBe(4)
    expect(checkTsSource('import { spawn } from "node:child_process"\nfetch("x")\n', "", "m").capabilities.sort()).toEqual(["network", "subprocess"])
    expect(nodeStrips("v22.18.0")).toBe(true)
    expect(nodeStrips("v22.17.1")).toBe(false)
    expect(validateSchema({ type: "object", required: ["a"], properties: { a: { type: "number" } } }, { a: "x" })).toEqual(["params.a: expected number"])
  })

  test("draft → check (real runtime) → publish → call_script and script.run", async () => {
    const ctx = makeCtx({ toolsmith: { recurrenceMinSessions: 1, minTests: 2 } })
    await ctx.git.init()
    const run = makeRun(ctx, "reviewer", { smith: "toolsmith", userText: "bitte ein Skript zum Addieren" })
    const report = await ctx.workshop.draft(run, { name: "add-numbers", language: "typescript", description: "Adds two numbers", usage: "node add_numbers.ts < params.json", code: CODE, tests: TESTS, docs: "## Zweck\nAddiert.", capabilities: [], requirements: [], tags: ["math"], params: { type: "object", required: ["a", "b"], properties: { a: { type: "number" }, b: { type: "number" } } } })
    expect(report).toContain("CHECK PASSED")
    const pub = await ctx.workshop.publish(run, { name: "add-numbers", userQuote: "bitte ein Skript zum Addieren" })
    expect(pub).toContain("add-numbers")
    const e = ctx.store.getOwned("script", "add-numbers")!
    expect(e.fields.language).toBe("typescript")
    const r = await callScript(ctx, "add-numbers", { params: { a: 2, b: 40 } })
    expect(r).toMatchObject({ ok: true, data: { sum: 42 } })
    await expect(callScript(ctx, "add-numbers", { params: { a: "x" } })).rejects.toThrow(/Schema/)
    const w = await executeAction({ ctx, actor: "web" }, { action: "script.run", target: "script:add-numbers", args: { params: { a: 1, b: 1 } } })
    expect((w.data as any).data).toEqual({ sum: 2 })
  }, 120_000)
})
