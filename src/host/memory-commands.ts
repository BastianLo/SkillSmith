/** Commands of memorysmith, the doctor and the web view. */
import type { Ctx } from "../core/context"
import { str } from "../core/frontmatter"
import { isStoreId } from "../core/graph"
import { stateId } from "../core/memory-db"
import { formatMemoryList, formatResult, formatState, memoryLine } from "../core/memory-format"
import { resolveConflict } from "../core/actions/memory"
import { normalizeNodeId } from "../core/ops"
import type { ReviewQueue } from "../core/queue"
import type { Entry, Run, Smith } from "../types"
import { errorMessage, tokenize, truncate } from "../util/text"

export type Mutate = (ctx: Ctx, smith: Smith, trigger: string, sessionID: string, fn: (run: Run) => Promise<string>) => Promise<string>

export const MEMORY_COMMANDS = [
  { name: "memory", usage: "/memory [suchbegriffe]", description: "memorysmith: Erinnerungen dieses Projekts (Arbeitsstand, Vorgaben, Entscheidungen, Erfahrungen, Ergebnisse) bzw. suchen" },
  { name: "remember", usage: "/remember [text]", description: "memorysmith: etwas ausdrücklich merken (ohne Text: diese Session sofort auf Erinnerungen prüfen)" },
  { name: "forget", usage: "/forget <id>", description: "memorysmith: Erinnerung archivieren bzw. Arbeitsstand/Ergebnis verwerfen" },
  { name: "resume", usage: "/resume [branch]", description: "memorysmith: Arbeitsstand eines Branches mit offenen Punkten und Entscheidungen zeigen" },
  { name: "smith-doctor", usage: "/smith-doctor [run|resolve <id> a|b|beide|kein-bezug]", description: "doctor: Konflikte und Bezüge zwischen Einträgen – Status, Lauf starten, Konflikt entscheiden" },
  { name: "smith-web", usage: "/smith-web [stop]", description: "skillsmith: Weboberfläche öffnen – Wissen, Editor, Graph, Aufgaben, Pipeline, Agenten, Statistik" },
]

const inScope = (ctx: Ctx, e: Entry) => {
  const p = str(e.fields.project)
  return !p || p === ctx.scope().project || ctx.options.memorysmith.crossProject
}

function overview(ctx: Ctx): string {
  const s = ctx.scope()
  const mem = ctx.mem
  const memories = ctx.store.list("memory").filter((e) => e.tier === "active" && inScope(ctx, e))
  const of = (t: string) => memories.filter((e) => str(e.fields.type) === t).sort((a, b) => (b.meta?.updatedAt ?? "").localeCompare(a.meta?.updatedAt ?? ""))
  const states = mem?.states(s.project).filter((x) => x.status === "gueltig") ?? []
  const current = s.branch ? states.find((x) => x.branch === s.branch) : undefined
  const results = mem?.results(s.project).slice(0, 5) ?? []
  const doc = ctx.doctor?.status()
  const lines = [
    `**Erinnerungen – ${s.projectName}**${s.branch ? ` (Branch ${s.branch}${s.ticket ? `, ${s.ticket}` : ""})` : ""}`,
    `Projekt-Id: ${s.project}`,
    "",
    current ? formatState(current) : `Kein Arbeitsstand für ${s.branch ? `Branch ${s.branch}` : "dieses Verzeichnis"}.`,
  ]
  const others = states.filter((x) => x !== current)
  if (others.length) lines.push("", `Weitere Arbeitsstände: ${others.map((x) => `${x.branch}${x.ticket ? ` (${x.ticket})` : ""}`).join(", ")} – /resume <branch>`)
  for (const [type, label] of [
    ["vorgabe", "Vorgaben"],
    ["entscheidung", "Entscheidungen"],
    ["erfahrung", "Erfahrungen"],
  ] as const) {
    const list = of(type)
    lines.push("", `**${label} (${list.length})**`)
    lines.push(list.length ? formatMemoryList(list.slice(0, type === "erfahrung" ? 8 : 15)) : "- (keine)")
    if (type === "erfahrung" && list.length > 8) lines.push(`- … ${list.length - 8} weitere (/memory <suchbegriffe>)`)
  }
  if (results.length) lines.push("", `**Ergebnisse (${results.length})**`, ...results.map((r) => `- ${formatResult(r)}`))
  if (!mem?.available) lines.push("", "Hinweis: lokale Datenbank (SQLite) nicht verfügbar – Arbeitsstände, Ergebnisse und Doktor sind aus.")
  if (doc && (doc.open || doc.needsUser)) lines.push("", `Doktor: ${doc.needsUser} Konflikt(e) brauchen eine Entscheidung, ${doc.open} offen – /smith-doctor`)
  lines.push("", "Lesen: memory_read(id) im Chat · /forget <id> · /smith-web für Graph und Details")
  return lines.join("\n")
}

async function search(ctx: Ctx, query: string): Promise<string> {
  const s = ctx.scope()
  const hits = await ctx.retriever.search(query, { kinds: ["memory"], tiers: ["active", "archive"], limit: 30, purpose: "search" })
  const lines: string[] = []
  for (const h of hits) {
    const e = ctx.store.getOwned("memory", h.name)
    if (!e || !inScope(ctx, e)) continue
    lines.push(`- ${memoryLine(e)}`)
    if (lines.length >= 12) break
  }
  const terms = [...new Set(tokenize(query))]
  if (ctx.mem?.available && terms.length) {
    const score = (text: string) => {
      const t = new Set(tokenize(text))
      return terms.filter((x) => t.has(x)).length / terms.length
    }
    for (const st of ctx.mem.states(s.project)) if (score(formatState(st)) >= 0.5) lines.push(`- ${st.id} [Arbeitsstand] Branch ${st.branch} – ${truncate(st.summary || st.goal, 140)}`)
    for (const r of ctx.mem.results(s.project)) if (score(`${r.title}\n${r.question}\n${r.answer}`) >= 0.5) lines.push(`- ${formatResult(r)}`)
  }
  if (!lines.length) return `Keine Erinnerung zu „${truncate(query, 80)}“ in ${s.projectName}.`
  return [`**Erinnerungen zu „${truncate(query, 80)}“**`, "", ...lines, "", "Details: memory_read(id) · /smith-web"].join("\n")
}

function resume(ctx: Ctx, branchArg: string): string {
  const s = ctx.scope()
  const branch = branchArg || s.branch
  if (!branch) return "Kein Branch erkannt (kein git-Repository?). Angabe: /resume <branch>"
  if (!ctx.mem?.available) return "Die lokale Datenbank (SQLite) ist nicht verfügbar – Arbeitsstände sind aus."
  const st = ctx.mem.getState(stateId(s.project, branch))
  const lines: string[] = []
  if (!st) {
    lines.push(`Für Branch ${branch} in ${s.projectName} ist kein Arbeitsstand gespeichert.`)
    const others = ctx.mem.states(s.project).filter((x) => x.status === "gueltig")
    if (others.length) lines.push(`Vorhanden: ${others.map((x) => x.branch).join(", ")}`)
  } else {
    lines.push(formatState(st, { history: true }))
    if (st.status !== "gueltig") lines.push("(abgelaufen – evtl. nicht mehr aktuell)")
  }
  const memories = ctx.store
    .list("memory")
    .filter((e) => e.tier === "active" && inScope(ctx, e) && ["vorgabe", "entscheidung"].includes(str(e.fields.type)) && str(e.fields.status) !== "abgeloest")
  const onBranch = ctx.store.list("memory").filter((e) => e.tier === "active" && str(e.fields.branch) === branch && str(e.fields.project) === s.project && str(e.fields.type) === "erfahrung")
  if (memories.length) lines.push("", "Vorgaben und Entscheidungen:", formatMemoryList(memories.slice(0, 15)))
  if (onBranch.length) lines.push("", `Erfahrungen auf ${branch}:`, formatMemoryList(onBranch.slice(0, 8)))
  const results = ctx.mem.results(s.project).filter((r) => r.branch === branch).slice(0, 5)
  if (results.length) lines.push("", "Ergebnisse:", ...results.map((r) => `- ${formatResult(r)}`))
  lines.push("", "Diese Informationen stammen aus früheren Sessions; der Nutzer kann sie korrigieren.")
  return lines.join("\n")
}

async function forget(ctx: Ctx, mutate: Mutate, raw: string, sessionID: string): Promise<string> {
  if (!raw) return "Angabe: /forget <id> (z. B. memory:<name>, state:…, result:… – siehe /memory)"
  let id = normalizeNodeId(raw)
  if (!id.includes(":")) id = `memory:${id}`
  if (id.startsWith("state:")) {
    if (!ctx.mem?.getState(id)) return `Arbeitsstand ${id} nicht gefunden.`
    ctx.mem.setStateStatus(id, "abgelaufen")
    return `Arbeitsstand ${id} verworfen (abgelaufen).`
  }
  if (id.startsWith("result:")) {
    if (!ctx.mem?.getResult(id)) return `Ergebnis ${id} nicht gefunden.`
    ctx.mem.deleteResult(id)
    return `Ergebnis ${id} gelöscht.`
  }
  const s = isStoreId(id)
  if (!s || s.kind !== "memory") return `${id} ist keine Erinnerung. Andere Einträge: /smith-archive <art> <name>.`
  if (!ctx.store.getOwned("memory", s.name)) return `Erinnerung ${s.name} nicht gefunden.`
  return mutate(ctx, "memorysmith", "forget", sessionID, (run) => ctx.ops.move(run, "memory", { name: s.name, to: "archive", kind: "archive", reason: "vom Nutzer vergessen (/forget)" }))
}

function remember(ctx: Ctx, queue: ReviewQueue, text: string, sessionID: string): string {
  if (!ctx.options.memorysmith.enabled) return "memorysmith ist ausgeschaltet (memorysmith.enabled)."
  ctx.sessions.update(sessionID, ctx.directory, (s) => {
    if (text) s.rememberNotes = [...(s.rememberNotes ?? []), truncate(text, 2000)].slice(-10)
    s.rememberRequested = true
  })
  queue.enqueue(sessionID, "remember", true)
  return text
    ? `Wird gemerkt: „${truncate(text, 200)}“ – memorysmith speichert es gleich im Hintergrund (Ergebnis: Toast bzw. /memory).`
    : "memorysmith prüft diese Session jetzt auf Entscheidungen, Vorgaben, Erfahrungen und den Arbeitsstand."
}

async function doctorCommand(ctx: Ctx, mutate: Mutate, args: string, sessionID: string): Promise<string> {
  const doctor = ctx.doctor
  if (!doctor || !ctx.mem?.available) return "Der Doktor ist nicht verfügbar (doctor.enabled = false oder SQLite fehlt)."
  const [sub, id, choiceRaw] = args.split(/\s+/).filter(Boolean)
  if (sub === "run") {
    void doctor
      .run("manual")
      .then((r) => ctx.toast(truncate(`Doktor: ${r.pairs} Paar(e) geprüft – ${r.summary}${r.error ? ` (Fehler: ${r.error})` : ""}`, 300), r.ok ? "success" : "warning"))
      .catch((err) => ctx.log.error("doctor run failed", errorMessage(err)))
    return "Doktor gestartet (Kandidaten suchen, offene Paare beurteilen). Ergebnis: Toast bzw. /smith-doctor."
  }
  if (sub === "resolve") return resolve(ctx, mutate, id ?? "", (choiceRaw ?? "").toLowerCase(), sessionID)
  const st = doctor.status()
  const mem = ctx.mem
  const needs = mem.conflicts("needs_user")
  const open = mem.conflicts("open")
  const recent = mem
    .conflicts("resolved")
    .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))
    .slice(0, 5)
  const lines = [
    "**Doktor**",
    `Warteschlange: ${st.queued} · offen: ${st.open} · Entscheidung nötig: ${st.needsUser} · gelöst: ${st.resolved}`,
    `Automatische Korrektur bei klar veraltetem Wissen: ${ctx.options.doctor.autoResolve ? "an" : "aus"}`,
  ]
  if (needs.length) lines.push("", "**Bitte entscheiden** (/smith-doctor resolve <id> a|b|beide|kein-bezug):", ...needs.slice(0, 15).map((c) => doctor.describe(c)))
  if (open.length) lines.push("", `**Offen** (nächster Lauf: /smith-doctor run):`, ...open.slice(0, 10).map((c) => doctor.describe(c)))
  if (recent.length) lines.push("", "**Zuletzt gelöst:**", ...recent.map((c) => doctor.describe(c)))
  if (!needs.length && !open.length) lines.push("", "Keine offenen Konflikte.")
  return lines.join("\n")
}

const CHOICES: Record<string, "a" | "b" | "both" | "unrelated"> = {
  a: "a",
  b: "b",
  both: "both",
  beide: "both",
  unrelated: "unrelated",
  "kein-bezug": "unrelated",
  keiner: "unrelated",
  none: "unrelated",
}

async function resolve(ctx: Ctx, mutate: Mutate, id: string, choiceRaw: string, sessionID: string): Promise<string> {
  const choice = CHOICES[choiceRaw]
  if (!choice) return "Angabe: /smith-doctor resolve <id> a|b|beide|kein-bezug  (a = A gilt, B ist veraltet; b = umgekehrt)"
  return mutate(ctx, "doctor", "resolve", sessionID, (run) => resolveConflict(ctx, run, id, choice))
}

async function webCommand(ctx: Ctx, args: string): Promise<string> {
  if (!ctx.web) return "Die Weboberfläche ist nicht verfügbar."
  if (args === "stop") {
    if (!ctx.web.running) return "Die Weboberfläche läuft in diesem Fenster nicht."
    ctx.web.stop()
    return "Weboberfläche gestoppt."
  }
  try {
    const info = await ctx.web.start()
    const o = ctx.options.web
    const host = info.host ?? o.host
    const reach = host === "127.0.0.1" || host === "localhost" ? `nur auf diesem Rechner erreichbar (127.0.0.1:${info.port})` : `erreichbar über ${host}:${info.port} – nur mit Token`
    const mode = o.readOnly ? "Nur lesend (web.readOnly)" : "Lesen und Bearbeiten: Dokumente, Aufgaben, Projekte, Agenten – jede Änderung ist ein Commit im Store"
    const token = o.token
      ? "Der Link enthält den Zugangsschlüssel – nicht weitergeben."
      : "Token-Prüfung ist aus (web.token: false). Der Link enthält trotzdem den Schlüssel: Agenten starten/freigeben und Pipeline-Befehle ändern brauchen ihn immer."
    return [
      "**skillsmith Web**",
      "",
      `Öffnen: ${info.url}`,
      "",
      `${mode} · ${reach}.`,
      token,
      o.tokenRotate ? "Neuer Schlüssel bei jedem Start (web.tokenRotate)." : "Der Schlüssel bleibt über Neustarts gleich (web.tokenRotate: false) – Lesezeichen funktionieren weiter.",
      info.pid !== process.pid ? "(läuft bereits in einem anderen opencode-Fenster)" : "Stoppen: /smith-web stop (endet auch mit opencode)",
    ].join("\n")
  } catch (err) {
    return `Weboberfläche konnte nicht starten: ${errorMessage(err)}`
  }
}

/** Dispatcher for the commands above (undefined = not one of them). */
export async function memoryCommand(ctx: Ctx, queue: ReviewQueue, mutate: Mutate, name: string, args: string, sessionID: string): Promise<string | undefined> {
  switch (name) {
    case "memory":
      return args ? search(ctx, args) : overview(ctx)
    case "remember":
      return remember(ctx, queue, args, sessionID)
    case "forget":
      return forget(ctx, mutate, args, sessionID)
    case "resume":
      return resume(ctx, args)
    case "smith-doctor":
      return doctorCommand(ctx, mutate, args, sessionID)
    case "smith-web":
      return webCommand(ctx, args)
    default:
      return undefined
  }
}

/** Report lines for /smith-report. */
export function memoryReportLines(ctx: Ctx): string[] {
  const memories = ctx.store.list("memory")
  const active = memories.filter((e) => e.tier === "active")
  const count = (t: string) => active.filter((e) => str(e.fields.type) === t).length
  const proposed = active.filter((e) => str(e.fields.status) === "vorgeschlagen").length
  const mem = ctx.mem
  const doc = ctx.doctor?.status()
  return [
    `Erinnerungen: ${count("entscheidung")} Entscheidungen${proposed ? ` (${proposed} unbestätigt)` : ""} · ${count("vorgabe")} Vorgaben · ${count("erfahrung")} Erfahrungen · ${memories.length - active.length} archiviert · ${mem?.available ? `${mem.states().filter((s) => s.status === "gueltig").length} Arbeitsstände · ${mem.results().length} Ergebnisse` : "lokale Datenbank aus"}`,
    doc ? `Doktor: ${doc.queued} in Warteschlange · ${doc.open} offen · ${doc.needsUser} Entscheidung nötig · ${doc.resolved} gelöst` : `Doktor: aus`,
    `Web: ${ctx.web?.running && ctx.web.info ? `läuft auf 127.0.0.1:${ctx.web.info.port} (/smith-web)` : "aus (/smith-web)"}`,
  ]
}
