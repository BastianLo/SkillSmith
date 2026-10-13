/**
 * opencode 1.x host adapter: wires the host-independent core into the v1
 * plugin hooks. A v2 adapter would live next to this file.
 */
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"
import { expandHome, loadOptions, parseModel, type Options } from "../config"
import { checkTool, relay } from "../core/agent-hub"
import { sessionSignals, unwrap } from "../core/agent-runner"
import type { Ctx } from "../core/context"
import { Curator } from "../core/curator"
import { Doctor } from "../core/doctor"
import { Graph } from "../core/graph"
import { MemoryDb } from "../core/memory-db"
import { ScopeResolver } from "../core/scope"
import { attachServices, closeServices, startupServices } from "../core/services"
import { jobDefs } from "../core/job-defs"
import { registerAgents } from "../core/agent-defs"
import { migrateTaskColumns } from "../core/tasks"
import { releaseScheduler, sharedScheduler, userActivity } from "../core/jobs"
import { WebServer } from "../web/server"
import { EmbeddingClient, SemanticIndex } from "../core/embeddings"
import { finalizeRun } from "../core/finalize"
import { GitTracker } from "../core/git"
import { HintEngine } from "../core/hints"
import { Ops } from "../core/ops"
import { ASSISTANT_AGENT, assistantSystemPrompt, curatorAgent, curatorSystemPrompt, DOCTOR_AGENT, doctorSystemPrompt, isSmithAgent, reviewerAgent, reviewerSystemPrompt, SMITHS } from "../core/prompts"
import { ProjectDocs, safeDocsRoot } from "../core/project-docs"
import { ReviewQueue } from "../core/queue"
import { createRedactor } from "../core/redact"
import { Retriever } from "../core/retrieval"
import { AGENT_TITLE_PREFIX, reviewSession } from "../core/reviewer"
import { sharedRunRegistry } from "../core/runs"
import { SearchIndex } from "../core/search"
import { SessionHistory } from "../core/session-history"
import { OccurrenceStore, rememberModel, SessionStore, UsageStore } from "../core/state"
import { defaultForeignRoots, Store, STORE_VERSION } from "../core/store"
import { Workshop } from "../core/toolsmith"
import { openVectorStore } from "../core/vector-store"
import { INTERNAL_PREFIX, stripPluginNotes } from "../core/transcript"
import { createLogger, type Logger } from "../log"
import type { Smith } from "../types"
import { errorMessage, nowIso, sha, truncate } from "../util/text"
import { COMMAND_NAMES, COMMANDS, handleCommand } from "./commands"
import { MetricEvents } from "./metric-events"
import { loadZod } from "./schema"
import { createTools, READ_TOOLS, WRITE_TOOL_PREFIXES } from "./tools"

type AnyRecord = Record<string, any>

/** "merk dir …", "remember …" in a user message → memorysmith reviews right after the turn */
const REMEMBER_RE = /\b(merk(e)?\s+dir|merken\s+sie\s+sich|nicht\s+vergessen|vergiss\s+(das\s+)?nicht|notier(e)?\s+dir|behalt(e)?\s+(das|im\s+kopf)|remember\s+(this|that)|keep\s+in\s+mind|don'?t\s+forget)\b/i

const SKILL_TOOL_HINT =
  "\n\nIf none of the listed skills fits the task, call skill_search – it also finds dormant and archived skills (load them with skill_read). Related libraries: knowledge_search (documentation), glossary_lookup (abbreviations), error_lookup (known errors and fixes), script_search (tested Python scripts)."

function agentConfig(smith: Smith, prompt: string, description: string, o: Options, model?: string): AnyRecord {
  const permission: AnyRecord = { "*": "deny" }
  for (const t of READ_TOOLS) permission[t] = "allow"
  permission[`${smith}_*`] = "allow"
  return {
    mode: "primary",
    hidden: true,
    description,
    prompt,
    temperature: 0.2,
    steps: o.agentSteps,
    // only "provider/model" – opencode would read a bare name as a provider (sessions get an explicit model anyway)
    ...(parseModel(model) ? { model } : {}),
    permission,
  }
}

function withWriteToolsDenied(permission: unknown): AnyRecord {
  let p: AnyRecord
  if (permission === undefined || permission === null) p = {}
  else if (typeof permission === "string") p = { "*": permission }
  else if (typeof permission === "object" && !Array.isArray(permission)) p = permission as AnyRecord
  else p = {}
  // appended last → wins over earlier wildcard rules (opencode evaluates the last matching rule)
  for (const prefix of WRITE_TOOL_PREFIXES) {
    delete p[`${prefix}*`]
    p[`${prefix}*`] = "deny"
  }
  return p
}

function textOfParts(parts: AnyRecord[] | undefined): string {
  return (parts ?? [])
    .filter((p) => p?.type === "text" && !p.synthetic && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim()
}

export async function createServer(input: AnyRecord, rawOptions?: Record<string, unknown>): Promise<AnyRecord> {
  const { options, warnings } = loadOptions(rawOptions)
  if (!options.enabled) return {}
  const directory: string = resolve(input.directory ?? process.cwd())
  const worktree: string = resolve(input.worktree || directory)
  const guardKey = Symbol.for(`skillsmith.instance:${directory}`)
  if ((globalThis as any)[guardKey]) return {}
  ;(globalThis as any)[guardKey] = true

  const client = input.client
  // level per area from the live options (the settings page changes them in place)
  const logHandle = createLogger(join(options.storeDir, "state", "log"), {
    level: (area) => (options.debug ? "debug" : (options.log.areas[area] ?? options.log.level)),
    sink: (level, scope, msg) => {
      try {
        void client?.app?.log?.({ body: { service: "skillsmith", level, message: `[${scope}] ${msg}` } })?.catch?.(() => {})
      } catch {
        // ignore
      }
    },
  })
  const log: Logger = logHandle
  for (const w of warnings) log.warn(w)

  const store = new Store(options.storeDir, log.child("store"))
  store.init()
  const configDir = join(process.env.XDG_CONFIG_HOME ? expandHome(process.env.XDG_CONFIG_HOME) : join(homedir(), ".config"), "opencode")
  let extraSkillPaths: string[] = []
  if (options.indexForeignSkills) {
    store.setForeignRoots(() => defaultForeignRoots({ directory, worktree, configDir, extraPaths: extraSkillPaths }))
  }

  const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") => {
    try {
      void client?.tui?.showToast?.({ body: { title: "skillsmith", message, variant, duration: variant === "error" ? 12000 : 6000 } })?.catch?.(() => {})
    } catch {
      // ignore (no TUI attached)
    }
  }

  const redactor = createRedactor(options.redact)
  logHandle.configure({ redact: (s) => redactor.redact(s) })
  const index = new SearchIndex(store, options.indexForeignSkills)
  const embedClient = new EmbeddingClient(options.embedding, log.child("embed"))
  const vectorStore = options.embedding.enabled
    ? await openVectorStore(join(store.stateDir, "embeddings"), store.locksDir, log.child("embed"), { storage: options.embedding.storage })
    : undefined
  const semantic = vectorStore
    ? new SemanticIndex(embedClient, store, vectorStore, log.child("embed"), options.indexForeignSkills, `foreign-${sha(directory, 10)}`)
    : undefined
  const ctx = {
    options,
    log,
    store,
    index,
    retriever: new Retriever({ store, index, semantic, options }),
    semantic,
    git: new GitTracker(store, options.git.enabled, options.git.binary, log.child("git")),
    usage: new UsageStore(store.stateDir, store.locksDir),
    occurrences: new OccurrenceStore(store.stateDir, store.locksDir),
    sessions: new SessionStore(store.stateDir),
    redactor,
    ops: new Ops({ store, options, redactor, log }),
    runs: sharedRunRegistry(),
    client,
    directory,
    worktree,
    project: basename(worktree) || "project",
    toast,
  } as Ctx
  const docsRoot = safeDocsRoot(directory, worktree)
  if (options.docsmith.projectIndex && docsRoot) ctx.projectDocs = new ProjectDocs(docsRoot, options, log.child("docs"), (s) => redactor.redact(s), semantic)
  if (options.history.enabled) ctx.history = new SessionHistory(store.stateDir, store.locksDir, options, log.child("history"), (s) => redactor.redact(s), semantic)
  // memory-smith, doctor, graph
  const mem = options.memorysmith.enabled || options.doctor.enabled ? new MemoryDb(store.stateDir, log.child("memory")) : undefined
  ctx.mem = mem?.available ? mem : undefined
  ctx.scopes = new ScopeResolver(options.git.binary, options.memorysmith.ticketPattern)
  ctx.scope = () => ctx.scopes.resolve(directory, worktree)
  ctx.graph = new Graph(store, ctx.mem, ctx.history)
  ctx.ops.setMemory(ctx.mem, ctx.graph)
  attachServices(ctx, undefined, rawOptions)
  ctx.doctor = new Doctor(ctx)
  ctx.web = new WebServer(ctx)
  ctx.hints = new HintEngine(ctx)
  ctx.workshop = new Workshop(ctx)
  ctx.ops.setScriptRecheck(ctx.workshop.recheck)
  // always: tag plan works with BM25, the semantic gates only with embeddings
  ctx.ops.setSimilarity(ctx.retriever.similarity())
  const signals = sessionSignals()
  const curator = new Curator(ctx)
  const queue = new ReviewQueue(ctx, (job) => reviewSession(ctx, job, () => ctx.jobs?.event("after-review")))
  ctx.queue = queue
  ctx.curator = curator
  // recurring jobs: one scheduler per store and process; agent worktree instances only use it
  const worktreeInstance = directory.startsWith(join(store.stateDir, "worktrees"))
  const sched = worktreeInstance ? undefined : sharedScheduler(ctx, () => jobDefs(ctx))
  ctx.jobs = sched?.scheduler ?? (globalThis as any)[Symbol.for(`skillsmith.jobs:${store.root}`)]
  const zod = await loadZod()
  const tools = createTools(ctx, zod)
  const metricEvents = new MetricEvents(ctx)

  // --- session bookkeeping ----------------------------------------------------
  const parentCache = new Map<string, string | null>()
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()

  const isInternal = (sid: string | undefined) => !!sid && (signals.isInternal(sid) || ctx.runs.isAgentSession(sid))

  async function parentOf(sid: string): Promise<string | null> {
    if (parentCache.has(sid)) return parentCache.get(sid)!
    const st = ctx.sessions.peek(sid)
    if (st && st.parentID !== undefined) {
      parentCache.set(sid, st.parentID ?? null)
      return st.parentID ?? null
    }
    let parent: string | null = null
    try {
      const info = unwrap<AnyRecord>(await client.session.get({ path: { id: sid } }))
      parent = info?.parentID ?? null
      if (typeof info?.title === "string" && info.title.startsWith(AGENT_TITLE_PREFIX)) signals.markInternal(sid)
    } catch {
      parent = null
    }
    if (parentCache.size > 2000) parentCache.clear()
    parentCache.set(sid, parent)
    return parent
  }

  function clearIdle(sid: string) {
    const t = idleTimers.get(sid)
    if (t) {
      clearTimeout(t)
      idleTimers.delete(sid)
    }
  }

  async function onIdle(sid: string) {
    const parent = await parentOf(sid)
    if (parent) {
      if (options.reviewSubagents) queue.enqueue(sid, "subagent")
      return
    }
    const st = ctx.sessions.peek(sid)
    if (!st) return
    if (st.rememberRequested) {
      clearIdle(sid)
      queue.enqueue(sid, "remember", true)
      return
    }
    if (st.thresholdReached) {
      clearIdle(sid)
      queue.enqueue(sid, "threshold")
      return
    }
    if (options.idleReview && st.userMsgsSinceReview >= options.idleMinNewMessages) {
      clearIdle(sid)
      const t = setTimeout(() => {
        idleTimers.delete(sid)
        const cur = ctx.sessions.peek(sid)
        if (cur && cur.userMsgsSinceReview >= options.idleMinNewMessages) queue.enqueue(sid, "idle")
      }, options.idleDelayMin * 60_000)
      ;(t as any).unref?.()
      idleTimers.set(sid, t)
    }
  }

  async function migrateStore(): Promise<void> {
    if (store.storeVersion() >= STORE_VERSION) return
    const run = ctx.runs.create({
      smith: "skillsmith",
      actor: "command",
      trigger: "startup",
      writeMode: "auto",
      directory,
      project: ctx.project,
      limits: { maxNew: 0, maxChanges: 10_000, maxNotes: 0 },
    })
    run.subject = `skillsmith(command): migrate store to v${STORE_VERSION}`
    try {
      const moved = await store.migrate(run)
      run.actions.push({ kind: "migrate", target: "skill", name: `store-v${STORE_VERSION}`, detail: `${moved} file(s) moved`, applied: true })
      run.summary = `store layout v${STORE_VERSION} (knowledge, glossary, errors, scripts)`
      const fin = await finalizeRun(ctx, run, { ok: true })
      log.info(`store migrated to v${STORE_VERSION}`, { moved, commit: fin.commit })
    } catch (err) {
      await finalizeRun(ctx, run, { ok: false, error: errorMessage(err) })
      log.error("store migration failed", errorMessage(err))
    }
  }

  // --- startup tasks ------------------------------------------------------------
  const startup = setTimeout(() => {
    void (async () => {
      try {
        await ctx.git.init()
        await migrateStore()
        try {
          const moved = await migrateTaskColumns(ctx)
          if (moved) log.info(`${moved} task(s) moved to the 4.0 columns`)
        } catch (err) {
          log.warn("task column migration failed", errorMessage(err))
        }
        try {
          const st = startupServices(ctx)
          if (st.journal || st.baseline) log.info("audit/metrics initialised", st)
        } catch (err) {
          log.warn("audit/metrics startup failed", errorMessage(err))
        }
        // remove leftover agent sessions from crashed runs
        try {
          const sessions = unwrap<AnyRecord[]>(await client.session.list())
          for (const s of sessions ?? []) {
            if (!String(s.title ?? "").startsWith(AGENT_TITLE_PREFIX)) continue
            if (ctx.runs.isAgentSession(s.id)) continue
            if (Date.now() - (s.time?.updated ?? 0) < 30 * 60_000) continue
            await client.session.delete({ path: { id: s.id } }).catch?.(() => {})
          }
        } catch (err) {
          log.debug("session cleanup skipped", errorMessage(err))
        }
        if (options.catchUpOnStart) {
          for (const st of ctx.sessions.all()) {
            if (st.directory !== directory || st.parentID) continue
            if (Date.now() - Date.parse(st.lastActivityAt) > 7 * 86_400_000) continue
            if (st.thresholdReached || st.userMsgsSinceReview >= options.idleMinNewMessages || st.reviewProgress) queue.enqueue(st.id, "catchup")
          }
        }
        queue.start()
        // start jobs (lifecycle, doctor, embeddings, prepared proposals, clean-up) and the schedule
        if (sched?.owner) sched.scheduler.start()
        if (options.web.autostart) {
          void ctx.web
            ?.start()
            .then((info) => log.info(`web view: ${info.url.replace(/#t=.*/, "")} (link with token: /smith-web)`))
            .catch((err) => log.warn("web view not started", errorMessage(err)))
        }
        log.info(`started for ${directory}`, {
          store: store.root,
          writeMode: options.writeMode,
          smiths: SMITHS.filter((s) => options[s].enabled),
          doctor: !!ctx.doctor?.enabled,
          memoryDb: !!ctx.mem,
          git: ctx.git.available,
          toolSchemas: zod ? "zod" : "json-schema",
        })
      } catch (err) {
        log.error("startup failed", errorMessage(err))
      }
    })()
  }, 3000)
  ;(startup as any).unref?.()

  return {
    config: async (cfg: AnyRecord) => {
      try {
        embedClient.configureFromOpencode(cfg)
        if (Array.isArray(cfg.skills)) {
          log.warn("config.skills is an array (opencode v2 format) – skill directory not registered")
        } else {
          cfg.skills ??= {}
          cfg.skills.paths ??= []
          const active = store.activeDir
          extraSkillPaths = (cfg.skills.paths as string[]).filter((p) => resolve(expandHome(p)) !== active)
          if (!cfg.skills.paths.some((p: string) => resolve(expandHome(p)) === active)) cfg.skills.paths.push(active)
        }
        cfg.agent ??= {}
        // agents managed in the store (5b) – the store version wins over opencode.json and agent files
        const managed = registerAgents(ctx, cfg)
        if (managed.length) log.info(`agents from the store: ${managed.join(", ")}`)
        for (const [name, agent] of Object.entries(cfg.agent as AnyRecord)) {
          if (isSmithAgent(name) || !agent || typeof agent !== "object") continue
          if (agent.permission !== undefined) agent.permission = withWriteToolsDenied(agent.permission)
        }
        for (const smith of SMITHS) {
          const model = options[smith].model ?? options.reviewerModel
          cfg.agent[reviewerAgent(smith)] = agentConfig(smith, reviewerSystemPrompt(options, smith), `${smith} background reviewer (internal)`, options, model)
          cfg.agent[curatorAgent(smith)] = agentConfig(
            smith,
            curatorSystemPrompt(options, smith),
            `${smith} background curator (internal)`,
            options,
            options[smith].model ?? options.curatorModel ?? options.reviewerModel,
          )
        }
        if (options.doctor.enabled) {
          cfg.agent[DOCTOR_AGENT] = agentConfig(
            "doctor",
            doctorSystemPrompt(options),
            "doctor: relations and conflicts between entries (internal)",
            options,
            options.doctor.model ?? options.curatorModel ?? options.reviewerModel,
          )
        }
        {
          // read-only assistant of the web view (drafts, document checks, knowledge chat)
          const permission: AnyRecord = { "*": "deny" }
          for (const t of READ_TOOLS) permission[t] = "allow"
          cfg.agent[ASSISTANT_AGENT] = {
            mode: "primary",
            hidden: true,
            description: "skillsmith assistant: drafts, document checks, knowledge chat (internal, read only)",
            prompt: assistantSystemPrompt(options),
            temperature: 0.3,
            steps: options.agentSteps,
            ...(parseModel(options.docsmith.model ?? options.reviewerModel) ? { model: options.docsmith.model ?? options.reviewerModel } : {}),
            permission,
          }
        }
        cfg.permission = withWriteToolsDenied(cfg.permission)
        cfg.command ??= {}
        for (const c of COMMANDS) {
          cfg.command[c.name] ??= { template: `${INTERNAL_PREFIX} /${c.name} $ARGUMENTS`, description: c.description }
        }
      } catch (err) {
        log.error("config hook failed", errorMessage(err))
      }
    },

    tool: tools,

    event: async ({ event }: { event: AnyRecord }) => {
      try {
        metricEvents.onEvent(event)
      } catch (err) {
        log.debug("metrics of event failed", errorMessage(err))
      }
      try {
        // agent tasks run in other instances (worktrees): every instance relays to the job owner
        relay(directory, event)
      } catch (err) {
        log.debug("agent relay failed", errorMessage(err))
      }
      try {
        const props = event?.properties ?? {}
        switch (event?.type) {
          case "session.created": {
            const info = props.info
            if (info?.id) {
              parentCache.set(info.id, info.parentID ?? null)
              if (String(info.title ?? "").startsWith(AGENT_TITLE_PREFIX)) signals.markInternal(info.id)
            }
            break
          }
          case "session.status": {
            if (props.sessionID && props.status?.type && props.status.type !== "idle") signals.busy(props.sessionID)
            break
          }
          case "session.idle": {
            const sid = props.sessionID
            if (!sid) break
            signals.idle(sid)
            if (isInternal(sid)) break
            await onIdle(sid)
            break
          }
          case "session.error": {
            const sid = props.sessionID
            if (sid) {
              const err = props.error
              signals.error(sid, errorMessage(err?.data?.message ?? err?.message ?? err ?? "error"), err?.name)
            }
            break
          }
          case "session.deleted": {
            const id = props.info?.id
            if (id && !isInternal(id)) {
              clearIdle(id)
              parentCache.delete(id)
              ctx.sessions.remove(id)
            }
            break
          }
        }
      } catch (err) {
        log.error(`event ${event?.type} failed`, errorMessage(err))
      }
    },

    "chat.message": async (inp: AnyRecord, out: AnyRecord) => {
      try {
        const sid: string = inp.sessionID
        if (!sid || isInternal(sid) || isSmithAgent(inp.agent)) return
        const text = textOfParts(out.parts)
        if (text.startsWith(INTERNAL_PREFIX)) return
        clearIdle(sid)
        userActivity().last = Date.now()
        const parent = await parentOf(sid)
        const model = inp.model?.providerID && inp.model?.modelID ? { providerID: String(inp.model.providerID), modelID: String(inp.model.modelID) } : undefined
        if (model) rememberModel(store.stateDir, model)
        ctx.sessions.update(sid, directory, (s) => {
          s.lastActivityAt = nowIso()
          s.parentID = parent
          if (inp.agent) s.agent = inp.agent
          if (model) s.model = model
          if (!parent) {
            s.userMsgsSinceReview = (s.userMsgsSinceReview ?? 0) + 1
            if (s.userMsgsSinceReview >= options.reviewThreshold) s.thresholdReached = true
            if (options.memorysmith.enabled && REMEMBER_RE.test(text)) s.rememberRequested = true
          }
        })
        metricEvents.onUserMessage(sid, inp.agent, model ? `${model.providerID}/${model.modelID}` : undefined)
        const messageID = out.message?.id ?? inp.messageID
        if (options.hints.enabled && messageID && text && (!parent || options.hints.includeSubagents)) {
          ctx.hints.start(sid, messageID, text, { topLevel: !parent })
        }
      } catch (err) {
        log.error("chat.message hook failed", errorMessage(err))
      }
    },

    "experimental.chat.messages.transform": async (_inp: AnyRecord, out: AnyRecord) => {
      try {
        if (options.hints.enabled && Array.isArray(out?.messages)) await ctx.hints.inject(out.messages)
      } catch (err) {
        log.error("messages.transform hook failed", errorMessage(err))
      }
    },

    "tool.execute.before": async (inp: AnyRecord) => {
      try {
        metricEvents.onToolBefore(inp?.callID)
      } catch (err) {
        log.debug("tool.execute.before failed", errorMessage(err))
      }
      // write guard of agent tasks (proposal and review phases, whole session tree) – throws to block
      if (inp?.sessionID && inp?.tool) {
        await checkTool(String(inp.sessionID), String(inp.tool), async (id) => {
          const info = unwrap<AnyRecord>(await client.session.get({ path: { id } }))
          return info?.parentID ?? null
        })
      }
    },

    "tool.execute.after": async (inp: AnyRecord, out: AnyRecord) => {
      try {
        const sid: string = inp.sessionID
        if (!sid || isInternal(sid)) return
        const script = metricEvents.onToolAfter(sid, String(inp.tool ?? ""), inp.callID, inp.args ?? {}, out ?? {})
        if (script) ctx.hints.onEntryUsed(sid, "script", script)
        if (inp.tool === "skill") {
          const name = typeof inp.args?.name === "string" ? inp.args.name.trim() : ""
          if (!name || !ctx.store.get("skill", name)) return
          ctx.usage.recordLoad("skill", name, { session: sid, agent: inp.agent })
          ctx.sessions.update(sid, directory, (s) => {
            const k = `skill:${name}`
            if (!s.loaded.includes(k)) s.loaded.push(k)
          })
          ctx.hints.onEntryUsed(sid, "skill", name)
          return
        }
        if (inp.tool === "task") {
          // memorysmith: the subagent's answer is kept for the next review of this session
          if (options.memorysmith.enabled && options.memorysmith.captureSubagents && ctx.mem && !(await parentOf(sid))) {
            const output = stripPluginNotes(typeof out?.output === "string" ? out.output : "").trim()
            const prompt = String(inp.args?.prompt ?? inp.args?.description ?? "")
            if (output.length >= 40) {
              let project: string | undefined
              try {
                project = ctx.scope().project
              } catch {
                project = undefined
              }
              ctx.mem.capture(sid, project, redactor.redact(truncate(prompt, 4000)), redactor.redact(truncate(output, 12_000)))
            }
          }
          if (options.reviewSubagents) {
            const child = out?.metadata?.sessionId
            if (typeof child === "string" && child) queue.enqueue(child, "subagent")
          }
          return
        }
        const known = await ctx.hints.onToolResult(sid, String(inp.tool ?? ""), inp.args ?? {}, out ?? {})
        if (known && out && typeof out.output === "string") out.output += known
      } catch (err) {
        log.error("tool.execute.after hook failed", errorMessage(err))
      }
    },

    /** compaction: keep the remembered work state in the summary and review before details get lost */
    "experimental.session.compacting": async (inp: AnyRecord, out: AnyRecord) => {
      try {
        const sid: string = inp?.sessionID
        if (!sid || isInternal(sid) || !options.memorysmith.enabled) return
        if (await parentOf(sid)) return
        const stand = ctx.hints.standBlock()
        if (stand && Array.isArray(out?.context)) out.context.push(stand)
        queue.enqueue(sid, "compaction")
      } catch (err) {
        log.error("session.compacting hook failed", errorMessage(err))
      }
    },

    "tool.definition": async (inp: AnyRecord, out: AnyRecord) => {
      if (inp?.toolID === "skill" && typeof out?.description === "string" && !out.description.includes("skill_search")) {
        out.description += SKILL_TOOL_HINT
      }
    },

    "command.execute.before": async (inp: AnyRecord, out: AnyRecord) => {
      if (!COMMAND_NAMES.has(inp?.command)) return
      let result: string
      try {
        result = await handleCommand(ctx, { queue, curator }, inp.command, inp.arguments ?? "", inp.sessionID)
      } catch (err) {
        log.error(`command ${inp.command} failed`, errorMessage(err))
        result = `Fehler: ${errorMessage(err)}`
      }
      const text = `${INTERNAL_PREFIX} Output the following text exactly as written. Do not call any tools and do not add anything:\n\n${result}`
      if (Array.isArray(out?.parts)) out.parts.splice(0, out.parts.length, { type: "text", text })
    },

    dispose: async () => {
      clearTimeout(startup)
      if (sched?.owner) {
        sched.scheduler.stop()
        releaseScheduler(ctx, sched.scheduler)
      }
      ctx.settings?.dispose()
      ctx.doctor?.cancel()
      ctx.web?.stop()
      for (const t of idleTimers.values()) clearTimeout(t)
      idleTimers.clear()
      queue.stop()
      ctx.sessions.flush()
      await ctx.usage.flush().catch(() => {})
      await ctx.occurrences.flush().catch(() => {})
      await closeServices(ctx)
      await vectorStore?.close().catch(() => {})
      mem?.close()
      delete (globalThis as any)[guardKey]
    },
  }
}
