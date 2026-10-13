/** Slash commands (registered through the config hook, executed in command.execute.before). */
import { isAbsolute, join, resolve } from "node:path"
import type { Ctx } from "../core/context"
import type { Curator } from "../core/curator"
import { promptCost } from "../core/curator"
import { commandAction } from "../core/actions"
import { undoRun } from "../core/actions/system"
import { finalizeRun } from "../core/finalize"
import { str as fmStr, strArray } from "../core/frontmatter"
import { glossarySlug, kindFromAlias, meaningsOf, spec, TIER_LABEL } from "../core/kinds"
import { GuardError } from "../core/ops"
import { SMITHS } from "../core/prompts"
import { pythonEnv } from "../core/pyworkshop"
import type { ReviewQueue } from "../core/queue"
import { Retriever } from "../core/retrieval"
import { resolveModel } from "../core/reviewer"
import { buildEvalSet, formatEval, runEval } from "../core/embed-eval"
import { formatRecord } from "../core/session-history"
import { StoreError } from "../core/store"
import type { VectorStoreInfo } from "../core/vector-store"
import type { Entry, Kind, Run, Smith, Tier } from "../types"
import { KINDS } from "../types"
import { ensureDir, readText, writeFileAtomic } from "../util/fs"
import { daysBetween, errorMessage, fold, oneLine, truncate } from "../util/text"
import { glossaryRows, parseCsv, parseMarkdownTable } from "../core/actions/csv"
import { formatGlossary } from "./tools"
import { MEMORY_COMMANDS, memoryCommand, memoryReportLines } from "./memory-commands"
import { matchModel, modelCatalog, refOf, specOf } from "../core/models"

export { glossaryRows, parseCsv, parseMarkdownTable }

export interface CommandDef {
  name: string
  usage: string
  description: string
}

import { LIBRARY_COMMANDS, promptCommand } from "./library-commands"

export const COMMANDS: CommandDef[] = [
  { name: "smith-help", usage: "/smith-help", description: "skillsmith: Übersicht aller Befehle" },
  { name: "smith-report", usage: "/smith-report", description: "skillsmith: Status aller Smiths, Queue, Modell, Nutzung, letzte Commits" },
  { name: "smith-review", usage: "/smith-review", description: "skillsmith: diese Session sofort von allen Smiths bewerten lassen" },
  { name: "smith-curate", usage: "/smith-curate [dry]", description: "skillsmith: Curator jetzt ausführen (dry = nur Vorschau)" },
  { name: "smith-undo", usage: "/smith-undo [run-id|commit]", description: "skillsmith: letzten (oder angegebenen) Lauf per git revert zurücknehmen" },
  { name: "smith-pending", usage: "/smith-pending", description: "skillsmith: zur Freigabe vorgemerkte Änderungen" },
  { name: "smith-approve", usage: "/smith-approve <id|all>", description: "skillsmith: vorgemerkte Änderung übernehmen" },
  { name: "smith-reject", usage: "/smith-reject <id|all>", description: "skillsmith: vorgemerkte Änderung verwerfen" },
  { name: "smith-list", usage: "/smith-list <skills|wissen|glossar|fehler|skripte> [active|dormant|archive]", description: "skillsmith: Einträge einer Art auflisten" },
  { name: "smith-tags", usage: "/smith-tags [art]", description: "skillsmith: Tags/Schlagworte mit Anzahl" },
  { name: "smith-embed", usage: "/smith-embed [status|sync|eval [sessions]]", description: "skillsmith: semantische Suche – Status, Neuaufbau, Auswertung mit echten Sessions" },
  { name: "smith-pin", usage: "/smith-pin [art] <name>", description: "skillsmith: Eintrag anpinnen (nie automatisch archivieren)" },
  { name: "smith-unpin", usage: "/smith-unpin [art] <name>", description: "skillsmith: Pin entfernen" },
  { name: "smith-restore", usage: "/smith-restore [art] <name>", description: "skillsmith: ruhenden/archivierten Eintrag wieder aktivieren" },
  { name: "smith-archive", usage: "/smith-archive [art] <name>", description: "skillsmith: Eintrag archivieren" },
  { name: "skills-search", usage: "/skills-search <suchbegriffe>", description: "skillsmith: Skills durchsuchen (alle Stufen)" },
  { name: "skills-adopt", usage: "/skills-adopt <name>", description: "skillsmith: fremden Skill in den Store übernehmen" },
  { name: "knowledge", usage: "/knowledge [suchbegriffe]", description: "docsmith: Wissensdatenbank durchsuchen bzw. auflisten" },
  { name: "glossary", usage: "/glossary [abkürzung|suchbegriffe]", description: "docsmith: Glossar nachschlagen bzw. auflisten" },
  { name: "glossary-add", usage: "/glossary-add ABK | Bedeutung | Beschreibung [| Kontext]", description: "docsmith: Abkürzung ins Glossar eintragen" },
  { name: "glossary-open", usage: "/glossary-open", description: "docsmith: offene (unbekannte) Abkürzungen" },
  { name: "glossary-ignore", usage: "/glossary-ignore ABK [ABK …]", description: "docsmith: Abkürzungen künftig ignorieren" },
  { name: "glossary-import", usage: "/glossary-import <datei.csv|datei.md>", description: "docsmith: Glossar aus CSV oder Markdown-Tabelle importieren" },
  { name: "glossary-export", usage: "/glossary-export [ziel.md]", description: "docsmith: Glossar als Markdown-Tabelle exportieren" },
  { name: "errors", usage: "/errors [suchbegriffe]", description: "errorsmith: dokumentierte Fehler durchsuchen bzw. auflisten" },
  { name: "errors-top", usage: "/errors-top", description: "errorsmith: häufigste Fehler (dokumentiert und undokumentiert)" },
  { name: "scripts", usage: "/scripts [suchbegriffe]", description: "toolsmith: Skripte durchsuchen bzw. auflisten" },
  { name: "scripts-test", usage: "/scripts-test [name]", description: "toolsmith: Skripte jetzt neu testen" },
  { name: "docs-search", usage: "/docs-search <suchbegriffe>", description: "docsmith: Doku dieses Projekts (.md-Dateien) nach Bedeutung und Stichworten durchsuchen" },
  { name: "history", usage: "/history [suchbegriffe]", description: "skillsmith: frühere Sessions auflisten (dieses Projekt) bzw. durchsuchen (alle Projekte)" },
  { name: "task", usage: "/task [neu <titel> | <T-12> | <T-12> <spalte>]", description: "skillsmith: Aufgaben – anlegen, anzeigen, verschieben (Board: /smith-web)" },
  { name: "note", usage: "/note <text>", description: "skillsmith: Schnellnotiz ins Dokument „Eingang“ (mit Session-Link)" },
  { name: "doc", usage: "/doc <thema> [| vorlage]", description: "docsmith: aus dieser Session ein Dokument schreiben lassen (Entwurf als Ihr Dokument)" },
  ...MEMORY_COMMANDS,
  ...LIBRARY_COMMANDS,
]

export const COMMAND_NAMES = new Set(COMMANDS.map((c) => c.name))

export interface CommandDeps {
  queue: ReviewQueue
  curator: Curator
}

function commandRun(ctx: Ctx, smith: Smith, trigger: string, sessionID?: string): Run {
  return ctx.runs.create({
    smith,
    actor: "command",
    trigger,
    writeMode: "auto",
    directory: ctx.directory,
    project: ctx.project,
    sessionID,
    limits: { maxNew: 10_000, maxChanges: 10_000, maxNotes: 0 },
  })
}

async function mutate(ctx: Ctx, smith: Smith, trigger: string, sessionID: string, fn: (run: Run) => Promise<string>): Promise<string> {
  const run = commandRun(ctx, smith, trigger, sessionID)
  let message: string
  let ok = true
  try {
    message = await fn(run)
  } catch (err) {
    ok = false
    message = err instanceof GuardError || err instanceof StoreError ? `Abgelehnt: ${err.message}` : `Fehler: ${errorMessage(err)}`
  }
  const fin = await finalizeRun(ctx, run, { ok })
  return fin.commit ? `${message}\n(commit ${fin.commit})` : message
}

function pct(a: number, b: number): string {
  return b ? `${Math.round((100 * a) / b)} %` : "–"
}

const tier = (t: string) => TIER_LABEL[t] ?? t

function knowledgeDue(ctx: Ctx, e: Entry): boolean {
  const verified = e.meta?.verifiedAt ?? e.meta?.updatedAt ?? e.meta?.createdAt
  return e.tier === "active" && daysBetween(verified) >= ctx.options.docsmith.reviewAfterDays
}

async function report(ctx: Ctx, deps: CommandDeps): Promise<string> {
  const o = ctx.options
  const count = (kind: Kind) => {
    const l = ctx.store.list(kind)
    return { all: l, active: l.filter((e) => e.tier === "active"), dormant: l.filter((e) => e.tier === "dormant"), archive: l.filter((e) => e.tier === "archive") }
  }
  const skills = count("skill")
  const knowledge = count("knowledge")
  const glossary = count("glossary")
  const errors = count("error")
  const scripts = count("script")
  const foreign = ctx.store.listForeign()
  const usage = ctx.usage.all()
  const activeChars = skills.active.reduce((n, r) => n + promptCost(r), 0)
  const shown = Object.values(usage).reduce((n, u) => n + (u.hintsShown ?? 0), 0)
  const followed = Object.values(usage).reduce((n, u) => n + (u.hintsFollowed ?? 0), 0)
  const helped = Object.values(usage).reduce((n, u) => n + (u.helped ?? 0), 0)
  const failedHints = Object.values(usage).reduce((n, u) => n + (u.failed ?? 0), 0)
  const top = Object.entries(usage)
    .filter(([, u]) => u.loads > 0)
    .sort((a, b) => b[1].loads - a[1].loads)
    .slice(0, 6)
    .map(([n, u]) => `${n} (${u.loads})`)
  const errorProne = Object.entries(usage)
    .filter(([, u]) => u.reviewedLoads >= o.needsReviewMinLoads && u.loadsWithIssues / Math.max(1, u.reviewedLoads) > o.needsReviewRate)
    .map(([n, u]) => `${n} (${u.loadsWithIssues}/${u.reviewedLoads})`)
  const cands = ctx.store.candidates().filter((c) => !c.promotedTo)
  const candOf = (k: Kind) => cands.filter((c) => c.kind === k).length
  const staged = ctx.ops.staged()
  const shadowCount = (readText(ctx.ops.shadowFile) ?? "").split("\n").filter(Boolean).length
  const commits = await ctx.git.recent(6)
  const pending = deps.queue.pending().filter((j) => j.directory === ctx.directory)
  const lastErr = pending.find((j) => j.lastError)?.lastError
  const st = deps.curator.state()
  const resolved = resolveModel(ctx, "skillsmith", "reviewer")
  const modelSrc = o.reviewerModel ? "reviewerModel" : "zuletzt verwendetes Session-Modell"
  // what the session will really get (a name without provider is repaired against the offered models)
  const catalog = await modelCatalog(ctx.client)
  const fixed = resolved && catalog ? matchModel(specOf(resolved), catalog) : undefined
  const model = fixed ? refOf(fixed.spec) : resolved
  const env = o.toolsmith.enabled ? await pythonEnv(o, ctx.store.stateDir).catch(() => undefined) : undefined
  const tests = { passed: 0, failed: 0, untested: 0 }
  for (const s of scripts.all) tests[(s.meta?.test?.status ?? "untested") as keyof typeof tests]++
  const outdated = (readText(join(ctx.store.stateDir, "outdated-docs.jsonl")) ?? "")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as { at: string; project: string; doc: string }
      } catch {
        return undefined
      }
    })
    .filter((x): x is { at: string; project: string; doc: string } => !!x && x.project === ctx.project)
    .slice(-5)
  const modes = SMITHS.map((s) => `${s} ${o[s].enabled ? (o[s].writeMode ?? o.writeMode) : "aus"}`).join(" · ")
  const lines = [
    "**skillsmith Report**",
    "",
    `Store: ${ctx.store.root}`,
    `Smiths: ${modes}`,
    `Git: ${ctx.git.available ? "aktiv" : "aus"} · Hinweise: ${o.hints.enabled ? "an" : "aus"} · Subagent-Reviews: ${o.reviewSubagents ? "an" : "aus"}`,
    `Modell der Hintergrund-Agenten: ${model ? `${specOf(model)} (${modelSrc}${fixed?.repaired ? `, ergänzt aus „${specOf(resolved)}“` : ""})` : "Modell der jeweiligen Session"}`,
    `Semantische Suche: ${embedLine(ctx)}`,
    `Projekt-Doku: ${ctx.projectDocs?.enabled ? `${new Set(ctx.projectDocs.scan().map((c) => c.file)).size} .md-Datei(en), ${ctx.projectDocs.scan().length} Abschnitt(e)` : "aus"} · Session-Verlauf: ${ctx.history?.enabled ? `${ctx.history.all().length} Session(s)` : "aus"}`,
    `Review-Queue: ${pending.length} offen · ${deps.queue.runningCount()} laufen${lastErr ? ` · letzter Fehler: ${truncate(lastErr, 160)}` : ""}`,
    "",
    `Skills: ${skills.active.length} aktiv · ${skills.dormant.length} ruhend · ${skills.archive.length} archiviert · ${candOf("skill")} Kandidaten — fremde Skills: ${foreign.length}`,
    `  System-Prompt (eigene aktive): ${skills.active.length}/${o.activeBudget.maxSkills} Skills · ${activeChars}/${o.activeBudget.maxChars} Zeichen`,
    `Wissen: ${knowledge.active.length} aktiv · ${knowledge.archive.length} archiviert · ${knowledge.active.filter((e) => knowledgeDue(ctx, e)).length} zu prüfen (älter als ${o.docsmith.reviewAfterDays} Tage) · ${knowledge.active.filter((e) => e.meta?.doubts?.length).length} mit möglichem Widerspruch`,
    `Glossar: ${glossary.active.length} Begriffe · ${candOf("glossary")} offene Abkürzungen (/glossary-open)`,
    `Fehler: ${errors.active.filter((e) => e.fields.status !== "open").length} gelöst · ${errors.all.filter((e) => e.fields.status === "open").length} offen · ${errors.dormant.length} ruhend · ${errors.archive.length} archiviert · Live-Hinweise halfen ${helped}×, ${failedHints}× nicht`,
    `Skripte: ${scripts.active.length} aktiv · ${scripts.dormant.length} ruhend · ${scripts.archive.length} archiviert · Tests: ${tests.passed} ok, ${tests.failed} fehlgeschlagen, ${tests.untested} ungetestet · ${candOf("script")} Kandidaten`,
    ...memoryReportLines(ctx),
    env ? `  Python: ${env.ok ? `${env.version} (${env.executable})` : `nicht verfügbar – ${env.error}`} · Ziel ${o.toolsmith.pythonTarget} · Sandbox: ${env.sandbox ?? (env.partial ? `${env.partial} (nur Netzwerk)` : "keine")}` : "",
    "",
    `Hinweise: ${shown} gezeigt · ${followed} genutzt (${pct(followed, shown)})`,
    `Meistgenutzt: ${top.length ? top.join(", ") : "–"}`,
    `Fehleranfällig: ${errorProne.length ? errorProne.join(", ") : "–"}`,
    outdated.length ? `Projekt-Doku prüfen: ${outdated.map((x) => x.doc).join("; ")}` : "",
    `Freigabe ausstehend: ${staged.length} · Shadow-Vorschläge gesamt: ${shadowCount}`,
    `Curator: letzte Konsolidierung ${st.lastConsolidationAt ?? "noch nie"}${st.lastConsolidationResult ? ` (${truncate(st.lastConsolidationResult, 160)})` : ""} · Skript-Test ${st.lastRetestAt ?? "noch nie"}`,
    "",
    "Letzte Commits:",
    ...(commits.length ? commits.map((c) => `- ${c.hash} ${truncate(c.subject, 90)}`) : ["- (keine)"]),
  ]
  return lines.filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== "")).join("\n")
}

function embedLine(ctx: Ctx): string {
  if (!ctx.options.embedding.enabled || !ctx.semantic) return "aus (embedding.enabled = false)"
  const st = ctx.semantic.client.status
  const vectors = Object.values(ctx.semantic.status().counts).reduce((a, b) => a + b, 0)
  if (st.state === "unconfigured") return `aus – ${st.lastError ?? "kein Endpunkt gefunden (embedding.provider/baseURL)"}`
  if (st.state === "paused") return `pausiert bis ${st.pausedUntil?.slice(11, 16)} nach Fehlern (${st.lastError ?? "?"}) – solange nur BM25`
  return `${st.model ?? "Modell wird erkannt"}${st.dims ? ` · ${st.dims} Dim` : ""} · ${vectors} Vektoren${st.calls ? ` · Ø ${st.avgMs} ms` : ""}${st.lastError ? ` · letzter Fehler: ${truncate(st.lastError, 80)}` : ""}`
}

function storageLine(i: VectorStoreInfo): string {
  const mb = i.bytes >= 1_048_576 ? `${(i.bytes / 1_048_576).toFixed(1)} MB` : `${Math.round(i.bytes / 1024)} KB`
  return `Ablage: ${i.backend === "sqlite" ? "SQLite" : "Dateien (Fallback)"} – ${i.path} (${mb})${i.lastFlushRows ? ` · letzter Schreibvorgang: ${i.lastFlushRows} Vektor(en) in ${i.lastFlushMs} ms` : ""}`
}

async function embedCommand(ctx: Ctx, args: string): Promise<string> {
  const [sub = "status", arg] = args.split(/\s+/).filter(Boolean)
  const sem = ctx.semantic
  if (!sem) return "Semantische Suche ist ausgeschaltet (`embedding.enabled: false` oder SKILLSMITH_EMBEDDINGS=0)."
  if (sub === "sync") {
    if (!sem.client.configured) return `Kein Embedding-Endpunkt: ${embedLine(ctx)}`
    const n = await sem.sync()
    const docs = (await ctx.projectDocs?.syncVectors()) ?? 0
    const hist = (await ctx.history?.syncVectors()) ?? 0
    return `Synchronisiert: ${n} Eintrag/Kandidat(en), ${docs} Doku-Abschnitt(e), ${hist} Session(s) neu eingebettet.\n${embedLine(ctx)}`
  }
  if (sub === "eval") {
    const max = Math.min(500, Math.max(5, Number(arg) || 100))
    const { pairs, sessions } = await buildEvalSet(ctx, max)
    return formatEval(await runEval(ctx, pairs, sessions), ctx.options.embedding.hintMinSimilarity)
  }
  await sem.client.ensureModel().catch(() => undefined)
  const st = sem.client.status
  const counts = sem.status().counts
  const e = ctx.options.embedding
  return [
    "**Semantische Suche (Embeddings)**",
    "",
    `Status: ${embedLine(ctx)}`,
    `Endpunkt: ${st.baseURL ?? "–"}${st.provider ? ` (Provider ${st.provider})` : ""}`,
    `Modell: ${st.model ?? "–"} · Anweisung für Anfragen: ${sem.client.instruction()} · Kürzung auf ${e.dimensions || "volle"} Dimensionen`,
    `Vektoren: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" · ") || "–"}`,
    storageLine(sem.vectors.info()),
    `Aufrufe: ${st.calls} (${st.texts} Texte, Ø ${st.avgMs} ms)${st.lastError ? ` · letzter Fehler ${st.lastErrorAt?.slice(0, 16).replace("T", " ")}: ${st.lastError}` : ""}`,
    `Schwellen: Suche ${e.searchMinSimilarity} · Hinweise ${e.hintMinSimilarity} · Kandidaten ${e.candidateSimilarity} · Duplikate ${e.duplicateSimilarity} · Fehler ${e.errorSimilarity}`,
    `           Cluster ${e.clusterSimilarity} · verwandt/Widerspruch ${e.relatedSimilarity} · Tags ${e.tagSimilarity} · frühere Sessions ${e.sessionHintSimilarity}`,
    "",
    "/smith-embed sync baut fehlende Vektoren auf · /smith-embed eval prüft die Suche mit deinen bisherigen Sessions.",
  ].join("\n")
}

async function docsSearchCommand(ctx: Ctx, query: string): Promise<string> {
  const docs = ctx.projectDocs
  if (!docs?.enabled) return "Der Projekt-Doku-Index ist ausgeschaltet (`docsmith.projectIndex: false`)."
  if (!query) {
    const chunks = docs.scan(true)
    const files = new Set(chunks.map((c) => c.file))
    return `Projekt-Doku: ${files.size} .md-Datei(en), ${chunks.length} Abschnitt(e) indiziert (${ctx.worktree}).\nSuche: /docs-search <suchbegriffe>`
  }
  const hits = await docs.search(query, { limit: 8, purpose: "search" })
  if (!hits.length) return `Keine Doku-Stelle zu "${query}" gefunden.`
  return [
    `**Projekt-Doku – Suche: ${query}**`,
    "",
    ...hits.map(
      (h) =>
        `- ${h.file}:${h.line}${h.heading ? ` – ${h.heading}` : ""}${h.similarity !== undefined ? ` (Ähnlichkeit ${h.similarity.toFixed(2)})` : ""}\n  ${truncate(oneLine(h.text.replace(/^#+\s+[^\n]*\n?/, "")), 220)}`,
    ),
  ].join("\n")
}

async function historyCommand(ctx: Ctx, query: string): Promise<string> {
  const h = ctx.history
  if (!h?.enabled) return "Der Session-Verlauf ist ausgeschaltet (`history.enabled: false`)."
  if (!query) {
    const mine = h.all().filter((r) => r.project === ctx.project)
    if (!mine.length) return "Noch keine bewerteten Sessions in diesem Projekt. (Einträge entstehen nach jedem Review.)"
    return [`**Frühere Sessions – ${ctx.project} (${mine.length})**`, "", ...mine.slice(0, 15).map((r) => `- ${formatRecord(r, { currentProject: ctx.project })}`)].join("\n")
  }
  const hits = await h.search(query, { limit: 8, purpose: "search" })
  if (!hits.length) return `Keine frühere Session zu "${query}".`
  return [
    `**Frühere Sessions – Suche: ${query}**`,
    "",
    ...hits.map((x) => `- ${formatRecord(x.record, { currentProject: ctx.project })}${x.similarity !== undefined ? `\n   (Ähnlichkeit ${x.similarity.toFixed(2)})` : ""}`),
  ].join("\n")
}

async function searchKind(ctx: Ctx, kind: Kind, query: string, extra?: (e: Entry | undefined) => string): Promise<string> {
  const tiers: Array<Tier | "foreign"> = [...spec(kind).tiers, ...(kind === "skill" ? (["foreign"] as const) : [])]
  const hits = await ctx.retriever.search(query, { kinds: [kind], tiers, limit: 10, purpose: "search" })
  if (!hits.length) return `Keine Treffer zu "${query}" (${spec(kind).labelPlural}).`
  return [
    `**${spec(kind).labelPlural} – Suche: ${query}**`,
    "",
    ...hits.map((h) => {
      const e = h.owned ? ctx.store.getOwned(kind, h.name) : undefined
      const title = h.title && h.title !== h.name ? ` – ${truncate(h.title, 80)}` : ""
      return `- ${h.name} [${tier(h.tier)}] (${Retriever.display(h).toFixed(2)}${h.similarity !== undefined && h.confidence === 0 ? " sem" : ""})${title}: ${truncate(h.description, 140)}${extra ? extra(e) : ""}`
    }),
  ].join("\n")
}

function listKind(ctx: Ctx, kind: Kind, filter?: string, extra?: (e: Entry) => string): string {
  const all = ctx.store.list(kind)
  const tiers = filter && filter !== "all" ? [filter] : [...spec(kind).tiers, ...(kind === "skill" ? ["foreign"] : [])]
  const lines: string[] = []
  for (const t of tiers) {
    const items = t === "foreign" ? ctx.store.listForeign() : all.filter((s) => s.tier === t)
    if (!items.length && tiers.length > 1) continue
    lines.push(`**${spec(kind).labelPlural} – ${tier(t)} (${items.length})**`)
    for (const s of items.slice(0, 80)) {
      const u = ctx.usage.get(kind, s.name)
      const title = s.title && s.title !== s.name ? ` – ${truncate(s.title, 70)}` : ""
      lines.push(
        `- ${s.name}${s.meta?.pinned ? " 📌" : ""}${u.loads ? ` · ${u.loads}×` : ""}${s.source ? ` · ${s.source}` : ""}${title}: ${truncate(s.description, 110)}${s.tags.length ? ` {${s.tags.slice(0, 4).join(", ")}}` : ""}${
          extra ? extra(s) : ""
        }`,
      )
    }
    if (items.length > 80) lines.push(`- … ${items.length - 80} weitere`)
    lines.push("")
  }
  return lines.join("\n").trim() || `Keine ${spec(kind).labelPlural}-Einträge.`
}

/** "[art] <name>" → kind + name (art optional when the name is unique). */
function resolveTarget(ctx: Ctx, args: string): { kind: Kind; name: string } | string {
  const parts = args.split(/\s+/).filter(Boolean)
  if (!parts.length) return "Bitte Art und Namen angeben, z. B. skills foo, fehler bar."
  if (parts.length >= 2) {
    const kind = kindFromAlias(parts[0])
    if (kind) {
      const name = kind === "glossary" ? ctx.store.glossaryByTerm(parts[1])[0]?.name ?? parts[1] : parts[1]
      return { kind, name }
    }
  }
  const name = parts[parts.length - 1]
  const found = KINDS.filter((k) => ctx.store.getOwned(k, name))
  if (found.length === 1) return { kind: found[0], name }
  const g = ctx.store.glossaryByTerm(name)
  if (!found.length && g.length) return { kind: "glossary", name: g[0].name }
  if (found.length > 1) return `"${name}" gibt es mehrfach (${found.map((k) => spec(k).label).join(", ")}) – bitte die Art angeben, z. B. /smith-pin ${spec(found[0]).aliases[0]} ${name}`
  return `Kein Eintrag "${name}" gefunden.`
}

// ---------------------------------------------------------------------------
// glossary import / export
// ---------------------------------------------------------------------------

function exportGlossary(ctx: Ctx, target: string): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n+/g, " ")
  const entries = ctx.store.list("glossary").filter((e) => e.tier === "active")
  const lines = ["# Glossar", "", `Exportiert aus skillsmith (${entries.length} Begriffe).`, "", "| Abkürzung | Bedeutung | Beschreibung | Kontext |", "|---|---|---|---|"]
  for (const e of [...entries].sort((a, b) => String(a.fields.term).localeCompare(String(b.fields.term)))) {
    for (const m of meaningsOf(e.fields.meanings)) lines.push(`| ${esc(String(e.fields.term))} | ${esc(m.expansion)} | ${esc(m.description)} | ${esc(m.context ?? "")} |`)
  }
  ensureDir(resolve(target, ".."))
  writeFileAtomic(target, lines.join("\n") + "\n")
  return `${entries.length} Begriffe exportiert nach ${target}`
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

export async function handleCommand(ctx: Ctx, deps: CommandDeps, name: string, rawArgs: string, sessionID: string): Promise<string> {
  const args = (rawArgs ?? "").trim()
  const first = args.split(/\s+/)[0] ?? ""
  const memoryResult = await memoryCommand(ctx, deps.queue, mutate, name, args, sessionID)
  if (memoryResult !== undefined) return memoryResult
  switch (name) {
    case "prompt":
      return (await promptCommand(ctx, args)).text
    case "smith-help":
      return [
        "**skillsmith Befehle** (skillsmith · docsmith · errorsmith · toolsmith · memorysmith · doctor)",
        "",
        ...COMMANDS.map((c) => `- \`${c.usage}\` – ${c.description.replace(/^\w+: /, "")}`),
        "",
        "Arten: skills, wissen, glossar, fehler, skripte, erinnerungen",
      ].join("\n")
    case "smith-report":
      return report(ctx, deps)
    case "smith-review":
      deps.queue.enqueue(sessionID, "manual", true)
      return "Review dieser Session ist eingeplant und läuft im Hintergrund (alle zuständigen Smiths parallel). Ergebnis: Toast bzw. /smith-report."
    case "smith-curate": {
      if (first === "dry") return await deps.curator.dryRunReport()
      void (async () => {
        try {
          await deps.curator.lifecycle("manual", true)
          const msg = await deps.curator.consolidate("manual")
          ctx.toast(truncate(msg, 300), "info")
        } catch (err) {
          ctx.log.error("manual curator failed", errorMessage(err))
        }
      })()
      return "Curator gestartet (Lebenszyklus, Glossar-Duplikate, Konsolidierung im Hintergrund). Ergebnis: Toast bzw. /smith-report."
    }
    case "smith-pending": {
      const staged = ctx.ops.staged()
      if (!staged.length) return "Keine Änderungen zur Freigabe vorgemerkt."
      return [
        `**${staged.length} vorgemerkte Änderung(en)**`,
        "",
        ...staged.map(
          (s) =>
            `- \`${s.id}\` ${s.smith ?? "skillsmith"}: ${s.action} ${s.target === "skill" ? "" : `${spec(s.target).label} `}${s.name} (${s.actor}, ${s.createdAt.slice(0, 16).replace("T", " ")})${
              s.reason ? ` – ${truncate(s.reason, 160)}` : ""
            }`,
        ),
        "",
        "Übernehmen: /smith-approve <id|all> · Verwerfen: /smith-reject <id|all>",
      ].join("\n")
    }
    case "smith-approve": {
      if (!first) return "Bitte eine Id oder all angeben: /smith-approve <id|all>"
      const staged = ctx.ops.staged().filter((s) => first === "all" || s.id === first)
      if (!staged.length) return `Keine vorgemerkte Änderung "${first}" gefunden.`
      const bySmith = new Map<Smith, typeof staged>()
      for (const s of staged) {
        const smith = (s.smith as Smith) ?? spec(s.target).smith
        bySmith.set(smith, [...(bySmith.get(smith) ?? []), s])
      }
      const out: string[] = []
      for (const [smith, changes] of bySmith) {
        out.push(
          await mutate(ctx, smith, `approve ${first}`, sessionID, async (run) => {
            const results: string[] = []
            for (const change of changes) {
              try {
                results.push(`${change.id}: ${await ctx.ops.applyStaged(run, change)}`)
              } catch (err) {
                results.push(`${change.id}: Abgelehnt – ${errorMessage(err)}`)
              }
            }
            return results.join("\n")
          }),
        )
      }
      return out.join("\n")
    }
    case "smith-reject": {
      if (!first) return "Bitte eine Id oder all angeben: /smith-reject <id|all>"
      const staged = ctx.ops.staged().filter((s) => first === "all" || s.id === first)
      if (!staged.length) return `Keine vorgemerkte Änderung "${first}" gefunden.`
      for (const s of staged) ctx.ops.rejectStaged(s.id)
      return `${staged.length} vorgemerkte Änderung(en) verworfen.`
    }
    case "smith-undo": {
      try {
        const r = await undoRun(ctx, first || undefined, "command", sessionID)
        return `${r.message}${r.commit ? ` (commit ${r.commit})` : ""}`
      } catch (err) {
        return errorMessage(err)
      }
    }
    case "task":
      return taskCommand(ctx, args, sessionID)
    case "note": {
      if (!args) return "Bitte Text angeben: /note <text>"
      return commandAction(ctx, sessionID, { action: "note.quick", args: { text: args, session: sessionID } })
    }
    case "doc":
      return docCommand(ctx, args, sessionID)
    case "smith-list": {
      const kind = kindFromAlias(first || "skills")
      if (!kind) return `Unbekannte Art "${first}". Arten: skills, wissen, glossar, fehler, skripte`
      const filter = args.split(/\s+/)[1]
      if (kind === "glossary") return glossaryList(ctx)
      return listKind(ctx, kind, filter)
    }
    case "smith-embed":
      return embedCommand(ctx, args)
    case "docs-search":
      return docsSearchCommand(ctx, args)
    case "history":
      return historyCommand(ctx, args)
    case "smith-tags": {
      const kind = first ? kindFromAlias(first) : undefined
      if (first && !kind) return `Unbekannte Art "${first}".`
      const tags = ctx.index.tags(kind)
      if (!tags.length) return "Noch keine Tags vergeben."
      return [`**Tags${kind ? ` (${spec(kind).labelPlural})` : ""}**`, "", tags.slice(0, 150).map((t) => `${t.tag} (${t.count})`).join(" · ")].join("\n")
    }
    case "smith-pin":
    case "smith-unpin":
    case "smith-restore":
    case "smith-archive": {
      const t = resolveTarget(ctx, args)
      if (typeof t === "string") return t
      const smith = spec(t.kind).smith
      if (name === "smith-pin" || name === "smith-unpin") return mutate(ctx, smith, name, sessionID, (run) => ctx.ops.pin(run, t.kind, t.name, name === "smith-pin"))
      if (name === "smith-restore") return mutate(ctx, smith, name, sessionID, (run) => ctx.ops.move(run, t.kind, { name: t.name, to: "active", kind: "restore", reason: "manual restore", approved: true }))
      return mutate(ctx, smith, name, sessionID, (run) => ctx.ops.move(run, t.kind, { name: t.name, to: "archive", kind: "archive", reason: "manual archive", approved: true }))
    }
    case "skills-search":
      if (!args) return "Bitte Suchbegriffe angeben: /skills-search <begriffe>"
      return searchKind(ctx, "skill", args)
    case "skills-adopt":
      if (!first) return "Bitte einen Skill-Namen angeben: /skills-adopt <name>"
      return mutate(ctx, "skillsmith", name, sessionID, (run) => ctx.ops.adopt(run, first))
    case "knowledge":
      if (!args) return listKind(ctx, "knowledge", undefined, (e) => `${e.meta?.doubts?.length ? " ⚠ Widerspruch?" : ""}${knowledgeDue(ctx, e) ? " ⚠ zu prüfen" : ""}`)
      return searchKind(ctx, "knowledge", args)
    case "glossary": {
      if (!args) return glossaryList(ctx)
      const exact = ctx.store.glossaryByTerm(args)
      const hits = await ctx.retriever.search(args, { kinds: ["glossary"], tiers: ["active", "archive"], limit: 8, purpose: "search" })
      const entries = [...exact]
      for (const h of hits) {
        const e = ctx.store.getOwned("glossary", h.name)
        if (e && !entries.some((x) => x.name === e.name)) entries.push(e)
      }
      if (!entries.length) {
        const open = ctx.store.candidates("glossary").find((c) => !c.promotedTo && c.keywords.some((k) => fold(k) === fold(args)))
        return `Kein Glossar-Eintrag zu "${args}".${open ? ` Offen: in ${open.sessions.length} Session(s) gesehen – eintragen mit /glossary-add ${args} | Bedeutung | Beschreibung` : ""}`
      }
      return entries.slice(0, 8).map((e) => formatGlossary(e)).join("\n\n")
    }
    case "glossary-add": {
      const parts = args.split("|").map((p) => p.trim())
      if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) return "Format: /glossary-add ABK | Bedeutung | Beschreibung [| Kontext]"
      const [term, expansion, description, context] = parts
      return mutate(ctx, "docsmith", `glossary-add ${term}`, sessionID, (run) =>
        ctx.ops.glossaryUpsert(run, { term, meanings: [{ expansion, description, ...(context ? { context } : {}) }], reason: "manually added" }),
      )
    }
    case "glossary-open": {
      const open = ctx.store
        .candidates("glossary")
        .filter((c) => !c.promotedTo)
        .sort((a, b) => b.sessions.length - a.sessions.length || b.count - a.count)
      if (!open.length) return "Keine offenen Abkürzungen."
      return [
        `**${open.length} offene Abkürzung(en)** (Bedeutung unbekannt)`,
        "",
        ...open.slice(0, 60).map((c) => `- ${c.keywords[0] ?? c.id} – ${c.sessions.length} Session(s), ${c.count}× · ${truncate(c.summary.replace(/^[^:]+:\s*/, ""), 140)}`),
        "",
        "Eintragen: /glossary-add ABK | Bedeutung | Beschreibung · Ignorieren: /glossary-ignore ABK",
      ].join("\n")
    }
    case "glossary-ignore": {
      const terms = args.split(/[\s,]+/).filter(Boolean)
      if (!terms.length) return "Bitte Abkürzungen angeben: /glossary-ignore ABK [ABK …]"
      return mutate(ctx, "docsmith", `glossary-ignore ${terms.join(" ")}`, sessionID, async (run) => {
        const msg = await ctx.ops.ignoreTerms(run, terms)
        for (const t of terms) {
          const id = `abbr-${glossarySlug(t)}`
          const c = ctx.store.candidate("glossary", id)
          if (c && !c.promotedTo) await ctx.store.markCandidatePromoted(run, "glossary", id, "(ignoriert)")
        }
        return msg
      })
    }
    case "glossary-import": {
      if (!args) return "Bitte eine Datei angeben: /glossary-import <datei.csv|datei.md>"
      const file = isAbsolute(args) ? args : resolve(ctx.directory, args.replace(/^~\//, `${process.env.HOME ?? ""}/`))
      const text = readText(file)
      if (text === undefined) return `Datei nicht lesbar: ${file}`
      const rows = /\.(md|markdown)$/i.test(file) ? parseMarkdownTable(text) : parseCsv(text)
      const items = glossaryRows(rows).slice(0, 2000)
      if (!items.length) return "Keine Einträge erkannt. Erwartet: Spalten Abkürzung, Bedeutung, Beschreibung[, Kontext] (CSV mit ; , oder Tab, oder Markdown-Tabelle)."
      return mutate(ctx, "docsmith", `glossary-import ${args}`, sessionID, async (run) => {
        let ok = 0
        const failed: string[] = []
        for (const it of items) {
          try {
            await ctx.ops.glossaryUpsert(run, { term: it.term, meanings: [it.meaning], reason: `import ${args}` })
            ok++
          } catch (err) {
            failed.push(`${it.term}: ${errorMessage(err)}`)
          }
        }
        return `${ok} Bedeutung(en) importiert${failed.length ? `, ${failed.length} abgelehnt:\n${failed.slice(0, 15).map((f) => `- ${f}`).join("\n")}` : ""}`
      })
    }
    case "glossary-export": {
      const target = args ? (isAbsolute(args) ? args : resolve(ctx.directory, args)) : join(ctx.store.stateDir, "exports", "glossary.md")
      if (!/\.md$/i.test(target)) return "Export nur als .md-Datei."
      return exportGlossary(ctx, target)
    }
    case "errors": {
      const status = (e: Entry | undefined) => (e ? ` <${fmStr(e.fields.status) === "open" ? "offen" : "gelöst"}>` : "")
      if (!args) return listKind(ctx, "error", undefined, (e) => status(e))
      return searchKind(ctx, "error", args, status)
    }
    case "errors-top": {
      const occ = Object.values(ctx.occurrences.all())
        .filter((o) => daysBetween(o.lastSeen) <= 30)
        .sort((a, b) => b.sessions.length - a.sessions.length || b.count - a.count)
        .slice(0, 15)
      if (!occ.length) return "Keine Fehler in den letzten 30 Tagen aufgezeichnet."
      return [
        "**Häufigste Fehler (30 Tage)**",
        "",
        ...occ.map((o) => `- ${o.count}× in ${o.sessions.length} Session(s) – ${truncate(o.signature, 140)}${o.entry ? ` → ${o.entry}` : " · undokumentiert"}`),
      ].join("\n")
    }
    case "scripts": {
      const extra = (e: Entry | undefined) => (e ? `\n  ${truncate(fmStr(e.fields.usage), 140)} · Tests: ${e.meta?.test?.status ?? "?"}` : "")
      if (!args) return listKind(ctx, "script", undefined, (e) => extra(e))
      return searchKind(ctx, "script", args, extra)
    }
    case "scripts-test": {
      if (first) {
        if (!ctx.store.getOwned("script", first)) return `Skript "${first}" nicht gefunden.`
        return deps.curator.retestScripts("manual", [first])
      }
      void deps.curator
        .retestScripts("manual")
        .then((r) => ctx.toast(truncate(`toolsmith Test: ${r.replace(/\n/g, "; ")}`, 300), "info"))
        .catch((err) => ctx.log.error("retest failed", errorMessage(err)))
      return "Alle Skripte werden im Hintergrund neu getestet. Ergebnis: Toast bzw. /scripts."
    }
    default:
      return `Unbekannter Befehl ${name}. /smith-help zeigt alle Befehle.`
  }
}

async function taskCommand(ctx: Ctx, args: string, sessionID: string): Promise<string> {
  const parts = args.split(/\s+/).filter(Boolean)
  const sub = (parts[0] ?? "").toLowerCase()
  if (sub === "neu" || sub === "new") {
    const title = args.replace(/^\S+\s*/, "").trim()
    if (!title) return "Bitte einen Titel angeben: /task neu <titel>"
    const project = ctx.projects.forDirectory(ctx.directory)?.name
    let branch: string | undefined
    let ticket: string | undefined
    try {
      const s = ctx.scope()
      branch = s.branch
      ticket = s.ticket
    } catch {
      branch = undefined
    }
    return commandAction(ctx, sessionID, { action: "task.create", args: { title, ...(project ? { project } : {}), ...(branch ? { branch } : {}), ...(ticket ? { ticket } : {}) } })
  }
  const prefix = ctx.options.tasks.idPrefix
  if (new RegExp(`^${prefix}-\\d+$`, "i").test(parts[0] ?? "")) {
    const e = ctx.tasks.get(parts[0])
    if (!e) return `Aufgabe ${parts[0]} nicht gefunden.`
    if (parts[1]) return commandAction(ctx, sessionID, { action: "task.move", args: { target: `task:${e.name}`, to: parts[1] } })
    const v = ctx.tasks.view(e)
    return [`**${v.id} ${v.title}** [${v.status}] · ${v.priority}${v.project ? ` · ${v.project}` : ""}${v.due ? ` · fällig ${v.due}` : ""}`, v.description, "", e.body.trim(), v.children.length ? `\nUnteraufgaben: ${v.children.join(", ")} (${v.progress.done}/${v.progress.total})` : ""].filter(Boolean).join("\n")
  }
  const project = ctx.projects.forDirectory(ctx.directory)?.name
  const list = ctx.tasks.list({ project: project ?? "*" }).filter((t) => !ctx.tasks.isDone(t.status, t.project))
  if (!list.length) return `Keine offenen Aufgaben${project ? ` im Projekt ${project}` : ""}. Anlegen: /task neu <titel>`
  const cols = ctx.tasks.columns(project)
  const lines = [`**Aufgaben${project ? ` – ${project}` : ""}**`]
  for (const c of cols.slice(0, -1)) {
    const inCol = list.filter((t) => t.status === c)
    if (!inCol.length) continue
    lines.push("", `${c} (${inCol.length})`, ...inCol.map((t) => `- ${t.id} ${t.title}${t.priority !== "normal" ? ` · ${t.priority}` : ""}${t.agentStatus ? ` · Agent: ${t.agentStatus.label}` : ""}${t.pipeline ? ` · Pipeline ${t.pipeline.status}` : ""}`))
  }
  lines.push("", "Verschieben: /task T-12 <spalte> · Board: /smith-web")
  return lines.join("\n")
}

async function docCommand(ctx: Ctx, args: string, sessionID: string): Promise<string> {
  const [topic, template] = args.split("|").map((x) => x.trim())
  if (!topic) return "Bitte ein Thema angeben: /doc <thema> [| howto|runbook|troubleshooting]"
  try {
    const { executeAction } = await import("../core/actions")
    const d = await executeAction({ ctx, actor: "command", session: sessionID }, { action: "doc.draft", args: { session: sessionID, topic, ...(template ? { template } : {}) } })
    const data = d.data as { title: string; body: string; template?: string }
    const r = await executeAction({ ctx, actor: "command", session: sessionID }, { action: "doc.create", args: { title: data.title, body: data.body, ...(data.template ? { template: data.template } : {}) } })
    return `Entwurf „${data.title}“ als Ihr Dokument gespeichert${r.commit ? ` (commit ${r.commit})` : ""} – im Editor prüfen: /smith-web → ${r.open ?? ""}`
  } catch (err) {
    return `Entwurf fehlgeschlagen: ${errorMessage(err)}`
  }
}

function glossaryList(ctx: Ctx): string {
  const entries = ctx.store.list("glossary").filter((e) => e.tier === "active")
  if (!entries.length) return "Das Glossar ist leer. Eintragen: /glossary-add ABK | Bedeutung | Beschreibung"
  return [
    `**Glossar (${entries.length})**`,
    "",
    ...[...entries]
      .sort((a, b) => String(a.fields.term).localeCompare(String(b.fields.term)))
      .slice(0, 200)
      .map((e) => `- ${String(e.fields.term)} = ${meaningsOf(e.fields.meanings).map((m) => `${m.expansion}${m.context ? ` (${m.context})` : ""}`).join(" / ")}${strArray(e.fields.aliases).length ? ` · auch ${strArray(e.fields.aliases).join(", ")}` : ""}`),
  ].join("\n")
}

