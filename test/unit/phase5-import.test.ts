/** Step 5h (minimal): reading DOCX/PPTX/Markdown, extraction with quote check, apply in one commit. */
import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { executeAction } from "../../src/core/actions"
import { sessionSignals } from "../../src/core/agent-runner"
import { docxPages, pptxPages, readPages } from "../../src/core/importer"
import { makeCtx, tmp } from "./helpers"

function zip(files: Record<string, string>): Uint8Array {
  const dir = tmp("zip-")
  const out = join(dir, "x.zip")
  execFileSync("python3", ["-I", "-c", `import sys,json,zipfile\nz=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED)\nfor k,v in json.loads(sys.argv[2]).items(): z.writestr(k,v)\nz.close()`, out, JSON.stringify(files)])
  return new Uint8Array(readFileSync(out))
}

describe("import: reading", () => {
  test("docx with page break and heading, pptx per slide, markdown sections, scanned pdf", async () => {
    const doc = `<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Logout</w:t></w:r></w:p><w:p><w:r><w:t>Tokens werden beim Logout gesperrt.</w:t></w:r></w:p><w:p><w:r><w:br w:type="page"/><w:t>Seite zwei &amp; mehr.</w:t></w:r></w:p></w:body></w:document>`
    const pages = docxPages(zip({ "word/document.xml": doc }), 6000)
    expect(pages.map((p) => p.text)).toEqual(["# Logout\n\nTokens werden beim Logout gesperrt.", "Seite zwei & mehr."])
    const slide = (t: string) => `<p:sld><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>`
    const pp = pptxPages(zip({ "ppt/slides/slide2.xml": slide("Zwei"), "ppt/slides/slide1.xml": slide("Eins"), "ppt/slides/slide10.xml": slide("Zehn") }))
    expect(pp.map((p) => `${p.label} ${p.n}: ${p.text}`)).toEqual(["Folie 1: Eins", "Folie 2: Zwei", "Folie 3: Zehn"])
    expect((await readPages("a.md", new TextEncoder().encode("# A\nx\n\n# B\ny"))).length).toBe(2)
    await expect(readPages("scan.pdf", new TextEncoder().encode(JSON.stringify({ pages: [{ n: 1, text: "" }] })))).rejects.toThrow(/Textebene/)
  })
})

describe("import: extraction and apply", () => {
  test("findings need a quote from the file; apply writes one commit with provenance", async () => {
    const client: any = {
      config: { providers: async () => ({ data: { providers: [] } }) },
      session: {
        create: async () => ({ data: { id: "s1" } }),
        promptAsync: async ({ path }: any) => (setTimeout(() => sessionSignals().idle(path.id), 5), { data: {} }),
        messages: async () => ({
          data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: '```json\n[{"type": "wissen", "title": "Token-Sperre", "text": "Beim Logout wird das Refresh-Token gesperrt.", "quote": "Beim Logout wird das Refresh-Token gesperrt", "page": 1}, {"type": "offen", "title": "Erfunden", "text": "x", "quote": "Dieser Satz steht nirgends in der Datei", "page": 1}, {"type": "entscheidung", "title": "HttpOnly-Cookie", "text": "Tokens liegen im HttpOnly-Cookie.", "quote": "Wir speichern Tokens im HttpOnly-Cookie", "page": 2}]\n```' }] }],
        }),
        status: async () => ({ data: {} }),
        delete: async () => ({ data: true }),
      },
    }
    const ctx = makeCtx({}, client)
    await ctx.git.init()
    const md = "# Ablauf\nBeim Logout wird das Refresh-Token gesperrt.\n\n# Entscheidung\nWir speichern Tokens im HttpOnly-Cookie."
    const r = await executeAction({ ctx, actor: "web" }, { action: "import.create", args: { name: "Konzept Login.md" } }, new TextEncoder().encode(md))
    const id = (r.data as any).id
    const j = (await ctx.importer!.wait(id))!
    expect(j.status).toBe("fertig")
    expect(j.findings.map((f) => f.title)).toEqual(["Token-Sperre", "HttpOnly-Cookie"])
    expect(j.findings[1].page).toBe(2)
    const a = await executeAction({ ctx, actor: "web" }, { action: "import.apply", args: { id } })
    expect(a.commit).toBeTruthy()
    const entries = (a.data as any).entries as string[]
    const doc = ctx.store.getOwned("knowledge", entries[0].slice(10))!
    expect(doc.folder).toBe("import/konzept-login")
    expect(doc.fields.ai).toBe("vorschlag")
    expect(Object.values(doc.meta!.provenance!).flat().some((s) => s.type === "file" && s.ref === "Konzept Login.md#Abschnitt 1")).toBe(true)
    const mem = ctx.store.getOwned("memory", entries[1].slice(7))!
    expect(mem.fields.status).toBe("vorgeschlagen")
    expect(ctx.importer!.get(id)!.status).toBe("uebernommen")
  }, 30_000)
})
