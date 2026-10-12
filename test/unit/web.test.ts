import { describe, expect, test } from "bun:test"
import { stateId } from "../../src/core/memory-db"
import { cmdRun, makeCtx, TEST_SCOPE } from "./helpers"

const where = { ...TEST_SCOPE }

async function seeded() {
  const ctx = makeCtx({ web: { port: 47470 } })
  const cmd = cmdRun(ctx, "memorysmith")
  await ctx.ops.memorySave(cmd, {
    type: "entscheidung",
    topic: "token",
    title: "Token im HttpOnly-Cookie",
    summary: "Auth-Token liegt im HttpOnly-Cookie",
    body: "## Entscheidung\nCookie mit `HttpOnly`.\n\n<script>alert(1)</script>",
    tags: ["auth"],
    where,
  })
  const d = cmdRun(ctx, "docsmith")
  await ctx.ops.create(d, "knowledge", { name: "auth-gateway", title: "Auth-Gateway", description: "Gateway prüft Cookies und Tokens", body: "## A\n- prüft" })
  await ctx.ops.relate(cmd, { from: "memory:shop-entscheidung-token", to: "knowledge:auth-gateway", type: "depends_on", strength: 4, description: "Das Gateway muss Cookies lesen können." })
  await ctx.ops.memoryState(cmd, { goal: "Login umbauen", open: ["Logout testen"], where })
  await ctx.ops.relate(cmd, { from: stateId(TEST_SCOPE.project, TEST_SCOPE.branch!), to: "memory:shop-entscheidung-token", type: "depends_on", strength: 3, description: "Die Arbeit setzt die Cookie-Entscheidung um." })
  return ctx
}

const PORT = 47470
const TOKEN = "a".repeat(48)
const req = (path: string, init: { host?: string; token?: string | null; origin?: string; method?: string } = {}) =>
  new Request(`http://127.0.0.1:${PORT}${path}`, {
    method: init.method ?? "GET",
    headers: {
      host: init.host ?? `127.0.0.1:${PORT}`,
      ...(init.token === null ? {} : { "x-smith-token": init.token ?? TOKEN }),
      ...(init.origin ? { origin: init.origin } : {}),
    },
  })

describe("web view", () => {
  test("security: host, origin, token, read-only, static files with CSP, no traversal", async () => {
    const ctx = await seeded()
    const web = ctx.web!
    const h = (r: Request) => web.handle(r, PORT, TOKEN)
    expect((await h(req("/api/stats", { host: "evil.example" }))).status).toBe(421)
    expect((await h(req("/api/stats", { origin: "http://evil.example" }))).status).toBe(403)
    expect((await h(req("/api/stats", { token: null }))).status).toBe(401)
    expect((await h(req("/api/stats", { token: "b".repeat(48) }))).status).toBe(401)
    expect((await h(req("/api/stats", { method: "POST" }))).status).toBe(405)
    const ok = await h(req("/api/stats", { origin: `http://127.0.0.1:${PORT}` }))
    expect(ok.status).toBe(200)
    expect(ok.headers.get("cache-control")).toBe("no-store")
    const index = await h(req("/", { token: null }))
    expect(index.status).toBe(200)
    expect(index.headers.get("content-security-policy")).toContain("script-src 'self'")
    expect(await index.text()).toContain("cytoscape.min.js")
    expect((await h(req("/vendor/cytoscape.min.js", { token: null }))).status).toBe(200)
    expect((await h(req("/../../package.json", { token: null }))).status).toBe(404)
    expect((await h(req("/%2e%2e/%2e%2e/package.json", { token: null }))).status).toBe(404)
    expect((await h(req("/api/nope"))).status).toBe(404)
  })

  test("entry: complete content with every relation (both directions), fields and evidence", async () => {
    const ctx = await seeded()
    const api = (path: string, q: Record<string, string> = {}) => ctx.web!.api(path, new URLSearchParams(q)) as Promise<any>
    const e = await api("entry", { id: "memory:shop-entscheidung-token" })
    expect(e.node.title).toBe("Token im HttpOnly-Cookie")
    expect(e.node.label).toBe("Entscheidung")
    expect(e.body).toContain("<script>alert(1)</script>") // raw markdown; the page escapes it
    expect(e.fields.find((f: string[]) => f[0] === "Status")[1]).toBe("gültig")
    const out = e.relations.find((r: any) => r.direction === "out")
    expect(out).toMatchObject({ type: "depends_on", label: "setzt voraus", strength: 0.8, description: "Das Gateway muss Cookies lesen können.", source: "user", derived: false })
    expect(out.other).toMatchObject({ id: "knowledge:auth-gateway", exists: true, label: "Wissen", title: "Auth-Gateway" })
    const inc = e.relations.find((r: any) => r.direction === "in")
    expect(inc.other.id).toBe(stateId(TEST_SCOPE.project, TEST_SCOPE.branch!))
    expect(inc.other.label).toBe("Arbeitsstand")
    const st = await api("entry", { id: stateId(TEST_SCOPE.project, TEST_SCOPE.branch!) })
    expect(st.body).toContain("## Offen\n- Logout testen")
    await expect(api("entry", { id: "memory:nope" })).rejects.toThrow(/not found/)
  })

  test("graph, search, list, stats, conflicts, timeline", async () => {
    const ctx = await seeded()
    const api = (path: string, q: Record<string, string> = {}) => ctx.web!.api(path, new URLSearchParams(q)) as Promise<any>
    const g = await api("graph", { center: "memory:shop-entscheidung-token", depth: "1" })
    expect(g.nodes.map((n: any) => n.id).sort()).toEqual(["knowledge:auth-gateway", "memory:shop-entscheidung-token", stateId(TEST_SCOPE.project, TEST_SCOPE.branch!)].sort())
    expect(g.edges).toHaveLength(2)
    const filtered = await api("graph", { kinds: "memory,knowledge" })
    expect(filtered.nodes.some((n: any) => n.kind === "arbeitsstand")).toBe(false)
    const strong = await api("graph", { minStrength: "0.7" })
    expect(strong.edges.map((e: any) => e.type)).toEqual(["depends_on"])
    const s = await api("search", { q: "Cookie Token" })
    expect(s[0].id).toBe("memory:shop-entscheidung-token")
    const list = await api("list", { kind: "memory", type: "entscheidung" })
    expect(list).toHaveLength(1)
    const stats = await api("stats")
    expect(stats.memoryTypes.entscheidung).toBe(1)
    expect(stats.currentState.summary).toContain("Login umbauen")
    expect(stats.relations.stored).toBe(2)
    ctx.mem!.openConflict("memory:shop-entscheidung-token", "knowledge:auth-gateway", "Bezug prüfen", 0.8, "a", "b")
    const conflicts = await api("conflicts")
    expect(conflicts[0].a.title).toBeTruthy()
    expect(Array.isArray(await api("timeline"))).toBe(true)
  })

  test("start serves on 127.0.0.1 with a token link and stops again", async () => {
    const ctx = await seeded()
    const info = await ctx.web!.start()
    try {
      expect(info.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#t=[0-9a-f]{48}$/)
      const r = await fetch(`http://127.0.0.1:${info.port}/api/stats`, { headers: { "x-smith-token": info.token } })
      expect(r.status).toBe(200)
      expect((await r.json()).project).toBe("shop")
      const no = await fetch(`http://127.0.0.1:${info.port}/api/stats`)
      expect(no.status).toBe(401)
    } finally {
      ctx.web!.stop()
    }
    expect(ctx.web!.running).toBe(false)
  })
})
