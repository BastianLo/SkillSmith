/**
 * Process-global hub for agent tasks. Agent sessions run in other opencode instances
 * (the worktree or home_path of a project), so every skillsmith instance in this process
 * relays its events here and enforces the write guard for every session it sees:
 *
 *  - guard: session id → job; in the proposal and review phases write tools (and bash
 *    unless tasks.planAllowBash) are rejected for the whole session tree, subagents included;
 *  - parents: child session → parent (from session.created), so a subagent started by a
 *    guarded session is guarded before its first tool call;
 *  - events: every event of a guarded session goes to the instance that owns the job.
 */
type AnyRecord = Record<string, any>

export interface GuardInfo {
  job: string
  /** writes allowed? (implementing / fixing phases) */
  write: boolean
  allowBash: boolean
  writeTools: string[]
  /** the instance that owns the job (events, rejections) */
  owner: string
}

export interface HubListener {
  owner: string
  onEvent(directory: string, event: AnyRecord, job: string): void
  onRejected(sessionID: string, tool: string, job: string, message: string): void
}

interface Hub {
  guards: Map<string, GuardInfo>
  /** session → root session of a guarded tree */
  roots: Map<string, string>
  parents: Map<string, string>
  listeners: Map<string, HubListener>
}

export function agentHub(): Hub {
  const key = Symbol.for("skillsmith.agentHub")
  return ((globalThis as any)[key] ??= { guards: new Map(), roots: new Map(), parents: new Map(), listeners: new Map() })
}

export function guardSession(root: string, info: GuardInfo): void {
  const h = agentHub()
  h.guards.set(root, info)
  h.roots.set(root, root)
}

export function unguardJob(job: string): void {
  const h = agentHub()
  for (const [root, g] of h.guards) if (g.job === job) h.guards.delete(root)
  for (const [s, root] of h.roots) if (!h.guards.has(root)) h.roots.delete(s)
}

export function setWrite(job: string, write: boolean): void {
  for (const g of agentHub().guards.values()) if (g.job === job) g.write = write
}

/** Root session of a guarded tree (walks the known parents). */
export function rootOf(session: string): string | undefined {
  const h = agentHub()
  const known = h.roots.get(session)
  if (known) return known
  let cur: string | undefined = session
  const seen = new Set<string>()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    if (h.guards.has(cur)) {
      h.roots.set(session, cur)
      return cur
    }
    cur = h.parents.get(cur)
  }
  return undefined
}

export function guardOf(session: string): GuardInfo | undefined {
  const root = rootOf(session)
  return root ? agentHub().guards.get(root) : undefined
}

export function noteParent(child: string, parent: string | null | undefined): void {
  if (!parent) return
  const h = agentHub()
  h.parents.set(child, parent)
  if (h.parents.size > 20_000) h.parents.delete(h.parents.keys().next().value as string)
  const root = rootOf(parent)
  if (root) h.roots.set(child, root)
}

/** Every instance relays its events (session events of guarded trees reach the job owner). */
export function relay(directory: string, event: AnyRecord): void {
  const h = agentHub()
  const p = event?.properties ?? {}
  if (event?.type === "session.created" || event?.type === "session.updated") noteParent(p.info?.id, p.info?.parentID)
  const sid: string | undefined = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID ?? (event?.type?.startsWith("session.") ? p.info?.id : undefined)
  if (!sid) return
  const g = guardOf(sid)
  if (!g) return
  h.listeners.get(g.owner)?.onEvent(directory, event, g.job)
}

/**
 * tool.execute.before of any instance: throws when a guarded session tries to write.
 * `lookupParent` resolves unknown sessions (subagents created before we saw the event).
 */
export async function checkTool(sessionID: string, tool: string, lookupParent: (id: string) => Promise<string | null | undefined>): Promise<void> {
  const h = agentHub()
  if (!h.guards.size) return
  let g = guardOf(sessionID)
  if (!g && !h.roots.has(sessionID)) {
    // unknown session: walk up the parents once (cached)
    let cur = sessionID
    for (let i = 0; i < 8 && !g; i++) {
      const parent = h.parents.get(cur) ?? (await lookupParent(cur).catch(() => undefined))
      if (!parent) break
      noteParent(cur, parent)
      cur = parent
      g = guardOf(cur)
    }
  }
  if (!g || g.write) return
  const t = tool.toLowerCase()
  const writes = g.writeTools.some((w) => t === w.toLowerCase() || t.endsWith(`_${w.toLowerCase()}`))
  const bash = (t === "bash" || t === "shell") && !g.allowBash
  if (!writes && !bash) return
  const message = `skillsmith: ${bash ? "bash" : `„${tool}“`} ist in dieser Phase gesperrt (Vorschlag/Review: nur lesen und planen; Code ändern erst nach der Freigabe).`
  try {
    h.listeners.get(g.owner)?.onRejected(sessionID, tool, g.job, message)
  } catch {
    // ignore
  }
  throw new Error(message)
}
