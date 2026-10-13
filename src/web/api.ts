/**
 * Read endpoints of the web view (GET /api/<path>). Everything here only reads; writes
 * go through POST /api/action (src/core/actions). Private documents are visible here –
 * the web view is the user's own interface.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { catalog, isReadOnly } from "../core/actions"
import { folderDefaults } from "../core/actions/util"
import type { Ctx } from "../core/context"
import { str, strArray } from "../core/frontmatter"
import { isStoreId, nodeLabel, RELATION_LABEL, type GraphEdge, type GraphNode } from "../core/graph"
import { graphAt, semanticMap, shortestPath } from "../core/graph-extra"
import { aiAccessOf, isOwnDoc, meaningsOf, MEMORY_TYPE_LABEL, scriptFiles, spec, TIER_LABEL } from "../core/kinds"
import { M } from "../core/metrics"
import { inbox, markVisited } from "../core/inbox"
import { provenanceView, PROVENANCE_KINDS } from "../core/provenance"
import { projectPage, sessionPage, simulateHints, ticketPage } from "../core/productivity"
import { radiusOf, storeExtras } from "../core/relevance"
import { templates } from "../core/templates"
import type { Entry, Kind } from "../types"
import { AI_ACCESS, KINDS, key } from "../types"
import { sha, tokenize, truncate } from "../util/text"
import { journalLine, journalTarget, shadowLine, type JournalAction } from "../core/legacy"
import { ENDPOINTS } from "./endpoints"
import { readTaskFields } from "../core/task-fields"
import { entryUsage, statsAgents, statsErrors, statsEvents, statsHints, statsKnowledge, statsOverview, statsPipeline, statsSmiths, statsTasks, statsTools } from "./stats"

export class NotFound extends Error {}

type Json = object

const MAX_GRAPH_NODES = 600
const STATUS_LABEL: Record<string, string> = { gueltig: "gültig", vorgeschlagen: "vorgeschlagen (unbestätigt)", abgeloest: "abgelöst", abgelaufen: "abgelaufen" }

const int = (v: string | null, def: number, min: number, max: number) => Math.min(max, Math.max(min, Number(v) || def))

export class ReadApi {
  constructor(private ctx: Ctx) {}

  async get(path: string, q: URLSearchParams): Promise<Json> {
    const ctx = this.ctx
    const days = int(q.get("days"), 30, 1, 3650)
    switch (path) {
      case "ping":
        return { ok: true }
      case "info":
        return this.info()
      case "catalog":
        return catalog(ctx)
      case "stats":
        return this.stats()
      case "list":
        return this.list(q)
      case "search":
        return this.search(q.get("q") ?? "", (q.get("kinds") ?? "").split(",").filter(Boolean))
      case "entry":
        return this.entry(q.get("id") ?? "")
      case "graph":
        return this.graph(q)
      case "graph/path":
        return this.path(q.get("a") ?? "", q.get("b") ?? "")
      case "graph/at":
        return graphAt(ctx, q.get("date") ?? "")
      case "map":
        return semanticMap(ctx)
      case "conflicts":
        return this.conflicts()
      case "timeline":
        return this.timeline(int(q.get("limit"), 100, 1, 500))
      // versions and git
      case "versions": {
        const s = this.storeId(q.get("id") ?? "")
        return ctx.versions.log(s.kind, s.name)
      }
      case "diff": {
        const s = this.storeId(q.get("id") ?? "")
        return ctx.versions.diff(s.kind, s.name, q.get("to") ?? "working", q.get("from") ?? "parent", int(q.get("max"), ctx.options.web.diffMaxLines, 50, 1_000_000))
      }
      case "commit":
        return ctx.versions.commit(q.get("hash") ?? "")
      case "history":
        return ctx.versions.history({ smith: q.get("smith") ?? undefined, actor: q.get("actor") ?? undefined, since: q.get("since") ?? undefined, until: q.get("until") ?? undefined, manual: q.get("manual") === "1", limit: int(q.get("limit"), 100, 1, 1000), skip: int(q.get("skip"), 0, 0, 100_000) })
      // audit
      case "audit":
        return ctx.audit ? ctx.audit.query(this.auditFilter(q)) : { events: [], more: false, unavailable: true }
      case "audit/verify":
        return ctx.audit?.verify() ?? { ok: true, count: 0, unavailable: true }
      case "audit/rejected":
        return ctx.audit?.rejectedByReason(days) ?? []
      case "audit/runs": {
        const events = ctx.audit?.query({ ...this.auditFilter(q), limit: 2000 }).events ?? []
        const runs = new Map<string, { run: string; events: typeof events }>()
        for (const e of events) {
          const k = e.run ?? `seq-${e.seq}`
          ;(runs.get(k) ?? runs.set(k, { run: k, events: [] }).get(k)!).events.push(e)
        }
        return [...runs.values()].slice(0, int(q.get("limit"), 200, 1, 2000))
      }
      // statistics
      case "stats/overview":
        return statsOverview(ctx, days, q.get("project") ?? undefined)
      case "stats/knowledge":
        return statsKnowledge(ctx, days)
      case "stats/hints":
        return statsHints(ctx, days)
      case "stats/errors":
        return statsErrors(ctx, days)
      case "stats/smiths":
        return statsSmiths(ctx, days)
      case "stats/tools":
        return statsTools(ctx, days, q.get("tool") ?? undefined)
      case "stats/heatmap":
        return { grid: ctx.metrics?.heatmap(days) ?? [], available: !!ctx.metrics }
      case "stats/tasks":
        return statsTasks(ctx, days, q.get("project") ?? undefined)
      case "stats/pipeline":
        return statsPipeline(ctx, days, q.get("project") ?? undefined)
      case "stats/agents":
        return statsAgents(ctx, days)
      case "stats/events":
        return statsEvents(ctx, { type: q.get("type") ?? undefined, entry: q.get("entry") ?? undefined, day: q.get("day") ?? undefined, prefix: q.get("prefix") ?? undefined, limit: int(q.get("limit"), 300, 1, 2000) })
      case "usage":
        return entryUsage(ctx, q.get("id") ?? "", days)
      // productivity
      case "inbox": {
        const r = inbox(ctx, { since: q.get("since") ?? undefined })
        if (q.get("mark") === "1") markVisited(ctx)
        return r
      }
      case "simulate":
        return simulateHints(ctx, q.get("text") ?? "", {
          minScore: q.has("minScore") ? Number(q.get("minScore")) : undefined,
          hintMinSimilarity: q.has("minSim") ? Number(q.get("minSim")) : undefined,
          max: q.has("max") ? Number(q.get("max")) : undefined,
          ownBoost: q.has("ownBoost") ? Number(q.get("ownBoost")) : undefined,
        })
      case "templates":
        return templates(ctx)
      case "folders":
        return { folders: ctx.store.listFolders("knowledge"), defaults: folderDefaults(ctx), global: ctx.options.docs.defaultAiAccess, access: AI_ACCESS }
      case "tags":
        return ctx.index.tags()
      case "glossary":
        return ctx.store.list("glossary").map((e) => ({ id: `glossary:${e.name}`, term: str(e.fields.term), aliases: strArray(e.fields.aliases), meanings: meaningsOf(e.fields.meanings), tier: e.tier, version: e.version }))
      case "candidates":
        return ctx.store.candidates().filter((c) => !c.promotedTo)
      case "links/complete":
        return ctx.links.complete(q.get("q") ?? "", int(q.get("limit"), 20, 1, 50))
      case "links/resolve": {
        const out: Record<string, unknown> = {}
        for (const t of (q.get("targets") ?? "").split("\u001f").filter(Boolean).slice(0, 200)) {
          const r = ctx.links.resolve(t)
          out[t] = r ? { ...r, summary: truncate(this.entryOf(r.id)?.description ?? "", 200) } : null
        }
        return out
      }
      case "ticket":
        return ticketPage(ctx, q.get("id") ?? "")
      case "session":
        return sessionPage(ctx, q.get("id") ?? "")
      case "sessions":
        return (ctx.history?.all() ?? []).slice(0, int(q.get("limit"), 100, 1, 2000)).map((r) => ({ id: r.id, title: r.title ?? r.requests[0] ?? r.id, at: r.at, project: r.project, problems: r.problems.length, links: r.links.length }))
      case "staged":
        return ctx.ops.staged()
      case "shadow":
        return this.shadow()
      // tasks, projects, pipeline, agents
      case "board":
        return this.board(q.get("project") ?? "*")
      case "task":
        return this.task(q.get("id") ?? "")
      case "projects":
        return ctx.projects.list(q.get("archived") === "1")
      case "project":
        return projectPage(ctx, q.get("name") ?? "")
      case "pipeline/runs":
        return ctx.pipeline.runs(q.get("project") ?? undefined, int(q.get("limit"), 50, 1, 500))
      case "pipeline/run": {
        const r = ctx.pipeline.get(q.get("project") ?? "", q.get("id") ?? "")
        if (!r) throw new NotFound("Lauf nicht gefunden")
        return { run: r, log: ctx.pipeline.log(r.project, r.id, int(q.get("from"), 0, 0, 1e9)) }
      }
      case "pipeline/status":
        return ctx.pipeline.status()
      case "agents":
        return ctx.agentTasks.agents()
      case "models":
        return ctx.agentTasks.models()
      case "jobs":
        return ctx.agentTasks.all().slice(0, int(q.get("limit"), 100, 1, 1000)).map((j) => ({ id: j.id, task: j.task, project: j.project, agent: j.agent, stepAgent: j.stepAgent, model: j.model, phase: j.phase, step: j.step, column: j.column, waitingFor: j.waitingFor, loops: j.loops, startedAt: j.startedAt, endedAt: j.endedAt, cost: j.cost, tokens: j.tokens, permissions: j.permissions.length, prepared: !!j.prepared }))
      case "job":
        return ctx.agentTasks.tree(q.get("id") ?? "")
      case "job/session":
        return ctx.agentTasks.sessionView(q.get("id") ?? "", q.get("session") ?? "")
      case "job/diff":
        return ctx.agentTasks.diff(q.get("id") ?? "")
      case "rules":
        return ctx.agentTasks.rules()
      case "workshop": {
        const e = ctx.store.getOwned("script", q.get("name") ?? "")
        if (!e) throw new NotFound("Skript nicht gefunden")
        const f = scriptFiles(e.name)
        return { name: e.name, description: e.description, usage: str(e.fields.usage), capabilities: strArray(e.fields.capabilities), requirements: strArray(e.fields.requirements), tags: e.tags, docs: e.body, code: ctx.store.readFileOf(e, f.code) ?? "", tests: ctx.store.readFileOf(e, f.test) ?? "", test: e.meta?.test ?? null, runs: entryUsage(ctx, `script:${e.name}`, 90) }
      }
      case "exports":
        return this.exports()
      default: {
        const endpoint = ENDPOINTS[path]
        if (endpoint) return (await endpoint(ctx, q)) as Json
        throw new NotFound(`unknown endpoint ${path}`)
      }
    }
  }

  private storeId(id: string): { kind: Kind; name: string } {
    const s = isStoreId(id)
    if (!s) throw new NotFound(`kein Eintrag ${id}`)
    return s
  }

  private entryOf(id: string): Entry | undefined {
    const s = isStoreId(id)
    return s ? this.ctx.store.getOwned(s.kind, s.name) : undefined
  }

  private auditFilter(q: URLSearchParams) {
    const list = (k: string) => (q.get(k) ? q.get(k)!.split(",").filter(Boolean) : undefined)
    return {
      from: q.get("from") ?? undefined,
      to: q.get("to") ?? undefined,
      actor: list("actor"),
      smith: list("smith"),
      category: list("category"),
      result: list("result"),
      action: q.get("action") ?? undefined,
      project: q.get("project") ?? undefined,
      session: q.get("session") ?? undefined,
      target: q.get("target") ?? undefined,
      run: q.get("run") ?? undefined,
      text: q.get("text") ?? undefined,
      before: q.get("before") ? Number(q.get("before")) : undefined,
      limit: int(q.get("limit"), 200, 1, 5000),
    }
  }

  private scope() {
    try {
      return this.ctx.scope()
    } catch {
      return { project: `path:${this.ctx.worktree}`, projectName: this.ctx.project, projectSlug: this.ctx.project, branch: undefined, ticket: undefined }
    }
  }

  info(): Json {
    const o = this.ctx.options
    let version = "?"
    try {
      version = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")).version
    } catch {
      version = "3"
    }
    return {
      version,
      readOnly: isReadOnly(this.ctx),
      readOnlyConfig: o.web.readOnly,
      token: o.web.token,
      tasksRequireToken: o.tasks.requireToken,
      pipelineRequireToken: o.pipeline.requireToken,
      liveUpdates: o.web.liveUpdates,
      confirm: o.web.confirm,
      taskPrefix: o.tasks.idPrefix,
      columns: o.tasks.columns,
      agents: o.tasks.agents,
      ticketUrl: o.links.ticketUrl,
      notify: { browser: o.notify.browser },
      metrics: { enabled: o.metrics.enabled, available: !!this.ctx.metrics },
      audit: { available: !!this.ctx.audit },
      embeddings: this.ctx.retriever.semanticAvailable,
      project: this.scope().projectName,
      directory: this.ctx.directory,
      store: this.ctx.store.root,
      // values changed on the settings page that only take effect after a restart of opencode
      pendingRestart: [...(this.ctx.settings?.pendingRestart ?? [])],
      jobsAvailable: !!this.ctx.jobs,
      // effective configuration; secrets removed (the settings page shows sources and edits)
      config: publicConfig(o),
    }
  }

  private summaryNode(n: GraphNode, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const e = this.entryOf(n.id)
    return {
      id: n.id,
      kind: n.kind,
      type: n.type ?? null,
      label: nodeLabel(n.kind, n.type),
      title: n.title,
      summary: n.summary,
      status: n.status ?? null,
      tier: n.tier ?? null,
      tierLabel: n.tier ? (TIER_LABEL[n.tier] ?? n.tier) : null,
      project: n.projectName || n.project || null,
      date: n.date ?? null,
      ...(e ? { own: isOwnDoc(e), ai: aiAccessOf(e), folder: e.folder ?? null, pinned: !!e.meta?.pinned, quality: PROVENANCE_KINDS.includes(e.kind) ? (this.ctx.quality?.of(e).score ?? null) : null } : {}),
      ...extra,
    }
  }

  stats(): Json {
    const ctx = this.ctx
    const s = this.scope()
    const kinds = KINDS.map((k) => {
      const l = ctx.store.list(k)
      return { kind: k, label: spec(k).labelPlural, total: l.length, active: l.filter((e) => e.tier === "active").length, dormant: l.filter((e) => e.tier === "dormant").length, archive: l.filter((e) => e.tier === "archive").length, own: l.filter((e) => isOwnDoc(e)).length }
    })
    const memories = ctx.store.list("memory")
    const memTypes = Object.fromEntries(["entscheidung", "vorgabe", "erfahrung"].map((t) => [t, memories.filter((e) => str(e.fields.type) === t && e.tier === "active").length]))
    const mem = ctx.mem
    const state = s.branch ? mem?.state(s.project, s.branch) : undefined
    const edges = ctx.graph.allEdges()
    const doc = ctx.doctor?.status()
    const own = ctx.store.list("knowledge").filter((e) => isOwnDoc(e))
    return {
      project: s.projectName,
      projectId: s.project,
      branch: s.branch ?? null,
      ticket: s.ticket ?? null,
      kinds,
      memoryTypes: memTypes,
      states: mem?.states(s.project).filter((x) => x.status === "gueltig").length ?? 0,
      results: mem?.results(s.project).length ?? 0,
      currentState: state ? { id: state.id, summary: state.summary || state.goal, updatedAt: new Date(state.updatedAt).toISOString() } : null,
      relations: { stored: edges.filter((e) => !e.derived && e.type !== "not_related").length, derived: edges.filter((e) => e.derived).length },
      doctor: doc ?? null,
      embeddings: ctx.retriever.semanticAvailable,
      readOnly: isReadOnly(ctx),
      myDocs: { total: own.length, proposals: ctx.ops.staged().filter((x) => x.aiProposal).length, recent: own.sort((a, b) => (b.meta?.updatedAt ?? "").localeCompare(a.meta?.updatedAt ?? "")).slice(0, 6).map((e) => ({ id: `knowledge:${e.name}`, title: e.title, updatedAt: e.meta?.updatedAt ?? null })) },
      tasks: { open: ctx.tasks.list({ project: "*" }).filter((t) => !ctx.tasks.isDone(t.status, t.project)).length, agents: ctx.agentTasks.active().length },
      inbox: inbox(ctx).badge,
      jobs: { failed: (ctx.jobs?.list() ?? []).filter((j) => (j.last as { status?: string } | null)?.status === "error").length, running: (ctx.jobs?.list() ?? []).filter((j) => j.running).length },
    }
  }

  list(q: URLSearchParams): Json {
    const ctx = this.ctx
    const kindRaw = q.get("kind") ?? "memory"
    const tier = q.get("tier") ?? ""
    const type = q.get("type") ?? ""
    const allProjects = q.get("project") === "all"
    const s = this.scope()
    if (kindRaw === "arbeitsstand") return (ctx.mem?.states(allProjects ? undefined : s.project) ?? []).map((st) => this.summaryNode(ctx.graph.node(st.id)!))
    if (kindRaw === "ergebnis") return (ctx.mem?.results(allProjects ? undefined : s.project) ?? []).map((r) => this.summaryNode(ctx.graph.node(r.id)!))
    if (!(KINDS as string[]).includes(kindRaw)) throw new NotFound(`unknown kind ${kindRaw}`)
    const kind = kindRaw as Kind
    const author = q.get("author") ?? ""
    const ai = q.get("ai") ?? ""
    const folder = q.get("folder")
    const tag = q.get("tag") ?? ""
    const changedSince = q.get("aiChangedSince") ?? ""
    const proposals = q.get("proposals") === "1"
    const staged = proposals ? new Set(ctx.ops.staged().map((x) => `${x.target}:${x.name}`)) : undefined
    const aiChanged = changedSince
      ? new Set((ctx.audit?.query({ from: changedSince, category: ["change"], actor: ["reviewer", "curator", "doctor", "agent"], limit: 5000 }).events ?? []).flatMap((e) => e.targets))
      : undefined
    return ctx.store
      .list(kind)
      .filter((e) => !tier || e.tier === tier)
      .filter((e) => !type || str(e.fields.type) === type)
      .filter((e) => kind !== "memory" || allProjects || !str(e.fields.project) || str(e.fields.project) === s.project)
      .filter((e) => !author || (author === "ich" ? isOwnDoc(e) : !isOwnDoc(e)))
      .filter((e) => !ai || aiAccessOf(e) === ai)
      .filter((e) => folder === null || (e.folder ?? "") === folder || (folder !== "" && (e.folder ?? "").startsWith(`${folder}/`)))
      .filter((e) => !tag || e.tags.includes(tag))
      .filter((e) => !aiChanged || aiChanged.has(`${kind}:${e.name}`))
      .filter((e) => !staged || staged.has(`${kind}:${e.name}`))
      .sort((a, b) => (b.meta?.updatedAt ?? "").localeCompare(a.meta?.updatedAt ?? ""))
      .map((e) => this.summaryNode(ctx.graph.node(key(kind, e.name))!, { tags: e.tags }))
  }

  async search(query: string, kindsRaw: string[]): Promise<Json> {
    const ctx = this.ctx
    const q = query.trim()
    if (!q) return []
    const kinds = (kindsRaw.length ? kindsRaw : KINDS).filter((k): k is Kind => (KINDS as string[]).includes(k))
    const hits = kinds.length ? await ctx.retriever.search(q, { kinds, tiers: ["active", "dormant", "archive"], limit: 40, purpose: "search", includeForeign: false, includePrivate: true }) : []
    ctx.metrics?.record({ type: M.search, entry: "web", origin: "web", value: undefined, extra: { hits: hits.length } })
    const out: Array<Record<string, unknown>> = []
    for (const h of hits) {
      const n = ctx.graph.node(key(h.kind, h.name))
      if (!n) continue
      out.push(this.summaryNode(n, { score: Math.round(Math.max(h.confidence, h.similarity ?? 0) * 100) / 100, snippet: h.snippet }))
    }
    const wantVolatile = !kindsRaw.length || kindsRaw.includes("arbeitsstand") || kindsRaw.includes("ergebnis")
    if (wantVolatile && ctx.mem?.available) {
      const terms = [...new Set(tokenize(q))]
      const score = (text: string) => {
        const t = new Set(tokenize(text))
        return terms.length ? terms.filter((x) => t.has(x)).length / terms.length : 0
      }
      const extra = [...ctx.mem.states().map((st) => st.id), ...ctx.mem.results().map((r) => r.id)]
        .map((id) => ctx.graph.node(id)!)
        .filter(Boolean)
        .map((n) => ({ n, s: score(`${n.title}\n${n.summary}\n${n.text}`) }))
        .filter((x) => x.s >= 0.5)
        .sort((a, b) => b.s - a.s)
        .slice(0, 10)
      for (const { n, s } of extra) out.push(this.summaryNode(n, { score: Math.round(s * 100) / 100, snippet: truncate(n.summary, 160) }))
    }
    return out
  }

  /** Full entry: content, fields, evidence, history, relations, links, backlinks, mentions, proposals. */
  entry(id: string): Json {
    const ctx = this.ctx
    const g = ctx.graph
    const n = g.node(id)
    if (!n) throw new NotFound(`entry ${id} not found`)
    const s = isStoreId(id)
    const e: Entry | undefined = s ? ctx.store.get(s.kind, s.name) : undefined
    const fields: Array<[string, string]> = []
    let body = n.text
    let tags: string[] = []
    let evidence: Array<Record<string, unknown>> = []
    let history: Array<Record<string, unknown>> = []
    let file: string | null = null
    if (e) {
      body = e.body
      tags = e.tags
      file = e.file
      fields.push(...fieldRows(e))
      evidence = (e.meta?.evidence ?? []).slice(-10).reverse().map((ev) => ({ at: ev.at, source: ev.source, text: ev.text, session: ev.sessionID ?? null }))
      history = (e.meta?.history ?? []).slice(-30).reverse().map((h) => ({ at: h.at, action: h.action, actor: h.actor, reason: h.reason ?? null, run: h.runId }))
      if (e.meta?.doubts?.length) for (const d of e.meta.doubts) fields.push(["Zweifel", `${d.at.slice(0, 10)}: ${d.note}`])
      if (e.meta?.test) fields.push(["Tests", `${e.meta.test.status} (${e.meta.test.at.slice(0, 10)})`])
      const u = ctx.usage.get(e.kind, e.name)
      if (u.loads) fields.push(["Nutzung", `${u.loads}× gelesen${u.lastUsedAt ? `, zuletzt ${u.lastUsedAt.slice(0, 10)}` : ""}`])
      ctx.metrics?.record({ type: M.view, entry: id, origin: "web" })
    } else if (id.startsWith("state:")) {
      const st = ctx.mem?.getState(id)
      if (st) {
        fields.push(["Projekt", st.projectName || st.project], ["Branch", st.branch])
        if (st.ticket) fields.push(["Ticket", st.ticket])
        fields.push(["Stand", new Date(st.updatedAt).toISOString().slice(0, 16).replace("T", " ")], ["Status", STATUS_LABEL[st.status] ?? st.status])
        body = [st.goal ? `## Ziel\n${st.goal}` : "", st.done.length ? `## Erledigt\n${st.done.map((x) => `- ${x}`).join("\n")}` : "", st.open.length ? `## Offen\n${st.open.map((x) => `- ${x}`).join("\n")}` : "", st.next.length ? `## Nächste Schritte\n${st.next.map((x) => `- ${x}`).join("\n")}` : "", st.files.length ? `## Dateien\n${st.files.map((x) => `- \`${x}\``).join("\n")}` : ""].filter(Boolean).join("\n\n")
        history = st.history.map((h) => ({ at: new Date(h.at).toISOString(), action: "Stand", actor: "memorysmith", reason: h.summary, done: h.done, open: h.open, next: h.next }))
        if (st.evidence) evidence = [{ at: new Date(st.updatedAt).toISOString(), source: "transcript", text: st.evidence }]
      }
    } else if (id.startsWith("result:")) {
      const r = ctx.mem?.getResult(id)
      if (r) {
        fields.push(["Projekt", r.projectName || r.project])
        if (r.branch) fields.push(["Branch", r.branch])
        fields.push(["Erstellt", new Date(r.createdAt).toISOString().slice(0, 16).replace("T", " ")], ["Genutzt", `${r.used}×`])
        tags = r.tags
        body = [r.question ? `## Frage\n${r.question}` : "", `## Ergebnis\n${r.answer}`, r.files.length ? `## Dateien\n${r.files.map((x) => `- \`${x}\``).join("\n")}` : "", r.sources.length ? `## Quellen\n${r.sources.map((x) => `- ${x}`).join("\n")}` : ""].filter(Boolean).join("\n\n")
        if (r.evidence) evidence = [{ at: new Date(r.createdAt).toISOString(), source: "transcript", text: r.evidence }]
      }
    }
    const relations = g.edgesOf(id, true).map((edge) => this.relationView(id, edge))
    const conflicts = (ctx.mem?.conflicts(["open", "needs_user"]) ?? []).filter((c) => c.a === id || c.b === id).map((c) => ({ id: c.id, status: c.status, suspicion: c.suspicion, note: c.note ?? null, other: this.otherView(c.a === id ? c.b : c.a) }))
    const links = ctx.links.outgoingOf(id).map((l) => ({ raw: l.raw, target: l.target, label: l.label ?? null, section: l.section ?? null, id: l.id ?? null, title: l.id ? (this.entryOf(l.id)?.title ?? l.id) : null }))
    const backlinks = ctx.links.backlinksOf(id).map((b) => ({ from: b.from, title: this.entryOf(b.from)?.title ?? b.from, raw: b.link.raw }))
    const mentions = e ? ctx.links.mentionsOf(id).map((m) => ({ ...m, title: this.entryOf(m.from)?.title ?? m.from })) : []
    const proposals = s ? ctx.ops.staged().filter((x) => x.target === s.kind && x.name === s.name) : []
    let relevance: unknown = null
    try {
      const nodes = g.nodes()
      const map = ctx.relevance.compute(nodes, g.allEdges(), {}, storeExtras(nodes, (k, nm) => ctx.store.readMeta(k as Kind, nm)))
      relevance = map.get(id) ?? null
    } catch {
      relevance = null
    }
    return {
      node: this.summaryNode(n),
      description: n.summary,
      body,
      tags,
      fields,
      rawFields: e ? e.fields : null,
      title: e?.title ?? n.title,
      evidence,
      history,
      file,
      relations,
      conflicts,
      links,
      backlinks,
      mentions,
      proposals,
      relevance,
      version: e?.version ?? null,
      metaVersion: e?.meta ? sha(JSON.stringify(e.meta)) : null,
      folder: e?.folder ?? null,
      ai: e ? aiAccessOf(e) : null,
      own: e ? isOwnDoc(e) : null,
      owned: e?.owned ?? null,
      pinned: !!e?.meta?.pinned,
      task: e?.kind === "task" ? ctx.tasks.view(e) : null,
      ...(e ? this.qualityView(id, e) : {}),
    }
  }

  /** Code anchors, provenance per paragraph and the quality score of an entry (5c). */
  private qualityView(id: string, e: Entry): Record<string, unknown> {
    const ctx = this.ctx
    const status = ctx.anchors?.statusOf(id) ?? []
    const anchors = (e.meta?.anchors ?? []).map((a) => {
      const st = status.find((x) => x.ref === a.ref)
      return { ...a, status: st?.status ?? null, newPath: st?.newPath ?? null, note: st?.note ?? null, before: st?.before ?? null, after: st?.after ?? null }
    })
    const own = isOwnDoc(e)
    const provenance = PROVENANCE_KINDS.includes(e.kind) ? provenanceView(e, { anchors: status, own, exists: (x) => !!this.entryOf(x) }) : null
    return {
      anchors,
      provenance: provenance ? { counts: provenance.counts, share: provenance.share ?? null, own, paragraphs: provenance.paragraphs.map((p) => ({ index: p.index, key: p.key, line: p.line, status: p.status, neutral: p.neutral, text: truncate(p.text, 400), sources: p.sources, fromHistory: !!p.fromHistory, reason: p.reason ?? null })) } : null,
      quality: PROVENANCE_KINDS.includes(e.kind) ? (ctx.quality?.of(e) ?? null) : null,
    }
  }

  private otherView(id: string): Record<string, unknown> {
    const o = this.ctx.graph.node(id)
    return o ? { id, exists: true, kind: o.kind, label: nodeLabel(o.kind, o.type), title: o.title, summary: truncate(o.summary, 200), tier: o.tier ?? null, status: o.status ?? null } : { id, exists: false, kind: id.split(":")[0], label: id.split(":")[0], title: id, summary: "", tier: null, status: null }
  }

  private relationView(id: string, e: GraphEdge): Record<string, unknown> {
    const out = e.from === id
    return { direction: out ? "out" : "in", type: e.type, label: RELATION_LABEL[e.type] ?? e.type, strength: e.strength, description: e.description, source: e.source, at: e.at, derived: !!e.derived, other: this.otherView(out ? e.to : e.from), from: e.from, to: e.to }
  }

  graph(q: URLSearchParams): Json {
    const ctx = this.ctx
    const g = ctx.graph
    const center = q.get("center") ?? ""
    const depth = int(q.get("depth"), 1, 1, 3)
    const minStrength = Math.max(0, Math.min(1, Number(q.get("minStrength")) || 0))
    const types = (q.get("types") ?? "").split(",").filter(Boolean) as GraphEdge["type"][]
    const kinds = new Set((q.get("kinds") ?? "").split(",").filter(Boolean))
    const derived = q.get("derived") !== "0"
    const archived = q.get("archived") === "1"
    const allProjects = q.get("project") === "all"
    const onlyOwn = q.get("own") === "1"
    const top = int(q.get("top"), 0, 0, 10_000)
    const s = this.scope()
    const keepNode = (n: GraphNode) =>
      (!kinds.size || kinds.has(n.kind)) &&
      (archived || n.tier !== "archive") &&
      (allProjects || (n.kind !== "memory" && n.kind !== "arbeitsstand" && n.kind !== "ergebnis") || !n.project || n.project === s.project) &&
      (!onlyOwn || (() => {
        const e = this.entryOf(n.id)
        return !!e && isOwnDoc(e)
      })())
    const keepEdge = (e: GraphEdge) => e.type !== "not_related" && e.strength >= minStrength && (!types.length || types.includes(e.type)) && (derived || !e.derived)
    let nodes: GraphNode[]
    let edges: GraphEdge[]
    if (center) {
      if (!g.node(center)) throw new NotFound(`entry ${center} not found`)
      const nb = g.neighbourhood(center, depth, minStrength, types.length ? types : undefined)
      nodes = nb.nodes.filter((n) => n.id === center || keepNode(n))
      edges = nb.edges.filter(keepEdge)
    } else {
      nodes = g.nodes().filter(keepNode)
      edges = g.allEdges().filter(keepEdge)
    }
    const ids = new Set(nodes.map((n) => n.id))
    edges = edges.filter((e) => ids.has(e.from) && ids.has(e.to))
    const degree = new Map<string, number>()
    for (const e of edges) for (const x of [e.from, e.to]) degree.set(x, (degree.get(x) ?? 0) + 1)
    // relevance: node size and ring
    const window = q.get("window") === "total" ? "total" : "current"
    const all = g.nodes()
    const extras = storeExtras(all, (k, nm) => ctx.store.readMeta(k as Kind, nm))
    const own = new Set(all.filter((n) => {
      const e = this.entryOf(n.id)
      return !!e && isOwnDoc(e)
    }).map((n) => n.id))
    const backlinks = new Map<string, number>()
    for (const p of ctx.links.pairs()) if (own.has(p.from) || p.from.startsWith("task:")) backlinks.set(p.to, (backlinks.get(p.to) ?? 0) + 1)
    const rel = ctx.relevance.compute(all, g.allEdges(), { window, acrossKinds: q.get("across") === "1" }, { ...extras, ownDocs: own, backlinks })
    let truncated = false
    const limit = top || MAX_GRAPH_NODES
    if (nodes.length > limit) {
      truncated = true
      nodes = nodes
        .sort((a, b) => (rel.get(b.id)?.score ?? 0) - (rel.get(a.id)?.score ?? 0) || (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
        .slice(0, limit)
      const keep = new Set(nodes.map((n) => n.id))
      edges = edges.filter((e) => keep.has(e.from) && keep.has(e.to))
    }
    const sizeBy = q.get("sizeBy") ?? "relevance"
    return {
      center: center || null,
      truncated,
      sizeBy,
      nodes: nodes.map((n) => {
        const r = rel.get(n.id)
        const value = !r ? 0 : sizeBy === "usage" ? r.usage : sizeBy === "network" ? r.network : sizeBy === "equal" ? 0.3 : r.score
        return this.summaryNode(n, {
          degree: degree.get(n.id) ?? 0,
          summary: truncate(n.summary, 200),
          relevance: r ? Math.round(r.score * 1000) / 1000 : 0,
          size: Math.round(radiusOf(r?.isNew ? Math.max(value, 0.25) : value) * 10) / 10,
          ring: r?.ring ?? null,
          ringReason: r?.ringReason ?? null,
          isNew: !!r?.isNew,
          faded: !!r?.faded,
          explain: r?.explain ?? "",
          tags: this.entryOf(n.id)?.tags ?? [],
        })
      }),
      edges: edges.map((e, i) => ({ id: `e${i}`, from: e.from, to: e.to, type: e.type, label: RELATION_LABEL[e.type] ?? e.type, strength: e.strength, description: e.description, source: e.source, derived: !!e.derived })),
    }
  }

  path(a: string, b: string): Json {
    const p = shortestPath(this.ctx.graph.allEdges(), a, b)
    return { found: !!p, edges: (p ?? []).map((e) => ({ from: e.from, to: e.to, type: e.type, label: RELATION_LABEL[e.type] ?? e.type, strength: e.strength, derived: !!e.derived })) }
  }

  conflicts(): Json {
    const mem = this.ctx.mem
    if (!mem?.available) return []
    const order = (s: string) => (s === "needs_user" ? 0 : s === "open" ? 1 : 2)
    return mem
      .conflicts()
      .sort((a, b) => order(a.status) - order(b.status) || b.detectedAt - a.detectedAt)
      .slice(0, 300)
      .map((c) => ({ id: c.id, status: c.status, suspicion: c.suspicion, similarity: c.similarity, note: c.note ?? null, resolution: c.resolution ?? null, detectedAt: new Date(c.detectedAt).toISOString(), resolvedAt: c.resolvedAt ? new Date(c.resolvedAt).toISOString() : null, attempts: c.attempts, a: this.otherView(c.a), b: this.otherView(c.b) }))
  }

  timeline(limit: number): Json {
    let lines: string[] = []
    try {
      lines = readFileSync(join(this.ctx.store.stateDir, "journal.jsonl"), "utf8").split("\n").filter(Boolean)
    } catch {
      return []
    }
    return lines
      .slice(-limit)
      .reverse()
      .map((l) => {
        try {
          const j = journalLine(JSON.parse(l))
          return {
            at: j.at,
            run: j.run,
            smith: j.smith,
            actor: j.actor,
            trigger: j.trigger,
            ok: j.ok,
            commit: j.commit ?? null,
            summary: j.summary ?? null,
            session: j.session ?? null,
            project: j.project ?? null,
            actions: (j.actions as JournalAction[]).filter((a) => a.applied && a.kind !== "note").slice(0, 30).map((a) => ({ kind: a.kind, target: a.target, name: a.name, reason: a.reason ?? null, local: !!a.local, id: journalTarget(a) ?? null })),
          }
        } catch {
          return undefined
        }
      })
      .filter(Boolean) as unknown[]
  }

  private shadow(): Json {
    let lines: string[] = []
    try {
      lines = readFileSync(this.ctx.ops.shadowFile, "utf8").split("\n").filter(Boolean)
    } catch {
      return []
    }
    return lines
      .map((l, index) => {
        try {
          const j = shadowLine(JSON.parse(l))
          return { index, at: j.at, smith: j.smith, action: j.action, target: j.target, name: j.name, reason: j.reason ?? null }
        } catch {
          return undefined
        }
      })
      .filter(Boolean)
      .reverse()
      .slice(0, 300) as unknown[]
  }

  private board(project: string): Json {
    const ctx = this.ctx
    const p = project !== "*" && project !== "-" ? ctx.projects.get(project) : undefined
    return {
      project: p ?? null,
      columns: ctx.tasks.columns(p?.name),
      flows: ctx.agentTasks.flows(p?.name),
      wip: p?.wip ?? ctx.options.tasks.wipLimits,
      tasks: ctx.tasks.list({ project }),
      loose: ctx.tasks.looseItems(p?.name),
      projects: ctx.projects.list(),
      running: ctx.pipeline.status(),
    }
  }

  private task(idRaw: string): Json {
    const ctx = this.ctx
    const e = ctx.tasks.get(idRaw)
    if (!e) throw new NotFound(`Aufgabe ${idRaw} nicht gefunden`)
    const v = ctx.tasks.view(e)
    const children = ctx.tasks.list({ project: "*", includeArchived: true }).filter((t) => t.parent === v.id)
    return {
      task: v,
      body: e.body,
      checklist: (() => {
        const lines = e.body.split("\n")
        return lines.map((l, i) => ({ line: i, m: /^(\s*)[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(l) })).filter((x) => x.m).map((x) => ({ line: x.line, done: x.m![2] !== " ", text: x.m![3] }))
      })(),
      children,
      parent: v.parent ? ctx.tasks.view(ctx.tasks.require(v.parent)) : null,
      fields: readTaskFields(e.fields),
      flows: ctx.agentTasks.flows(v.project),
      jobs: ctx.agentTasks.all().filter((j) => j.task === e.name).map((j) => ({ id: j.id, agent: j.agent, stepAgent: j.stepAgent, model: j.model, phase: j.phase, step: j.step, column: j.column, waitingFor: j.waitingFor, loops: j.loops, startedAt: j.startedAt, endedAt: j.endedAt })),
      runs: ctx.pipeline.runs(v.project, 200).filter((r) => r.task === e.name).slice(0, 20),
      entry: this.entry(`task:${e.name}`),
    }
  }

  private exports(): Json {
    try {
      return readdirSync(join(this.ctx.store.stateDir, "exports")).sort().reverse().slice(0, 30)
    } catch {
      return []
    }
  }
}

/** Options without secrets (API keys) for the settings page. */
export function publicConfig(o: object): object {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (!v || typeof v !== "object") return v
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, /api.?key$|password|secret|token$/i.test(k) && typeof x === "string" ? "••••" : walk(x)]))
  }
  return walk(o) as object
}

/** Frontmatter fields of an entry as label/value rows (German labels). */
export function fieldRows(e: Entry): Array<[string, string]> {
  const f = e.fields
  const rows: Array<[string, string]> = [["Art", e.kind === "memory" ? (MEMORY_TYPE_LABEL[str(f.type)] ?? "Erinnerung") : spec(e.kind).label], ["Stufe", TIER_LABEL[e.tier] ?? e.tier]]
  const add = (label: string, v: unknown) => {
    const s = Array.isArray(v) ? v.map(String).join(", ") : str(v)
    if (s) rows.push([label, s])
  }
  switch (e.kind) {
    case "memory":
      add("Status", STATUS_LABEL[str(f.status)] ?? f.status)
      add("Gültigkeit", str(f.scope) === "global" ? "global" : str(f.project_name) || str(f.project))
      add("Thema", f.topic)
      add("Branch", f.branch)
      add("Ticket", f.ticket)
      add("Entschieden von", str(f.decided_by) === "agent" ? "Agent (unbestätigt)" : str(f.decided_by) === "user" ? "Nutzer" : "")
      add("Gültig seit", f.valid_from)
      add("Prüfen nach", f.review_after)
      add("Abgelöst durch", str(f.superseded_by) ? `memory:${str(f.superseded_by)}` : "")
      break
    case "error":
      add("Status", str(f.status) === "solved" ? "gelöst" : str(f.status) === "open" ? "offen" : f.status)
      add("Kontext", strArray(f.context))
      add("Signaturen", strArray(f.signatures).slice(0, 5))
      break
    case "script":
      add("Aufruf", f.usage)
      add("Datei", str(f.entry) || scriptFiles(e.name).code)
      add("Fähigkeiten", strArray(f.capabilities))
      add("Abhängigkeiten", strArray(f.requirements))
      break
    case "glossary":
      add("Begriff", f.term)
      add("Auch", strArray(f.aliases))
      for (const m of meaningsOf(f.meanings)) rows.push(["Bedeutung", `${m.expansion}${m.context ? ` (${m.context})` : ""}${m.description ? ` – ${m.description}` : ""}`])
      break
    case "knowledge":
      add("Ordner", e.folder ? e.folder : "")
      add("Auch genannt", strArray(f.aliases))
      add("Prüfen nach", f.review_after)
      break
    case "task":
      add("Spalte", f.status)
      add("Priorität", f.priority)
      add("Projekt", f.project)
      add("Fällig", f.due)
      add("Elternaufgabe", f.parent)
      add("Zugewiesen", str(f.assignee) === "agent" ? `Agent ${str(f.agent)}` : f.assignee)
      add("Branch", f.branch)
      add("Ticket", f.ticket)
      break
    case "project":
      add("Verzeichnis", f.home_path)
      add("Agent", f.agent)
      add("Modell", f.model)
      break
  }
  add("Autor", str(f.author) === "user" ? "ich" : str(f.author) === "agent" ? "KI" : "")
  if (str(f.ai)) add("KI-Recht", f.ai)
  if (e.meta?.createdAt) rows.push(["Erstellt", e.meta.createdAt.slice(0, 16).replace("T", " ")])
  if (e.meta?.updatedAt) rows.push(["Geändert", e.meta.updatedAt.slice(0, 16).replace("T", " ")])
  if (e.meta?.verifiedAt) rows.push(["Bestätigt", e.meta.verifiedAt.slice(0, 10)])
  if (e.meta?.pinned) rows.push(["Angepinnt", "ja"])
  if (e.meta?.absorbedInto) rows.push(["Zusammengeführt in", `${e.kind}:${e.meta.absorbedInto}`])
  if (!e.owned) rows.push(["Quelle", e.source ?? "fremd (nur lesen)"])
  return rows
}
