/** Office documents (minimal): create from a template, AI draft with live steps, accept, versions, restore, upload, KI-Recht. */
import { describe, expect, test } from "bun:test"
import { executeAction } from "../../src/core/actions"
import { sessionSignals } from "../../src/core/agent-runner"
import { applyOps, blank, inspect, parsePlan, retype, sniffFormat } from "../../src/core/office"
import { makeCtx } from "./helpers"

const PLAN = '```json\n{"summary": "Deckblatt und Ablauf", "ops": [{"op": "add_slide", "title": "Logout-Konzept", "subtitle": "Team Billing"}, {"op": "add_slide", "title": "Ablauf", "body": ["Token sperren", "Sitzung löschen"], "notes": "kurz"}, {"op": "set_text", "slide": 7, "element": "title", "text": "x"}]}\n```'

function fakeClient(answer: () => string): any {
  return {
    config: { providers: async () => ({ data: { providers: [] } }) },
    session: {
      create: async () => ({ data: { id: `s${Math.random()}` } }),
      promptAsync: async ({ path }: any) => (setTimeout(() => sessionSignals().idle(path.id), 5), { data: {} }),
      messages: async () => ({ data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: answer() }] }] }),
      status: async () => ({ data: {} }),
      delete: async () => ({ data: true }),
    },
  }
}

async function settle(ctx: any, name: string): Promise<void> {
  for (let i = 0; i < 400 && ctx.office.isRunning(name); i++) await new Promise((r) => setTimeout(r, 25))
}

describe("office: library", () => {
  test("blank documents, template retype, plan parsing, docx edits", async () => {
    const p = await blank("pptx", "T")
    expect(sniffFormat(p)).toBe("pptx")
    expect(sniffFormat(await retype(p, "potx"))).toBe("potx")
    expect(parsePlan("vorher ```json\n[{\"op\":\"delete\",\"block\":\"p1\"}]\n```")!.ops).toHaveLength(1)
    const d = await blank("docx", "D")
    const r = await applyOps("docx", d, [{ op: "insert", after: "start", blocks: [{ style: "Titel", text: "Deckblatt" }, { text: "mit **fett**", pageBreakBefore: true }, { rows: [["A", "B"]] }] }, { op: "replace_text", find: "fett", replace: "kräftig" }])
    expect(r.errors).toEqual([])
    const info = await inspect("docx", r.bytes)
    expect(info.text).toContain("# Deckblatt")
    expect(info.text).toContain("mit kräftig")
    expect(info.outline).toContain("neue Seite")
  })
})

describe("office: documents in the store", () => {
  test("template → new deck → AI draft live → accept (one commit) → restore", async () => {
    const ctx = makeCtx({}, fakeClient(() => PLAN))
    await ctx.git.init()
    const steps: any[] = []
    ctx.bus.on((ev: any) => { if (ev.type === "office.draft") steps.push(ev.data) })
    // template upload (.potx)
    const potx = await retype(await blank("pptx", "Vorlage"), "potx")
    const up = await executeAction({ ctx, actor: "web" }, { action: "office.upload", args: { fileName: "Firmenvorlage.potx" } }, potx)
    expect(up.commit).toBeTruthy()
    expect(ctx.office!.templates("pptx").map((e) => e.name)).toEqual(["firmenvorlage"])
    // new deck from the template, the AI fills it after the commit
    const cr = await executeAction({ ctx, actor: "web" }, { action: "office.create", args: { format: "pptx", title: "Logout Konzept", template: "office:firmenvorlage", prompt: "erstelle bitte ein Deckblatt und eine Folie zum Ablauf" } })
    expect(cr.commit).toBeTruthy()
    const name = "logout-konzept"
    await new Promise((r) => setTimeout(r, 30))
    await settle(ctx, name)
    const draft = ctx.office!.draft(name)!
    expect(draft.status).toBe("bereit")
    expect(draft.steps[0].done).toHaveLength(2)
    expect(draft.steps[0].errors[0]).toMatch(/Folie 7/)
    expect(steps.filter((s) => s.current?.phase === "aendert").length).toBe(3)
    // the store is unchanged until accept
    expect(ctx.store.getOwned("office", name)!.fields.pages).toBe(0)
    const acc = await executeAction({ ctx, actor: "web" }, { action: "office.accept", args: { target: `office:${name}` } })
    expect(acc.commit).toBeTruthy()
    const e = ctx.store.getOwned("office", name)!
    expect(e.fields.pages).toBe(2)
    expect(e.fields.template).toBe("firmenvorlage")
    // the library's blank deck has layouts without placeholders → text boxes (a real .potx fills its placeholders)
    expect(e.body).toMatch(/## Folie 1[\s\S]*Logout-Konzept[\s\S]*## Folie 2[\s\S]*Token sperren/)
    expect(ctx.office!.draft(name)).toBeUndefined()
    // search finds the slide text
    const hits = await ctx.retriever.search("Sitzung löschen", { kinds: ["office"] } as any)
    expect(JSON.stringify(hits)).toContain(name)
    // versions + restore of the empty first version
    const log = await ctx.versions.log("office", name)
    expect(log.length).toBe(2)
    const first = log[log.length - 1].hash
    expect((await ctx.office!.bytesAt(e, first)).length).toBeGreaterThan(1000)
    const rs = await executeAction({ ctx, actor: "web" }, { action: "entry.restoreVersion", args: { target: `office:${name}`, hash: first }, force: true } as any)
    expect(rs.commit).toBeTruthy()
    expect(ctx.store.getOwned("office", name)!.fields.pages).toBe(0)
  })

  test("upload docx, editor save, body guard, KI-Recht lesen blocks AI edits", async () => {
    const ctx = makeCtx({}, fakeClient(() => "{}"))
    await ctx.git.init()
    const d = await blank("docx", "D")
    const filled = (await applyOps("docx", d, [{ op: "insert", after: "start", blocks: [{ style: "Heading1", text: "Logout" }, { text: "Tokens werden gesperrt." }] }])).bytes
    const up = await executeAction({ ctx, actor: "web" }, { action: "office.upload", args: { fileName: "Konzept.docx", ai: "lesen" } }, filled)
    expect(up.commit).toBeTruthy()
    const e = ctx.store.getOwned("office", "konzept")!
    expect(e.body).toContain("## Logout")
    await expect(executeAction({ ctx, actor: "web" }, { action: "office.edit", args: { target: "office:konzept", prompt: "Deckblatt bitte" } })).rejects.toThrow(/KI-Recht/)
    await expect(executeAction({ ctx, actor: "web" }, { action: "entry.save", args: { target: "office:konzept", body: "anders" } })).rejects.toThrow(/Datei ändern/)
    const changed = (await applyOps("docx", filled, [{ op: "replace_text", find: "gesperrt", replace: "widerrufen" }])).bytes
    const sv = await executeAction({ ctx, actor: "web" }, { action: "office.save", args: { target: "office:konzept" } }, changed)
    expect(sv.commit).toBeTruthy()
    expect(ctx.store.getOwned("office", "konzept")!.body).toContain("widerrufen")
    await expect(executeAction({ ctx, actor: "web" }, { action: "office.upload", args: { fileName: "x.docx" } }, new TextEncoder().encode("kein zip"))).rejects.toThrow(/Keine PowerPoint/)
  })
})
