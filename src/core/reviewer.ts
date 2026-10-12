/**
 * One review job: fetch transcript → extract signals → route to the smiths →
 * run their background agents in parallel (each its own run and commit) →
 * feedback statistics.
 */
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { parseModel } from "../config"
import { refOf, specOf } from "./models"
import type { Candidate, Entry, ErrorChain, Kind, ReviewJob, Run, SearchHit, Smith } from "../types"
import { CONTENT_KINDS } from "../types"
import { ensureDir, isLocked, sleep } from "../util/fs"
import { errorMessage, nowIso, oneLine, tokenize, truncate } from "../util/text"
import { agentSemaphore, runAgentSession, unwrap, type ModelRef } from "./agent-runner"
import type { Ctx } from "./context"
import { safeDocsRoot } from "./project-docs"
import type { HistoryLink } from "./session-history"
import { describeActions, finalizeRun } from "./finalize"
import { glossarySlug, isPrivate, spec } from "./kinds"
import type { Capture } from "./memory-db"
import type { Scope } from "./scope"
import { formatMemoryList, formatState } from "./memory-format"
import {
  buildDocJob,
  buildErrorJob,
  buildMemoryJob,
  buildSkillJob,
  buildToolJob,
  isSmithAgent,
  reviewerAgent,
  SMITHS,
  type SessionInfo,
} from "./prompts"
import { cleanupDrafts, pythonEnv } from "./pyworkshop"
import {
  automationSignals,
  codeChanges,
  commandHead,
  detectAbbreviations,
  errorSignature,
  extractChains,
  looksLikeError,
  scanRepoDocs,
  type AbbrevFinding,
  type AutomationSignals,
  type CodeChanges,
} from "./signals"
import { lastModel } from "./state"
import { buildTranscript, sessionModel, SHELL_TOOLS, sliceUnreviewed, type Msg, type TranscriptResult } from "./transcript"

export const AGENT_TITLE_PREFIX = "skillsmith ·"
/** @deprecated v1 names */
export const REVIEWER_AGENT = "skillsmith-reviewer"
export const CURATOR_AGENT = "skillsmith-curator"

export type ReviewOutcome = "done" | "skipped" | "failed" | "gone" | "config-error"

export interface ReviewResult {
  outcome: ReviewOutcome
  error?: string
}

/** Messages up to (and including) the last completed assistant message. */
export function completedPrefix(messages: Msg[]): Msg[] {
  let end = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.info.role === "assistant" && m.info.time?.completed) {
      end = i
      break
    }
  }
  return end < 0 ? [] : messages.slice(0, end + 1)
}

export async function waitForCurator(ctx: Ctx, maxMs = 30 * 60_000): Promise<void> {
  const started = Date.now()
  while (isLocked(ctx.store.locksDir, "curator", 2 * ctx.options.reviewTimeoutMin * 60_000)) {
    if (Date.now() - started > maxMs) break
    await sleep(3000)
  }
}

/** Model for a background agent: smith option → reviewerModel/curatorModel → reviewed session → last seen model. */
export function resolveModel(ctx: Ctx, smith: Smith, role: "reviewer" | "curator", messages?: Msg[]): ModelRef | undefined {
  const o = ctx.options
  const option = o[smith].model ?? (role === "curator" ? (o.curatorModel ?? o.reviewerModel) : o.reviewerModel)
  // a name without provider ("Hermes") is kept – runAgentSession repairs it against the offered models
  const explicit = parseModel(option) ?? (specOf(option) ? refOf(specOf(option)!) : undefined)
  if (explicit) return explicit
  return (messages ? sessionModel(messages) : undefined) ?? lastModel(ctx.store.stateDir)
}

/** Name of a store script a shell command runs (absolute store path or module file name). */
export function scriptOfCommand(ctx: Ctx, command: string): string | undefined {
  const root = ctx.store.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const m = new RegExp(`${root}/scripts/(?:active|dormant|archive)/([a-z0-9-]+)/`).exec(command)
  if (m) return m[1]
  if (!/\bpython[0-9.]*\b/.test(command)) return undefined
  for (const s of aiList(ctx, "script")) {
    const module = String(s.fields.entry || `${s.name.replace(/-/g, "_")}.py`)
    if (new RegExp(`(^|[\\s/])${module.replace(/\./g, "\\.")}(\\s|$)`).test(command)) return s.name
  }
  return undefined
}

export interface Prep {
  transcript: TranscriptResult
  chains: ErrorChain[]
  hinted: Array<{ entry: string; label: string; helped?: boolean }>
  automation: AutomationSignals
  abbreviations: AbbrevFinding[]
  changes: CodeChanges
  docs: Array<{ file: string; line: number; text: string }>
  haystack: string
  userText: string
  /** reviewed session is a subagent session */
  isChild: boolean
  /** memorysmith: unconsumed results of finished subagents of this session */
  captures: Capture[]
  /** memorysmith: project / branch / ticket */
  scope: Scope
  /** /remember texts of the user (count as user words) */
  rememberNotes: string[]
}

/** Deterministic signal extraction for all smiths (no LLM). */
export async function prepare(ctx: Ctx, transcript: TranscriptResult, sessionID: string, opts: { isChild?: boolean; rememberNotes?: string[] } = {}): Promise<Prep> {
  const o = ctx.options
  const redact = (s: string) => ctx.redactor.redact(s)
  const chains = extractChains(transcript.calls, transcript.userTexts, (k) => ctx.occurrences.sessionsFor(k)).slice(0, 12)
  // errors pasted by the user (stack traces etc.) become chains too
  transcript.userTexts.forEach((text, i) => {
    if (chains.length >= 12 || !looksLikeError(text)) return
    const sig = errorSignature("user", "", text)
    if (chains.some((c) => c.sigKey === sig.sigKey)) return
    ctx.occurrences.record({ sigKey: sig.sigKey, signature: sig.signature, tool: "user", head: "", sample: redact(truncate(text, 600)), sessionID, project: ctx.project })
    chains.push({
      id: `P${i + 1}`,
      tool: "user",
      head: "",
      command: "(pasted by the user)",
      error: redact(truncate(oneLine(text), 600)),
      signature: sig.signature,
      sigKey: sig.sigKey,
      attempts: [],
      resolved: false,
      label: `U${i + 1}`,
      sessions: Math.max(1, ctx.occurrences.sessionsFor(sig.sigKey)),
    })
  })
  // shell errors are recorded live (tool.execute.after); record the others here
  for (const c of chains) {
    if (c.tool === "user" || SHELL_TOOLS.has(c.tool)) continue
    ctx.occurrences.record({ sigKey: c.sigKey, signature: c.signature, tool: c.tool, head: c.head, sample: c.error, sessionID, project: ctx.project })
  }
  const hinted: Prep["hinted"] = []
  transcript.calls.forEach((c, i) => {
    if (!c.hinted) return
    const head = SHELL_TOOLS.has(c.tool) ? commandHead(String(c.input?.command ?? "")) : c.tool
    const next = transcript.calls
      .slice(i + 1)
      .find((n) => n.turn === c.turn && n.tool === c.tool && (SHELL_TOOLS.has(n.tool) ? commandHead(String(n.input?.command ?? "")) : n.tool) === head)
    hinted.push({ entry: c.hinted, label: c.label, helped: next ? next.ok : undefined })
  })
  const automation = automationSignals(transcript.calls, transcript.userText)
  const abbreviations = o.docsmith.enabled && o.docsmith.detectAbbreviations
    ? detectAbbreviations({
        userTexts: transcript.userTexts,
        assistantText: transcript.assistantText,
        isKnown: (t) => ctx.store.glossaryByTerm(t).length > 0,
        ignore: [...o.docsmith.ignoreAbbreviations, ...ctx.store.ignoredTerms()],
        redact,
      })
    : []
  const changes = codeChanges(transcript.calls, redact, o.docsmith.changesMaxChars)
  const docsRoot = safeDocsRoot(ctx.directory, ctx.worktree)
  const docs = o.docsmith.enabled && o.docsmith.repoDocs && docsRoot
    ? scanRepoDocs(docsRoot, changes.identifiers, o.docsmith.repoDocsMaxChars).map((d) => ({ ...d, text: redact(d.text) }))
    : []
  // project docs RAG: sections related to the changes (or to the session) by meaning and keywords
  if (o.docsmith.enabled && o.docsmith.repoDocs && ctx.projectDocs?.enabled && (changes.text || transcript.userMessages > 0)) {
    try {
      const query = changes.text ? `${changes.identifiers.join(" ")}\n${truncate(changes.text, 4000)}` : transcript.searchText
      const hits = await ctx.projectDocs.search(query, { limit: 6, purpose: "context", minCoverage: 0.5, minSimilarity: o.embedding.hintMinSimilarity })
      let used = docs.reduce((n, d) => n + d.text.length, 0)
      for (const h of hits) {
        if (docs.some((d) => d.file === h.file && Math.abs(d.line - h.line) <= 3)) continue
        const text = `${h.heading ? `› ${h.heading}\n` : ""}${truncate(h.text, 1200)}`
        if (used + text.length > o.docsmith.repoDocsMaxChars) break
        docs.push({ file: h.file, line: h.line, text })
        used += text.length
      }
    } catch (err) {
      ctx.log.debug("project docs search failed", errorMessage(err))
    }
  }
  const isChild = !!opts.isChild
  const captures = !isChild && o.memorysmith.enabled ? (ctx.mem?.captures(sessionID) ?? []).slice(-8) : []
  const rememberNotes = (opts.rememberNotes ?? []).map(redact)
  let scope: Scope
  try {
    scope = ctx.scope()
  } catch {
    scope = { project: `path:${ctx.worktree}`, projectName: ctx.project, projectSlug: ctx.project }
  }
  const haystack = [transcript.haystack, ...docs.map((d) => d.text), changes.text, ...captures.map((c) => `${c.prompt}\n${c.output}`)].join("\n")
  const userText = [redact(transcript.userText), ...rememberNotes].filter(Boolean).join("\n")
  return { transcript, chains, hinted, automation, abbreviations, changes, docs, haystack, userText, isChild, captures, scope, rememberNotes }
}

export function route(ctx: Ctx, prep: Prep): Smith[] {
  const o = ctx.options
  const t = prep.transcript
  const out: Smith[] = []
  if (o.skillsmith.enabled && (t.userMessages >= 1 || t.toolCalls >= 1)) out.push("skillsmith")
  if (o.docsmith.enabled && (t.userMessages >= 1 || prep.changes.files.length > 0)) out.push("docsmith")
  if (o.errorsmith.enabled && (prep.chains.length > 0 || prep.hinted.length > 0)) out.push("errorsmith")
  const scriptUses = t.uses.some((u) => u.kind === "script")
  if (o.toolsmith.enabled && (prep.automation.score >= o.toolsmith.minSignalScore || prep.automation.userRequested || scriptUses)) out.push("toolsmith")
  // memories come from the user's own sessions (subagent results arrive as captures of the parent)
  if (o.memorysmith.enabled && !prep.isChild && (t.userMessages >= 1 || prep.captures.length > 0 || prep.rememberNotes.length > 0)) out.push("memorysmith")
  return out
}

/** Open candidates of a kind, most relevant to the transcript first (semantic similarity when available). */
export async function relevantCandidates(ctx: Ctx, kind: Kind, searchText: string, n = 8): Promise<Candidate[]> {
  const terms = new Set(tokenize(searchText))
  const sem = await ctx.retriever.candidateRanking(kind, searchText).catch(() => undefined)
  return ctx.store
    .candidates(kind)
    .filter((c) => !c.promotedTo)
    .map((c) => {
      const ct = new Set([...tokenize(c.summary), ...c.keywords.flatMap((k) => tokenize(k))])
      let overlap = 0
      for (const t of ct) if (terms.has(t)) overlap++
      return { c, overlap: sem ? (sem.get(c.id) ?? 0) * 100 + overlap / 100 : overlap }
    })
    .sort((a, b) => b.overlap - a.overlap || b.c.updatedAt.localeCompare(a.c.updatedAt))
    .slice(0, n)
    .map((x) => x.c)
}

export interface SmithResult {
  smith: Smith
  ok: boolean
  error?: string
  configError?: boolean
  actions: number
  summary: string
  commit?: string
  outdatedDocs?: string[]
  /** entries created/changed by this run (session history) */
  links?: HistoryLink[]
}

interface SmithInput {
  job: ReviewJob
  info: { id: string; parentID?: string }
  prep: Prep
  sessionAgent?: string
  model?: ModelRef
}

const ALL_TIERS = ["active", "dormant", "archive", "foreign"] as const

function limitsFor(ctx: Ctx, smith: Smith): Run["limits"] {
  const o = ctx.options
  switch (smith) {
    case "skillsmith":
      return { maxNew: o.maxNewSkillsPerReview, maxChanges: o.maxChangesPerReview, maxNotes: 5 }
    case "docsmith":
      return { maxNew: Math.max(1, Math.ceil(o.docsmith.maxChangesPerReview / 2)), maxChanges: o.docsmith.maxChangesPerReview, maxNotes: 5 }
    case "errorsmith":
      return { maxNew: Math.max(1, Math.ceil(o.errorsmith.maxChangesPerReview / 2)), maxChanges: o.errorsmith.maxChangesPerReview, maxNotes: 5 }
    case "toolsmith":
      return { maxNew: 1, maxChanges: 3, maxNotes: 5 }
    case "memorysmith":
      return { maxNew: o.memorysmith.maxChangesPerReview, maxChanges: o.memorysmith.maxChangesPerReview, maxNotes: 0 }
    case "doctor":
      return { maxNew: 0, maxChanges: o.doctor.maxPairsPerRun * 4, maxNotes: 0 }
  }
}

async function buildPrompt(ctx: Ctx, smith: Smith, run: Run, input: SmithInput, session: SessionInfo): Promise<string> {
  const { prep } = input
  const t = prep.transcript
  const o = ctx.options
  const getOwnedOr = (kind: Kind) => (n: string) => ctx.store.get(kind, n)
  switch (smith) {
    case "skillsmith": {
      const loadedNames = [...new Set(t.uses.filter((u) => u.kind === "skill").map((l) => l.name))]
      return buildSkillJob({
        runId: run.id,
        options: o,
        session,
        transcript: t,
        loaded: loadedNames.map((n) => ctx.store.get("skill", n)).filter((r): r is Entry => !!r),
        relevant: await ctx.retriever.search(t.searchText, { kinds: ["skill"], tiers: [...ALL_TIERS], limit: 8, purpose: "context" }),
        catalog: aiList(ctx, "skill"),
        candidates: await relevantCandidates(ctx, "skill", t.searchText),
        usage: ctx.usage.ofKind("skill"),
        limits: run.limits,
        get: getOwnedOr("skill"),
      })
    }
    case "docsmith": {
      const changedRelevant = prep.changes.identifiers.length
        ? await ctx.retriever.search(`${prep.changes.identifiers.join(" ")}\n${truncate(prep.changes.text, 3000)}`, { kinds: ["knowledge"], tiers: ["active", "archive"], limit: 6, purpose: "context" })
        : []
      return buildDocJob({
        runId: run.id,
        options: o,
        session,
        transcript: t,
        relevant: await ctx.retriever.search(t.searchText, { kinds: ["knowledge"], tiers: ["active", "archive"], limit: 8, purpose: "context" }),
        changedRelevant,
        catalogSize: aiList(ctx, "knowledge").length,
        abbreviations: prep.abbreviations,
        glossaryOf: (term) => ctx.store.glossaryByTerm(term),
        changes: prep.changes,
        docs: prep.docs,
        candidates: await relevantCandidates(ctx, "knowledge", t.searchText),
        limits: run.limits,
        used: t.uses.filter((u) => u.kind === "knowledge"),
        get: getOwnedOr("knowledge"),
      })
    }
    case "errorsmith": {
      const matches = new Map<string, SearchHit[]>()
      const errors = aiList(ctx, "error")
      for (const c of prep.chains) {
        const exact = errors.filter((e) => ((e.fields.signatures as string[]) ?? []).includes(c.signature))
        const hits = await ctx.retriever.search(`${c.signature} ${c.error}`, { kinds: ["error"], tiers: ["active", "dormant", "archive"], limit: 3, purpose: "error" })
        const merged: SearchHit[] = [
          ...exact.map((e) => ({
            kind: "error" as Kind,
            name: e.name,
            title: e.title,
            tier: e.tier,
            owned: true,
            description: e.description,
            tags: e.tags,
            score: 99,
            confidence: 1,
            similarity: undefined,
            matched: [],
            snippet: "exact signature match",
            file: e.file,
          })),
          ...hits.filter((h) => !exact.some((e) => e.name === h.name)),
        ]
        matches.set(c.id, merged.slice(0, 3))
      }
      return buildErrorJob({
        runId: run.id,
        options: o,
        session,
        transcript: t,
        chains: prep.chains,
        matches,
        hinted: prep.hinted,
        candidates: await relevantCandidates(ctx, "error", t.searchText),
        limits: run.limits,
      })
    }
    case "toolsmith": {
      const env = await pythonEnv(o, ctx.store.stateDir)
      return buildToolJob({
        runId: run.id,
        options: o,
        session,
        transcript: t,
        automation: prep.automation,
        relevant: await ctx.retriever.search(`${prep.automation.items.join(" ")} ${t.searchText}`, { kinds: ["script"], tiers: ["active", "dormant", "archive"], limit: 6, purpose: "context" }),
        candidates: await relevantCandidates(ctx, "script", `${prep.automation.items.join(" ")} ${t.searchText}`),
        used: t.uses.filter((u) => u.kind === "script"),
        get: getOwnedOr("script"),
        env,
        limits: run.limits,
      })
    }
    case "memorysmith": {
      const scope = prep.scope
      const state = scope.branch ? ctx.mem?.state(scope.project, scope.branch) : undefined
      const hits = await ctx.retriever.search(t.searchText, { kinds: ["memory"], tiers: ["active", "archive"], limit: 20, purpose: "context" })
      const inScope = (e: Entry) => {
        const p = String(e.fields.project ?? "")
        return !p || p === scope.project
      }
      const relevant = hits.map((h) => ctx.store.getOwned("memory", h.name)).filter((e): e is Entry => !!e && inScope(e))
      // conventions and valid decisions of the project always (they are few)
      const standing = ctx.store
        .list("memory")
        .filter((e) => e.tier === "active" && inScope(e) && (String(e.fields.type) === "vorgabe" || String(e.fields.type) === "entscheidung"))
      const memories = [...new Map([...relevant.slice(0, 12), ...standing.slice(0, 20)].map((e) => [e.name, e])).values()]
      run.captureIds = prep.captures.map((c) => c.id)
      return buildMemoryJob({
        runId: run.id,
        options: o,
        session,
        transcript: t,
        scope,
        state: state ? formatState(state) : undefined,
        memories: formatMemoryList(memories, { withBody: true }),
        captures: prep.captures,
        rememberNotes: prep.rememberNotes,
        chains: prep.chains,
        changes: prep.changes,
        limits: run.limits,
      })
    }
    case "doctor":
      throw new Error("the doctor is not a reviewer")
  }
}

/** docsmith: unknown abbreviations become open glossary candidates (deterministic, before the agent runs). */
async function noteAbbreviations(ctx: Ctx, run: Run, prep: Prep): Promise<void> {
  for (const a of prep.abbreviations) {
    const known = ctx.store.glossaryByTerm(a.term)
    if (known.length) {
      for (const k of known) ctx.usage.recordLoad("glossary", k.name, { session: run.sessionID })
      continue
    }
    try {
      await ctx.ops.note(run, "glossary", {
        summary: `${a.term}: Bedeutung offen – „${truncate(a.contexts[0] ?? a.term, 160)}“`,
        keywords: [a.term],
        fixedId: `abbr-${glossarySlug(a.term)}`,
        internal: true,
      })
    } catch (err) {
      ctx.log.debug(`abbreviation note ${a.term} skipped`, errorMessage(err))
    }
  }
}

async function runSmith(ctx: Ctx, smith: Smith, input: SmithInput): Promise<SmithResult> {
  const o = ctx.options
  const { prep, job, info } = input
  const run = ctx.runs.create({
    smith,
    actor: "reviewer",
    trigger: job.reason,
    writeMode: o[smith].writeMode ?? o.writeMode,
    directory: ctx.directory,
    project: ctx.project,
    sessionID: job.sessionID,
    sessionAgent: input.sessionAgent,
    parentSessionID: info.parentID,
    limits: limitsFor(ctx, smith),
    userText: prep.userText,
    haystack: prep.haystack,
  })
  run.chains = prep.chains
  run.scope = prep.scope
  const session: SessionInfo = { id: job.sessionID, parentID: info.parentID, agent: input.sessionAgent, project: ctx.project, trigger: job.reason }
  let result: { ok: boolean; error?: string; configError?: boolean } = { ok: false }
  try {
    if (smith === "docsmith") await noteAbbreviations(ctx, run, prep)
    const prompt = await buildPrompt(ctx, smith, run, input, session)
    const release = await agentSemaphore(o.agentConcurrency).acquire()
    try {
      ctx.log.info(`${smith} review ${run.id} started`, { session: job.sessionID, model: input.model ? `${input.model.providerID}/${input.model.modelID}` : "default" })
      result = await runAgentSession({
        client: ctx.client,
        agent: reviewerAgent(smith),
        title: `${AGENT_TITLE_PREFIX} ${smith} ${job.sessionID.slice(-8)}`,
        prompt,
        model: input.model,
        timeoutMs: o.reviewTimeoutMin * 60_000,
        keepSession: o.keepAgentSessions,
        log: ctx.log,
        onSession: (sid) => ctx.runs.attach(run, sid),
      })
    } finally {
      release()
    }
  } catch (err) {
    result = { ok: false, error: errorMessage(err) }
    ctx.log.error(`${smith} review ${run.id} crashed`, errorMessage(err))
  }
  if (smith === "toolsmith") cleanupDrafts(ctx.store.stateDir, run.id)
  if (smith === "memorysmith" && result.ok && run.captureIds?.length) ctx.mem?.consumeCaptures(run.captureIds)
  const fin = await finalizeRun(ctx, run, result)
  const summary = describeActions(run)
  ctx.log.info(`${smith} review ${run.id} finished`, { ok: result.ok, error: result.error, commit: fin.commit, actions: summary || "none" })
  return {
    smith,
    ok: result.ok,
    error: result.error,
    configError: result.configError,
    actions: run.actions.length,
    summary,
    commit: fin.commit,
    outdatedDocs: run.outdatedDocs,
    links: run.actions
      .filter((a) => a.applied && LINK_ACTIONS.has(a.kind))
      .map((a) => ({ kind: a.target, name: a.name, rel: a.kind === "create" ? ("new" as const) : ("changed" as const) })),
  }
}

const LINK_ACTIONS = new Set(["create", "update", "merge", "patch", "rewrite", "upsert", "restore", "activate"])

/** Session history: one compact record per (top-level) session, merged per reviewed segment. */
async function recordHistory(ctx: Ctx, info: { id: string; parentID?: string; title?: string }, prep: Prep, results: SmithResult[]): Promise<void> {
  if (!ctx.history?.enabled || info.parentID) return
  const t = prep.transcript
  const links: HistoryLink[] = [
    ...results.flatMap((r) => r.links ?? []),
    ...t.uses.map((u) => ({ kind: u.kind, name: u.name, rel: "used" as const })),
    ...prep.hinted.filter((h) => h.helped).map((h) => ({ kind: "error" as const, name: h.entry, rel: "used" as const })),
    ...t.calls
      .filter((c) => c.tool === "error_lookup" && c.ok && typeof c.input?.name === "string")
      .map((c) => ({ kind: "error" as const, name: String(c.input.name).trim(), rel: "used" as const })),
  ].filter((l) => !!ctx.store.getOwned(l.kind, l.name))
  const blocks = t.assistantText.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean)
  try {
    await ctx.history.record({
      id: info.id,
      project: ctx.project,
      directory: ctx.directory,
      title: info.title,
      requests: t.userTexts,
      chains: prep.chains.filter((c) => c.tool !== "user" || c.resolved),
      links,
      outcome: blocks[blocks.length - 1],
    })
  } catch (err) {
    ctx.log.debug("session history not recorded", errorMessage(err))
  }
}

function recordOutdatedDocs(ctx: Ctx, sessionID: string, docs: string[]): void {
  if (!docs.length) return
  try {
    ensureDir(ctx.store.stateDir)
    appendFileSync(
      join(ctx.store.stateDir, "outdated-docs.jsonl"),
      docs.map((d) => JSON.stringify({ at: nowIso(), project: ctx.project, directory: ctx.directory, session: sessionID, doc: d })).join("\n") + "\n",
    )
  } catch {
    // ignore
  }
}

let lastConfigToast = 0

export async function reviewSession(ctx: Ctx, job: ReviewJob, after?: () => void): Promise<ReviewResult> {
  const { client, options: o, log } = ctx
  const sid = job.sessionID
  let info: { id: string; parentID?: string; title?: string }
  try {
    info = unwrap(await client.session.get({ path: { id: sid } }))
  } catch (err) {
    log.info(`session ${sid} not available, dropping job`, errorMessage(err))
    return { outcome: "gone" }
  }
  if ((info.title ?? "").startsWith(AGENT_TITLE_PREFIX)) return { outcome: "skipped" }
  const isChild = !!info.parentID
  if (isChild && !o.reviewSubagents && !job.force) return { outcome: "skipped" }

  let messages: Msg[]
  try {
    messages = unwrap<Msg[]>(await client.session.messages({ path: { id: sid } }))
  } catch (err) {
    log.warn(`could not load messages of ${sid}`, errorMessage(err))
    return { outcome: "failed", error: errorMessage(err) }
  }
  const state = ctx.sessions.reload(sid) ?? ctx.sessions.get(sid, ctx.directory)
  const counted = state.userMsgsSinceReview
  const rememberNotes = [...(state.rememberNotes ?? [])]
  const range = completedPrefix(sliceUnreviewed(messages, state.lastReviewedMessageID))
  if (range.some((m) => m.info.role === "user" && isSmithAgent(m.info.agent))) return { outcome: "skipped" }

  const transcript = buildTranscript(range, {
    maxChars: o.transcriptMaxChars,
    redact: (s) => ctx.redactor.redact(s),
    scriptOf: (cmd) => scriptOfCommand(ctx, cmd),
  })
  const markReviewed = () =>
    ctx.sessions.update(sid, ctx.directory, (s) => {
      if (transcript.lastMessageID) s.lastReviewedMessageID = transcript.lastMessageID
      s.lastReviewedAt = nowIso()
      s.userMsgsSinceReview = Math.max(0, s.userMsgsSinceReview - counted)
      s.thresholdReached = false
      s.reviewFailures = 0
      s.parentID = info.parentID ?? null
      delete s.reviewProgress
      delete s.rememberRequested
      if (s.rememberNotes?.length) s.rememberNotes = s.rememberNotes.slice(rememberNotes.length)
    })

  // /remember or subagent results without new user messages: memorysmith alone (the others have nothing to review)
  const pendingCaptures = !isChild && o.memorysmith.enabled ? (ctx.mem?.captures(sid).length ?? 0) : 0
  const memoryOnly = !!job.force && o.memorysmith.enabled && (rememberNotes.length > 0 || pendingCaptures > 0)
  if (!memoryOnly && (range.length === 0 || (transcript.userMessages === 0 && transcript.toolCalls === 0))) {
    if (range.length) markReviewed()
    return { outcome: "skipped" }
  }
  if (!job.force) {
    if (isChild && transcript.toolCalls < o.subagentMinToolCalls && transcript.errors === 0) {
      log.debug(`subagent ${sid}: ${transcript.toolCalls} tool calls, no errors → not reviewed`)
      markReviewed()
      return { outcome: "skipped" }
    }
    if (!isChild && job.reason === "idle" && transcript.userMessages < o.idleMinNewMessages) return { outcome: "skipped" }
  }

  await waitForCurator(ctx)

  const prep = await prepare(ctx, transcript, sid, { isChild, rememberNotes })
  const lastID = transcript.lastMessageID ?? ""
  const already = state.reviewProgress && state.reviewProgress.lastMessageID === lastID ? new Set(state.reviewProgress.done) : new Set<Smith>()
  const smiths = route(ctx, prep).filter((s) => !already.has(s))
  const firstUser = range.find((m) => m.info.role === "user")
  const sessionAgent = firstUser?.info.agent || transcript.agents[0]

  const results = await Promise.all(
    smiths.map((smith) =>
      runSmith(ctx, smith, { job, info, prep, sessionAgent, model: resolveModel(ctx, smith, "reviewer", messages) }).catch(
        (err): SmithResult => ({ smith, ok: false, error: errorMessage(err), actions: 0, summary: "" }),
      ),
    ),
  )
  const succeeded = results.filter((r) => r.ok || r.actions > 0)
  const failed = results.filter((r) => !(r.ok || r.actions > 0))
  const outdated = results.flatMap((r) => r.outdatedDocs ?? [])
  recordOutdatedDocs(ctx, sid, outdated)
  await recordHistory(ctx, info, prep, results)

  const summaries = results.filter((r) => r.summary).map((r) => `${r.smith}: ${r.summary}`)
  if (summaries.length) ctx.toast(truncate(summaries.join(" · "), 300), failed.length ? "warning" : "success")
  if (outdated.length) ctx.toast(truncate(`docsmith: Projekt-Doku prüfen – ${outdated.join("; ")}`, 300), "info")

  let outcome: ReviewOutcome
  let error: string | undefined
  if (failed.length === 0) {
    for (const use of transcript.uses) {
      const issue = use.errors[0] ?? (use.userCorrection ? `user correction: ${use.userCorrection}` : undefined)
      ctx.usage.recordFeedback(use.kind, use.name, !!issue, issue, { session: sid })
    }
    markReviewed()
    outcome = results.length ? "done" : "skipped"
  } else {
    const configError = failed.find((r) => r.configError)
    error = (configError ?? failed[0]).error
    ctx.sessions.update(sid, ctx.directory, (s) => {
      s.reviewProgress = { lastMessageID: lastID, done: [...already, ...succeeded.map((r) => r.smith)] }
    })
    if (configError) {
      outcome = "config-error"
      log.warn(`review of ${sid} postponed – configuration problem`, error)
      if (Date.now() - lastConfigToast > 30 * 60_000) {
        lastConfigToast = Date.now()
        ctx.toast(
          truncate(
            `skillsmith: Hintergrund-Agent konnte nicht starten (${error}). Reviews werden aufgehoben und alle 10 min erneut versucht. Tipp: "reviewerModel": "<provider>/<modell>" in der Plugin-Konfiguration setzen.`,
            400,
          ),
          "error",
        )
      }
    } else {
      const failures = ctx.sessions.update(sid, ctx.directory, (s) => {
        s.reviewFailures = (s.reviewFailures ?? 0) + 1
      }).reviewFailures
      if (failures >= 5) {
        log.warn(`review of ${sid} failed ${failures}× (${failed.map((r) => r.smith).join(", ")}) – skipping this range`, error)
        markReviewed()
        outcome = "done"
      } else {
        outcome = "failed"
      }
    }
  }
  try {
    after?.()
  } catch {
    // ignore
  }
  return { outcome, error }
}

/** Entries as the background agents see them (private documents do not exist). */
function aiList(ctx: Ctx, kind: Kind): Entry[] {
  return ctx.store.list(kind).filter((e) => !isPrivate(e))
}

export const SMITH_KINDS: Record<Smith, Kind[]> = Object.fromEntries(SMITHS.map((s) => [s, CONTENT_KINDS.filter((k) => spec(k).smith === s)])) as Record<Smith, Kind[]>
