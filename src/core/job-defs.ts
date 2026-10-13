/**
 * The built-in jobs. Each job only wires an existing service into the scheduler; the work
 * itself stays in its module (curator, doctor, agent tasks, …).
 */
import { join } from "node:path"
import type { Smith } from "../types"
import { SMITHS } from "./prompts"
import type { Ctx } from "./context"
import type { JobDef } from "./jobs"
import { pruneLogs } from "./logs"
import { reviewAgents } from "./agent-defs"

const smithsParam = (v: string | undefined): Smith[] | undefined => {
  const list = (v ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter((x): x is Smith => (SMITHS as string[]).includes(x))
  return list.length ? list : undefined
}

export const BUILTIN_JOBS: JobDef[] = [
  {
    id: "lifecycle",
    label: "Lebenszyklus",
    description: "Curator ohne Modell: ungenutzte Einträge ruhen lassen bzw. archivieren, Glossar-Duplikate zusammenführen, Tags vereinheitlichen, abgelaufene Arbeitsstände aufräumen.",
    area: "curator",
    defaults: () => ({ start: true, afterReview: true }),
    unavailable: (ctx) => (ctx.curator ? undefined : "Curator nicht verfügbar"),
    async run(ctx, jr) {
      const r = await ctx.curator!.lifecycle(jr.trigger, jr.trigger === "von Hand")
      return { summary: r.moves ? `${r.moves} Änderung(en)` : "nichts zu tun", commits: r.commits }
    },
  },
  {
    id: "consolidate",
    label: "Konsolidierung",
    description: "Curator-Agenten fassen ähnliche Einträge zusammen, prüfen fehleranfällige und widersprüchliche (mit Modell).",
    area: "curator",
    defaults: (o) => ({ enabled: o.consolidate, intervalMin: Math.round(o.curatorIntervalDays * 1440), catchUp: "once" }),
    params: [{ name: "smiths", label: "nur für", values: [...SMITHS].filter((s) => s !== "doctor"), multiple: true }],
    unavailable: (ctx) => (!ctx.curator ? "Curator nicht verfügbar" : undefined),
    previousRun: (ctx) => ctx.curator?.state().lastConsolidationAt,
    async run(ctx, jr) {
      const summary = await ctx.curator!.consolidate(jr.trigger, smithsParam(jr.params.smiths))
      return { summary, commits: [...summary.matchAll(/commit ([0-9a-f]{7,40})/g)].map((m) => m[1]) }
    },
  },
  {
    id: "retest",
    label: "Skript-Retests",
    description: "Alle veröffentlichten Python-Skripte erneut testen; ein Statuswechsel wird committet.",
    area: "toolsmith",
    defaults: () => ({ intervalMin: 7 * 1440, catchUp: "once" }),
    unavailable: (ctx) => (!ctx.options.toolsmith.enabled ? "toolsmith ist aus" : !ctx.curator ? "Curator nicht verfügbar" : undefined),
    previousRun: (ctx) => ctx.curator?.state().lastRetestAt,
    async run(ctx, jr) {
      const summary = await ctx.curator!.retestScripts(jr.trigger)
      return { summary }
    },
  },
  {
    id: "doctor",
    label: "Doktor",
    description: "Bezüge und Widersprüche zwischen geänderten Einträgen beurteilen (mit Modell); beim ersten Start auch den Bestand.",
    area: "doctor",
    defaults: () => ({ start: true, afterReview: true }),
    unavailable: (ctx) => (!ctx.doctor?.enabled ? "Doktor ist aus oder die lokale Datenbank fehlt" : undefined),
    async run(ctx, jr) {
      if (jr.trigger === "Start") ctx.doctor!.backfill()
      const st = ctx.doctor!.status()
      if (!st.queued && !st.open && jr.trigger !== "von Hand") return { summary: "nichts zu prüfen", status: "skipped" }
      const r = await ctx.doctor!.run(jr.trigger)
      return { summary: r.summary, status: r.ok ? "ok" : "warn" }
    },
  },
  {
    id: "embeddings",
    label: "Embeddings abgleichen",
    description: "Vektoren der Einträge, der Projekt-Doku und des Session-Verlaufs nachziehen.",
    area: "embeddings",
    defaults: () => ({ start: true }),
    unavailable: (ctx) => (!ctx.semantic ? "semantische Suche ist aus" : undefined),
    async run(ctx) {
      const n = await ctx.semantic!.sync()
      const st = ctx.semantic!.client.status
      if (!st.model) return { summary: `kein Embedding-Modell (${st.lastError ?? st.state})`, status: "skipped" }
      const docs = (await ctx.projectDocs?.syncVectors()) ?? 0
      const hist = (await ctx.history?.syncVectors()) ?? 0
      return { summary: `${n} Eintrag/Kandidat(en), ${docs} Doku-Abschnitt(e), ${hist} Session(s) eingebettet (${st.model})` }
    },
  },
  {
    id: "prepare",
    label: "Vorschläge vorab",
    description: "Für geplante Aufgaben, die einem Agenten zugewiesen sind, den Plan schon vorbereiten.",
    area: "agent",
    defaults: (o) => ({ enabled: o.tasks.prepare && o.tasks.agents, start: true, daily: o.tasks.prepareAt }),
    unavailable: (ctx) => (!ctx.options.tasks.agents ? "Agenten-Aufträge sind aus" : undefined),
    async run(ctx, jr) {
      const n = await ctx.agentTasks.prepareProposals(jr.trigger)
      return { summary: n ? `${n} Vorschlag/Vorschläge gestartet` : "keine geplanten Aufgaben", status: n ? "ok" : "skipped" }
    },
  },
  {
    id: "agent-review",
    label: "Agenten verbessern",
    description: "Wertet Rücksprünge, Review-Befunde, Überarbeitungen und Korrekturen aus und schlägt Prompt-Änderungen der Agenten als Diff mit Begründung vor (Sie geben frei).",
    area: "agent",
    defaults: () => ({ intervalMin: 7 * 1440, catchUp: "once", params: { days: "30", minEvidence: "3" } }),
    params: [
      { name: "days", label: "Zeitraum in Tagen" },
      { name: "minEvidence", label: "Mindestzahl Belege je Agent" },
    ],
    unavailable: (ctx) => (!ctx.options.tasks.agents ? "Agenten-Aufträge sind aus" : !ctx.store.list("agent").length ? "keine Agenten im Store (Bibliothek → Agenten → aus opencode übernehmen)" : undefined),
    run: (ctx, jr) => reviewAgents(ctx, jr),
  },
  {
    id: "anchors",
    label: "Code-Anker prüfen",
    description: "Verankert neue [[code:…]]-Anker und prüft nach neuen Commits in den Projekten, ob der verankerte Code unverändert, geändert, verschoben oder gelöscht ist (Eingang „Code geändert“).",
    area: "anchors",
    defaults: () => ({ start: true, intervalMin: 15 }),
    unavailable: (ctx) => (!ctx.options.anchors.enabled ? "Code-Anker sind aus" : !ctx.anchors ? "nicht verfügbar" : undefined),
    run: (ctx, jr) => ctx.anchors!.runJob(jr.trigger, jr.trigger === "von Hand"),
  },
  {
    id: "gym",
    label: "Gym",
    description: "A/B-Läufe: dieselbe Aufgabe ohne und mit Eintrag, mehrere Läufe je Arm; Urteil hilft, neutral, schadet oder ungenutzt (mit Modell).",
    area: "gym",
    defaults: () => ({ idleMin: 30, catchUp: "skip" }),
    unavailable: (ctx) => (!ctx.options.gym.enabled ? "Gym ist aus" : !ctx.gym?.tasks().some((t) => t.status === "aktiv") ? "keine aktiven Gym-Aufgaben" : undefined),
    run: (ctx, jr) => ctx.gym!.runJob(jr.trigger),
  },
  {
    id: "prune",
    label: "Aufräumen",
    description: "Alte Logs, Audit-Ereignisse und Metriken nach den Aufbewahrungsfristen löschen; alte Session-Zustände entfernen.",
    area: "jobs",
    defaults: () => ({ start: true, intervalMin: 1440 }),
    async run(ctx) {
      ctx.sessions.prune(30)
      const audit = ctx.audit?.prune() ?? 0
      const metrics = ctx.metrics?.prune() ?? 0
      const logs = pruneLogs(join(ctx.store.stateDir, "log"), ctx.options.log.days, ctx.options.log.maxMB).removed
      return { summary: `Audit ${audit}, Metriken ${metrics}, Log-Dateien ${logs} entfernt` }
    },
  },
]

/** All jobs of an instance (built-in + later steps register theirs here). */
export function jobDefs(_ctx: Ctx): JobDef[] {
  return BUILTIN_JOBS
}
