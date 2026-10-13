/**
 * Curator for all smiths:
 *  - deterministic lifecycle (active → dormant → archive, reactivation,
 *    prompt budget for skills), glossary de-duplication, weekly script
 *    re-tests – one run (and commit) per smith;
 *  - periodic LLM consolidation per smith (similar entries, error-prone
 *    entries, failing scripts).
 */
import { appendFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { Entry, GlossaryMeaning, Kind, Run, Smith, Tier } from "../types"
import { CONTENT_KINDS } from "../types"
import { acquireFileLock, isLocked, readJson, sleep, writeJsonAtomic } from "../util/fs"
import { daysBetween, errorMessage, fold, maxIso, nowIso } from "../util/text"
import { agentSemaphore, runAgentSession } from "./agent-runner"
import { dot } from "./embeddings"
import type { Ctx } from "./context"
import { describeActions, finalizeRun } from "./finalize"
import { aiAccessOf, meaningsOf, scriptFiles, spec } from "./kinds"
import { normalizeQuote } from "./ops"
import { buildCuratorJob, curatorAgent, SMITHS } from "./prompts"
import { checkDraft, cleanupDrafts, pythonEnv } from "./pyworkshop"
import { AGENT_TITLE_PREFIX, resolveModel } from "./reviewer"

export interface PlannedMove {
  /** entry kind */
  target: Kind
  name: string
  from: Tier
  to: Tier
  kind: "dormant" | "archive" | "activate"
  reason: string
}

export interface PlannedRetag {
  kind: Kind
  name: string
  from: string[]
  to: string[]
  /** "variant → canonical" pairs applied to this entry */
  changes: string[]
}

export interface ConsolidationPlan {
  clusters: string[][]
  problems: Array<{ name: string; note: string }>
  /** related but distinct entries to check for contradictions (docsmith) */
  pairs: Array<{ a: string; b: string; similarity: number }>
}

interface CuratorState {
  createdAt: string
  lastLifecycleAt?: string
  lastConsolidationAt?: string
  lastConsolidationResult?: string
  lastRetestAt?: string
  lastRetestResult?: string
  /** related knowledge pairs already checked ("a|b" → ISO date) */
  checkedPairs?: Record<string, string>
}

const MAX_CLUSTER = 6
const MAX_PAIRS = 5

/** Rough size of a skill's entry in opencode's system prompt (name, description, location, tags). */
export function promptCost(rec: Entry): number {
  return rec.name.length + rec.description.length + rec.file.length + 70
}

const LIFECYCLE: Partial<Record<Kind, (ctx: Ctx) => { stale: number; archive: number }>> = {
  skill: (ctx) => ({ stale: ctx.options.staleDays, archive: ctx.options.archiveDays }),
  error: (ctx) => ({ stale: ctx.options.errorsmith.staleDays, archive: ctx.options.errorsmith.archiveDays }),
  script: (ctx) => ({ stale: ctx.options.toolsmith.staleDays, archive: ctx.options.toolsmith.archiveDays }),
}

export class Curator {
  private stateFile: string

  constructor(private ctx: Ctx) {
    this.stateFile = join(ctx.store.stateDir, "curator.json")
  }

  state(): CuratorState {
    const s = readJson<CuratorState | null>(this.stateFile, null)
    if (s) return s
    const fresh = { createdAt: nowIso() }
    writeJsonAtomic(this.stateFile, fresh)
    return fresh
  }

  private saveState(patch: Partial<CuratorState>): void {
    writeJsonAtomic(this.stateFile, { ...this.state(), ...patch })
  }

  /** Entries the curator may touch: only KI-Recht "frei" (the user's documents default to "vorschlag", private ones are invisible). */
  private aiList(kind: Kind): Entry[] {
    return this.ctx.store.list(kind).filter((e) => aiAccessOf(e) === "frei")
  }

  lastActivity(rec: Entry): string | undefined {
    const u = this.ctx.usage.get(rec.kind, rec.name)
    const m = rec.meta
    let seen: string | undefined
    if (rec.kind === "error") {
      for (const o of Object.values(this.ctx.occurrences.all())) if (o.entry === rec.name && (!seen || o.lastSeen > seen)) seen = o.lastSeen
    }
    return maxIso(u.lastUsedAt, seen, m?.createdAt, m?.updatedAt, rec.tier === "active" ? m?.tierChangedAt : undefined)
  }

  planLifecycle(now = new Date()): PlannedMove[] {
    const moves: PlannedMove[] = []
    for (const kind of Object.keys(LIFECYCLE) as Kind[]) {
      if (!this.ctx.options[spec(kind).smith].enabled) continue
      moves.push(...this.planKind(kind, now))
    }
    if (this.ctx.options.memorysmith.enabled) moves.push(...this.planMemory(now))
    return moves
  }

  /**
   * Durable memories: superseded ones are archived, experiences unused for
   * experienceArchiveDays are archived, archived ones that are used again come back.
   * Decisions and conventions are never archived for age – they belong to the user.
   */
  planMemory(now = new Date()): PlannedMove[] {
    const o = this.ctx.options.memorysmith
    const moves: PlannedMove[] = []
    for (const rec of this.aiList("memory")) {
      if (rec.meta?.pinned || rec.meta?.absorbedInto) continue
      const type = String(rec.fields.type ?? "")
      const status = String(rec.fields.status ?? "")
      const usage = this.ctx.usage.get("memory", rec.name)
      if (rec.tier === "archive") {
        if (status !== "abgeloest" && usage.lastUsedAt && rec.meta?.tierChangedAt && usage.lastUsedAt > rec.meta.tierChangedAt) {
          moves.push({ target: "memory", name: rec.name, from: "archive", to: "active", kind: "activate", reason: "used again" })
        }
        continue
      }
      if (status === "abgeloest") {
        moves.push({ target: "memory", name: rec.name, from: "active", to: "archive", kind: "archive", reason: `superseded${rec.fields.superseded_by ? ` by ${String(rec.fields.superseded_by)}` : ""}` })
        continue
      }
      if (type === "erfahrung") {
        const idle = daysBetween(this.lastActivity(rec), now)
        if (idle >= o.experienceArchiveDays) moves.push({ target: "memory", name: rec.name, from: "active", to: "archive", kind: "archive", reason: `unused for ${Math.floor(idle)} days` })
      }
    }
    return moves
  }

  /**
   * Volatile memories (local, no commit): work states expire after stateDays or when
   * their branch is gone; results are deleted after resultDays unless they were used
   * or linked.
   */
  cleanVolatile(now = Date.now()): { expired: number; deleted: number } {
    const mem = this.ctx.mem
    const o = this.ctx.options.memorysmith
    if (!mem?.available || !o.enabled) return { expired: 0, deleted: 0 }
    let expired = 0
    let deleted = 0
    let scope: ReturnType<Ctx["scope"]> | undefined
    try {
      scope = this.ctx.scope()
    } catch {
      scope = undefined
    }
    for (const s of mem.states()) {
      if (s.status !== "gueltig") continue
      const old = now - s.updatedAt > o.stateDays * 86_400_000
      const gone = scope && s.project === scope.project && s.branch && !this.ctx.scopes.branchExists(this.ctx.directory, s.branch)
      if (old || gone) {
        mem.setStateStatus(s.id, "abgelaufen")
        expired++
      }
    }
    for (const r of mem.results()) {
      if (now - r.createdAt <= o.resultDays * 86_400_000) continue
      if (r.used > 0 || mem.relationsOf(r.id).some((e) => e.type !== "not_related")) continue
      mem.deleteResult(r.id)
      deleted++
    }
    if (expired || deleted) this.ctx.log.info(`memories: ${expired} work state(s) expired, ${deleted} result(s) deleted`)
    return { expired, deleted }
  }

  private planKind(kind: Kind, now: Date): PlannedMove[] {
    const o = this.ctx.options
    const { stale, archive } = LIFECYCLE[kind]!(this.ctx)
    const owned = this.aiList(kind)
    const moves: PlannedMove[] = []
    const finalTier = new Map<string, Tier>()
    for (const rec of owned) {
      const tier = rec.tier as Tier
      finalTier.set(rec.name, tier)
      if (rec.meta?.pinned) continue
      const usage = this.ctx.usage.get(kind, rec.name)
      const idle = daysBetween(this.lastActivity(rec), now)
      if (tier !== "active" && usage.lastUsedAt && rec.meta?.tierChangedAt && usage.lastUsedAt > rec.meta.tierChangedAt && !rec.meta?.absorbedInto) {
        moves.push({ target: kind, name: rec.name, from: tier, to: "active", kind: "activate", reason: "used again" })
        finalTier.set(rec.name, "active")
        continue
      }
      if (rec.meta?.absorbedInto) continue
      if (tier === "active" && idle >= stale) {
        moves.push({ target: kind, name: rec.name, from: tier, to: "dormant", kind: "dormant", reason: `unused for ${Math.floor(idle)} days` })
        finalTier.set(rec.name, "dormant")
      } else if (tier === "dormant" && idle >= archive) {
        moves.push({ target: kind, name: rec.name, from: tier, to: "archive", kind: "archive", reason: `unused for ${Math.floor(idle)} days` })
        finalTier.set(rec.name, "archive")
      }
    }
    if (kind !== "skill") return moves
    // budget for the system prompt: demote the least recently active, unpinned skills
    const active = owned.filter((r) => finalTier.get(r.name) === "active")
    let count = active.length
    let chars = active.reduce((n, r) => n + promptCost(r), 0)
    const { maxSkills, maxChars } = o.activeBudget
    if (count > maxSkills || chars > maxChars) {
      const demotable = active
        .filter((r) => !r.meta?.pinned)
        .sort((a, b) => (this.lastActivity(a) ?? "").localeCompare(this.lastActivity(b) ?? "") || a.name.localeCompare(b.name))
      for (const rec of demotable) {
        if (count <= maxSkills && chars <= maxChars) break
        const activation = moves.findIndex((m) => m.name === rec.name && m.kind === "activate")
        if (activation >= 0) moves.splice(activation, 1)
        else moves.push({ target: "skill", name: rec.name, from: "active", to: "dormant", kind: "dormant", reason: `active budget (${maxSkills} skills / ${maxChars} chars)` })
        count--
        chars -= promptCost(rec)
      }
    }
    return moves
  }

  /** Glossary entries whose term/aliases overlap → groups (oldest entry first). */
  planGlossaryMerges(): Entry[][] {
    const entries = this.aiList("glossary").filter((e) => e.tier === "active")
    const keyOf = (t: string) => fold(t).replace(/[^a-z0-9]/g, "")
    const parent = new Map(entries.map((e) => [e.name, e.name]))
    const find = (n: string): string => {
      let p = parent.get(n)!
      while (p !== parent.get(p)) p = parent.get(p)!
      parent.set(n, p)
      return p
    }
    const owner = new Map<string, string>()
    for (const e of entries) {
      for (const t of [String(e.fields.term ?? ""), ...((e.fields.aliases as string[]) ?? [])]) {
        const k = keyOf(t)
        if (!k) continue
        const other = owner.get(k)
        if (other) parent.set(find(e.name), find(other))
        else owner.set(k, e.name)
      }
    }
    const groups = new Map<string, Entry[]>()
    for (const e of entries) groups.set(find(e.name), [...(groups.get(find(e.name)) ?? []), e])
    return [...groups.values()]
      .filter((g) => g.length > 1)
      .map((g) => g.sort((a, b) => (a.meta?.createdAt ?? "9999").localeCompare(b.meta?.createdAt ?? "9999") || a.name.localeCompare(b.name)))
  }

  /** Tag variants (lexical, and semantic with embeddings) → entries to re-tag with the canonical tag. */
  async planTagMerges(): Promise<PlannedRetag[]> {
    if (!this.ctx.options.unifyTags) return []
    const map = await this.ctx.retriever.tagMerges()
    if (!map.size) return []
    const out: PlannedRetag[] = []
    for (const smith of SMITHS) {
      if (!this.ctx.options[smith].enabled) continue
      for (const kind of CONTENT_KINDS.filter((k) => spec(k).smith === smith)) {
        for (const e of this.aiList(kind)) {
          const changes = e.tags.filter((t) => map.has(t)).map((t) => `${t}→${map.get(t)}`)
          if (!changes.length) continue
          const to = [...new Set(e.tags.map((t) => map.get(t) ?? t))]
          out.push({ kind, name: e.name, from: e.tags, to, changes })
        }
      }
    }
    return out
  }

  private async mergeGlossaryGroup(run: Run, group: Entry[]): Promise<void> {
    const target = group[0]
    const meanings: GlossaryMeaning[] = []
    for (const e of group) {
      for (const m of meaningsOf(e.fields.meanings)) {
        const same = meanings.find((x) => normalizeQuote(x.expansion) === normalizeQuote(m.expansion))
        if (!same) meanings.push({ ...m })
        else if (!same.description && m.description) same.description = m.description
      }
    }
    const term = String(target.fields.term)
    const aliases = [
      ...new Set(group.flatMap((e) => [String(e.fields.term), ...((e.fields.aliases as string[]) ?? [])]).filter((t) => normalizeQuote(t) !== normalizeQuote(term))),
    ]
    await this.ctx.ops.merge(run, "glossary", {
      sources: group.map((e) => e.name),
      target: target.name,
      title: term,
      description: meanings.map((m) => m.expansion).join(" / "),
      tags: [...new Set(group.flatMap((e) => e.tags))],
      fields: { term, aliases, meanings: meanings.slice(0, 10) },
      body: group
        .map((e) => e.body.trim())
        .filter(Boolean)
        .join("\n\n"),
      reason: "duplicate glossary terms",
      approved: true,
    })
  }

  async lifecycle(trigger: string, force = false): Promise<{ moves: number; commits: string[]; planned: PlannedMove[] }> {
    const st = this.state()
    if (!force && st.lastLifecycleAt && Date.now() - Date.parse(st.lastLifecycleAt) < 10 * 60_000) {
      return { moves: 0, commits: [], planned: [] }
    }
    let release: (() => void) | undefined
    try {
      release = await acquireFileLock(this.ctx.store.locksDir, "lifecycle", { timeoutMs: 0, staleMs: 10 * 60_000 })
    } catch {
      return { moves: 0, commits: [], planned: [] }
    }
    try {
      try {
        this.cleanVolatile()
      } catch (err) {
        this.ctx.log.warn("volatile memory cleanup failed", errorMessage(err))
      }
      const planned = this.planLifecycle()
      const glossaryGroups = this.ctx.options.docsmith.enabled ? this.planGlossaryMerges() : []
      let retags: PlannedRetag[] = []
      try {
        retags = await this.planTagMerges()
      } catch (err) {
        this.ctx.log.warn("tag unification skipped", errorMessage(err))
      }
      this.saveState({ lastLifecycleAt: nowIso() })
      let moves = 0
      const commits: string[] = []
      for (const smith of SMITHS) {
        const mine = planned.filter((m) => spec(m.target).smith === smith)
        const groups = smith === "docsmith" ? glossaryGroups : []
        // glossary entries absorbed by a merge are not re-tagged separately
        const absorbed = new Set(groups.flatMap((g) => g.slice(1).map((e) => e.name)))
        const tagFixes = retags.filter((r) => spec(r.kind).smith === smith && !(r.kind === "glossary" && absorbed.has(r.name)))
        if (!mine.length && !groups.length && !tagFixes.length) continue
        const mode = this.ctx.options[smith].writeMode ?? this.ctx.options.writeMode
        if (mode === "shadow") {
          appendFileSync(
            join(this.ctx.store.stateDir, "shadow.jsonl"),
            [
              ...mine.map((m) => JSON.stringify({ at: nowIso(), smith, actor: "curator", action: m.kind, target: m.target, name: m.name, reason: m.reason, args: m })),
              ...groups.map((g) => JSON.stringify({ at: nowIso(), smith, actor: "curator", action: "merge", target: "glossary", name: g[0].name, reason: "duplicate glossary terms", args: { sources: g.map((e) => e.name) } })),
              ...tagFixes.map((r) => JSON.stringify({ at: nowIso(), smith, actor: "curator", action: "update", target: r.kind, name: r.name, reason: `unify tags: ${r.changes.join(", ")}`, args: { tags: r.to } })),
            ].join("\n") + "\n",
          )
          continue
        }
        const run = this.ctx.runs.create({
          smith,
          actor: "curator",
          trigger: `lifecycle (${trigger})`,
          writeMode: "auto",
          directory: this.ctx.directory,
          project: this.ctx.project,
          limits: { maxNew: 0, maxChanges: 10_000, maxNotes: 0 },
        })
        for (const m of mine) {
          try {
            await this.ctx.ops.move(run, m.target, { name: m.name, to: m.to, kind: m.kind, reason: m.reason, approved: true })
          } catch (err) {
            this.ctx.log.warn(`lifecycle move ${m.target}:${m.name} failed`, errorMessage(err))
          }
        }
        for (const g of groups) {
          try {
            await this.mergeGlossaryGroup(run, g)
          } catch (err) {
            this.ctx.log.warn(`glossary merge ${g.map((e) => e.name).join(",")} failed`, errorMessage(err))
          }
        }
        for (const r of tagFixes) {
          try {
            await this.ctx.ops.update(run, r.kind, { name: r.name, tags: r.to, reason: `unify tags: ${r.changes.join(", ")}`, approved: true })
          } catch (err) {
            this.ctx.log.warn(`re-tag ${r.kind}:${r.name} failed`, errorMessage(err))
          }
        }
        const fin = await finalizeRun(this.ctx, run, { ok: true })
        moves += fin.applied
        if (fin.commit) commits.push(fin.commit)
        this.ctx.log.info(`${smith} lifecycle: ${fin.applied} change(s)`, { commit: fin.commit })
      }
      return { moves, commits, planned }
    } finally {
      release()
    }
  }

  // ---------------------------------------------------------------------------
  // script re-tests (toolsmith)
  // ---------------------------------------------------------------------------

  async retestScripts(trigger: string, names?: string[]): Promise<string> {
    const scripts = this.aiList("script").filter((s) => (names ? names.includes(s.name) : s.tier !== "archive"))
    if (!names) this.saveState({ lastRetestAt: nowIso() })
    if (!scripts.length) return "Keine Skripte zu testen."
    const env = await pythonEnv(this.ctx.options, this.ctx.store.stateDir, true)
    if (!env.ok) return `Python nicht verfügbar: ${env.error ?? "?"}`
    const run = this.ctx.runs.create({
      smith: "toolsmith",
      actor: "curator",
      trigger: `retest (${trigger})`,
      writeMode: "auto",
      directory: this.ctx.directory,
      project: this.ctx.project,
      limits: { maxNew: 0, maxChanges: 10_000, maxNotes: 0 },
    })
    const lines: string[] = []
    try {
      for (const s of scripts) {
        const f = scriptFiles(s.name)
        const code = this.ctx.store.readFileOf(s, f.code)
        const tests = this.ctx.store.readFileOf(s, f.test)
        if (code === undefined || tests === undefined) {
          lines.push(`${s.name}: Dateien fehlen`)
          continue
        }
        const report = await checkDraft({
          spec: {
            name: s.name,
            description: s.description,
            usage: String(s.fields.usage ?? ""),
            code,
            tests,
            capabilities: (s.fields.capabilities as string[]) ?? [],
            requirements: (s.fields.requirements as string[]) ?? [],
            tags: s.tags,
            docs: s.body,
          },
          dir: join(this.ctx.store.stateDir, "drafts", run.id, s.name),
          env,
          options: this.ctx.options,
          log: this.ctx.log,
        })
        const before = s.meta?.test?.status
        lines.push(`${s.name}: ${report.test.status}${report.test.summary ? ` (${report.test.summary})` : ""}`)
        if (before !== report.test.status || (report.test.status === "failed" && s.meta?.test?.summary !== report.test.summary)) {
          try {
            await this.ctx.ops.setTestStatus(
              run,
              s.name,
              { ...report.test, summary: report.ok ? report.test.summary : `${report.test.summary ?? ""} ${report.errors.join(" | ")}`.trim().slice(0, 1500) },
              "weekly re-test",
            )
          } catch (err) {
            this.ctx.log.warn(`retest status ${s.name} failed`, errorMessage(err))
          }
        }
      }
    } finally {
      cleanupDrafts(this.ctx.store.stateDir, run.id)
      const fin = await finalizeRun(this.ctx, run, { ok: true })
      this.saveState({ lastRetestResult: lines.join("; ").slice(0, 500) })
      if (fin.commit) this.ctx.log.info(`retest committed ${fin.commit}`)
    }
    return lines.join("\n")
  }

  // ---------------------------------------------------------------------------
  // consolidation (LLM, per smith)
  // ---------------------------------------------------------------------------

  /** Pairwise cosine similarity of stored entry vectors (empty without embeddings). */
  semanticPairs(kind: Kind, names: string[], min: number, max = 1): Array<{ a: string; b: string; score: number }> {
    const sem = this.ctx.semantic
    if (!sem || !sem.client.configured) return []
    const vecs = sem.entryVectors(kind)
    const list = names.filter((n) => vecs.has(n)).slice(0, 1500)
    const out: Array<{ a: string; b: string; score: number }> = []
    for (let i = 0; i < list.length; i++) {
      const va = vecs.get(list[i])!
      for (let j = i + 1; j < list.length; j++) {
        const s = dot(va, vecs.get(list[j])!)
        if (s >= min && s < max) out.push({ a: list[i], b: list[j], score: Math.round(s * 1000) / 1000 })
      }
    }
    return out.sort((x, y) => y.score - x.score)
  }

  /** Consolidation clusters: TF-IDF pairs ∪ semantic pairs, union-find, at most MAX_CLUSTER entries each. */
  clustersFor(kind: Kind, names: string[]): string[][] {
    const o = this.ctx.options
    const pairs = [
      ...this.ctx.index.similarPairs(names, o.similarityThreshold, kind),
      ...this.semanticPairs(kind, names, o.embedding.clusterSimilarity),
    ]
    const parent = new Map(names.map((n) => [n, n]))
    const find = (n: string): string => {
      let p = parent.get(n)!
      while (p !== parent.get(p)) p = parent.get(p)!
      parent.set(n, p)
      return p
    }
    const degree = new Map<string, number>()
    for (const { a, b } of pairs) {
      degree.set(a, (degree.get(a) ?? 0) + 1)
      degree.set(b, (degree.get(b) ?? 0) + 1)
      const ra = find(a)
      const rb = find(b)
      if (ra !== rb) parent.set(ra, rb)
    }
    const groups = new Map<string, string[]>()
    for (const n of names) groups.set(find(n), [...(groups.get(find(n)) ?? []), n])
    return [...groups.values()]
      .filter((g) => g.length > 1)
      .map((g) => g.sort((x, y) => (degree.get(y) ?? 0) - (degree.get(x) ?? 0) || x.localeCompare(y)).slice(0, MAX_CLUSTER).sort())
  }

  planConsolidation(): Record<Smith, ConsolidationPlan> {
    const o = this.ctx.options
    const plan = {} as Record<Smith, ConsolidationPlan>
    const cluster = (kind: Kind, tiers: Tier[]) =>
      this.clustersFor(
        kind,
        this.ctx.store
          .list(kind)
          .filter((r) => tiers.includes(r.tier as Tier))
          .map((r) => r.name),
      )
    // skills
    const skills = this.aiList("skill").filter((r) => r.tier !== "archive")
    plan.skillsmith = {
      pairs: [],
      clusters: o.skillsmith.enabled ? cluster("skill", ["active", "dormant"]) : [],
      problems: o.skillsmith.enabled
        ? skills
            .filter((r) => {
              const u = this.ctx.usage.get("skill", r.name)
              return u.reviewedLoads >= o.needsReviewMinLoads && u.loadsWithIssues / Math.max(1, u.reviewedLoads) > o.needsReviewRate
            })
            .map((r) => {
              const u = this.ctx.usage.get("skill", r.name)
              return { name: r.name, note: `${u.loadsWithIssues}/${u.reviewedLoads} reviewed loads had problems; last issue: ${u.lastIssue ?? "n/a"}` }
            })
        : [],
    }
    plan.docsmith = { clusters: o.docsmith.enabled ? cluster("knowledge", ["active"]) : [], problems: [], pairs: [] }
    // with the doctor, contradictions between knowledge entries are its job
    const doctorOn = o.doctor.enabled && !!this.ctx.mem?.available
    if (o.docsmith.enabled) {
      const knowledge = this.aiList("knowledge").filter((r) => r.tier === "active")
      plan.docsmith.problems = knowledge
        .filter((r) => r.meta?.doubts?.length)
        .map((r) => ({ name: r.name, note: `possible contradictions noted: ${r.meta!.doubts!.map((d) => `${d.note}${d.related ? ` (see ${d.related})` : ""}`).join(" | ")}` }))
      const inCluster = new Set(plan.docsmith.clusters.flat())
      const checked = this.state().checkedPairs ?? {}
      plan.docsmith.pairs = doctorOn ? [] : this.semanticPairs(
        "knowledge",
        knowledge.map((r) => r.name),
        o.embedding.relatedSimilarity,
        o.embedding.clusterSimilarity,
      )
        .filter((p) => !(inCluster.has(p.a) && inCluster.has(p.b)))
        .filter((p) => {
          const at = checked[`${p.a}|${p.b}`]
          if (!at) return true
          // re-check when one of them changed since
          const changed = [p.a, p.b].some((n) => (this.ctx.store.getOwned("knowledge", n)?.meta?.updatedAt ?? "") > at)
          return changed || daysBetween(at) > 90
        })
        .slice(0, MAX_PAIRS)
        .map((p) => ({ a: p.a, b: p.b, similarity: p.score }))
    }
    const errors = this.aiList("error").filter((r) => r.tier !== "archive")
    plan.errorsmith = {
      pairs: [],
      clusters: o.errorsmith.enabled ? cluster("error", ["active", "dormant"]) : [],
      problems: o.errorsmith.enabled
        ? errors
            .filter((r) => {
              const u = this.ctx.usage.get("error", r.name)
              return (u.failed ?? 0) >= 2 && (u.failed ?? 0) > (u.helped ?? 0)
            })
            .map((r) => {
              const u = this.ctx.usage.get("error", r.name)
              return { name: r.name, note: `live hint shown ${u.hintsShown}×: helped ${u.helped ?? 0}×, same error again ${u.failed ?? 0}×` }
            })
        : [],
    }
    const scripts = this.aiList("script").filter((r) => r.tier !== "archive")
    plan.toolsmith = {
      pairs: [],
      clusters: [],
      problems: o.toolsmith.enabled
        ? scripts
            .filter((r) => {
              const u = this.ctx.usage.get("script", r.name)
              return r.meta?.test?.status === "failed" || (u.reviewedLoads >= o.needsReviewMinLoads && u.loadsWithIssues / Math.max(1, u.reviewedLoads) > o.needsReviewRate)
            })
            .map((r) => {
              const u = this.ctx.usage.get("script", r.name)
              const t = r.meta?.test
              return {
                name: r.name,
                note: `${t?.status === "failed" ? `re-test FAILED (${t.at}): ${t.summary ?? ""}` : ""}${u.loadsWithIssues ? ` · ${u.loadsWithIssues}/${u.reviewedLoads} uses had problems; last: ${u.lastIssue ?? "n/a"}` : ""}`.trim(),
              }
            })
        : [],
    }
    // memories: similar memories of the same project
    plan.memorysmith = { clusters: [], problems: [], pairs: [] }
    if (o.memorysmith.enabled) {
      const byProject = new Map<string, string[]>()
      for (const r of this.aiList("memory")) {
        if (r.tier !== "active") continue
        const p = String(r.fields.project ?? "") || "(global)"
        byProject.set(p, [...(byProject.get(p) ?? []), r.name])
      }
      for (const names of byProject.values()) if (names.length > 1) plan.memorysmith.clusters.push(...this.clustersFor("memory", names))
    }
    plan.doctor = { clusters: [], problems: [], pairs: [] }
    return plan
  }

  private reviewsRunning(): boolean {
    let names: string[] = []
    try {
      names = readdirSync(this.ctx.store.locksDir).filter((n) => n.startsWith("review-") && n.endsWith(".lock"))
    } catch {
      return false
    }
    const stale = (2 * this.ctx.options.reviewTimeoutMin + 5) * 60_000
    return names.some((n) => isLocked(this.ctx.store.locksDir, n.slice(0, -5), stale))
  }

  /** LLM consolidation per smith with work (job "consolidate"; `only` limits the smiths, e.g. ["skillsmith"]). */
  async consolidate(trigger: string, only?: Smith[]): Promise<string> {
    await this.ctx.semantic?.ensureCurrent(15_000)
    const plan = this.planConsolidation()
    const work = SMITHS.filter((s) => (!only?.length || only.includes(s)) && (plan[s].clusters.length || plan[s].problems.length || plan[s].pairs.length))
    if (work.length === 0) {
      this.saveState({ lastConsolidationAt: nowIso(), lastConsolidationResult: "nothing to consolidate" })
      return "Nichts zu konsolidieren (keine ähnlichen oder problematischen Einträge)."
    }
    let release: (() => void) | undefined
    try {
      release = await acquireFileLock(this.ctx.store.locksDir, "curator", {
        timeoutMs: 0,
        staleMs: 2 * this.ctx.options.reviewTimeoutMin * 60_000,
      })
    } catch {
      return "Der Curator läuft bereits."
    }
    try {
      const waitStart = Date.now()
      while (this.reviewsRunning() && Date.now() - waitStart < 15 * 60_000) await sleep(3000)
      const results = await Promise.all(work.map((smith) => this.consolidateSmith(smith, plan[smith], trigger)))
      const summary = results.join(" · ")
      this.saveState({ lastConsolidationAt: nowIso(), lastConsolidationResult: summary.slice(0, 500) })
      return `Curator fertig: ${summary}`
    } finally {
      release()
    }
  }

  private async consolidateSmith(smith: Smith, p: ConsolidationPlan, trigger: string): Promise<string> {
    const o = this.ctx.options
    const kind: Kind =
      smith === "skillsmith" ? "skill" : smith === "docsmith" ? "knowledge" : smith === "errorsmith" ? "error" : smith === "memorysmith" ? "memory" : "script"
    const run = this.ctx.runs.create({
      smith,
      actor: "curator",
      trigger: `consolidate (${trigger})`,
      writeMode: o[smith].writeMode ?? o.writeMode,
      directory: this.ctx.directory,
      project: this.ctx.project,
      limits: { maxNew: 0, maxChanges: o.curatorMaxChanges, maxNotes: 0 },
    })
    const get = (n: string) => this.ctx.store.getOwned(kind, n)
    const pairs = p.pairs
      .map((x) => ({ a: get(x.a)!, b: get(x.b)!, similarity: x.similarity }))
      .filter((x) => !!x.a && !!x.b)
    const prompt = buildCuratorJob({
      smith,
      runId: run.id,
      limits: run.limits,
      clusters: p.clusters.map((names) => ({ names, entries: names.map(get).filter((r): r is Entry => !!r) })),
      problems: p.problems.map((x) => ({ entry: get(x.name)!, note: x.note })).filter((x) => !!x.entry),
      pairs,
    })
    if (smith === "docsmith") {
      // evidence for curator edits = the entries themselves (no new facts possible)
      const involved = new Set([...p.clusters.flat(), ...p.problems.map((x) => x.name), ...p.pairs.flatMap((x) => [x.a, x.b])])
      run.haystack = [...involved]
        .map((n) => get(n))
        .filter((r): r is Entry => !!r)
        .map((r) => `${r.title}\n${r.description}\n${r.body}`)
        .join("\n")
    }
    this.ctx.log.info(`${smith} curator ${run.id} started`, { clusters: p.clusters, problems: p.problems.map((x) => x.name) })
    const sem = await agentSemaphore(o.agentConcurrency).acquire()
    let result: { ok: boolean; error?: string }
    try {
      result = await runAgentSession({
        client: this.ctx.client,
        agent: curatorAgent(smith),
        title: `${AGENT_TITLE_PREFIX} ${smith} curator`,
        prompt,
        model: resolveModel(this.ctx, smith, "curator"),
        timeoutMs: o.reviewTimeoutMin * 60_000,
        keepSession: o.keepAgentSessions,
        log: this.ctx.log,
        onSession: (sid) => this.ctx.runs.attach(run, sid),
      })
    } finally {
      sem()
    }
    if (smith === "toolsmith") cleanupDrafts(this.ctx.store.stateDir, run.id)
    if (result.ok && p.pairs.length) {
      const checked = { ...(this.state().checkedPairs ?? {}) }
      for (const x of p.pairs) checked[`${x.a}|${x.b}`] = nowIso()
      this.saveState({ checkedPairs: checked })
    }
    const fin = await finalizeRun(this.ctx, run, result)
    const summary = describeActions(run) || "keine Änderungen"
    this.ctx.log.info(`${smith} curator ${run.id} finished`, { ok: result.ok, error: result.error, commit: fin.commit, summary })
    if (fin.applied || fin.proposed) this.ctx.toast(`${smith} Curator: ${summary}`, "success")
    return `${smith}: ${summary}${fin.commit ? ` (commit ${fin.commit})` : ""}${result.error ? ` – Hinweis: ${result.error}` : ""}`
  }

  async dryRunReport(): Promise<string> {
    const moves = this.planLifecycle()
    const groups = this.planGlossaryMerges()
    const retags = await this.planTagMerges().catch(() => [] as PlannedRetag[])
    const plan = this.planConsolidation()
    const lines = ["**Curator – Vorschau (dry run)**", ""]
    lines.push(moves.length ? "Lebenszyklus:" : "Lebenszyklus: keine Änderungen")
    for (const m of moves) lines.push(`- ${spec(m.target).label} ${m.name}: ${m.from} → ${m.to} (${m.reason})`)
    if (groups.length) {
      lines.push("", "Doppelte Glossar-Einträge (werden zusammengeführt):")
      for (const g of groups) lines.push(`- ${g.map((e) => `${String(e.fields.term)} (${e.name})`).join(", ")}`)
    }
    if (retags.length) {
      const pairs = [...new Set(retags.flatMap((r) => r.changes))]
      lines.push("", `Tags vereinheitlichen (${retags.length} Einträge): ${pairs.join(", ")}`)
      for (const r of retags.slice(0, 15)) lines.push(`- ${spec(r.kind).label} ${r.name}: ${r.changes.join(", ")}`)
      if (retags.length > 15) lines.push(`- … und ${retags.length - 15} weitere`)
    }
    lines.push("")
    for (const smith of SMITHS) {
      const p = plan[smith]
      if (!p.clusters.length && !p.problems.length && !p.pairs.length) continue
      lines.push(`**${smith}**`)
      for (const c of p.clusters) lines.push(`- ähnlich: ${c.join(", ")}`)
      for (const x of p.problems) lines.push(`- prüfen: ${x.name} – ${x.note}`)
      for (const x of p.pairs) lines.push(`- auf Widersprüche prüfen: ${x.a} ↔ ${x.b} (Ähnlichkeit ${x.similarity.toFixed(2)})`)
    }
    if (SMITHS.every((s) => !plan[s].clusters.length && !plan[s].problems.length && !plan[s].pairs.length)) lines.push("Keine Konsolidierungskandidaten.")
    const st = this.state()
    lines.push("")
    lines.push(`Letzte Konsolidierung: ${st.lastConsolidationAt ?? "noch nie"} (Zeitplan: Seite Jobs, „Konsolidierung“)`)
    lines.push(`Letzter Skript-Test: ${st.lastRetestAt ?? "noch nie"}${st.lastRetestResult ? ` (${st.lastRetestResult})` : ""}`)
    return lines.join("\n")
  }
}
