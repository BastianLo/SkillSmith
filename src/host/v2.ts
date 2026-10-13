/**
 * opencode 2 host adapter (plugin API "@opencode-ai/plugin" 2.x preview, `opencode2`).
 *
 * The core stays host independent: this adapter
 *   1. builds a small v1-shaped SDK facade on top of the v2 plugin context (sessions, messages,
 *      models, agents) – the core keeps calling `client.session.create/promptAsync/messages…`;
 *   2. creates the v1 hook object (`createServer`) once per location;
 *   3. translates v2 transforms, hooks and events onto those hooks:
 *
 *      v1 hook                               v2
 *      config (agents, permission, commands)  agent.transform, command.transform, skill.transform
 *      tool                                   tool.transform (JSON schema, codemode off)
 *      event                                  event.subscribe() (session.created/status/execution.*)
 *      chat.message                           session.hook("prompt")
 *      experimental.chat.messages.transform   session.hook("context")
 *      tool.execute.before / after            tool.hook("execute.before" / "execute.after")
 *      experimental.session.compacting        event session.compaction.started (review only)
 *      tool.definition (skill hint)           tool.transform → update("skill")
 *      command.execute.before                 command.transform → add(), output as synthetic message
 *
 * Message shapes: v2 messages (`type: user|assistant|synthetic`, assistant `content[]`) become v1
 * `{info, parts}`; tool names map shell → bash and subagent → task, subagent output becomes the v1
 * `<task …><task_result>` block, so transcripts, signatures and parsers stay as they are.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createServer } from "./v1"
import { COMMANDS } from "./commands"
import { INTERNAL_PREFIX } from "../core/transcript"
import { errorMessage } from "../util/text"

type AnyRecord = Record<string, any>

/** v2 tool names → the names the core knows from v1 */
const TOOL_V1: Record<string, string> = { shell: "bash", subagent: "task" }
const toolV1 = (name: string) => TOOL_V1[name] ?? name

const SKILL_TOOL_HINT =
  "\n\nIf none of the listed skills fits the task, call skill_search – it also finds dormant and archived skills (load them with skill_read). Related libraries: knowledge_search (documentation), glossary_lookup (abbreviations), error_lookup (known errors and fixes), script_search (tested Python scripts)."

const data = <T>(v: T) => ({ data: v })

function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((c: AnyRecord) => (typeof c === "string" ? c : c?.type === "text" ? String(c.text ?? "") : ""))
    .filter(Boolean)
    .join("\n")
}

/** `<subagent sessionID="…" state="completed">…</subagent>` → inner text */
function subagentInner(text: string): string {
  const m = /^<subagent\b[^>]*>\n?([\s\S]*?)\n?<\/subagent>\s*$/.exec(text.trim())
  return m ? m[1] : text
}

function v1TaskOutput(sessionID: string | undefined, state: string, inner: string): string {
  return `<task id="${sessionID ?? ""}" state="${state}">\n<task_result>${inner}</task_result>\n</task>`
}

function v1Model(m: AnyRecord | undefined): { providerID: string; modelID: string } | undefined {
  return m?.providerID && m?.id ? { providerID: String(m.providerID), modelID: String(m.id) } : undefined
}

/** one v2 tool content item of an assistant message → v1 tool part */
function toolPart(sessionID: string, messageID: string, t: AnyRecord): AnyRecord {
  const st = t.state ?? {}
  const tool = toolV1(String(t.name ?? ""))
  let output = contentText(st.content)
  const metadata: AnyRecord = { ...(st.metadata ?? {}) }
  if (t.name === "subagent") {
    const child = metadata.sessionID
    if (child) metadata.sessionId = child
    output = v1TaskOutput(child, st.status ?? "completed", subagentInner(output))
  }
  if (t.name === "shell" && typeof metadata.output !== "string") metadata.output = output
  return {
    id: `${messageID}-${t.id}`,
    sessionID,
    messageID,
    type: "tool",
    tool,
    callID: t.id,
    state: {
      status: st.status === "streaming" ? "pending" : st.status,
      input: st.input ?? {},
      ...(st.status === "completed" || st.status === "error" ? { output } : {}),
      ...(st.status === "error" ? { error: st.error?.message ?? "error" } : {}),
      metadata,
      time: { start: t.time?.created ?? 0, end: t.time?.completed ?? t.time?.ran ?? 0 },
    },
  }
}

/** v2 session messages → v1 `{info, parts}` (what transcript.ts, the reviewer and agent-runner read) */
export function toV1Messages(sessionID: string, msgs: AnyRecord[]): AnyRecord[] {
  const out: AnyRecord[] = []
  for (const m of msgs ?? []) {
    if (m.type === "user" || m.type === "synthetic") {
      out.push({
        info: { id: m.id, sessionID, role: "user", time: { created: m.time?.created ?? 0 } },
        parts: [{ id: `${m.id}-text`, sessionID, messageID: m.id, type: "text", text: String(m.text ?? ""), ...(m.type === "synthetic" ? { synthetic: true } : {}) }],
      })
    } else if (m.type === "assistant") {
      const model = v1Model(m.model)
      const parts: AnyRecord[] = []
      ;(m.content ?? []).forEach((c: AnyRecord, i: number) => {
        if (c.type === "text") parts.push({ id: `${m.id}-${i}`, sessionID, messageID: m.id, type: "text", text: String(c.text ?? "") })
        else if (c.type === "reasoning") parts.push({ id: `${m.id}-${i}`, sessionID, messageID: m.id, type: "reasoning", text: String(c.text ?? "") })
        else if (c.type === "tool") parts.push(toolPart(sessionID, m.id, c))
      })
      out.push({
        info: {
          id: m.id,
          sessionID,
          role: "assistant",
          agent: m.agent,
          mode: m.agent,
          ...(model ?? {}),
          time: { created: m.time?.created ?? 0, ...(m.time?.completed ? { completed: m.time.completed } : {}) },
          ...(m.error ? { error: { name: m.error.type, data: { message: m.error.message } } } : {}),
          ...(m.tokens ? { tokens: m.tokens } : {}),
          ...(typeof m.cost === "number" ? { cost: m.cost } : {}),
        },
        parts,
      })
    }
  }
  return out
}

function v1Session(s: AnyRecord): AnyRecord {
  return {
    id: s.id,
    ...(s.parentID ? { parentID: s.parentID } : {}),
    title: s.title ?? "",
    directory: s.location?.directory,
    projectID: s.projectID,
    time: { created: s.time?.created ?? 0, updated: s.time?.updated ?? s.time?.created ?? 0 },
  }
}

const modelString = (m: AnyRecord | undefined) => (m?.providerID && m?.id ? `${m.providerID}/${m.id}` : undefined)

/**
 * The parts of the v1 SDK client the core uses, on top of the v2 plugin context.
 * Not available in v2 plugins: listing, deleting and reverting sessions, session diffs and
 * permission replies – those calls answer empty (the core treats them as optional).
 */
export class V2Client {
  /** sessions with tools switched off for one prompt (v1 `tools` of promptAsync) */
  readonly disabledTools = new Map<string, Set<string>>()
  /** busy sessions (from the events) for `session.status()` */
  readonly busy = new Set<string>()

  constructor(
    private c: AnyRecord,
    private directory: string,
  ) {}

  private async providerList(): Promise<AnyRecord[]> {
    try {
      const r = await this.c.catalog?.provider?.list?.()
      return Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : Array.isArray(r?.providers) ? r.providers : []
    } catch {
      return []
    }
  }

  private async modelList(): Promise<AnyRecord[]> {
    try {
      const r = await this.c.catalog?.model?.list?.()
      return Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : Array.isArray(r?.models) ? r.models : []
    } catch {
      return []
    }
  }

  async defaultModel(): Promise<string | undefined> {
    try {
      const r = await this.c.catalog?.model?.default?.()
      const m = r?.data ?? r
      return modelString(m?.model ?? m) ?? (m?.providerID && m?.modelID ? `${m.providerID}/${m.modelID}` : undefined)
    } catch {
      return undefined
    }
  }

  /** v1 `config.provider` shape: the providers of opencode.json (embedding endpoint detection); `all` adds the built-in ones */
  async v1Providers(all = false): Promise<AnyRecord> {
    const out: AnyRecord = {}
    const configured = new Set<string>()
    for (const p of await this.providerList()) {
      const id = String(p.id ?? p.providerID ?? "")
      if (!id) continue
      // built-in integrations (OpenCode Zen, Copilot, …) carry an integrationID – v1 listed only the
      // providers of opencode.json, and the embedding auto-detection relies on that
      if (p.integrationID && !all) continue
      configured.add(id)
      const settings = p.settings ?? p.options ?? {}
      out[id] = { name: p.name ?? id, npm: typeof p.package === "string" ? p.package.replace(/^aisdk:/, "") : undefined, options: { ...settings }, models: {} }
    }
    for (const m of await this.modelList()) {
      const pid = String(m.providerID ?? "")
      const mid = String(m.id ?? m.modelID ?? "")
      if (!pid || !mid || !configured.has(pid)) continue
      out[pid].models[mid] = { id: mid, name: m.name ?? mid }
    }
    return out
  }

  private async agentList(): Promise<AnyRecord[]> {
    try {
      const r = await this.c.agent?.list?.()
      return Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : []
    } catch {
      return []
    }
  }

  readonly session = {
    create: async (input: AnyRecord = {}) => {
      const s = await this.c.session.create({
        ...(input.body?.title ? { title: String(input.body.title) } : {}),
        location: { directory: input.query?.directory ?? this.directory },
      })
      return data(v1Session(s))
    },
    promptAsync: async (input: AnyRecord) => {
      const sessionID = String(input.path?.id ?? "")
      const body = input.body ?? {}
      if (body.agent) await this.c.session.switchAgent({ sessionID, agent: String(body.agent) })
      if (body.model?.providerID && body.model?.modelID) await this.c.session.switchModel({ sessionID, model: { id: String(body.model.modelID), providerID: String(body.model.providerID) } })
      if (body.tools && typeof body.tools === "object") {
        const off = Object.entries(body.tools as AnyRecord)
          .filter(([, v]) => v === false)
          .map(([k]) => k)
        if (off.length) this.disabledTools.set(sessionID, new Set(off))
      }
      const text = (body.parts ?? [])
        .filter((p: AnyRecord) => p?.type === "text")
        .map((p: AnyRecord) => String(p.text ?? ""))
        .join("\n")
      await this.c.session.prompt({ sessionID, text })
      return data(undefined)
    },
    messages: async (input: AnyRecord) => {
      const sessionID = String(input.path?.id ?? "")
      const msgs = await this.c.session.context({ sessionID })
      return data(toV1Messages(sessionID, Array.isArray(msgs) ? msgs : (msgs?.data ?? [])))
    },
    get: async (input: AnyRecord) => data(v1Session(await this.c.session.get({ sessionID: String(input.path?.id ?? "") }))),
    abort: async (input: AnyRecord) => {
      await this.c.session.interrupt({ sessionID: String(input.path?.id ?? "") }).catch(() => undefined)
      return data(true)
    },
    status: async () => data(Object.fromEntries([...this.busy].map((id) => [id, { type: "busy" }]))),
    // not offered to v2 plugins
    list: async () => data([]),
    delete: async () => data(true),
    children: async () => data([]),
    revert: async () => data(true),
    diff: async () => data([]),
  }

  readonly config = {
    providers: async () => {
      // every provider with its models (built-in ones too): the core checks chosen models against it
      const prov = await this.v1Providers(true)
      return data({ providers: Object.entries(prov).map(([id, p]) => ({ id, name: p.name, models: p.models })), default: {} })
    },
    get: async () => {
      const prov = await this.v1Providers()
      const agents = await this.agentList()
      return data({
        model: await this.defaultModel(),
        provider: prov,
        agent: Object.fromEntries(agents.map((a) => [a.id, { mode: a.mode, description: a.description, ...(modelString(a.model) ? { model: modelString(a.model) } : {}) }])),
      })
    },
  }

  readonly app = {
    agents: async () => data((await this.agentList()).map((a) => ({ name: a.id, mode: a.mode, description: a.description, hidden: a.hidden, ...(v1Model(a.model) ? { model: v1Model(a.model) } : {}) }))),
    log: async () => data(true),
  }

  readonly tui = { showToast: async () => data(true) }

  async postSessionIdPermissionsPermissionId(): Promise<never> {
    throw new Error("permission replies are not available to opencode 2 plugins – answer in opencode")
  }
}

/** v1 agent config (from the config hook) → v2 Agent.Info changes */
function applyAgent(a: AnyRecord, def: AnyRecord): void {
  if (def.description !== undefined) a.description = def.description
  if (def.prompt) a.system = def.prompt
  if (def.mode) a.mode = def.mode
  if (def.hidden !== undefined) a.hidden = !!def.hidden
  if (typeof def.steps === "number") a.steps = def.steps
  if (def.color) a.color = def.color
  if (typeof def.model === "string" && def.model.includes("/")) {
    const i = def.model.indexOf("/")
    a.model = { providerID: def.model.slice(0, i), id: def.model.slice(i + 1) }
  }
  if (typeof def.temperature === "number") {
    a.request ??= { settings: {}, headers: {}, body: {} }
    a.request.settings = { ...(a.request.settings ?? {}), temperature: def.temperature }
  }
  if (def.permission && typeof def.permission === "object") a.permissions = permissionRules(def.permission)
}

/** v1 permission object (`{"*": "deny", "read": "allow"}`) → v2 rules (later rules win) */
function permissionRules(p: AnyRecord): AnyRecord[] {
  return Object.entries(p)
    .filter(([, v]) => v === "allow" || v === "deny" || v === "ask")
    .map(([action, effect]) => ({ action: toolV2Name(action), resource: "*", effect }))
}

const toolV2Name = (n: string) => (n === "bash" ? "shell" : n === "task" ? "subagent" : n)

/** The v2 plugin: `export default { id: "skillsmith", setup }` */
export async function setup(context: AnyRecord): Promise<(() => Promise<void>) | void> {
  const directory: string = context.location?.directory ?? process.cwd()
  const worktree: string = context.location?.project?.directory || directory
  const client = new V2Client(context, directory)
  // bridge: the adapter reaches parts of the core that v1 configures through its config hook
  const bridge: AnyRecord = {}
  const hooks: AnyRecord = await createServer({ client, directory, worktree, skillsmithBridge: bridge }, (context.options ?? {}) as Record<string, unknown>)
  if (!hooks || !Object.keys(hooks).length) return
  const registrations: Array<{ dispose: () => Promise<void> }> = []
  const keep = (r: unknown) => {
    if (r && typeof (r as AnyRecord).dispose === "function") registrations.push(r as { dispose: () => Promise<void> })
  }
  const warn = (msg: string, err: unknown) => {
    try {
      console.error(`[skillsmith] ${msg}: ${errorMessage(err)}`)
    } catch {
      // ignore
    }
  }

  // --- config: agents, permissions, commands, skills -------------------------------------------------
  const existing = await client.app.agents().then((r) => r.data).catch(() => [] as AnyRecord[])
  const cfg: AnyRecord = {
    agent: Object.fromEntries(existing.map((a: AnyRecord) => [a.name, { mode: a.mode, description: a.description }])),
    permission: {},
    command: {},
    skills: { paths: [] },
    provider: await client.v1Providers(),
    model: await client.defaultModel(),
  }
  const before = new Set(Object.keys(cfg.agent))
  await hooks.config?.(cfg)
  // agents defined (or changed) by skillsmith: internal smith agents, assistant, agents from the store
  const defined = Object.entries(cfg.agent as AnyRecord).filter(([name, def]) => !before.has(name) || (def && typeof def === "object" && (def.prompt || def.permission)))
  const denyRules = permissionRules(cfg.permission ?? {}).filter((r) => r.effect === "deny")
  keep(
    await context.agent.transform((ed: AnyRecord) => {
      for (const [name, def] of defined) {
        try {
          ed.update(name, (a: AnyRecord) => applyAgent(a, def as AnyRecord))
        } catch (err) {
          warn(`agent ${name}`, err)
        }
      }
      // write tools of the smiths are never offered to the user's agents
      const internal = new Set(defined.filter(([, d]) => (d as AnyRecord)?.hidden).map(([n]) => n))
      for (const a of ed.list()) {
        if (internal.has(a.id)) continue
        ed.update(a.id, (x: AnyRecord) => {
          const rules = (x.permissions ?? []).filter((r: AnyRecord) => !denyRules.some((d) => d.action === r.action))
          x.permissions = [...rules, ...denyRules]
        })
      }
    }),
  )
  const skillDirs: string[] = (cfg.skills?.paths ?? []).filter((p: unknown) => typeof p === "string")
  keep(
    await context.skill.transform((ed: AnyRecord) => {
      for (const dir of skillDirs) {
        for (const s of readSkills(dir)) {
          if (!ed.get(s.id)) ed.add(s)
        }
      }
    }),
  )
  const commandHook = hooks["command.execute.before"]
  keep(
    await context.command.transform((ed: AnyRecord) => {
      for (const c of COMMANDS) {
        ed.add({
          name: c.name,
          description: c.description,
          execute: async (inv: AnyRecord) => {
            const sessionID = String(inv.sessionID)
            const out: AnyRecord = { parts: [] }
            try {
              await commandHook?.({ command: c.name, arguments: String(inv.prompt?.text ?? ""), sessionID }, out)
            } catch (err) {
              out.parts = [{ type: "text", text: `${INTERNAL_PREFIX} x\n\nFehler: ${errorMessage(err)}` }]
            }
            const text = String(out.parts?.[0]?.text ?? "")
            if (!text) return
            if (!text.startsWith(INTERNAL_PREFIX)) {
              // /prompt: the filled prompt is the user's message
              await context.session.prompt({ sessionID, text })
              return
            }
            // like the v1 command template: the agent repeats the output (a synthetic message without
            // a turn would wait in the session's inbox until the next prompt)
            await context.session.synthetic({ sessionID, text, description: `/${c.name}` })
          },
        })
      }
    }),
  )

  // --- tools ----------------------------------------------------------------------------------------
  const tools = (hooks.tool ?? {}) as Record<string, AnyRecord>
  keep(
    await context.tool.transform((ed: AnyRecord) => {
      for (const [name, def] of Object.entries(tools)) {
        if (ed.get(name)) continue
        const args = (def.args ?? {}) as AnyRecord
        ed.add({
          name,
          description: String(def.description ?? name),
          input: { type: "object", properties: args, additionalProperties: false },
          options: { codemode: false },
          execute: async (input: AnyRecord, tc: AnyRecord) => {
            const result = await def.execute(input ?? {}, { sessionID: tc.sessionID, agent: tc.agent, messageID: tc.messageID, callID: tc.id, abort: new AbortController().signal })
            return { content: typeof result === "string" ? result : JSON.stringify(result) }
          },
        })
      }
      try {
        ed.update("skill", (t: AnyRecord) => {
          if (typeof t.description === "string" && !t.description.includes("skill_search")) t.description += SKILL_TOOL_HINT
        })
      } catch {
        // no skill tool
      }
    }),
  )

  // --- hooks ------------------------------------------------------------------------------------------
  const sessionInfo = async (sessionID: string): Promise<AnyRecord | undefined> => {
    try {
      return await context.session.get({ sessionID })
    } catch {
      return undefined
    }
  }

  keep(
    await context.session.hook("prompt", async (p: AnyRecord) => {
      try {
        const info = await sessionInfo(String(p.sessionID))
        const text = String(p.prompt?.text ?? "")
        const model = v1Model(info?.model)
        await hooks["chat.message"]?.(
          { sessionID: p.sessionID, agent: info?.agent, messageID: p.messageID, ...(model ? { model } : {}) },
          { message: { id: p.messageID }, parts: [{ type: "text", text }] },
        )
      } catch (err) {
        warn("prompt hook", err)
      }
    }),
  )

  keep(
    await context.session.hook("context", async (c: AnyRecord) => {
      try {
        const users = (c.messages ?? []).filter((m: AnyRecord) => m?.role === "user" && m.id)
        if (!users.length) return
        const v1 = users.map((m: AnyRecord) => ({ info: { id: m.id, role: "user", sessionID: c.sessionID }, parts: [] as AnyRecord[] }))
        await hooks["experimental.chat.messages.transform"]?.({}, { messages: v1 })
        v1.forEach((vm: AnyRecord, i: number) => {
          const add = vm.parts.filter((p: AnyRecord) => p.type === "text" && typeof p.text === "string").map((p: AnyRecord) => ({ type: "text", text: p.text }))
          if (!add.length) return
          const m = users[i]
          if (typeof m.content === "string") m.content = [{ type: "text", text: m.content }, ...add]
          else if (Array.isArray(m.content)) m.content.push(...add)
        })
      } catch (err) {
        warn("context hook", err)
      }
    }),
  )

  keep(
    await context.tool.hook("execute.before", async (x: AnyRecord) => {
      const off = client.disabledTools.get(String(x.sessionID))
      if (off && (off.has(x.tool) || off.has(toolV1(String(x.tool))) || [...off].some((p) => p.endsWith("*") && String(x.tool).startsWith(p.slice(0, -1))))) {
        throw new Error(`tool ${x.tool} is not available in this session`)
      }
      // the agent-task write guard throws to block
      await hooks["tool.execute.before"]?.({ tool: toolV1(String(x.tool)), sessionID: x.sessionID, callID: x.id, args: x.input ?? {} })
    }),
  )

  keep(
    await context.tool.hook("execute.after", async (x: AnyRecord) => {
      try {
        if (x.status !== "completed") return
        const result = (x.result ?? {}) as AnyRecord
        const metadata: AnyRecord = { ...(result.metadata ?? {}) }
        let output = contentText(result.content)
        if (x.tool === "subagent") {
          const child = metadata.sessionID ?? result.output?.sessionID
          if (child) metadata.sessionId = child
          output = v1TaskOutput(child, "completed", subagentInner(output))
        }
        const out: AnyRecord = { title: "", output, metadata }
        const before = out.output
        await hooks["tool.execute.after"]?.({ tool: toolV1(String(x.tool)), sessionID: x.sessionID, callID: x.id, agent: x.agent, args: x.input ?? {} }, out)
        if (typeof out.output === "string" && out.output !== before && out.output.startsWith(before)) {
          const extra = out.output.slice(before.length)
          const content = Array.isArray(result.content) ? [...result.content] : result.content ? [{ type: "text", text: String(result.content) }] : []
          x.result = { ...result, content: [...content, { type: "text", text: extra }] }
        }
      } catch (err) {
        warn("tool.execute.after hook", err)
      }
    }),
  )

  // --- events -----------------------------------------------------------------------------------------
  let stopped = false
  const emit = (event: AnyRecord) => hooks.event?.({ event })
  const loop = (async () => {
    while (!stopped) {
      try {
        for await (const ev of context.event.subscribe()) {
          if (stopped) break
          const d = (ev?.data ?? {}) as AnyRecord
          const sid = d.sessionID
          switch (ev?.type) {
            case "session.created":
              await emit({ type: "session.created", properties: { info: { id: sid, parentID: d.parentID, title: d.title ?? "" } } })
              break
            case "session.execution.started":
              client.busy.add(sid)
              await emit({ type: "session.status", properties: { sessionID: sid, status: { type: "busy" } } })
              break
            case "session.execution.failed":
              client.busy.delete(sid)
              await emit({ type: "session.error", properties: { sessionID: sid, error: { name: d.error?.type ?? "Error", data: { message: d.error?.message ?? "error" } } } })
              await emit({ type: "session.idle", properties: { sessionID: sid } })
              break
            case "session.execution.succeeded":
            case "session.execution.interrupted":
              client.busy.delete(sid)
              client.disabledTools.delete(sid)
              await emit({ type: "session.idle", properties: { sessionID: sid } })
              break
            case "session.deleted":
              client.busy.delete(sid)
              await emit({ type: "session.deleted", properties: { info: { id: sid } } })
              break
            case "catalog.updated":
            case "config.updated":
              // the providers of opencode.json arrive after setup: embedding endpoint detection again
              bridge.configureProviders?.({ provider: await client.v1Providers() })
              break
            case "session.compaction.started":
              await hooks["experimental.session.compacting"]?.({ sessionID: sid }, { context: [] })
              break
          }
        }
      } catch (err) {
        if (!stopped) warn("event stream", err)
      }
      if (!stopped) await new Promise((r) => setTimeout(r, 2000))
    }
  })()
  void loop
  // the catalog may already be complete when the stream starts
  setTimeout(() => void client.v1Providers().then((provider) => bridge.configureProviders?.({ provider })), 5000).unref?.()

  return async () => {
    stopped = true
    for (const r of registrations) await r.dispose().catch(() => undefined)
    await hooks.dispose?.()
  }
}

/** SKILL.md files below a directory → v2 Skill.Info */
function readSkills(dir: string): AnyRecord[] {
  const out: AnyRecord[] = []
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const file = join(dir, name, "SKILL.md")
    if (!existsSync(file)) continue
    try {
      const raw = readFileSync(file, "utf8")
      const fm = /^---\n([\s\S]*?)\n---\n?/.exec(raw)
      const field = (k: string) => {
        const m = fm ? new RegExp(`^${k}:\\s*(.*)$`, "m").exec(fm[1]) : null
        if (!m) return ""
        const v = m[1].trim()
        try {
          return v.startsWith('"') ? JSON.parse(v) : v
        } catch {
          return v
        }
      }
      out.push({ id: field("name") || name, name: field("name") || name, description: field("description") || name, location: file, content: fm ? raw.slice(fm[0].length) : raw })
    } catch {
      // unreadable skill
    }
  }
  return out
}
