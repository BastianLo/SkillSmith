/**
 * Step 4b/4c: web actions (one commit + audit event, 409, read-only, confirmations),
 * write security (origin, content type, token, strong token), AI access per document,
 * folders, rename with link rewrite, proposals.
 */
import { describe, expect, test } from "bun:test"
import { executeAction } from "../../src/core/actions"
import { finalizeRun } from "../../src/core/finalize"
import { BODY, cmdRun, makeCtx, makeRun } from "./helpers"

const PORT = 47480
const TOKEN = "c".repeat(48)
const ORIGIN = `http://127.0.0.1:${PORT}`

function post(path: string, body: unknown, init: { token?: string | null; origin?: string | null; type?: string; site?: string } = {}) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      host: `127.0.0.1:${PORT}`,
      "content-type": init.type ?? "application/json",
      ...(init.token === null ? {} : { "x-smith-token": init.token ?? TOKEN }),
      ...(init.origin === null ? {} : { origin: init.origin ?? ORIGIN }),
      ...(init.site ? { "sec-fetch-site": init.site } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

async function commitCount(ctx: ReturnType<typeof makeCtx>): Promise<number> {
  await ctx.git.init()
  return Number((await ctx.git.git(["rev-list", "--count", "HEAD"])).stdout.trim())
}

describe("web actions", () => {
  test("a web action is one run, one commit with prefix (web) and an audit event", async () => {
    const ctx = makeCtx()
    const before = await commitCount(ctx)
    const r = await executeAction({ ctx, actor: "web" }, { action: "doc.create", args: { title: "Mein Runbook", template: "runbook", folder: "betrieb" } })
    expect(r.ok).toBe(true)
    expect(r.commit).toBeTruthy()
    expect(await commitCount(ctx)).toBe(before + 1)
    const subject = (await ctx.git.git(["log", "-1", "--format=%s"])).stdout.trim()
    expect(subject).toBe("docsmith(web): create knowledge mein-runbook")
    const e = ctx.store.getOwned("knowledge", "mein-runbook")!
    expect(e.folder).toBe("betrieb")
    expect(e.fields).toMatchObject({ author: "user", ai: "vorschlag", template: "runbook" })
    expect(e.body).toContain("## Störungen")
    const ev = ctx.audit!.query({ run: r.run }).events
    expect(ev.find((x) => x.category === "change")).toMatchObject({ actor: "user-web", targets: ["knowledge:mein-runbook"] })
    expect(r.audit).toBeGreaterThan(0)
  })

  test("save with a stale base → 409 with the diff; preview shows the diff; force overwrites", async () => {
    const ctx = makeCtx()
    const run = cmdRun(ctx, "docsmith")
    await ctx.ops.create(run, "knowledge", { name: "doc", title: "Doc", description: "d", body: "## A\nalt" })
    await finalizeRun(ctx, run, { ok: true })
    const base = ctx.store.getOwned("knowledge", "doc")!.version
    // a background agent is faster
    const agent = cmdRun(ctx, "docsmith")
    await ctx.ops.update(agent, "knowledge", { name: "doc", body: "## A\nvom Agenten", reason: "x" })
    await finalizeRun(ctx, agent, { ok: true })
    const preview = await executeAction({ ctx, actor: "web" }, { action: "entry.save", args: { target: "knowledge:doc", body: "## A\nmein Text" }, preview: true })
    expect((preview.preview as any).diff.additions).toBe(1)
    let status = 0
    let body: any
    try {
      await executeAction({ ctx, actor: "web" }, { action: "entry.save", base, args: { target: "knowledge:doc", body: "## A\nmein Text" } })
    } catch (err: any) {
      status = err.status
      body = err.body
    }
    expect(status).toBe(409)
    expect(body.entry.body).toContain("vom Agenten")
    expect(body.diff.body.hunks.length).toBeGreaterThan(0)
    const forced = await executeAction({ ctx, actor: "web" }, { action: "entry.save", base, force: true, args: { target: "knowledge:doc", body: "## A\nmein Text" } })
    expect(forced.ok).toBe(true)
    expect(ctx.store.getOwned("knowledge", "doc")!.body).toContain("mein Text")
  })

  test("read-only: config switch and session lock block writes", async () => {
    const ctx = makeCtx({ web: { readOnly: true } })
    await expect(executeAction({ ctx, actor: "web" }, { action: "doc.create", args: { title: "x" } })).rejects.toMatchObject({ status: 403 })
    const ctx2 = makeCtx()
    await executeAction({ ctx: ctx2, actor: "web" }, { action: "system.lock", args: { locked: true } })
    await expect(executeAction({ ctx: ctx2, actor: "web" }, { action: "doc.create", args: { title: "x" } })).rejects.toMatchObject({ status: 403 })
    await executeAction({ ctx: ctx2, actor: "web" }, { action: "system.lock", args: { locked: false } })
    expect((await executeAction({ ctx: ctx2, actor: "web" }, { action: "doc.create", args: { title: "x" } })).ok).toBe(true)
  })

  test("unknown actions and arguments are rejected; delete needs the typed name and an archived entry", async () => {
    const ctx = makeCtx()
    await expect(executeAction({ ctx, actor: "web" }, { action: "fs.write", args: {} })).rejects.toMatchObject({ status: 404 })
    await expect(executeAction({ ctx, actor: "web" }, { action: "doc.create", args: { title: "x", path: "/etc/passwd" } })).rejects.toMatchObject({ status: 400 })
    await executeAction({ ctx, actor: "web" }, { action: "doc.create", args: { title: "Weg damit" } })
    await expect(executeAction({ ctx, actor: "web" }, { action: "entry.delete", args: { target: "knowledge:weg-damit", confirm: "weg-damit" } })).rejects.toMatchObject({ status: 422 })
    await executeAction({ ctx, actor: "web" }, { action: "entry.archive", args: { target: "knowledge:weg-damit" } })
    await expect(executeAction({ ctx, actor: "web" }, { action: "entry.delete", args: { target: "knowledge:weg-damit", confirm: "falsch" } })).rejects.toMatchObject({ status: 422 })
    const r = await executeAction({ ctx, actor: "web" }, { action: "entry.delete", args: { target: "knowledge:weg-damit", confirm: "weg-damit" } })
    expect(r.commit).toBeTruthy()
    expect(ctx.store.fresh("knowledge", "weg-damit")).toBeUndefined()
  })

  test("undo of a web action restores the previous state", async () => {
    const ctx = makeCtx()
    const r = await executeAction({ ctx, actor: "web" }, { action: "doc.create", args: { title: "Kurz", body: "eins" } })
    await executeAction({ ctx, actor: "web" }, { action: "entry.save", args: { target: "knowledge:kurz", body: "zwei" } })
    const last = ctx.audit!.query({ category: ["run"], limit: 1 }).events[0]
    const u = await executeAction({ ctx, actor: "web" }, { action: "run.undo", args: { run: last.run } })
    expect(u.message).toContain("Zurückgenommen")
    expect(ctx.store.getOwned("knowledge", "kurz")!.body).toBe("eins")
    expect(r.ok).toBe(true)
  })
})

describe("write security over HTTP", () => {
  test("origin, fetch metadata, content type, size, preflight, token", async () => {
    const ctx = makeCtx({ web: { port: PORT, maxBodyKB: 16 } })
    const h = (r: Request) => ctx.web!.handle(r, PORT, TOKEN)
    const ok = await h(post("/api/action", { action: "doc.create", args: { title: "Per HTTP" } }))
    expect(ok.status).toBe(200)
    expect((await ok.json()).commit).toBeTruthy()
    expect((await h(post("/api/action", { action: "doc.create", args: { title: "x" } }, { origin: null }))).status).toBe(403)
    expect((await h(post("/api/action", { action: "doc.create", args: { title: "x" } }, { origin: "http://evil.example" }))).status).toBe(403)
    expect((await h(post("/api/action", { action: "doc.create", args: { title: "x" } }, { site: "cross-site" }))).status).toBe(403)
    expect((await h(post("/api/action", "action=doc.create", { type: "application/x-www-form-urlencoded" }))).status).toBe(415)
    expect((await h(post("/api/action", { action: "doc.create", args: { title: "x", body: "y".repeat(20_000) } }))).status).toBe(413)
    expect((await h(post("/api/action", { action: "doc.create", args: { title: "x" } }, { token: null }))).status).toBe(401)
    expect((await h(new Request(`${ORIGIN}/api/action`, { method: "OPTIONS", headers: { host: `127.0.0.1:${PORT}` } }))).status).toBe(405)
    expect((await h(post("/api/stats", {}))).status).toBe(405)
    expect(ctx.audit!.query({ category: ["security"] }).events.length).toBeGreaterThan(0)
  })

  test("without token: reads and normal writes work, agent start still needs the token", async () => {
    const ctx = makeCtx({ web: { port: PORT, token: false } })
    const h = (r: Request) => ctx.web!.handle(r, PORT, TOKEN)
    expect((await h(post("/api/action", { action: "doc.create", args: { title: "Ohne Token" } }, { token: null }))).status).toBe(200)
    const strong = await h(post("/api/action", { action: "agent.assign", args: { target: "task:t-1", agent: "build" } }, { token: null }))
    expect(strong.status).toBe(401)
    expect((await strong.json()).code).toBe("token-required")
    // the origin check stays active
    expect((await h(post("/api/action", { action: "doc.create", args: { title: "x" } }, { token: null, origin: "http://evil.example" }))).status).toBe(403)
  })

  test("attachments: upload as raw bytes, size limit, secret scan, served with a sandbox CSP", async () => {
    const ctx = makeCtx({ web: { port: PORT }, docs: { attachmentMaxMB: 0.1 } })
    const h = (r: Request) => ctx.web!.handle(r, PORT, TOKEN)
    const up = (name: string, data: Uint8Array | string) =>
      h(new Request(`${ORIGIN}/api/upload?name=${encodeURIComponent(name)}`, { method: "POST", headers: { host: `127.0.0.1:${PORT}`, origin: ORIGIN, "x-smith-token": TOKEN, "content-type": "application/octet-stream" }, body: data }))
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const r = await up("Bild 1.png", png)
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.data.markdown).toMatch(/^!\[Bild 1\.png\]\(anhang:\d{4}-\d{2}\/bild-1-[a-z0-9]+\.png\)$/)
    const get = await h(new Request(`${ORIGIN}/api/attachment?path=${encodeURIComponent(j.data.path)}`, { headers: { host: `127.0.0.1:${PORT}`, "x-smith-token": TOKEN } }))
    expect(get.status).toBe(200)
    expect(get.headers.get("content-security-policy")).toContain("sandbox")
    expect((await up("x.exe", "MZ")).status).toBe(415)
    expect((await up("big.png", new Uint8Array(200_000))).status).toBe(413)
    expect((await up("secret.txt", "password=hunter2hunter2 token ghp_abcdefghijklmnopqrstuvwxyz0123456789")).status).toBe(422)
    expect((await h(new Request(`${ORIGIN}/api/attachment?path=..%2F..%2Fstore.json`, { headers: { host: `127.0.0.1:${PORT}`, "x-smith-token": TOKEN } }))).status).toBe(400)
  })
})

describe("AI access per document", () => {
  test("vorschlag → proposal (staged) for agents, lesen → rejected, privat → invisible", async () => {
    const ctx = makeCtx()
    for (const [name, ai] of [["mein-v", "vorschlag"], ["mein-l", "lesen"], ["mein-p", "privat"]] as const) {
      await executeAction({ ctx, actor: "web" }, { action: "doc.create", args: { title: name, body: `## Inhalt\nKafka Offsets ${name}`, ai } })
    }
    const agent = makeRun(ctx, "reviewer", { smith: "docsmith", userText: "x", haystack: "Kafka Offsets neu belegt" })
    const v = await ctx.ops.update(agent, "knowledge", { name: "mein-v", body: "## Inhalt\nKafka Offsets neu", evidence: "Kafka Offsets neu belegt", reason: "neu" })
    expect(v).toContain("staged")
    const staged = ctx.ops.staged().find((s) => s.name === "mein-v")!
    expect(staged.aiProposal).toBe(true)
    expect(ctx.store.getOwned("knowledge", "mein-v")!.body).toContain("mein-v")
    await expect(ctx.ops.update(agent, "knowledge", { name: "mein-l", body: "x", evidence: "Kafka Offsets neu belegt", reason: "x" })).rejects.toThrow(/read-only for the AI/)
    await expect(ctx.ops.update(agent, "knowledge", { name: "mein-p", body: "x", evidence: "Kafka Offsets neu belegt", reason: "x" })).rejects.toThrow(/not found/)
    await expect(ctx.ops.move(agent, "knowledge", { name: "mein-v", to: "archive", kind: "archive", reason: "x" })).rejects.toThrow(/never archived/)
    // relations (metadata) stay allowed for lesen, never for privat
    expect(await ctx.ops.relate(agent, { from: "knowledge:mein-l", to: "knowledge:mein-v", type: "related", strength: 3, description: "Beide zu Kafka Offsets." })).toContain("related")
    await expect(ctx.ops.relate(agent, { from: "knowledge:mein-p", to: "knowledge:mein-v", type: "related", strength: 3, description: "Beide zu Kafka Offsets." })).rejects.toThrow(/not found/)
    // private: not in agent search, but in the user's web search
    expect((await ctx.retriever.search("Kafka Offsets", { kinds: ["knowledge"] })).map((h) => h.name).sort()).toEqual(["mein-l", "mein-v"])
    const web = (await ctx.web!.api("search", new URLSearchParams({ q: "Kafka Offsets" }))) as any[]
    expect(web.map((x) => x.id)).toContain("knowledge:mein-p")
    // a rejected proposal is not repeated while the document is unchanged
    await executeAction({ ctx, actor: "web" }, { action: "proposal.reject", args: { id: staged.id, reason: "passt nicht" } })
    await expect(ctx.ops.update(agent, "knowledge", { name: "mein-v", body: "## Inhalt\nnochmal", evidence: "Kafka Offsets neu belegt", reason: "neu" })).rejects.toThrow(/rejected a proposal/)
  })

  test("accepting a proposal (also adjusted) applies it as the user; folder defaults set the AI access", async () => {
    const ctx = makeCtx()
    await executeAction({ ctx, actor: "web" }, { action: "folder.setAi", args: { folder: "privat", ai: "privat" } })
    await executeAction({ ctx, actor: "web" }, { action: "doc.create", args: { title: "Geheimnisvoll", folder: "privat/notizen" } })
    expect(ctx.store.getOwned("knowledge", "geheimnisvoll")!.fields.ai).toBe("privat")
    await executeAction({ ctx, actor: "web" }, { action: "doc.create", args: { title: "Notiz", body: "## A\nText" } })
    const agent = makeRun(ctx, "reviewer", { smith: "docsmith", userText: "x", haystack: "Text belegt hier" })
    await ctx.ops.update(agent, "knowledge", { name: "notiz", body: "## A\nText neu", evidence: "Text belegt hier", reason: "neu" })
    const s = ctx.ops.staged()[0]
    const p = await executeAction({ ctx, actor: "web" }, { action: "proposal.accept", args: { id: s.id }, preview: true })
    expect((p.preview as any).diff.additions).toBe(1)
    await executeAction({ ctx, actor: "web" }, { action: "proposal.accept", args: { id: s.id, body: "## A\nText angepasst" } })
    expect(ctx.store.getOwned("knowledge", "notiz")!.body).toBe("## A\nText angepasst")
    expect(ctx.ops.staged()).toHaveLength(0)
  })
})

describe("documents", () => {
  test("rename rewrites links in every referring entry (one commit); folders move with their docs", async () => {
    const ctx = makeCtx()
    await executeAction({ ctx, actor: "web" }, { action: "doc.create", args: { title: "Auth Gateway", body: "## A" } })
    await executeAction({ ctx, actor: "web" }, { action: "doc.create", args: { title: "Login", body: "Siehe [[auth-gateway]] und [[knowledge:auth-gateway|hier]]." } })
    await executeAction({ ctx, actor: "web" }, { action: "relation.create", args: { from: "knowledge:login", to: "knowledge:auth-gateway", type: "depends_on", strength: 4, description: "braucht das Gateway" } })
    const pv = await executeAction({ ctx, actor: "web" }, { action: "entry.rename", args: { target: "knowledge:auth-gateway", to: "gateway" }, preview: true })
    expect((pv.preview as any).affected.map((a: any) => a.id)).toEqual(["knowledge:login"])
    const before = await commitCount(ctx)
    await executeAction({ ctx, actor: "web" }, { action: "entry.rename", args: { target: "knowledge:auth-gateway", to: "gateway" } })
    expect(await commitCount(ctx)).toBe(before + 1)
    const login = ctx.store.getOwned("knowledge", "login")!
    expect(login.body).toBe("Siehe [[gateway]] und [[knowledge:gateway|hier]].")
    expect(login.meta!.relations!.map((r) => r.to)).toEqual(["knowledge:gateway"])
    await executeAction({ ctx, actor: "web" }, { action: "entry.relocate", args: { target: "knowledge:gateway", folder: "infra/netz" } })
    await executeAction({ ctx, actor: "web" }, { action: "folder.rename", args: { from: "infra", to: "plattform" } })
    expect(ctx.store.getOwned("knowledge", "gateway")!.folder).toBe("plattform/netz")
    expect(ctx.store.listFolders("knowledge")).toContain("plattform/netz")
    const log = await ctx.versions.log("knowledge", "gateway")
    expect(log.length).toBeGreaterThanOrEqual(2)
  })

  test("quick note, daily note, checklist toggle, glossary import, tags rename, mention → link", async () => {
    const ctx = makeCtx()
    await executeAction({ ctx, actor: "web" }, { action: "note.quick", args: { text: "Idee: Cache prüfen", session: "ses_9" } })
    await executeAction({ ctx, actor: "web" }, { action: "note.quick", args: { text: "Zweite Notiz" } })
    const inbox = ctx.store.getOwned("knowledge", "eingang")!
    expect(inbox.body).toMatch(/Idee: Cache prüfen \(\[Session\]\(#\/session\/ses_9\)\)\n- .* · Zweite Notiz$/)
    const j = await executeAction({ ctx, actor: "web" }, { action: "journal.open", args: { date: "2026-10-11" } })
    expect(j.target).toBe("knowledge:journal-2026-10-11")
    expect(ctx.store.getOwned("knowledge", "journal-2026-10-11")!.folder).toBe("journal")
    expect((j.data as any).standup).toContain("**Gestern**")
    await executeAction({ ctx, actor: "web" }, { action: "doc.create", args: { title: "Plan", body: "- [ ] eins\n- [ ] zwei (bis 2026-10-20)" } })
    expect(ctx.tasks.looseItems().map((x) => x.text)).toEqual(["eins", "zwei (bis 2026-10-20)"])
    await executeAction({ ctx, actor: "web" }, { action: "checklist.toggle", args: { target: "knowledge:plan", line: 0, done: true } })
    expect(ctx.store.getOwned("knowledge", "plan")!.body).toContain("- [x] eins")
    const imp = await executeAction({ ctx, actor: "web" }, { action: "glossary.import", args: { format: "csv", text: "Abkürzung;Bedeutung;Beschreibung\nZKB;Zürcher Kantonalbank;Bank\nDB2;Database 2;IBM-Datenbank" } })
    expect(imp.message).toContain("2 Bedeutung(en)")
    await executeAction({ ctx, actor: "web" }, { action: "entry.save", args: { target: "knowledge:plan", tags: ["deploy"] } })
    await executeAction({ ctx, actor: "web" }, { action: "tags.rename", args: { from: "deploy", to: "deployment" } })
    expect(ctx.store.getOwned("knowledge", "plan")!.tags).toEqual(["deployment"])
    await executeAction({ ctx, actor: "web" }, { action: "doc.create", args: { title: "Zürcher Kantonalbank Notizen", body: "Die ZKB hat ein Gateway." } })
    await executeAction({ ctx, actor: "web" }, { action: "mention.link", args: { target: "knowledge:zurcher-kantonalbank-notizen", to: "glossary:zkb", phrase: "ZKB" } })
    expect(ctx.store.getOwned("knowledge", "zurcher-kantonalbank-notizen")!.body).toBe("Die [[glossary:zkb|ZKB]] hat ein Gateway.")
  })

  test("static export as HTML and Markdown (private only on request)", async () => {
    const ctx = makeCtx()
    await executeAction({ ctx, actor: "web" }, { action: "doc.create", args: { title: "Öffentlich", body: "Siehe [[geheim]]" } })
    await executeAction({ ctx, actor: "web" }, { action: "doc.create", args: { title: "Geheim", body: "x", ai: "privat" } })
    const r = await executeAction({ ctx, actor: "web" }, { action: "export.static", args: { format: "html" } })
    const data = r.data as any
    expect(data.count).toBe(1)
    const { readFileSync } = await import("node:fs")
    const html = readFileSync(`${data.dir}/knowledge-offentlich.html`, "utf8")
    expect(html).toContain('<span class="broken">geheim</span>')
    const md = await executeAction({ ctx, actor: "web" }, { action: "export.static", args: { format: "md", includePrivate: true } })
    expect((md.data as any).count).toBe(2)
  })
})

describe("doctor and memories through actions", () => {
  test("conflict resolved by the user (shared with /smith-doctor)", async () => {
    const ctx = makeCtx()
    const run = cmdRun(ctx, "skillsmith")
    await ctx.ops.create(run, "skill", { name: "alt-skill", description: "Alt", body: BODY })
    await ctx.ops.create(run, "skill", { name: "neu-skill", description: "Neu", body: BODY })
    await finalizeRun(ctx, run, { ok: true })
    const id = ctx.mem!.openConflict("skill:alt-skill", "skill:neu-skill", "Duplikat?", 0.9, "a", "b")!
    const r = await executeAction({ ctx, actor: "web" }, { action: "conflict.resolve", args: { id, choice: "b" } })
    expect(r.message).toContain("B gilt")
    expect(ctx.store.getOwned("skill", "alt-skill")!.tier).toBe("archive")
    expect(ctx.mem!.conflict(id)!.status).toBe("resolved")
  })
})
