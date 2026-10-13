/** Skill packages (minimal): SKILL.md + references/ upload, replace, skill_read file, office agents load the whole skill. */
import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { executeAction } from "../../src/core/actions"
import { sessionSignals } from "../../src/core/agent-runner"
import { parseSkillPackage } from "../../src/core/skill-package"
import { makeCtx } from "./helpers"

const enc = (s: string) => new TextEncoder().encode(s)
const dir = (files: Record<string, string>) => enc(JSON.stringify({ files: Object.entries(files).map(([path, t]) => ({ path, data: Buffer.from(t).toString("base64") })) }))
const SKILL = '---\nname: pptx-design\ndescription: "Folien im Firmenstil gestalten"\n---\n# PPTX-Design\nLies [Styleguide](references/Style Guide.md) und references/design-patterns.md.\n'

describe("skill packages", () => {
  test("folder upload with references → one commit; replace removes stale files", async () => {
    const pkg = parseSkillPackage("pptx.skilldir.json", dir({ "pptx/SKILL.md": SKILL, "pptx/references/Style Guide.md": "Primärfarbe #0A3D62", "pptx/references/design-patterns.md": "Eine Aussage pro Folie", "pptx/.DS_Store": "x", "pptx/run.exe": "x" }))
    expect(pkg.name).toBe("pptx-design")
    expect(Object.keys(pkg.files).sort()).toEqual(["references/design-patterns.md", "references/style-guide.md"])
    expect(pkg.body).toContain("(references/style-guide.md)")
    expect(pkg.warnings.join()).toContain("run.exe")

    const ctx = makeCtx({}, undefined as any)
    await ctx.git.init()
    const up = await executeAction({ ctx, actor: "web" }, { action: "skill.upload", args: { fileName: "pptx.skilldir.json" } } as any, dir({ "pptx/SKILL.md": SKILL, "pptx/references/Style Guide.md": "Primärfarbe #0A3D62", "pptx/references/old.md": "alt" }))
    expect(up.commit).toBeTruthy()
    const rec = ctx.store.get("skill", "pptx-design")!
    expect(ctx.store.readFileOf(rec, "references/style-guide.md")).toBe("Primärfarbe #0A3D62")
    // same name again → confirmation, then replace (stale file removed, one commit)
    await expect(executeAction({ ctx, actor: "web" }, { action: "skill.upload", args: { fileName: "x.skilldir.json" } } as any, dir({ "pptx/SKILL.md": SKILL, "pptx/references/design-patterns.md": "Eine Aussage pro Folie" }))).rejects.toMatchObject({ status: 428 })
    const re = await executeAction({ ctx, actor: "web" }, { action: "skill.upload", args: { fileName: "x.skilldir.json", force: true } } as any, dir({ "pptx/SKILL.md": SKILL, "pptx/references/design-patterns.md": "Eine Aussage pro Folie" }))
    expect(re.commit).toBeTruthy()
    expect(existsSync(join(rec.dir, "references/old.md"))).toBe(false)
    expect(existsSync(join(rec.dir, "references/design-patterns.md"))).toBe(true)
    // a secret in a reference file is rejected
    await expect(executeAction({ ctx, actor: "web" }, { action: "skill.upload", args: { fileName: "s.skilldir.json" } } as any, dir({ "s/SKILL.md": "---\nname: geheim\ndescription: d\n---\nx", "s/references/k.md": "key AKIAIOSFODNN7EXAMPL0 hier" }))).rejects.toThrow()
  })

  test("office agent loads the assigned skill completely into the prompt", async () => {
    const prompts: string[] = []
    const client: any = {
      config: { providers: async () => ({ data: { providers: [] } }) },
      session: {
        create: async () => ({ data: { id: `s${Math.random()}` } }),
        promptAsync: async ({ path, body }: any) => (prompts.push(body.parts.map((p: any) => p.text).join("\n")), setTimeout(() => sessionSignals().idle(path.id), 5), { data: {} }),
        messages: async () => ({ data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: '```json\n{"summary":"s","ops":[{"op":"add_slide","title":"T"}]}\n```' }] }] }),
        status: async () => ({ data: {} }),
        delete: async () => ({ data: true }),
      },
    }
    const ctx = makeCtx({}, client)
    await ctx.git.init()
    await executeAction({ ctx, actor: "web" }, { action: "skill.upload", args: { fileName: "p.skilldir.json" } } as any, dir({ "p/SKILL.md": SKILL, "p/references/Style Guide.md": "Primärfarbe #0A3D62" }))
    await executeAction({ ctx, actor: "web" }, { action: "settings.set", args: { values: { "office.skills.pptx": ["pptx-design"] } } } as any)
    expect(ctx.options.office.skills.pptx).toEqual(["pptx-design"])
    await executeAction({ ctx, actor: "web" }, { action: "office.create", args: { format: "pptx", title: "Deck", prompt: "erstelle ein Deckblatt" } } as any)
    await new Promise((r) => setTimeout(r, 30))
    for (let i = 0; i < 400 && ctx.office!.isRunning("deck"); i++) await new Promise((r) => setTimeout(r, 25))
    const p = prompts.join("\n")
    expect(p).toContain("Verbindliche Skills")
    expect(p).toContain("# PPTX-Design")
    expect(p).toContain("references/style-guide.md")
    expect(p).toContain("Primärfarbe #0A3D62")
    expect(ctx.office!.draft("deck")!.steps[0].skills).toEqual(["pptx-design"])
  })
})
