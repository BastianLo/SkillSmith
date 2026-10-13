/**
 * Hints for the main agent:
 *  - per user message: one combined block (skills, glossary, knowledge, known
 *    errors, scripts) appended to THAT message – never to the system prompt,
 *    so the prompt-cache prefix stays stable. Hints are stored per messageID
 *    and re-injected identically on every step.
 *  - live: when a shell command fails with a known error, the documented
 *    solution is appended to the tool output (errorsmith).
 */
import type { Entry, Kind, SearchHit, Tier } from "../types"
import { key } from "../types"
import { fold, oneLine, stripCode, tokenize, truncate } from "../util/text"
import type { Ctx } from "./context"
import { str } from "./frontmatter"
import { nodeLabel, RELATION_LABEL } from "./graph"
import { isPrivate, meaningsOf, MEMORY_TYPE_LABEL, TIER_LABEL } from "./kinds"
import { formatStand, standParts } from "./memory-format"
import { semanticErrorMatch } from "./retrieval"
import { formatDate, linkSummary, meaningfulTitle, type HistoryHit } from "./session-history"
import { commandHead, errorSignature, isIgnorableFailure, looksLikeError } from "./signals"
import { HINT_PART_PREFIX, SHELL_TOOLS, stripPluginNotes, type Msg } from "./transcript"

export { TIER_LABEL }

export interface HintSet {
  skills: SearchHit[]
  glossary: Entry[]
  knowledge: SearchHit[]
  errors: SearchHit[]
  scripts: SearchHit[]
  /** code snippets of the library (5j) */
  snippets?: SearchHit[]
  /** similar earlier sessions with reusable results */
  sessions?: HistoryHit[]
  /** memorysmith: decisions, conventions, experiences and results of this project */
  memories?: Array<{ id: string; label: string; title: string; summary: string }>
  /** strong graph neighbours of the hinted entries */
  seeAlso?: Array<{ id: string; label: string; title: string; rel: string; via: string }>
}

const strong = (minScore: number) => (h: SearchHit) => h.confidence >= minScore && (h.matched.length >= 2 || (h.matched.length === 1 && h.confidence >= 0.6))

export function formatHint(set: HintSet & { project?: string }): string | undefined {
  const sections: string[] = []
  if (set.skills.length) {
    sections.push(`Skills (load with skill_read):\n${set.skills.map((h) => `- ${h.name} [${TIER_LABEL[h.tier] ?? h.tier}]: ${truncate(h.description, 160)}`).join("\n")}`)
  }
  if (set.glossary.length) {
    const lines = set.glossary.map((e) => {
      const ms = meaningsOf(e.fields.meanings)
      return `- ${String(e.fields.term)} = ${ms.map((m) => `${m.expansion}${m.context ? ` (${m.context})` : ""}${m.description ? ` – ${truncate(m.description, 120)}` : ""}`).join(" | ")}`
    })
    sections.push(`Glossar:\n${lines.join("\n")}`)
  }
  if (set.knowledge.length) {
    sections.push(`Wissen (knowledge_read):\n${set.knowledge.map((h) => `- ${h.name}: ${truncate(h.title, 80)} – ${truncate(h.description, 140)}`).join("\n")}`)
  }
  if (set.errors.length) {
    sections.push(`Bekannte Fehler (error_lookup):\n${set.errors.map((h) => `- ${h.name}: ${truncate(h.title, 100)} – ${truncate(h.description, 120)}`).join("\n")}`)
  }
  if (set.scripts.length) {
    sections.push(`Skripte (script_read):\n${set.scripts.map((h) => `- ${h.name}: ${truncate(h.description, 140)}`).join("\n")}`)
  }
  if (set.snippets?.length) {
    sections.push(`Snippets:\n${set.snippets.map((h) => `- ${h.name}: ${truncate(h.description, 120)}${h.snippet ? `\n  ${truncate(h.snippet.replace(/\s+/g, " "), 200)}` : ""}`).join("\n")}`)
  }
  if (set.memories?.length) {
    sections.push(`Erinnerungen (memory_read):\n${set.memories.map((m) => `- ${m.id} [${m.label}]: ${truncate(m.title, 100)}${m.summary && m.summary !== m.title ? ` – ${truncate(m.summary, 120)}` : ""}`).join("\n")}`)
  }
  if (set.seeAlso?.length) {
    sections.push(`Siehe auch (verknüpft):\n${set.seeAlso.map((s) => `- ${s.id} [${s.label}] „${truncate(s.title, 90)}“ – ${s.rel} ${s.via}`).join("\n")}`)
  }
  if (set.sessions?.length) {
    const lines = set.sessions.map(({ record: r }) => {
      const solved = r.problems.filter((p) => p.resolved)
      const what = (meaningfulTitle(r.title) ? r.title : undefined) || r.requests[0] || solved[0]?.error || ""
      const parts = [
        `- ${formatDate(r.at)}${r.project !== set.project ? ` (Projekt ${r.project})` : ""}: „${truncate(what, 90)}“`,
        solved.length ? ` – gelöst${solved[0].fix ? `: ${truncate(solved[0].fix, 120)}` : ""}` : "",
        r.links.length ? ` – siehe ${linkSummary(r, 3)}` : "",
      ]
      return parts.join("")
    })
    sections.push(`Ähnliche frühere Sessions (Details: history_search):\n${lines.join("\n")}`)
  }
  if (!sections.length) return undefined
  return `<smith_hints source="skillsmith">\nPossibly relevant entries for this request – use them if they help, ignore otherwise:\n${sections.join("\n")}\n</smith_hints>`
}

/** @deprecated skills only (v1 shape) */
export function selectHints(ctx: Ctx, text: string, exclude: Set<string>): SearchHit[] {
  const o = ctx.options.hints
  const query = stripCode(text).trim()
  if (query.length < 12) return []
  return ctx.index
    .search(query, { kinds: ["skill"], tiers: ["active", "dormant", "archive", "foreign"], limit: 10, exclude })
    .filter(strong(o.minScore))
    .slice(0, o.max)
}

interface PendingError {
  entry: string
  tool: string
  head: string
  at: number
}

export class HintEngine {
  private glossaryIndex?: { revision: number; at: number; map: Map<string, Entry[]> }
  private pending = new Map<string, PendingError>()
  private pendingHints = new Map<string, Promise<string | undefined>>()
  private shown = new Map<string, number>()

  constructor(private ctx: Ctx) {}

  private glossaryMap(): Map<string, Entry[]> {
    const cur = this.glossaryIndex
    if (cur && cur.revision === this.ctx.store.revision && Date.now() - cur.at < 15_000) return cur.map
    const map = new Map<string, Entry[]>()
    for (const e of this.ctx.store.list("glossary")) {
      if (e.tier !== "active" || isPrivate(e)) continue
      for (const t of [String(e.fields.term ?? ""), ...((e.fields.aliases as string[]) ?? [])]) {
        const k = fold(t).replace(/[^a-z0-9]/g, "")
        if (!k) continue
        map.set(k, [...(map.get(k) ?? []), e])
      }
    }
    this.glossaryIndex = { revision: this.ctx.store.revision, at: Date.now(), map }
    return map
  }

  /** Glossary entries for terms that occur in the text (whole tokens, case-insensitive). */
  glossaryIn(text: string, skip: Set<string>, max: number): Entry[] {
    const map = this.glossaryMap()
    if (!map.size) return []
    const out: Entry[] = []
    const seen = new Set<string>()
    for (const m of stripCode(text).matchAll(/[\p{L}\p{N}][\p{L}\p{N}&]*/gu)) {
      if (m[0].length > 14) continue
      const k = fold(m[0]).replace(/[^a-z0-9]/g, "")
      if (k.length < 2 || seen.has(k) || skip.has(k)) continue
      seen.add(k)
      const entries = map.get(k)
      if (!entries) continue
      // lowercase words only match when the glossary term itself is written in lowercase
      if (m[0] === m[0].toLowerCase() && entries.every((e) => String(e.fields.term) !== String(e.fields.term).toLowerCase())) continue
      for (const e of entries) if (!out.includes(e)) out.push(e)
      if (out.length >= max) break
    }
    return out.slice(0, max)
  }

  /** Choose hints for a message: BM25 immediately, semantic similarity when the embedding answers in time. */
  async select(sessionID: string, text: string): Promise<HintSet> {
    const o = this.ctx.options.hints
    const state = this.ctx.sessions.get(sessionID, this.ctx.directory)
    const query = stripCode(text).trim()
    const empty: HintSet = { skills: [], glossary: [], knowledge: [], errors: [], scripts: [] }
    if (!query) return empty
    const loaded = new Set(state.loaded)
    const long = query.length >= 12
    const minSim = this.ctx.options.embedding.hintMinSimilarity
    const bm25Strong = strong(o.minScore)
    const isStrong = (h: SearchHit) => bm25Strong(h) || (h.similarity ?? 0) >= minSim
    const vec = long ? await this.ctx.retriever.queryVector(query, "hint", this.ctx.options.embedding.hintWaitMs) : undefined
    const search = (kinds: Kind[], tiers: Array<Tier | "foreign">, limit: number) =>
      this.ctx.retriever.search(query, { kinds, tiers, limit, exclude: loaded, queryVector: vec, minSimilarity: minSim, purpose: "hint", ownBoost: this.ctx.options.docs.ownBoost })
    const isError = o.errors && looksLikeError(query)
    const history = this.ctx.history
    const sessionMin = this.ctx.options.embedding.sessionHintSimilarity
    const [skills, knowledge, errors, scripts, sessions, snippets] = await Promise.all([
      long ? search(["skill"], ["active", "dormant", "archive", "foreign"], 10) : Promise.resolve([]),
      o.knowledge && long ? search(["knowledge"], ["active"], 6) : Promise.resolve([]),
      isError ? search(["error"], ["active", "dormant"], 6) : Promise.resolve([]),
      o.scripts && long ? search(["script"], ["active"], 6) : Promise.resolve([]),
      o.sessions && long && history?.enabled
        ? history.search(query, { limit: 5, exclude: sessionID, queryVector: vec, usefulOnly: true, minSimilarity: sessionMin }).catch(() => [])
        : Promise.resolve([]),
      o.scripts && long ? search(["snippet"], ["active"], 4).catch(() => []) : Promise.resolve([]),
    ])
    // semantic: clearly similar; BM25 only: most query terms (≥ 3) in the record
    const similarSession = (h: HistoryHit) => (h.similarity ?? 0) >= sessionMin || (h.matched.length >= 3 && h.coverage >= 0.75)
    // quality (5c): among the strong hits, entries with a high score come first
    const boost = this.ctx.options.quality.hintBoost
    const byQuality = (all: SearchHit[]): SearchHit[] => {
      // the gym found these harmful (confirmed): not shown as hints any more
      const hits = this.ctx.gym ? all.filter((h) => !this.ctx.gym!.suppressed(`${h.kind}:${h.name}`)) : all
      if (!boost || !this.ctx.quality) return hits
      const rank = (h: SearchHit) => {
        const q = h.owned ? this.ctx.quality!.score(h.kind, h.name) : undefined
        return Math.max(h.score, 1e-6) * (1 + boost * ((q ?? 50) / 100 - 0.5))
      }
      return hits.map((h, i) => ({ h, i, r: rank(h) })).sort((a, b) => b.r - a.r || a.i - b.i).map((x) => x.h)
    }
    return {
      skills: byQuality(skills.filter(isStrong)).slice(0, o.max),
      glossary: o.glossary ? this.glossaryIn(text, new Set(state.explained ?? []), o.maxGlossary) : [],
      knowledge: byQuality(knowledge.filter(isStrong)).slice(0, 2),
      errors: byQuality(errors.filter((h) => (h.confidence >= o.minScore && h.matched.length >= 2) || (h.similarity ?? 0) >= minSim)).slice(0, 2),
      scripts: byQuality(scripts.filter(isStrong)).slice(0, 2),
      snippets: byQuality((snippets as SearchHit[]).filter(isStrong)).slice(0, 2),
      sessions: sessions.filter(similarSession).slice(0, 2),
      memories: await this.memories(query, vec, loaded, isStrong).catch(() => []),
    }
  }

  /** Durable memories of this project (and global ones) plus matching results. */
  private async memories(
    query: string,
    vec: Float32Array | undefined,
    loaded: Set<string>,
    isStrong: (h: SearchHit) => boolean,
  ): Promise<NonNullable<HintSet["memories"]>> {
    const o = this.ctx.options
    if (!o.memorysmith.enabled || query.length < 12) return []
    const scope = this.ctx.scope()
    const out: NonNullable<HintSet["memories"]> = []
    const hits = await this.ctx.retriever.search(query, {
      kinds: ["memory"],
      tiers: ["active"],
      limit: 8,
      exclude: loaded,
      queryVector: vec,
      minSimilarity: o.embedding.hintMinSimilarity,
      purpose: "hint",
    })
    for (const h of hits.filter(isStrong)) {
      const e = this.ctx.store.getOwned("memory", h.name)
      if (!e) continue
      const p = str(e.fields.project)
      if (p && p !== scope.project && !o.memorysmith.crossProject) continue
      if (str(e.fields.status) === "abgeloest") continue
      out.push({ id: `memory:${e.name}`, label: MEMORY_TYPE_LABEL[str(e.fields.type)] ?? "Erinnerung", title: e.title, summary: e.description })
      if (out.length >= 2) break
    }
    // results of the last days: few, keyword overlap
    const terms = [...new Set(tokenize(query))]
    if (this.ctx.mem?.available && terms.length >= 2) {
      const best = this.ctx.mem
        .results(scope.project)
        .filter((r) => r.status === "gueltig" && !loaded.has(r.id))
        .map((r) => {
          const t = new Set(tokenize(`${r.title}\n${r.question}\n${r.tags.join(" ")}\n${r.answer}`))
          return { r, score: terms.filter((x) => t.has(x)).length / terms.length }
        })
        .filter((x) => x.score >= 0.6)
        .sort((a, b) => b.score - a.score)[0]
      if (best) out.push({ id: best.r.id, label: "Ergebnis", title: best.r.title, summary: truncate(best.r.answer.split("\n")[0] ?? "", 140) })
    }
    return out
  }

  /** Strong neighbours (≥ 0.6) of the hinted entries that are not hinted themselves. */
  seeAlso(ids: string[], skip: Set<string>, max = 3): NonNullable<HintSet["seeAlso"]> {
    const out: NonNullable<HintSet["seeAlso"]> = []
    if (!ids.length) return out
    const seen = new Set([...ids, ...skip])
    const scope = this.ctx.scope()
    for (const id of ids) {
      let edges
      try {
        edges = this.ctx.graph.edgesOf(id)
      } catch {
        return out
      }
      for (const e of edges) {
        if (e.strength < 0.6 || e.type === "contradicts") continue
        const other = e.from === id ? e.to : e.from
        if (seen.has(other) || other.startsWith("session:")) continue
        const n = this.ctx.graph.node(other)
        if (!n || n.tier === "archive" || this.ctx.graph.hidden(other)) continue
        if (n.project && n.project !== scope.project && !this.ctx.options.memorysmith.crossProject && (n.kind === "memory" || n.kind === "arbeitsstand" || n.kind === "ergebnis")) continue
        seen.add(other)
        const rel = e.from === id ? RELATION_LABEL[e.type] : `${RELATION_LABEL[e.type]} (eingehend)`
        out.push({ id: other, label: nodeLabel(n.kind, n.type), title: n.title, rel: `${rel}:`, via: id })
        if (out.length >= max) return out
      }
    }
    return out
  }

  /** chat.message: start computing the hint without blocking the message; inject() waits for it. */
  start(sessionID: string, messageID: string, text: string, opts: { topLevel?: boolean } = {}): void {
    const state = this.ctx.sessions.get(sessionID, this.ctx.directory)
    if (state.hints[messageID] || this.pendingHints.has(messageID)) return
    const started = Date.now()
    const p = this.onUserMessage(sessionID, messageID, text, opts)
      .then((hint) => {
        const n = this.ctx.sessions.peek(sessionID)?.hinted[messageID]?.length ?? 0
        this.ctx.metrics?.record({ type: "hint.compute", entry: "", session: sessionID, origin: opts.topLevel === false ? "subagent" : "main", project: this.ctx.project, value: Date.now() - started, extra: { n, shown: !!hint, semantic: this.ctx.semantic?.client.status.state === "ready" } })
        return hint
      })
      .catch((err) => {
        this.ctx.log.debug("hint failed", String(err))
        return undefined
      })
      .finally(() => this.pendingHints.delete(messageID))
    this.pendingHints.set(messageID, p)
  }

  /** The stand block for the first message of a session (work state, conventions, decisions). */
  standBlock(): string | undefined {
    const o = this.ctx.options.memorysmith
    if (!o.enabled || !o.standBlock) return undefined
    const scope = this.ctx.scope()
    const state = scope.branch ? this.ctx.mem?.state(scope.project, scope.branch) : undefined
    return formatStand(standParts(this.ctx.store.list("memory").filter((e) => !isPrivate(e)), scope, state, o.crossProject), scope, o.standMaxChars)
  }

  /** Compute and remember the hint for a new user message. */
  async onUserMessage(sessionID: string, messageID: string, text: string, opts: { topLevel?: boolean } = {}): Promise<string | undefined> {
    const state = this.ctx.sessions.get(sessionID, this.ctx.directory)
    if (state.hints[messageID]) return state.hints[messageID]
    // first message of a top-level session: what is remembered for this project/branch
    let stand: string | undefined
    if (opts.topLevel !== false && !state.standMessageID) {
      try {
        stand = this.standBlock()
      } catch (err) {
        this.ctx.log.debug("stand block failed", String(err))
      }
      this.ctx.sessions.update(sessionID, this.ctx.directory, (s) => {
        s.standMessageID = messageID
      })
    }
    const set = await this.select(sessionID, text)
    const standIds = new Set([...(stand ?? "").matchAll(/\[(memory:[^\]]+)\]/g)].map((m) => m[1]))
    if (set.memories?.length) set.memories = set.memories.filter((m) => !standIds.has(m.id))
    const keys = [
      ...set.skills.map((h) => key("skill", h.name)),
      ...set.knowledge.map((h) => key("knowledge", h.name)),
      ...set.errors.map((h) => key("error", h.name)),
      ...set.scripts.map((h) => key("script", h.name)),
      ...(set.snippets ?? []).map((h) => key("snippet", h.name)),
      ...(set.memories ?? []).map((m) => m.id),
    ]
    try {
      set.seeAlso = this.seeAlso(keys.slice(0, 6), new Set([...state.loaded, ...standIds]))
    } catch (err) {
      this.ctx.log.debug("see-also failed", String(err))
    }
    const regular = formatHint({ ...set, project: this.ctx.project })
    const hint = [stand, regular].filter(Boolean).join("\n")
    if (!hint) return undefined
    this.ctx.sessions.update(sessionID, this.ctx.directory, (s) => {
      s.hints[messageID] = hint
      s.hinted[messageID] = [...keys, ...(set.seeAlso ?? []).map((x) => x.id)]
      s.explained = [
        ...new Set([...(s.explained ?? []), ...set.glossary.flatMap((e) => [String(e.fields.term), ...((e.fields.aliases as string[]) ?? [])].map((t) => fold(t).replace(/[^a-z0-9]/g, "")))]),
      ].slice(-300)
    })
    const uc = { session: sessionID }
    for (const h of set.skills) this.ctx.usage.recordHintShown("skill", h.name, uc)
    for (const h of set.knowledge) this.ctx.usage.recordHintShown("knowledge", h.name, uc)
    for (const h of set.errors) this.ctx.usage.recordHintShown("error", h.name, uc)
    for (const h of set.scripts) this.ctx.usage.recordHintShown("script", h.name, uc)
    for (const h of set.snippets ?? []) this.ctx.usage.recordHintShown("snippet", h.name, uc)
    for (const m of set.memories ?? []) if (m.id.startsWith("memory:")) this.ctx.usage.recordHintShown("memory", m.id.slice(7), uc)
    for (const e of set.glossary) {
      this.ctx.usage.recordHintShown("glossary", e.name, uc)
      this.ctx.usage.recordLoad("glossary", e.name, uc)
    }
    this.ctx.log.debug(`hint for ${messageID}`, keys)
    return hint
  }

  /** An entry was loaded/read: count it as a followed hint when it was hinted in the last user messages. */
  onEntryUsed(sessionID: string, kind: Kind, name: string): void {
    const state = this.ctx.sessions.peek(sessionID)
    if (!state) return
    const k = key(kind, name)
    const recent = Object.entries(state.hinted).slice(-3)
    for (const [messageID, names] of recent) {
      if (!names.includes(k) && !(kind === "skill" && names.includes(name))) continue
      this.ctx.usage.recordHintFollowed(kind, name, { session: sessionID })
      this.ctx.sessions.update(sessionID, this.ctx.directory, (s) => {
        s.hinted[messageID] = (s.hinted[messageID] ?? []).filter((n) => n !== k && n !== name)
      })
      return
    }
  }

  /** @deprecated */
  onSkillLoaded(sessionID: string, skill: string): void {
    this.onEntryUsed(sessionID, "skill", skill)
  }

  /** experimental.chat.messages.transform: append stored hints to their user messages (waits for pending ones). */
  async inject(messages: Msg[]): Promise<number> {
    let injected = 0
    const waiting = messages.filter((m) => m.info.role === "user" && this.pendingHints.has(m.info.id)).map((m) => this.pendingHints.get(m.info.id)!)
    if (waiting.length) await Promise.all(waiting)
    for (const msg of messages) {
      if (msg.info.role !== "user") continue
      const sid = msg.info.sessionID
      if (!sid) continue
      const state = this.ctx.sessions.peek(sid)
      const hint = state?.hints[msg.info.id]
      if (!hint) continue
      const partId = `${HINT_PART_PREFIX}_${msg.info.id}`
      if (msg.parts.some((p) => p.id === partId)) continue
      msg.parts.push({ id: partId, sessionID: sid, messageID: msg.info.id, type: "text", text: hint, synthetic: true } as any)
      injected++
    }
    return injected
  }

  // ---------------------------------------------------------------------------
  // live known-error hints (errorsmith)
  // ---------------------------------------------------------------------------

  /** Find the error entry for a failure: exact signature, strong full-text hit, then semantic similarity. */
  async matchError(signature: string, errorText: string): Promise<Entry | undefined> {
    const errors = this.ctx.store.list("error").filter((e) => e.tier !== "archive" && !isPrivate(e))
    const exact = errors.find((e) => ((e.fields.signatures as string[]) ?? []).includes(signature))
    if (exact) return exact
    const hits = this.ctx.index.search(`${signature} ${errorText}`, { kinds: ["error"], tiers: ["active", "dormant"], limit: 3 })
    const best = hits.find((h) => h.confidence >= this.ctx.options.errorsmith.hintMinScore && h.matched.length >= 3)
    if (best) return this.ctx.store.getOwned("error", best.name)
    const sem = await semanticErrorMatch(
      { store: this.ctx.store, index: this.ctx.index, semantic: this.ctx.semantic, options: this.ctx.options },
      errorText,
      Math.min(3000, this.ctx.options.embedding.timeoutMs),
    )
    return sem ? this.ctx.store.getOwned("error", sem.name) : undefined
  }

  /**
   * tool.execute.after for shell tools: record the error occurrence and return a
   * <known_error> block to append to the output (or undefined).
   */
  async onToolResult(sessionID: string, tool: string, args: Record<string, unknown>, output: { output?: unknown; metadata?: Record<string, unknown> }): Promise<string | undefined> {
    if (!SHELL_TOOLS.has(tool)) return undefined
    const command = String(args?.command ?? "")
    const exit = typeof output?.metadata?.exit === "number" ? (output.metadata.exit as number) : undefined
    const head = commandHead(command) || tool
    // outcome of a previously shown hint
    const pend = this.pending.get(sessionID)
    if (pend && pend.head === head && Date.now() - pend.at < 30 * 60_000) {
      this.pending.delete(sessionID)
      this.ctx.usage.recordHintOutcome("error", pend.entry, exit === 0 || exit === undefined, { session: sessionID })
    }
    if (exit === undefined || exit === 0) return undefined
    const raw = stripPluginNotes(String(output?.output ?? output?.metadata?.output ?? ""))
    if (isIgnorableFailure({ tool, input: args, exit, output: raw })) return undefined
    const tail = raw
      .split("\n")
      .filter((l) => l.trim())
      .slice(-4)
      .join(" | ")
    const errText = this.ctx.redactor.redact(`exit ${exit}${tail ? `: ${oneLine(tail)}` : ""}`)
    const sig = errorSignature(tool, this.ctx.redactor.redact(truncate(oneLine(command), 300)), errText)
    const o = this.ctx.options.errorsmith
    let entry: Entry | undefined
    if (o.enabled && o.liveHints) entry = await this.matchError(sig.signature, errText)
    this.ctx.occurrences.record({
      sigKey: sig.sigKey,
      signature: sig.signature,
      tool,
      head: sig.head,
      sample: truncate(errText, 600),
      sessionID,
      project: this.ctx.project,
      entry: entry?.name,
    })
    if (!entry) return undefined
    const shownKey = `${sessionID}:${entry.name}`
    const last = this.shown.get(shownKey)
    this.pending.set(sessionID, { entry: entry.name, tool, head, at: Date.now() })
    this.ctx.usage.recordLoad("error", entry.name, { session: sessionID })
    if (last && Date.now() - last < 10 * 60_000) return undefined
    this.shown.set(shownKey, Date.now())
    if (this.shown.size > 2000) this.shown.clear()
    this.ctx.usage.recordHintShown("error", entry.name, { session: sessionID })
    const status = String(entry.fields.status) === "open" ? "open" : "solved"
    const solution = /^##\s+(lösung|loesung|solution|fix|behebung)[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/im.exec(entry.body)?.[2]?.trim()
    const cause = /^##\s+(ursache|cause|root cause)[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/im.exec(entry.body)?.[2]?.trim()
    const text =
      status === "solved"
        ? [cause ? `Ursache: ${truncate(cause, 500)}` : "", `Lösung:\n${truncate(solution ?? entry.body, 1500)}`].filter(Boolean).join("\n")
        : `Status: noch ungelöst. ${truncate(entry.body, 1200)}`
    return `\n\n<known_error source="errorsmith" name="${entry.name}" status="${status}">\nThis error is documented: ${entry.title}\n${text}\n(Full entry: error_lookup(name="${entry.name}"))\n</known_error>`
  }
}
