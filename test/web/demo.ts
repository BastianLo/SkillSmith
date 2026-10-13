/**
 * Demo server of the web view (development, screenshots, UI smoke test):
 * a temporary store with documents, tasks, a project with pipeline, memories, conflicts,
 * metrics over 90 days and an agent job (fake opencode client) – then the real WebServer.
 *
 *   bun test/web/demo.ts [port]        → prints the link with token
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { deflateSync } from "node:zlib"
import { executeAction } from "../../src/core/actions"
import { agentHub, checkTool } from "../../src/core/agent-hub"
import { finalizeRun } from "../../src/core/finalize"
import { M } from "../../src/core/metrics"
import { jobDefs } from "../../src/core/job-defs"
import { JobScheduler } from "../../src/core/jobs"
import { createLogger, withLogContext } from "../../src/log"
import { BODY, ERROR_BODY, cmdRun, makeCtx, makeRun, tmp } from "../unit/helpers"

const TOKEN_STORE = `package de.shop.auth;

import java.util.Set;

public class TokenStore {
  private final Set<String> revoked;

  public TokenStore(Set<String> revoked) {
    this.revoked = revoked;
  }

  public void revoke(String id) {
    revoked.add(id);
  }

  public String find(String id) {
    return revoked.contains(id) ? null : id;
  }
}
`

const port = Number(process.argv[2] || process.env.DEMO_PORT || 47555)
const DAY = 86_400_000

// ---------------------------------------------------------------------------
// fake opencode server for the agent job
// ---------------------------------------------------------------------------
function fakeClient() {
  const sessions = new Map<string, { id: string; directory?: string; parentID?: string; title: string; status: "idle" | "busy"; messages: any[] }>()
  let n = 0
  const now = () => Date.now()
  const msg = (role: string, parts: any[], extra: any = {}) => ({ info: { id: `m${++n}`, role, mode: extra.mode ?? "orchestrator", providerID: "litellm", modelID: "deepseek-v4.1-flash", cost: role === "assistant" ? 0.0042 : 0, tokens: role === "assistant" ? { input: 5200, output: 640, reasoning: 120 } : undefined, time: { created: now(), completed: now() } }, parts })
  const reply = (s: any, parts: any[], mode?: string) => {
    s.messages.push(msg("assistant", parts, { mode }))
    s.status = "idle"
  }
  const tool = (name: string, title: string, input: unknown, output: string) => ({ type: "tool", tool: name, state: { status: "completed", title, input, output, time: { start: now() - 1800, end: now() } } })
  const client: any = {
    app: { agents: async () => ({ data: [{ name: "orchestrator", mode: "primary", description: "plant und delegiert", model: { providerID: "litellm", modelID: "deepseek-v4.1-flash" } }, { name: "generalist", mode: "primary", description: "erledigt alles selbst" }, { name: "hera", mode: "primary", description: "Orchestrator (Router-Kombination)", model: { providerID: "Hermes", modelID: "" } }, { name: "build", mode: "primary" }, { name: "explore", mode: "subagent" }] }) },
    config: {
      providers: async () => ({ data: { providers: [{ id: "litellm", models: { "deepseek-v4.1-flash": { id: "deepseek-v4.1-flash" } } }, { id: "9router", models: { Hermes: { id: "Hermes" }, Athene: { id: "Athene" } } }], default: { litellm: "deepseek-v4.1-flash" } } }),
      get: async () => ({ data: {} }),
    },
    session: {
      create: async ({ body, query }: any) => {
        const id = `ses_${++n}${Math.random().toString(36).slice(2, 6)}`
        sessions.set(id, { id, directory: query?.directory, parentID: body?.parentID, title: body?.title ?? "", status: "idle", messages: [] })
        return { data: { id, title: body?.title } }
      },
      get: async ({ path }: any) => ({ data: sessions.get(path.id) }),
      promptAsync: async ({ path, body, query }: any) => {
        const s = sessions.get(path.id)!
        const text = body.parts[0].text as string
        s.messages.push(msg("user", [{ type: "text", text }]))
        s.status = "busy"
        setTimeout(async () => {
          const dir = query?.directory ?? s.directory
          if (/^Du verifizierst die Umsetzung/.test(text)) return reply(s, [{ type: "text", text: 'Beide Kriterien sind durch Diff und Testprotokoll belegt. Ein Hinweis zur Fehlermeldung.\n```json\n{"verdicts": [{"criterion": "K1", "verdict": "erfuellt", "evidence": "Logout ruft TokenStore.revoke auf (src/Logout.java:3); TF1 bestanden"}, {"criterion": "K2", "verdict": "erfuellt", "evidence": "TF2: zweiter Logout liefert 204"}], "findings": [{"file": "src/Logout.java", "line": 4, "severity": "warn", "text": "Fehlermeldung nennt den Grund nicht"}], "summary": "Erfüllt; Fehlermeldung könnte genauer sein."}\n```' }], "verifier")
          if (/SCHRITT TEST/.test(text)) return reply(s, [tool("bash", "curl -X POST /logout (2×)", { command: "curl -s -o /dev/null -w '%{http_code}' -X POST localhost:8080/logout" }, "204\n204"), { type: "text", text: 'Getestet.\n```json\n[{"id": "TF2", "result": "bestanden", "protocol": "Zwei POST /logout hintereinander: beide 204."}]\n```' }], "tester")
          if (/SCHRITT PLANUNG|überarbeitet haben/.test(text)) {
            const child = `ses_${++n}sub`
            sessions.set(child, { id: child, directory: dir, parentID: s.id, title: "Code lesen", status: "idle", messages: [msg("user", [{ type: "text", text: "Lies LoginController und finde die Session-Behandlung" }]), msg("assistant", [tool("read", "src/LoginController.java", { filePath: "src/LoginController.java" }), { type: "text", text: "Die Session wird in `invalidate()` beendet, das Token bleibt gültig." }], { mode: "explore" })] })
            agentHub().parents.set(child, s.id)
            try {
              await checkTool(child, "edit", async () => s.id)
            } catch {
              // the guard rejects writes of subagents in the proposal phase (audited)
            }
            return reply(s, [tool("task", "Code lesen (explore)", { description: "Code lesen" }, "Session wird beendet, Token bleibt gültig"), { type: "text", text: 'Ich habe den Login-Ablauf gelesen.\n```json\n{"approach": "Beim Logout zusätzlich das Refresh-Token in der Datenbank sperren und den Endpunkt nur mit gültiger Session erlauben.", "files": ["src/Logout.java", "src/TokenStore.java"], "steps": ["TokenStore.revoke(userId) ergänzen", "Logout ruft revoke auf", "Test für doppelten Logout"], "risks": ["laufende Sessions anderer Geräte werden beendet"], "questions": ["Sollen alle Geräte abgemeldet werden?"], "criteria": ["Refresh-Token ist nach dem Logout gesperrt", "Doppelter Logout liefert 204"], "testcases": [{"title": "Logout-Klasse vorhanden", "mode": "befehl", "command": "test -f src/Logout.java", "expected": "Exit 0"}, {"title": "Doppelter Logout", "mode": "agent", "steps": ["POST /logout", "POST /logout erneut"], "expected": "beide Antworten 204"}, {"title": "Abmelden im Browser auf T2", "mode": "manuell", "pre": "angemeldet auf T2", "steps": ["Abmelden klicken", "Seite neu laden"], "expected": "Login-Seite erscheint, Refresh schlägt fehl"}]}\n```' }])
          }
          if (/SCHRITT UMSETZUNG/.test(text)) {
            mkdirSync(join(dir, "src"), { recursive: true })
            writeFileSync(join(dir, "src", "Logout.java"), 'class Logout {\n  void run(TokenStore store, String user) {\n    store.revoke(user);\n    throw new IllegalStateException("fehlgeschlagen");\n  }\n}\n')
            return reply(s, [tool("edit", "src/Logout.java", { filePath: "src/Logout.java" }, "ok"), tool("bash", "mvn -q test", { command: "mvn -q test" }, "Tests run: 12, Failures: 0"), { type: "text", text: "Umgesetzt: `Logout` sperrt das Token über `TokenStore.revoke`. Tests laufen." }])
          }
          if (/Prüfbefehle des Projekts sind rot/.test(text)) {
            writeFileSync(join(dir, "fixed.txt"), "ok\n")
            return reply(s, [{ type: "text", text: "Nachgebessert: fehlende Datei ergänzt." }])
          }
          if (/^Du bearbeitest die PowerPoint/.test(text)) {
            const plan = /Agenda/.test(text.split("## Aktueller Stand")[0])
              ? { summary: "Agenda nach dem Deckblatt eingefügt.", ops: [{ op: "add_slide", at: 2, title: "Agenda", body: ["Ausgangslage", "Lösung", "Nächste Schritte"] }] }
              : { summary: "Deckblatt, Ausgangslage und Lösung angelegt.", ops: [{ op: "add_slide", title: "Logout-Konzept", subtitle: "Team Billing · Oktober 2026" }, { op: "add_slide", title: "Ausgangslage", body: ["Refresh-Token bleibt nach dem Logout gültig", "Gestohlene Tokens funktionieren weiter"], notes: "Vorfall aus T2 erwähnen" }, { op: "add_slide", title: "Lösung", body: ["TokenStore.revoke beim Logout", "Doppelter Logout liefert 204"] }, { op: "add_table", slide: 3, rows: [["Schritt", "Aufwand"], ["revoke ergänzen", "1 Tag"], ["Tests", "0,5 Tage"]], y: 66, h: 22 }] }
            return reply(s, [{ type: "text", text: "```json\n" + JSON.stringify(plan) + "\n```" }])
          }
          if (/^Du bearbeitest das Word/.test(text)) {
            const plan = { summary: "Deckblatt vorangestellt.", ops: [{ op: "insert", after: "start", blocks: [{ style: "Title", text: "Konzept Logout" }, { style: "Subtitle", text: "Team Billing · Oktober 2026" }, { text: "Stand: Entwurf zur Abstimmung" }] }, { op: "page_break", before: "p0" }] }
            return reply(s, [{ type: "text", text: "```json\n" + JSON.stringify(plan) + "\n```" }])
          }
          return reply(s, [{ type: "text", text: "ok" }])
        }, 30)
        return { data: undefined }
      },
      status: async () => ({ data: Object.fromEntries([...sessions.values()].map((x) => [x.id, { type: x.status }])) }),
      children: async ({ path }: any) => ({ data: [...sessions.values()].filter((x) => x.parentID === path.id).map((x) => ({ id: x.id, title: x.title, time: { created: Date.now() } })) }),
      messages: async ({ path }: any) => ({ data: sessions.get(path.id)?.messages ?? [] }),
      abort: async () => ({ data: true }),
      revert: async () => ({ data: true }),
      diff: async () => ({ data: [] }),
      delete: async () => ({ data: true }),
    },
    postSessionIdPermissionsPermissionId: async () => ({ data: true }),
    tui: { showToast: async () => ({}) },
  }
  return client
}

// ---------------------------------------------------------------------------
// tiny PNG (attachment demo)
// ---------------------------------------------------------------------------
function png(w: number, hgt: number): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_x, k) => {
    let c = k
    for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf: Uint8Array) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length)
    const dv = new DataView(out.buffer)
    dv.setUint32(0, data.length)
    out.set(new TextEncoder().encode(type), 4)
    out.set(data, 8)
    dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)))
    return out
  }
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, w)
  dv.setUint32(4, hgt)
  ihdr.set([8, 2, 0, 0, 0], 8)
  const raw = new Uint8Array(hgt * (1 + w * 3))
  for (let y = 0; y < hgt; y++) {
    raw[y * (1 + w * 3)] = 0
    for (let x = 0; x < w; x++) {
      const i = y * (1 + w * 3) + 1 + x * 3
      raw[i] = 40 + Math.round((x / w) * 60)
      raw[i + 1] = 90 + Math.round((y / hgt) * 100)
      raw[i + 2] = 200
    }
  }
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

// ---------------------------------------------------------------------------
// seed
// ---------------------------------------------------------------------------
async function main() {
  const home = tmp("skillsmith-demo-app-")
  const g = (...a: string[]) => execFileSync("git", a, { cwd: home, env: { ...process.env, GIT_AUTHOR_NAME: "u", GIT_AUTHOR_EMAIL: "u@x", GIT_COMMITTER_NAME: "u", GIT_COMMITTER_EMAIL: "u@x" } })
  g("init", "-q", "-b", "main")
  mkdirSync(join(home, "src"), { recursive: true })
  writeFileSync(join(home, "src", "LoginController.java"), "class LoginController {}\n")
  writeFileSync(join(home, "src", "TokenStore.java"), TOKEN_STORE)
  writeFileSync(join(home, ".gitignore"), "target/\n")
  writeFileSync(join(home, "ci.sh"), `#!/bin/sh\nmkdir -p target/surefire-reports\nprintf '<testsuite tests="3" failures="0"><testcase classname="de.shop.LoginTest" name="login"/><testcase classname="de.shop.LoginTest" name="logout"/><testcase classname="de.shop.TokenTest" name="revoke"/></testsuite>' > target/surefire-reports/TEST-login.xml\necho "[INFO] Tests run: 3, Failures: 0"\n`)
  g("add", "-A")
  g("commit", "-q", "-m", "init")

  // no autoStart: the demo moves cards without starting agents (deterministic state for the UI tests)
  const ctx = makeCtx({ web: { port, autostart: false }, tasks: { autoFixRounds: 1, autoStart: false } }, fakeClient())
  const web = (action: string, args: Record<string, unknown> = {}, payload?: Uint8Array) => executeAction({ ctx, actor: "web" }, { action, args }, payload)

  // documents of the user (folders, links, tags, checklists, mermaid, code, table, image)
  await web("folder.create", { path: "betrieb/runbooks" })
  await web("folder.create", { path: "architektur" })
  await web("folder.setAi", { folder: "architektur", ai: "lesen" })
  const att = await web("attachment.add", { path: `knowledge/_anhaenge/${new Date().toISOString().slice(0, 7)}/login-ablauf-demo.png`, name: "Login-Ablauf" }, png(320, 120))
  await web("doc.create", {
    title: "Auth-Gateway",
    folder: "architektur",
    description: "Wie Login, Token und Logout im Kundenportal zusammenspielen",
    tags: ["auth", "gateway"],
    body: `## Überblick\nDas Gateway prüft jedes Token gegen den [[Token-Store]] und leitet an die Services weiter. #sicherheit\n\n${(att.data as any).markdown}\n\n## Ablauf\n\`\`\`mermaid\nsequenceDiagram\n  Browser->>Gateway: Login\n  Gateway->>TokenStore: issue\n  Browser->>Gateway: Logout\n  Gateway->>TokenStore: revoke\n\`\`\`\n\n## Konfiguration\n| Schlüssel | Wert |\n|---|---|\n| token.ttl | 15 min |\n| refresh.ttl | 7 Tage |\n\n\`\`\`java\n@Bean\nSecurityFilterChain chain(HttpSecurity http) {\n  return http.oauth2ResourceServer(o -> o.jwt()).build();\n}\n\`\`\`\n\nSiehe auch [[skill:kafka-reset|Kafka-Offsets zurücksetzen]] und T-1.`,
  })
  await web("doc.create", { title: "Token-Store", folder: "architektur", description: "Speicherung und Sperre von Refresh-Tokens (DB2)", tags: ["auth", "db2"], body: "## Tabelle\n`AUTH.REFRESH_TOKEN` mit Spalte `REVOKED_AT`.\n\n## Sperren\n1. `UPDATE AUTH.REFRESH_TOKEN SET REVOKED_AT = CURRENT TIMESTAMP WHERE USER_ID = ?`\n2. Cache im Gateway leeren.\n\nGenutzt vom [[Auth-Gateway]]." })
  await web("doc.create", { title: "Deployment Testsystem T2", folder: "betrieb/runbooks", template: "runbook", tags: ["deployment", "t2"], body: "## Vorbereitung\n- [ ] Changelog prüfen (bis 2026-10-20)\n- [x] Freigabe im Ticket\n- [ ] Datenbank-Migration testen\n\n## Schritte\n1. Pipeline im Kundenportal grün\n2. `helm upgrade portal ./chart -n t2`\n\nBei Fehlern: [[error:pkix-path-building-failed]]" })
  await web("doc.create", { title: "Besprechung Login-Redesign", tags: ["besprechung"], template: "besprechung", body: "## Teilnehmer\nTeam Portal\n\n## Entscheidungen\n- Logout sperrt künftig auch das Refresh-Token\n\n## Offene Punkte\n- [ ] Rückfrage beim Fachbereich zu Mehrgeräte-Logout\n- [ ] Konzept für Passwort-Reset" })
  await web("doc.create", { title: "Persönliche Notizen", ai: "privat", body: "Nur für mich – die KI sieht dieses Dokument nicht." })
  // entries of the agents
  const rev = cmdRun(ctx, "skillsmith")
  rev.actor = "reviewer"
  await ctx.ops.create(rev, "skill", { name: "kafka-reset", description: "Kafka consumer group offsets reset", body: BODY, tags: ["kafka"], approved: true })
  await finalizeRun(ctx, rev, { ok: true })
  const er = cmdRun(ctx, "errorsmith")
  er.actor = "reviewer"
  await ctx.ops.create(er, "error", { name: "pkix-path-building-failed", title: "PKIX path building failed", description: "Maven lädt nicht vom Nexus – Root-CA fehlt", body: ERROR_BODY, tags: ["maven", "tls"], fields: { status: "solved", signatures: ["PKIX path building failed"], context: ["maven"] }, approved: true })
  await finalizeRun(ctx, er, { ok: true })
  const ds = cmdRun(ctx, "docsmith")
  ds.actor = "reviewer"
  await ctx.ops.create(ds, "knowledge", { name: "t2-testsystem", title: "Testsystem T2", description: "Zugänge, Eigenheiten und Datenstand des Testsystems T2", body: "## Zugang\nÜber das Gateway `t2.portal.intern`.\n\n## Eigenheiten\n- Datenbank wird jeden Montag zurückgesetzt\n- Mail-Versand geht an den Testpostfach-Sammler", tags: ["t2", "testsystem"], approved: true })
  await ctx.ops.glossaryUpsert(ds, { term: "ZKB", meanings: [{ expansion: "Zentrale Kundenbetreuung", description: "Fachbereich für Kundenanfragen", context: "Portal" }], aliases: [], reason: "Demo", approved: true })
  await ctx.ops.glossaryUpsert(ds, { term: "SSO", meanings: [{ expansion: "Single Sign-on", description: "Anmeldung über den Konzern-IdP" }], aliases: ["S.S.O."], reason: "Demo", approved: true })
  await finalizeRun(ctx, ds, { ok: true })
  // memories, state, result
  const where = { project: "github.com/acme/shop", projectName: "shop", projectSlug: "shop", branch: "feature/T2-123-login", ticket: "T2-123" }
  const mem = cmdRun(ctx, "memorysmith")
  await ctx.ops.memorySave(mem, { type: "entscheidung", topic: "token-speicherung", title: "Refresh-Token im HttpOnly-Cookie statt localStorage", summary: "Token-Speicherung im Browser: HttpOnly-Cookie wegen XSS", body: "## Entscheidung\nHttpOnly-Cookie.\n\n## Begründung\nXSS kann localStorage auslesen.\n\n## Alternativen\n- localStorage (verworfen)", where })
  await ctx.ops.memorySave(mem, { type: "vorgabe", topic: "lombok", title: "Kein Lombok in diesem Projekt", summary: "Lombok ist im Kundenportal nicht erlaubt", body: "Getter und Setter ausschreiben.", where })
  await ctx.ops.memorySave(mem, { type: "erfahrung", topic: "t2-datenbank", title: "T2-Datenbank wird montags zurückgesetzt", summary: "Testdaten auf T2 sind montags weg", body: "Testdaten nach Montag neu anlegen.", where })
  await finalizeRun(ctx, mem, { ok: true })
  ctx.mem?.upsertState({ project: where.project, projectName: "shop", branch: where.branch, ticket: where.ticket, goal: "Logout sperrt das Refresh-Token", done: ["Ablauf analysiert", "TokenStore.revoke entworfen"], open: ["Test für doppelten Logout", "Rückfrage Mehrgeräte-Logout"], next: ["Logout-Endpunkt umbauen"], files: ["src/Logout.java"], summary: "Umsetzung des Logouts läuft" })
  ctx.mem?.addResult?.({ project: where.project, projectName: "shop", branch: where.branch, title: "Wo das Gateway Tokens prüft", question: "Wo werden Tokens geprüft?", answer: "Im `JwtFilter` des Gateways, Cache 60 s.", files: ["gateway/JwtFilter.java"], sources: [], tags: ["auth"] } as any)
  await web("relation.create", { from: "knowledge:auth-gateway", to: "memory:shop-entscheidung-token-speicherung", type: "depends_on", strength: 4, description: "Das Gateway setzt die Entscheidung zur Token-Speicherung um" })
  ctx.mem?.openConflict("knowledge:t2-testsystem", "memory:shop-erfahrung-t2-datenbank", "Wann wird T2 zurückgesetzt?", 0.82, "a", "b")
  // a proposal of docsmith for a user document (KI-Recht vorschlag → staged)
  const prop = makeRun(ctx, "reviewer", { smith: "docsmith", userText: "Die Migration muss vor dem Deployment auf T2 laufen, sonst startet der Pod nicht." })
  await ctx.ops.update(prop, "knowledge", { name: "deployment-testsystem-t2", body: "## Vorbereitung\n- [ ] Changelog prüfen (bis 2026-10-20)\n- [x] Freigabe im Ticket\n- [ ] Datenbank-Migration testen\n- [ ] Migration vor dem Deployment ausführen (sonst startet der Pod nicht)\n\n## Schritte\n1. Pipeline im Kundenportal grün\n2. `helm upgrade portal ./chart -n t2`\n\nBei Fehlern: [[error:pkix-path-building-failed]]", evidence: "Die Migration muss vor dem Deployment auf T2 laufen", reason: "Reihenfolge Migration/Deployment ergänzt" })
  await finalizeRun(ctx, prop, { ok: true })

  // project with pipeline, tasks, suggested task
  await web("project.save", {
    name: "kundenportal",
    title: "Kundenportal",
    description: "Spring-Boot-Backend und React-Frontend des Kundenportals",
    home_path: home,
    agent: "orchestrator",
    color: "#0b7fbf",
    wip: { umsetzung: 3 },
    pipeline: { trigger: ["test"], source: "arbeitsverzeichnis", stages: [{ name: "build", run: "echo '[INFO] BUILD SUCCESS'" }, { name: "verify", run: "sh ci.sh && test -f fixed.txt -o -f src/LoginController.java", reports: "target/surefire-reports/*.xml", timeout: "20m" }, { name: "lint", run: "echo 'checkstyle: 0 Verstöße'", allowFailure: true }] },
  })
  await web("project.save", { name: "batch", title: "Batch-Verarbeitung", description: "Nächtliche Abgleiche mit DB2", color: "#8a44c6" })
  const t = async (title: string, extra: Record<string, unknown> = {}) => (await web("task.create", { title, project: "kundenportal", ...extra })).data as { id: string }
  await t("Logout-Endpunkt absichern", { priority: "hoch", labels: ["auth", "backend"], due: new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10), body: "Beim Logout bleibt das Refresh-Token gültig. Siehe [[Auth-Gateway]] und [[Token-Store]].\n\n## Akzeptanzkriterien\n- [ ] Token ist nach Logout gesperrt\n- [ ] Doppelter Logout liefert 204\n- [x] Ablauf mit Fachbereich geklärt", ticket: "T2-123", branch: "feature/T2-123-login" })
  await t("Passwort-Reset-Mail auf T2 prüfen", { labels: ["t2"], due: new Date(Date.now() - DAY).toISOString().slice(0, 10) })
  await t("Gateway-Timeouts konfigurierbar machen", { labels: ["gateway"], priority: "normal" })
  await t("Login-Seite barrierefrei", { labels: ["frontend", "a11y"], priority: "niedrig" })
  await t("DB2-Index für Token-Abfrage", { labels: ["db2"], priority: "kritisch" })
  await web("task.subtask", { target: "task:t-1", title: "TokenStore.revoke implementieren" })
  await web("task.subtask", { target: "task:t-1", title: "LogoutTest schreiben" })
  await web("task.move", { target: "task:t-3", to: "planung" })
  await web("task.move", { target: "task:t-4", to: "planung" })
  await web("task.move", { target: "task:t-5", to: "umsetzung" })
  await web("task.move", { target: "task:t-2", to: "test" })
  await web("task.create", { title: "Nächtlichen Abgleich parallelisieren", project: "batch", labels: ["performance"] })
  await web("attachment.add", { path: `knowledge/_anhaenge/${new Date().toISOString().slice(0, 7)}/screenshot-fehler.png`, target: "task:t-2", name: "Screenshot Fehler" }, png(200, 90))
  const s = cmdRun(ctx, "memorysmith")
  s.actor = "command"
  await ctx.tasks.create(s, { title: "Mehrgeräte-Logout mit Fachbereich klären", project: "kundenportal", suggested: true, body: "> das machen wir später\n\n_Vorschlag von memorysmith_" })
  await finalizeRun(ctx, s, { ok: true })

  // agent job: plan → gate 1 → implementation → pipeline (red, fix) → test cases (command, agent;
  // the manual one waits for the user – the UI flow enters it) → verification → gate 2
  const a = await web("agent.assign", { target: "task:t-1", agent: "orchestrator", workplace: "worktree" })
  const job = (a.data as any).job
  const until = async (pred: (j: any) => boolean) => {
    for (let i = 0; i < 400 && !pred(ctx.agentTasks.get(job)); i++) {
      await ctx.agentTasks.tick()
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  await until((j) => j?.phase === "waiting" && j.waitingFor === "plan")
  await web("agent.approve", { job, answers: "Sollen alle Geräte abgemeldet werden?\n→ Ja, alle Geräte." })
  await until((j) => j?.phase === "waiting" && j.waitingFor === "tests")
  ctx.agentTasks.start()

  // 5c: knowledge anchored in code (one anchor changes after a commit), provenance per paragraph
  await web("doc.create", { title: "Refresh-Token sperren", folder: "architektur", description: "Wo und wie der Logout das Refresh-Token sperrt", tags: ["auth"], body: "## Sperre\nBeim Logout ruft der Controller [[code:TokenStore#revoke]] auf; das setzt `REVOKED_AT`.\n\n## Suche\n[[code:TokenStore#find]] liefert gesperrte Tokens nicht mehr aus.\n\nDatei: [[code:src/TokenStore.java]]" })
  writeFileSync(join(home, "src", "TokenStore.java"), TOKEN_STORE.replace("    revoked.add(id);", "    revoked.add(id);\n    audit.log(\"revoke\", id);"))
  g("commit", "-qam", "audit revoke")
  await ctx.anchors!.runJob("Start")
  const hay = "Nutzer: Das Gateway cached geprüfte Tokens 60 Sekunden. Tool: JwtFilter.java: CACHE_TTL = Duration.ofSeconds(60); Revocations werden erst nach Ablauf des Caches wirksam."
  const rv = makeRun(ctx, "reviewer", { smith: "docsmith", userText: hay, haystack: hay, limits: { maxNew: 2, maxChanges: 5, maxNotes: 2 } })
  await ctx.ops.create(rv, "knowledge", { name: "gateway-token-cache", title: "Token-Cache im Gateway", description: "Geprüfte Tokens werden 60 Sekunden gecacht", tags: ["auth", "gateway"], body: "## Cache\nDas Gateway cached geprüfte Tokens 60 Sekunden.\n\n## Folge\nEine Sperre wirkt erst nach Ablauf des Caches.\n\n## Offen\nOb der Cache je Pod oder zentral liegt, ist nicht belegt.", evidence: "Das Gateway cached geprüfte Tokens 60 Sekunden", sources: [{ paragraph: "Eine Sperre wirkt erst", evidence: "Revocations werden erst nach Ablauf des Caches wirksam" }] })
  await finalizeRun(ctx, rv, { ok: true })

  // 5d–5j: gym task, snippet, prompt, review candidates, an import (findings without model)
  await web("entry.create", { kind: "snippet", title: "SLF4J-Logger", description: "Logger-Feld einer Klasse", tags: ["java", "logging"], body: "```java\nprivate static final Logger ${name:log} = LoggerFactory.getLogger(${klasse}.class);\n```" })
  await web("entry.create", { kind: "prompt", name: "review-diff", title: "Diff reviewen", description: "Diff gegen die Vorgaben des Teams prüfen", tags: ["review"], body: "Prüfe {{auswahl}} für Ticket {{ticket}} auf Branch {{branch}} gegen unsere Vorgaben.", fields: { agent: "build" } })
  await web("gym.task.save", { entry: "knowledge:refresh-token-sperren", prompt: "Wie wird beim Logout das Refresh-Token gesperrt?", mode: "fragen", checks: [{ type: "contains", text: "REVOKED_AT" }] })
  await ctx.reviews!.add(["Bitte keine Field Injection mit @Autowired.", "Constructor Injection statt @Autowired Field Injection.", "Field Injection @Autowired vermeiden."].map((body, i) => ({ id: `acme/portal#${i + 1}`, repo: "acme/portal", pr: 10 + i, author: i % 2 ? "ben" : "anna", body, path: "src/LoginController.java", line: 12, url: `https://github.com/acme/portal/pull/${10 + i}`, at: new Date().toISOString() })))
  await ctx.reviews!.bundle()
  const imp = await ctx.importer!.create("Konzept Logout.md", new TextEncoder().encode("# Ablauf\nBeim Logout wird das Refresh-Token gesperrt und der Gateway-Cache geleert.\n\n# Offene Punkte\nMehrgeräte-Logout mit dem Fachbereich klären."))
  const st = ctx.importer!.get(imp.id)!
  st.status = "fertig"
  st.sections = st.sections.map((x) => ({ ...x, done: true }))
  st.findings = [
    { index: 0, type: "wissen", title: "Logout sperrt das Refresh-Token", text: "Beim Logout wird das Refresh-Token gesperrt und der Gateway-Cache geleert.", quote: "Beim Logout wird das Refresh-Token gesperrt", page: 1, selected: true, similar: { id: "knowledge:refresh-token-sperren", title: "Refresh-Token sperren", score: 0.71 } },
    { index: 1, type: "offen", title: "Mehrgeräte-Logout klären", text: "Mehrgeräte-Logout mit dem Fachbereich klären.", quote: "Mehrgeräte-Logout mit dem Fachbereich klären", page: 2, selected: true },
  ]
  require("node:fs").writeFileSync(require("node:path").join(ctx.store.stateDir, "imports", imp.id, "import.json"), JSON.stringify(st))

  // office documents: a .potx template, a deck from it filled by the AI (accepted), an open
  // draft on top, a Word document
  const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "office")
  await web("office.upload", { fileName: "Firmenvorlage.potx", title: "Firmenvorlage" }, new Uint8Array(readFileSync(join(fixtures, "firmenvorlage.potx"))))
  await web("office.create", { format: "pptx", title: "Logout-Konzept", template: "office:firmenvorlage", prompt: "Erstelle bitte eine kurze Präsentation zum Logout-Konzept" })
  const settle = async (n: string) => {
    for (let i = 0; i < 2400 && (ctx.office!.isRunning(n) || !ctx.office!.draft(n) || ctx.office!.draft(n)!.status === "laeuft"); i++) await new Promise((r) => setTimeout(r, 25))
  }
  await settle("logout-konzept")
  await web("office.accept", { target: "office:logout-konzept" })
  ctx.office!.edit("logout-konzept", "Füge nach dem Deckblatt eine Agenda ein")
  await settle("logout-konzept")
  await web("office.upload", { fileName: "Konzept Logout.docx", title: "Konzept Logout (Word)" }, new Uint8Array(readFileSync(join(fixtures, "konzept-logout.docx"))))

  // metrics over 90 days (charts, calendar, heatmap, tools)
  const m = ctx.metrics!
  const entries = ["skill:kafka-reset", "knowledge:auth-gateway", "knowledge:token-store", "error:pkix-path-building-failed", "knowledge:t2-testsystem", "memory:shop-entscheidung-token-speicherung"]
  const tools = ["bash", "read", "edit", "grep", "jira_get_issue", "confluence_search", "db2_query", "browser_open"]
  let seed = 7
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280)
  for (let d = 90; d >= 0; d--) {
    const dayStart = Date.now() - d * DAY
    const weekday = new Date(dayStart).getDay()
    if (weekday === 0 || weekday === 6) continue
    const sessions = 2 + Math.floor(rnd() * 4)
    for (let sIdx = 0; sIdx < sessions; sIdx++) {
      const at = dayStart - (dayStart % DAY) + (7 + Math.floor(rnd() * 10)) * 3_600_000 + Math.floor(rnd() * 3_600_000)
      const session = `ses_demo_${d}_${sIdx}`
      m.record({ at, type: M.userMessage, session, project: "shop", origin: "main" })
      m.record({ at: at + 60_000, type: M.reply, entry: "session", session, project: "shop", model: "litellm/deepseek-v4.1-flash", value: 4000 + Math.floor(rnd() * 9000), value2: 0.002 + rnd() * 0.01, origin: "main" })
      for (let k = 0; k < 6; k++) m.record({ at: at + k * 30_000, type: M.toolCall, entry: `tool:${tools[Math.floor(rnd() * tools.length)]}`, session, value: 50 + Math.floor(rnd() * 3000), extra: rnd() < 0.06 ? { error: true } : {}, origin: "main" })
      const e = entries[Math.floor(rnd() * entries.length)]
      m.record({ at: at + 5000, type: M.hintShown, entry: e, session, origin: "main" })
      if (rnd() < 0.55) m.record({ at: at + 9000, type: M.hintFollowed, entry: e, session, origin: "main" })
      if (rnd() < 0.5) m.record({ at: at + 12000, type: M.load, entry: entries[Math.floor(rnd() * entries.length)], session, agent: "orchestrator", origin: "main" })
      if (rnd() < 0.2) m.record({ at: at + 15000, type: M.errorOccurrence, entry: "sig:pkix", session, project: "shop" })
      m.record({ at: at + 600_000, type: M.smithRun, entry: `smith:${["skillsmith", "docsmith", "memorysmith", "errorsmith"][Math.floor(rnd() * 4)]}`, value: 20_000 + Math.floor(rnd() * 60_000), extra: { ok: true }, origin: "background" })
      m.record({ at: at + 600_000, type: M.reply, entry: "smith:docsmith", model: "litellm/deepseek-v4.1-flash", value: 9000 + Math.floor(rnd() * 5000), value2: 0.004, origin: "background" })
    }
  }
  await m.flush()
  // one red pipeline run for the statistics
  await ctx.pipeline.start({ project: "kundenportal", task: "t-2", trigger: "manual", by: "demo" }).catch(() => undefined)

  // structured log, jobs with history (5a)
  const log = createLogger(join(ctx.store.stateDir, "log"), { level: (a) => (ctx.options.log.areas[a] ?? ctx.options.log.level) as any, redact: (s) => ctx.redactor.redact(s) })
  ctx.log = log
  ctx.jobs = new JobScheduler(ctx, () => jobDefs(ctx))
  await ctx.jobs.run("prune", "Start")
  await ctx.jobs.run("lifecycle", "Start")
  withLogContext({ run: "web-demo-pipeline-1" }, () => {
    log.child("pipeline").info("Stufe build gestartet", { project: "kundenportal", command: "./ci.sh" })
    log.child("pipeline").warn("Stufe test rot", { failed: 1, token: "sk-demo1234567890abcdef" })
  })
  withLogContext({ session: "ses_demo_1" }, () => log.child("reviewer").error("Review fehlgeschlagen", "ProviderModelNotFoundError: Model not found: Hermes/."))
  log.child("embeddings").info("3 Eintrag/Kandidat(en) eingebettet")

  const info = await ctx.web!.start()
  console.log(`DEMO_URL ${info.url}`)
  console.log(`store ${ctx.store.root}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
