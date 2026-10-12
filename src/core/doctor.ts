/**
 * Doctor: checks new and changed entries against similar ones.
 *
 *  1. queue    – every applied content change (all smiths, commands) queues its node
 *  2. scan     – deterministic: candidates by meaning (embeddings) or keywords (BM25),
 *                pairs already judged with unchanged content are skipped, the rest
 *                becomes an open conflict with a suspicion ("Duplikat-Verdacht" …)
 *  3. judge    – the background agent "smith-doctor" decides each open pair:
 *                relation (type, strength, description), not related, merge,
 *                correction (outdated fact, evidenced) or conflict for the user
 *  4. user     – /smith-doctor resolve <id> a|b|both|unrelated
 *
 * One run and one commit per doctor run; relations with a volatile end are local.
 */
import type { Kind, Run } from "../types"
import { key } from "../types"
import { isPrivate } from "./kinds"
import { acquireFileLock } from "../util/fs"
import { errorMessage, truncate } from "../util/text"
import { agentSemaphore, runAgentSession } from "./agent-runner"
import type { Ctx } from "./context"
import { M } from "./metrics"
import { describeActions, finalizeRun } from "./finalize"
import { isStoreId, nodeLabel, type GraphNode } from "./graph"
import type { Conflict } from "./memory-db"
import { buildDoctorJob, DOCTOR_AGENT, type DoctorPairView } from "./prompts"
import { AGENT_TITLE_PREFIX, resolveModel } from "./reviewer"

export const DOCTOR_KINDS: Kind[] = ["knowledge", "memory", "error", "skill", "script"]
const CONTENT_ACTIONS = new Set(["create", "update", "merge", "patch", "rewrite", "publish", "restore", "activate", "result"])
const MAX_ATTEMPTS = 3

export interface DoctorRunResult {
  ok: boolean
  pairs: number
  summary: string
  commit?: string
  error?: string
}

export class Doctor {
  private busy = false
  private pendingTimer?: ReturnType<typeof setTimeout>

  constructor(private ctx: Ctx) {}

  get enabled(): boolean {
    return this.ctx.options.doctor.enabled && !!this.ctx.mem?.available
  }

  /** After any run: queue the nodes whose content changed (never the doctor's own changes). */
  onRunFinished(run: Run): void {
    if (!this.enabled || run.smith === "doctor") return
    const mem = this.ctx.mem!
    for (const a of run.actions) {
      if (!a.applied || !CONTENT_ACTIONS.has(a.kind)) continue
      if (a.local) {
        if (a.kind === "result") mem.enqueue(a.name, "new")
        continue
      }
      if (!DOCTOR_KINDS.includes(a.target)) continue
      const e = this.ctx.store.getOwned(a.target, a.name)
      if (!e || e.tier === "archive") continue
      mem.enqueue(key(a.target, a.name), e.version)
    }
  }

  /** Once per store: queue every existing entry so old knowledge gets checked too (processed in portions). */
  backfill(): number {
    if (!this.enabled) return 0
    const mem = this.ctx.mem!
    if (mem.metaValue("doctor.backfill") === "1") return 0
    let n = 0
    for (const kind of DOCTOR_KINDS) {
      for (const e of this.ctx.store.list(kind).filter((x) => !isPrivate(x))) {
        if (e.tier === "archive") continue
        mem.enqueue(key(kind, e.name), e.version, Date.now() + n)
        n++
      }
    }
    mem.setMeta("doctor.backfill", "1")
    if (n) this.ctx.log.info(`doctor: ${n} existing entr${n === 1 ? "y" : "ies"} queued for the first check`)
    return n
  }

  private suspicion(a: GraphNode, b: GraphNode, score: number, semantic: boolean): string {
    if (a.kind === b.kind && semantic && score >= 0.92) return "Duplikat-Verdacht"
    if (a.kind === "memory" && b.kind === "memory") {
      return a.type === b.type ? `zwei ${nodeLabel("memory", a.type)}en zum selben Thema – Widerspruch, Duplikat oder Ergänzung?` : "Erinnerungen mit ähnlichem Inhalt – Bezug prüfen"
    }
    if (a.kind === b.kind && (a.kind === "knowledge" || a.kind === "error")) return "ähnlicher Inhalt – Widerspruch, Ergänzung oder Duplikat?"
    if (a.kind === "memory" || b.kind === "memory") return "Erinnerung und Wissen zum selben Thema – Widerspruch oder Bezug?"
    return "ähnlicher Inhalt – Bezug prüfen"
  }

  /** Candidates of one node: similar entries that were not judged with their current content. */
  async candidatesOf(node: GraphNode): Promise<Array<{ node: GraphNode; score: number; semantic: boolean }>> {
    const o = this.ctx.options
    const mem = this.ctx.mem!
    const graph = this.ctx.graph
    const s = isStoreId(node.id)
    const vector = s ? this.ctx.retriever.vectorOf(s.kind, s.name) : undefined
    const similar = await this.ctx.retriever.similarTo(node.text, DOCTOR_KINDS, { exclude: new Set([node.id]), limit: o.doctor.candidates, vector })
    const out: Array<{ node: GraphNode; score: number; semantic: boolean }> = []
    for (const c of similar) {
      const other = graph.node(key(c.kind, c.name))
      if (!other || other.tier === "archive") continue
      // memories of different projects cannot contradict each other
      if (node.kind === "memory" && other.kind === "memory" && node.project && other.project && node.project !== other.project) continue
      if (mem.isChecked(node.id, other.id, node.hash, other.hash)) continue
      const known = graph.between(node.id, other.id)
      if (known?.derived && (known.type === "duplicates" || known.type === "supersedes")) continue
      if (known && !known.derived && known.hashes) {
        const [hf, ht] = known.from === node.id ? [node.hash, other.hash] : [other.hash, node.hash]
        if (known.hashes.from === hf && known.hashes.to === ht) continue
      }
      out.push({ node: other, score: c.score, semantic: c.semantic })
    }
    return out
  }

  /** Deterministic part: process queued nodes into open conflicts. Returns the number of new/updated conflicts. */
  async scan(limit: number): Promise<number> {
    if (!this.enabled) return 0
    const mem = this.ctx.mem!
    let opened = 0
    for (const q of mem.queued(Math.max(1, limit))) {
      mem.dequeue(q.id)
      const node = this.ctx.graph.node(q.id)
      if (!node || node.tier === "archive" || node.kind === "session" || node.kind === "arbeitsstand") continue
      let cands: Awaited<ReturnType<Doctor["candidatesOf"]>>
      try {
        cands = await this.candidatesOf(node)
      } catch (err) {
        this.ctx.log.debug(`doctor: candidates of ${q.id} failed`, errorMessage(err))
        continue
      }
      for (const c of cands) {
        const suspicion = this.suspicion(node, c.node, c.score, c.semantic)
        const id = mem.openConflict(node.id, c.node.id, suspicion, Math.round(c.score * 1000) / 1000, node.hash, c.node.hash)
        if (!id) continue
        opened++
        if (mem.lastConflictCreated === id) this.ctx.audit?.append({ actor: "doctor", smith: "doctor", category: "conflict", action: "open", targets: [node.id, c.node.id], result: "ok", message: `${id}: ${suspicion}` })
      }
    }
    return opened
  }

  /** Open pairs ready for the agent (vanished nodes are closed on the way). */
  openPairs(max: number): Array<{ conflict: Conflict; a: GraphNode; b: GraphNode }> {
    const mem = this.ctx.mem!
    const out: Array<{ conflict: Conflict; a: GraphNode; b: GraphNode }> = []
    for (const c of mem.conflicts("open")) {
      if (out.length >= max) break
      const a = this.ctx.graph.node(c.a)
      const b = this.ctx.graph.node(c.b)
      if (!a || !b || a.tier === "archive" || b.tier === "archive") {
        mem.updateConflict(c.id, { status: "resolved", resolution: "Eintrag entfernt oder archiviert" })
        continue
      }
      out.push({ conflict: c, a, b })
    }
    return out
  }

  status(): { queued: number; open: number; needsUser: number; resolved: number } {
    const mem = this.ctx.mem
    if (!mem?.available) return { queued: 0, open: 0, needsUser: 0, resolved: 0 }
    const all = mem.conflicts()
    return {
      queued: mem.queueSize(),
      open: all.filter((c) => c.status === "open").length,
      needsUser: all.filter((c) => c.status === "needs_user").length,
      resolved: all.filter((c) => c.status === "resolved").length,
    }
  }

  /** Fire and forget (after reviews, at startup). */
  maybeRun(trigger: string, delayMs = 5000): void {
    if (!this.enabled || this.pendingTimer) return
    const t = setTimeout(() => {
      this.pendingTimer = undefined
      const st = this.status()
      if (!st.queued && !st.open) return
      void this.run(trigger).catch((err) => this.ctx.log.warn("doctor run failed", errorMessage(err)))
    }, delayMs)
    ;(t as any).unref?.()
    this.pendingTimer = t
  }

  cancel(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer)
    this.pendingTimer = undefined
  }

  /** scan + one agent run over at most maxPairsPerRun open pairs. */
  async run(trigger: string): Promise<DoctorRunResult> {
    const ctx = this.ctx
    const o = ctx.options
    if (!this.enabled) return { ok: false, pairs: 0, summary: "Doktor ist aus (doctor.enabled) oder die lokale Datenbank fehlt." }
    if (this.busy) return { ok: false, pairs: 0, summary: "Der Doktor läuft bereits." }
    this.busy = true
    let release: (() => void) | undefined
    try {
      release = await acquireFileLock(ctx.store.locksDir, "doctor", { timeoutMs: 0, staleMs: 2 * o.reviewTimeoutMin * 60_000 })
    } catch {
      this.busy = false
      return { ok: false, pairs: 0, summary: "Ein anderer Doktor-Lauf (anderes opencode-Fenster) ist aktiv." }
    }
    try {
      await this.scan(Math.max(o.doctor.backfillPerRun, o.doctor.maxPairsPerRun * 2))
      const pairs = this.openPairs(o.doctor.maxPairsPerRun)
      if (!pairs.length) {
        if (this.ctx.mem!.queueSize()) this.maybeRun("follow-up", 2000)
        return { ok: true, pairs: 0, summary: "keine offenen Paare" }
      }
      const res = await this.judge(trigger, pairs)
      // more work left (large backfill, many changes): continue in portions while runs succeed
      const st = this.status()
      if (res.ok && (st.open > 0 || st.queued > 0)) this.maybeRun("follow-up", 10_000)
      return res
    } finally {
      release?.()
      this.busy = false
    }
  }

  private async judge(trigger: string, pairs: Array<{ conflict: Conflict; a: GraphNode; b: GraphNode }>): Promise<DoctorRunResult> {
    const ctx = this.ctx
    const o = ctx.options
    const mem = ctx.mem!
    const run = ctx.runs.create({
      smith: "doctor",
      actor: "curator",
      trigger: `doctor (${trigger})`,
      writeMode: o.doctor.writeMode ?? o.writeMode,
      directory: ctx.directory,
      project: ctx.project,
      limits: { maxNew: 0, maxChanges: o.doctor.maxPairsPerRun * 4, maxNotes: 0 },
    })
    run.doctorPairs = {}
    const views: DoctorPairView[] = []
    pairs.forEach(({ conflict, a, b }, i) => {
      const pid = `P${i + 1}`
      run.doctorPairs![pid] = { conflict: conflict.id, a: a.id, b: b.id, aHash: a.hash, bHash: b.hash }
      const existing = ctx.graph.between(a.id, b.id)
      views.push({
        id: pid,
        suspicion: conflict.suspicion,
        similarity: conflict.similarity,
        existing: existing && !existing.derived ? `${existing.from === a.id ? "A" : "B"} ${existing.type} ${existing.from === a.id ? "B" : "A"} (${existing.strength}) – ${existing.description}` : undefined,
        a: { id: a.id, label: nodeLabel(a.kind, a.type), meta: metaLine(a), text: a.text },
        b: { id: b.id, label: nodeLabel(b.kind, b.type), meta: metaLine(b), text: b.text },
      })
    })
    // corrections must quote the other entry verbatim
    run.haystack = pairs.map((p) => `${p.a.text}\n${p.b.text}`).join("\n")
    run.userText = ""
    const prompt = buildDoctorJob(run.id, views, run.limits)
    let result: { ok: boolean; error?: string; configError?: boolean } = { ok: false }
    try {
      const release = await agentSemaphore(o.agentConcurrency).acquire()
      try {
        ctx.log.info(`doctor ${run.id} started`, { pairs: pairs.length })
        result = await runAgentSession({
          client: ctx.client,
          agent: DOCTOR_AGENT,
          title: `${AGENT_TITLE_PREFIX} doctor ${run.id.slice(-6)}`,
          prompt,
          model: resolveModel(ctx, "doctor", "curator"),
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
    }
    // undecided pairs: count the attempt, hand over to the user after three
    for (const p of Object.values(run.doctorPairs)) {
      if (p.decided) continue
      const c = mem.conflict(p.conflict)
      if (!c || c.status !== "open") continue
      if (result.configError) continue
      const attempts = c.attempts + 1
      mem.updateConflict(c.id, attempts >= MAX_ATTEMPTS ? { attempts, status: "needs_user", note: c.note ?? "Der Doktor kam nach mehreren Läufen zu keinem Urteil." } : { attempts })
    }
    const fin = await finalizeRun(ctx, run, result)
    const summary = describeActions(run) || run.summary || "keine Änderungen"
    ctx.log.info(`doctor ${run.id} finished`, { ok: result.ok, error: result.error, commit: fin.commit, actions: summary })
    return { ok: result.ok, pairs: pairs.length, summary, commit: fin.commit, error: result.error }
  }

  /** Record a verdict for a pair of the run (tools). */
  decide(run: Run, pairId: string, verdict: string, conflictPatch: { status: "resolved" | "needs_user"; note?: string; resolution?: string }): void {
    const p = run.doctorPairs?.[pairId]
    if (!p) return
    p.decided = verdict
    const mem = this.ctx.mem!
    // hashes after the verdict (a correction or merge changed the content)
    const a = this.ctx.graph.node(p.a)
    const b = this.ctx.graph.node(p.b)
    mem.markChecked(p.a, p.b, a?.hash ?? p.aHash, b?.hash ?? p.bHash, verdict)
    mem.updateConflict(p.conflict, conflictPatch)
    this.ctx.metrics?.record({ type: M.doctorVerdict, entry: `verdict:${verdict}`, origin: "background", model: run.model, extra: { status: conflictPatch.status } })
    this.ctx.audit?.append({ actor: "doctor", smith: "doctor", category: "conflict", action: verdict, targets: [p.a, p.b], result: "ok", reason: conflictPatch.note ?? conflictPatch.resolution, message: `${p.conflict}: ${conflictPatch.status}`, run: run.id, model: run.model, project: run.project })
  }

  /** Text of a conflict for /smith-doctor and the web UI. */
  describe(c: Conflict): string {
    const a = this.ctx.graph.node(c.a)
    const b = this.ctx.graph.node(c.b)
    const name = (n: GraphNode | undefined, id: string) => (n ? `${nodeLabel(n.kind, n.type)} „${truncate(n.title, 70)}“ (${id})` : `${id} (entfernt)`)
    return `${c.id} [${c.status === "needs_user" ? "Entscheidung nötig" : c.status === "open" ? "offen" : "gelöst"}] ${c.suspicion}\n   A: ${name(a, c.a)}\n   B: ${name(b, c.b)}${c.note ? `\n   Hinweis: ${c.note}` : ""}${c.resolution ? `\n   Lösung: ${c.resolution}` : ""}`
  }
}

function metaLine(n: GraphNode): string {
  return [
    n.summary ? `summary: ${truncate(n.summary, 200)}` : "",
    n.status ? `status: ${n.status}` : "",
    n.project ? `project: ${n.projectName || n.project}` : "",
    n.date ? `updated: ${n.date.slice(0, 10)}` : "",
  ]
    .filter(Boolean)
    .join(" · ")
}

