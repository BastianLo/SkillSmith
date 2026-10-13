/**
 * Guarded operations on all entry kinds. Every write goes through here:
 * background agents (tools), commands and staged approvals. Guards are
 * deterministic and enforced in code, independent of the model:
 * limits, validation, evidence gates, secret scan, pins, foreign skills,
 * write modes and cross-run claims.
 */
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import type { Options } from "../config"
import { smithWriteMode } from "../config"
import type { Logger } from "../log"
import type { ActionKind, AnchorRecord, Entry, Evidence, GlossaryMeaning, Kind, Meta, ProvenanceSource, ProvenanceType, Relation, RelationType, Run, TestStatus, Tier } from "../types"
import { isUser, MEMORY_TYPES, PROVENANCE_TYPES, RELATION_TYPES } from "../types"
import { ensureDir, listFiles, readJson, removePath, sleep, writeJsonAtomic } from "../util/fs"
import { fold, nowIso, oneLine, shortId, truncate } from "../util/text"
import { str, strArray } from "./frontmatter"
import { canonicalEdge, isStoreId, type Graph } from "./graph"
import { aiAccessOf, isOwnDoc, glossarySlug, meaningsOf, memoryName, normalizeTags, spec, topicKey, type EntryContent } from "./kinds"
import type { MemoryDb, WorkState } from "./memory-db"
import type { Scope } from "./scope"
import type { Redactor } from "./redact"
import { lintBody, validateBody, validateDescription, validateName } from "./skill"
import type { Store } from "./store"
import { evidenceSource, findParagraph, nextProvenance, paragraphs, PROVENANCE_KINDS, type Paragraph } from "./provenance"
import type { CrossChecker, CheckParagraph } from "./crosscheck"
import { ClaimedError, StoreError } from "./store"

export class GuardError extends Error {}

export interface StagedChange {
  id: string
  runId: string
  createdAt: string
  actor: string
  smith: string
  sessionID?: string
  project: string
  action: ActionKind
  target: Kind
  name: string
  reason?: string
  args: Record<string, unknown>
  /** version of the entry when the change was proposed (diff, stale proposals) */
  baseVersion?: string
  /** staged because of the entry's KI-Recht (proposal for a user document) */
  aiProposal?: boolean
}

export interface OpsDeps {
  store: Store
  options: Options
  redactor: Redactor
  log: Logger
  claimWait?: { agent: number; command: number }
  checkClaims?: boolean
}

const DEFAULT_CLAIM_WAIT = { agent: 180_000, command: 20_000 }

const WRITE_ACTIONS = new Set<ActionKind>([
  "create",
  "update",
  "patch",
  "rewrite",
  "merge",
  "upsert",
  "archive",
  "restore",
  "dormant",
  "activate",
  "flag",
  "relate",
  "supersede",
  "state",
  "result",
])
const NEW_KINDS = new Set<Kind>(["skill", "knowledge", "error", "script", "memory"])

/** stage reason of proposals for the user's documents */
export const AI_PROPOSAL = "KI-Recht vorschlag"

export function normalizeQuote(s: string): string {
  return fold(s).replace(/[^a-z0-9]+/g, " ").trim()
}

const TAG_STOP = new Set(["and", "the", "with", "for", "from", "into", "via", "und", "der", "die", "das", "mit", "fur", "von", "zum", "zur", "bei", "how", "use"])

/** Keywords derived from the entry itself when the agent gave none (every entry stays findable by tags). */
export function deriveTags(kind: Kind, c: EntryContent): string[] {
  if (kind === "glossary") return normalizeTags(meaningsOf(c.fields.meanings).map((m) => m.context ?? "").filter(Boolean)).slice(0, 4)
  const parts = c.name.split("-").filter((p) => p.length >= 3 && !TAG_STOP.has(p) && !/^\d+$/.test(p))
  const extra = kind === "error" ? strArray(c.fields.context) : []
  return normalizeTags([...extra, ...parts]).slice(0, 5)
}

/** A source for one paragraph (5c): a verbatim quote, or a reference that appears in the transcript. */
export interface SourceArg {
  /** start of the paragraph (≥ 12 characters, as in the text) */
  paragraph: string
  /** verbatim quote from the transcript / project doc / session */
  evidence?: string
  type?: ProvenanceType
  /** commit, ticket, url, code ref or "kind:name" */
  ref?: string
}

/** Result of the anchor / provenance step of a write. */
interface ContentMeta {
  warnings: string[]
  /** changed or new statement paragraphs */
  changed: Paragraph[]
  provenance?: Record<string, ProvenanceSource[]>
}

/** Pins the code anchors of a text (src/core/anchors.ts). */
export type AnchorPin = (text: string, previous: AnchorRecord[], repin?: string[]) => Promise<{ records: AnchorRecord[]; unresolved: string[] }>

export interface CreateArgs {
  name: string
  title?: string
  description: string
  tags?: unknown
  fields?: Record<string, unknown>
  body: string
  reason?: string
  candidateId?: string
  userQuote?: string
  evidence?: string
  chainId?: string
  approved?: boolean
  /** knowledge: folder below the tier */
  folder?: string
  /** sources per paragraph */
  sources?: SourceArg[]
}

export interface UpdateArgs {
  name: string
  title?: string
  description?: string
  tags?: unknown
  fields?: Record<string, unknown>
  body?: string
  baseVersion?: string
  reason?: string
  evidence?: string
  approved?: boolean
  /** sources per paragraph */
  sources?: SourceArg[]
  /** code anchors to pin again (the text was adapted to changed code) */
  repinAnchors?: string[]
}

export interface PublishArgs {
  name: string
  isNew: boolean
  content: EntryContent
  files: Record<string, string>
  test: TestStatus
  capabilities: string[]
  reason?: string
  candidateId?: string
  /** forces approval (risky capabilities / not sandbox-tested) */
  needsApproval?: string
  approved?: boolean
}

/** Semantic similarity (embeddings) – optional; gates are skipped when it is missing or unavailable. */
export interface SimilarityProvider {
  /** an existing entry of the same kind that is (almost) the same content */
  duplicateOf(kind: Kind, c: EntryContent): Promise<{ name: string; similarity: number; tier: string } | undefined>
  /** an open candidate that describes the same pattern */
  matchCandidate(kind: Kind, text: string): Promise<{ id: string; similarity: number } | undefined>
  /** map tags onto the existing vocabulary, suggest tags from similar entries */
  tagPlan?(kind: Kind, c: EntryContent): Promise<{ tags: string[]; notes: string[] }>
}

export type ScriptRecheck = (args: PublishArgs) => Promise<{ ok: boolean; message: string; test?: TestStatus }>

export class Ops {
  readonly stagedDir: string
  readonly shadowFile: string
  private recheck?: ScriptRecheck
  private anchorPin?: AnchorPin
  private crossChecker?: { applies(run: Run, kind: Kind): boolean; check: CrossChecker }
  private sim?: SimilarityProvider
  private mem?: MemoryDb
  private graph?: Graph

  constructor(private d: OpsDeps) {
    this.stagedDir = join(d.store.stateDir, "staged")
    this.shadowFile = join(d.store.stateDir, "shadow.jsonl")
  }

  setSimilarity(p: SimilarityProvider): void {
    this.sim = p
  }

  /** memory-smith: local memory database and the knowledge graph (relations, node lookup) */
  setMemory(mem: MemoryDb | undefined, graph: Graph): void {
    this.mem = mem
    this.graph = graph
  }

  /** Tags: vocabulary mapping + suggestions (similarity provider), name-derived fallback. Returns notes for the agent. */
  private async planTags(run: Run, kind: Kind, c: EntryContent): Promise<string[]> {
    const notes: string[] = []
    const given = c.tags.length
    // explicit tags of the user (commands) are kept as given
    if (this.sim?.tagPlan && !(isUser(run) && given)) {
      try {
        const plan = await this.sim.tagPlan(kind, c)
        c.tags = plan.tags
        if (plan.notes.length) notes.push(`tags: ${plan.notes.join("; ")}`)
      } catch {
        // keep the given tags
      }
    }
    if (!c.tags.length) {
      c.tags = deriveTags(kind, c)
      if (c.tags.length) notes.push(`no tags given – derived: ${c.tags.join(", ")} (pass 2–8 tags for better search)`)
    } else if (!given) {
      notes.push(`no tags given – ${c.tags.join(", ")} taken from similar entries (pass 2–8 tags for better search)`)
    }
    return notes
  }

  /** Duplicate gate for background agents (embeddings). */
  private async duplicateGate(run: Run, kind: Kind, c: EntryContent): Promise<void> {
    if (!this.sim || isUser(run)) return
    let dup: Awaited<ReturnType<SimilarityProvider["duplicateOf"]>>
    try {
      dup = await this.sim.duplicateOf(kind, c)
    } catch {
      return
    }
    if (!dup) return
    const where = dup.tier === "active" ? "" : ` (${dup.tier} – restore it first)`
    throw new GuardError(
      `a very similar ${spec(kind).label} entry already exists: "${dup.name}"${where}, similarity ${dup.similarity.toFixed(2)}. Update that entry instead of creating a duplicate${kind === "skill" ? " (skillsmith_patch / skillsmith_rewrite)" : ""}.`,
    )
  }

  /** code anchors: resolve [[code:…]] on every write (5c) */
  setAnchorPin(fn: AnchorPin | undefined): void {
    this.anchorPin = fn
  }

  /** cross-check of AI-written paragraphs by a second model (5d) */
  setCrossCheck(c: { applies(run: Run, kind: Kind): boolean; check: CrossChecker } | undefined): void {
    this.crossChecker = c
  }

  /**
   * Cross-check (5d): returns a stage reason when a paragraph is not supported, throws when one
   * is contradicted. Only for background agents; the user's writes and approvals are not checked.
   */
  private async crossGate(run: Run, kind: Kind, name: string, cm: ContentMeta, approved: boolean): Promise<string | undefined> {
    if (approved || isUser(run) || !this.crossChecker?.applies(run, kind) || !cm.changed.length) return undefined
    const paras: CheckParagraph[] = cm.changed.map((p) => ({ index: p.index, text: p.text, sources: cm.provenance?.[p.key] ?? [] }))
    const r = await this.crossChecker.check(run, kind, name, paras)
    if (r.error && !r.verdicts.length) return `Kreuzprüfung nicht möglich (${truncate(r.error, 120)})`
    const bad = r.verdicts.filter((v) => v.verdict === "widersprochen")
    if (bad.length) {
      const msg = `cross-check (${r.model}): the source contradicts ${bad.map((v) => `"${truncate(paras.find((p) => p.index === v.index)?.text ?? "", 50)}" – ${v.reason}`).join("; ")}. Do not write what the sources do not say.`
      ;(run.rejections ??= []).push({ at: nowIso(), target: `${kind}:${name}`, message: msg })
      throw new GuardError(msg)
    }
    const weak = r.verdicts.filter((v) => v.verdict === "nicht_gestuetzt")
    if (weak.length) return `Kreuzprüfung: ${weak.length} Absatz/Absätze nicht gestützt (${weak.map((v) => truncate(v.reason, 80)).join("; ")})`
    if (r.error) return `Kreuzprüfung unvollständig (${truncate(r.error, 120)})`
    return undefined
  }

  /** A source given for one paragraph – verified like evidence (quote) or by its reference in the transcript. */
  private verifySource(run: Run, s: SourceArg, body: string, approved: boolean): ProvenanceSource {
    const at = nowIso()
    const type = s.type && (PROVENANCE_TYPES as readonly string[]).includes(s.type) ? s.type : undefined
    if (s.evidence && s.evidence.trim()) {
      const ev = this.verifyEvidence(run, s.evidence)
      if (!ev && !approved) throw new GuardError(`the source for paragraph "${truncate(s.paragraph, 40)}" was not found verbatim in the transcript; copy the passage exactly`)
      this.scanSecrets(s.evidence)
      const base = ev ? evidenceSource(ev, run.id, "paragraph") : { type: "user" as const, quote: truncate(oneLine(s.evidence), 300), at, runId: run.id, scope: "paragraph" as const }
      return type ? { ...base, type, ...(s.ref ? { ref: s.ref } : {}) } : base
    }
    const ref = (s.ref ?? "").trim()
    if (!type || !ref) throw new GuardError(`a source for paragraph "${truncate(s.paragraph, 40)}" needs evidence (a verbatim quote) or type + ref`)
    if (!approved) {
      if (type === "code") {
        if (!body.includes(`[[code:${ref}]]`)) throw new GuardError(`code source ${ref}: anchor the code in the text with [[code:${ref}]]`)
      } else if (type === "doc") {
        const i = ref.indexOf(":")
        if (i <= 0 || !this.d.store.getOwned(ref.slice(0, i) as Kind, ref.slice(i + 1))) throw new GuardError(`document source ${ref} not found (use kind:name)`)
      } else if (!normalizeQuote(`${run.userText ?? ""} ${run.haystack ?? ""}`).includes(normalizeQuote(ref))) {
        throw new GuardError(`source ${type} ${ref} does not appear in the transcript; do not invent sources`)
      }
    }
    return { type, ref: truncate(ref, 300), at, runId: run.id, scope: "paragraph" }
  }

  /**
   * Code anchors and provenance of a write (5c): pins new [[code:…]] anchors and carries the
   * sources per paragraph. Mutates metaPatch, returns warnings for the agent.
   */
  private async contentMeta(run: Run, kind: Kind, body: string, rec: Entry | undefined, metaPatch: Partial<Meta>, sources: SourceArg[] | undefined, approved: boolean, repin?: string[]): Promise<ContentMeta> {
    const o = this.o()
    const warnings: string[] = []
    const result: ContentMeta = { warnings, changed: [] }
    if (o.anchors?.enabled && this.anchorPin && kind !== "project") {
      const prev = rec?.meta?.anchors ?? []
      if (prev.length || body.includes("[[code:")) {
        try {
          const { records, unresolved } = await this.anchorPin(body, prev, repin)
          if (JSON.stringify(records) !== JSON.stringify(prev)) metaPatch.anchors = records.length ? records : undefined
          if (unresolved.length) warnings.push(`code anchors not found in the projects: ${unresolved.join(", ")} (checked again later)`)
        } catch (err) {
          this.d.log.warn(`anchors: ${String(err)}`)
        }
      }
    }
    if (!o.provenance?.enabled || !PROVENANCE_KINDS.includes(kind)) return result
    const paras = paragraphs(body)
    const per = new Map<string, ProvenanceSource[]>()
    for (const s of sources ?? []) {
      const p = findParagraph(paras, s.paragraph ?? "")
      if (!p) throw new GuardError(`sources: paragraph starting with "${truncate(s.paragraph ?? "", 40)}" not found in the new text (copy ≥ 12 characters of its start)`)
      per.set(p.key, [...(per.get(p.key) ?? []), this.verifySource(run, s, body, approved || isUser(run))])
    }
    const user = isUser(run)
    const general: ProvenanceSource[] = user
      ? [{ type: "user", at: nowIso(), runId: run.id, scope: "change", ...(approved && run.actor !== "web" ? { ref: "freigabe" } : {}) }]
      : (metaPatch.evidence ?? []).map((ev) => evidenceSource(ev, run.id))
    const next = nextProvenance(body, rec?.meta?.provenance, general, per)
    result.changed = next.changed
    result.provenance = next.provenance
    if (JSON.stringify(next.provenance) !== JSON.stringify(rec?.meta?.provenance ?? {})) metaPatch.provenance = next.provenance
    const mode = o.provenance.perParagraph
    if (!user && !approved && mode !== "aus" && next.withoutOwn.length >= 2) {
      const list = next.withoutOwn.map((p) => `"${truncate(p.text.replace(/\s+/g, " "), 50)}"`).join(", ")
      if (mode === "pflicht") throw new GuardError(`each changed paragraph needs its own source: pass sources [{paragraph, evidence}] for ${list}`)
      warnings.push(`provenance: ${next.withoutOwn.length} changed paragraphs share one evidence – next time pass sources [{paragraph, evidence}] per paragraph`)
    }
    return result
  }

  /** Pin or re-pin the code anchors of an entry (metadata only; job "anchors", "passt noch"). */
  async setAnchors(run: Run, kind: Kind, name: string, anchors: AnchorRecord[], reason?: string): Promise<string> {
    this.requireOwned(kind, name)
    this.aiGate(run, kind, name, "meta")
    await this.awaitClaims(run, this.claims(kind, name), `${kind} "${name}"`)
    await this.d.store.editMeta(run, kind, name, (m) => {
      m.anchors = anchors.length ? anchors : undefined
    }, "anchor", reason)
    this.applied(run, "anchor", kind, name, reason)
    return `${anchors.length} Code-Anker von "${name}" verankert`
  }

  /** The user names the source of one paragraph (metadata only). */
  async addSource(run: Run, kind: Kind, name: string, a: { paragraph: string; type: ProvenanceType; ref?: string; quote?: string }): Promise<string> {
    const rec = this.requireOwned(kind, name)
    if (!isUser(run)) throw new GuardError("only the user sets sources by hand")
    const p = findParagraph(paragraphs(rec.body), a.paragraph)
    if (!p) throw new GuardError("Absatz nicht gefunden")
    if (a.quote) this.scanSecrets(a.quote)
    const src: ProvenanceSource = { type: a.type, ...(a.ref ? { ref: truncate(a.ref, 300) } : {}), ...(a.quote ? { quote: truncate(oneLine(a.quote), 300) } : {}), at: nowIso(), runId: run.id, scope: "paragraph" }
    await this.awaitClaims(run, this.claims(kind, name), `${kind} "${name}"`)
    await this.d.store.editMeta(run, kind, name, (m) => {
      const prov = { ...(m.provenance ?? {}) }
      prov[p.key] = [src, ...(prov[p.key] ?? [])].slice(0, 6)
      m.provenance = prov
    }, "source", `Quelle für Absatz ${p.index + 1}`)
    this.applied(run, "anchor", kind, name, `Quelle ${a.type}${a.ref ? ` ${a.ref}` : ""} für Absatz ${p.index + 1}`, "source")
    return `Quelle für Absatz ${p.index + 1} gespeichert`
  }

  /** toolsmith registers a re-check used when staged scripts are approved */
  setScriptRecheck(fn: ScriptRecheck): void {
    this.recheck = fn
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  private requireOwned(kind: Kind, name: string): Entry {
    const rec = this.d.store.getOwned(kind, name)
    if (rec) return rec
    if (kind === "skill") {
      const foreign = this.d.store.get("skill", name)
      if (foreign) throw new GuardError(`"${name}" is a foreign skill (${foreign.source ?? "other location"}) and read-only for skillsmith`)
    }
    throw new GuardError(`${spec(kind).label} "${name}" not found`)
  }

  private o(): Options {
    return this.d.options
  }

  /**
   * KI-Recht of an entry for a change by a background agent (never for the user's own runs):
   * frei → returns undefined; vorschlag → returns the stage reason (content) or rejects (tier, merge);
   * lesen → rejects (metadata like relations and doubts stay allowed); privat → "not found".
   * Tasks and projects belong to the user alone.
   */
  aiGate(run: Run, kind: Kind, name: string, what: "content" | "meta" | "tier"): string | undefined {
    if (isUser(run)) return undefined
    if (spec(kind).userOwned) throw new GuardError(`${spec(kind).labelPlural} are maintained by the user only`)
    const rec = this.d.store.getOwned(kind, name)
    if (!rec) return undefined
    const access = aiAccessOf(rec)
    if (access === "frei") return undefined
    if (access === "privat") throw new GuardError(`${spec(kind).label} "${name}" not found`)
    if (what === "meta") return undefined
    if (access === "lesen") {
      throw new GuardError(
        `"${name}" is read-only for the AI (KI-Recht lesen): do not change it${kind === "knowledge" ? "; if it looks outdated, leave a doubt with docsmith_flag and the evidence" : ""}`,
      )
    }
    if (what === "tier") throw new GuardError(`"${name}" belongs to the user (KI-Recht vorschlag): it is never archived, merged or moved automatically`)
    const rejected = this.rejectedProposal(kind, name)
    if (rejected && rejected.version === rec.version) {
      throw new GuardError(`the user rejected a proposal for "${name}" on ${rejected.at.slice(0, 10)}; do not propose again until the document changes`)
    }
    return AI_PROPOSAL
  }

  private get rejectedFile(): string {
    return join(this.d.store.stateDir, "rejected-proposals.json")
  }

  /** Last rejected AI proposal for an entry (it is not repeated while the entry is unchanged). */
  rejectedProposal(kind: Kind, name: string): { version?: string; at: string; reason?: string } | undefined {
    return readJson<Record<string, { version?: string; at: string; reason?: string }>>(this.rejectedFile, {})[`${kind}:${name}`]
  }

  private scanSecrets(...texts: string[]): void {
    const secrets = this.d.redactor.scan(texts.join("\n"))
    if (secrets.length) {
      throw new GuardError(`content looks like it contains sensitive data (${secrets.join(", ")}); remove it or use placeholders like <TOKEN>`)
    }
  }

  private maxBody(kind: Kind): number {
    const o = this.o()
    if (kind === "knowledge") return o.docsmith.maxBodyChars
    if (kind === "error") return o.errorsmith.maxBodyChars
    if (kind === "script") return Math.min(o.maxBodyChars, 8000)
    if (kind === "memory") return o.memorysmith.maxBodyChars
    return o.maxBodyChars
  }

  /** Validate content of an entry; returns non-blocking warnings. `user`: the user's own documents (no required sections). */
  validate(kind: Kind, c: EntryContent, user = false): string[] {
    const o = this.o()
    const nameErr = validateName(c.name)
    if (nameErr) throw new GuardError(nameErr)
    const warnings: string[] = []
    if (kind === "task" || kind === "project" || kind === "agent" || (kind === "knowledge" && user)) {
      // the user's documents, tasks, projects and agent prompts: free form, longer, still checked for secrets
      const t = c.title.trim()
      if (!t || /\n/.test(t) || t.length > 160) throw new GuardError("title must be a single line of 1–160 characters")
      if (/\n/.test(c.description) || c.description.length > o.maxDescriptionChars) throw new GuardError(`description must be a single line of at most ${o.maxDescriptionChars} characters`)
      if (c.body.length > o.docs.maxBodyChars) throw new GuardError(`text is longer than ${o.docs.maxBodyChars} characters`)
      if (c.body.trim().startsWith("---")) throw new GuardError("text must not start with frontmatter")
      this.scanSecrets(c.name, c.title, c.description, c.body, c.tags.join(" "), JSON.stringify(c.fields))
      return warnings
    }
    if (kind !== "glossary") {
      const err = validateDescription(c.description, o.maxDescriptionChars)
      if (err) throw new GuardError(err)
    }
    if (kind === "knowledge" || kind === "error" || kind === "memory") {
      const t = c.title.trim()
      if (!t || /\n/.test(t) || t.length > 120) throw new GuardError("title must be a single line of 1–120 characters")
    }
    if (kind === "glossary") {
      const term = str(c.fields.term).trim()
      if (!term || term.length > 60 || /\n/.test(term)) throw new GuardError("term must be a single line of 1–60 characters")
      const meanings = meaningsOf(c.fields.meanings)
      if (meanings.length === 0) throw new GuardError("a glossary entry needs at least one meaning (expansion + description)")
      if (meanings.length > 10) throw new GuardError("at most 10 meanings per term")
      for (const m of meanings) {
        if (m.expansion.length > 200 || /\n/.test(m.expansion)) throw new GuardError("expansion must be a single line ≤ 200 characters")
        if (!m.description.trim()) throw new GuardError(`meaning "${m.expansion}" needs a short description (Kurzbeschreibung)`)
        if (m.description.length > 400) throw new GuardError("description of a meaning must be ≤ 400 characters")
        if ((m.context ?? "").length > 120) throw new GuardError("context must be ≤ 120 characters")
      }
      if (c.body.length > 3000) throw new GuardError("glossary notes must be ≤ 3000 characters")
    } else if (kind === "script") {
      const usage = str(c.fields.usage).trim()
      if (!usage || /\n/.test(usage) || usage.length > 300) throw new GuardError("usage must be one line (≤ 300 chars), e.g. python3 <script>.py --input <file>")
      if (c.body.length > this.maxBody(kind)) throw new GuardError(`docs are longer than ${this.maxBody(kind)} characters`)
    } else {
      const err = validateBody(c.body, this.maxBody(kind))
      if (err) throw new GuardError(err)
      if (kind === "error") {
        const status = str(c.fields.status)
        if (status !== "solved" && status !== "open") throw new GuardError('status must be "solved" or "open"')
        if (status === "solved" && !/^##\s+(lösung|loesung|solution|fix|behebung)/im.test(c.body)) {
          throw new GuardError('a solved error needs a "## Lösung" section with the working fix')
        }
        if (!/^##\s+(symptom|fehlerbild)/im.test(c.body)) throw new GuardError('an error entry needs a "## Symptom" section')
        const sigs = strArray(c.fields.signatures)
        if (sigs.length > 12) throw new GuardError("at most 12 signatures")
      }
      if (kind === "skill") warnings.push(...lintBody(c.body))
    }
    const texts = [c.name, c.title, c.description, c.body, c.tags.join(" "), JSON.stringify(c.fields)]
    this.scanSecrets(...texts)
    return warnings
  }

  private budget(run: Run, action: ActionKind, kind: Kind): void {
    if (!WRITE_ACTIONS.has(action)) return
    if (run.changes >= run.limits.maxChanges) {
      throw new GuardError(`change limit reached for this run (${run.limits.maxChanges}); finish with ${run.smith}_done`)
    }
    if (action === "create" && NEW_KINDS.has(kind) && run.created >= run.limits.maxNew) {
      throw new GuardError(
        run.limits.maxNew === 0
          ? "creating new entries is not allowed in this run"
          : `new-entry limit reached for this run (${run.limits.maxNew}); prefer updating existing entries or noting a candidate`,
      )
    }
  }

  private count(run: Run, action: ActionKind, kind: Kind): void {
    if (WRITE_ACTIONS.has(action)) run.changes++
    if (action === "create" && NEW_KINDS.has(kind)) run.created++
  }

  /** stage/shadow handling. Returns a message when the change was not applied. */
  private divert(
    run: Run,
    action: ActionKind,
    kind: Kind,
    name: string,
    reason: string | undefined,
    args: Record<string, unknown>,
    forceStage?: string,
  ): string | undefined {
    if (isUser(run)) return undefined
    const mode = run.writeMode === "shadow" ? "shadow" : forceStage ? "stage" : run.writeMode
    if (mode === "auto") return undefined
    if (mode === "stage") {
      const id = `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${shortId(6)}`
      const staged: StagedChange = {
        id,
        runId: run.id,
        createdAt: nowIso(),
        actor: run.actor,
        smith: run.smith,
        sessionID: run.sessionID,
        project: run.project,
        action,
        target: kind,
        name,
        reason: forceStage ? `${reason ?? ""}${reason ? " · " : ""}Freigabe nötig: ${forceStage}` : reason,
        args,
        baseVersion: this.d.store.getOwned(kind, name)?.version,
        ...(forceStage === AI_PROPOSAL ? { aiProposal: true } : {}),
      }
      ensureDir(this.stagedDir)
      writeJsonAtomic(join(this.stagedDir, `${id}.json`), staged)
      run.actions.push({ kind: action, target: kind, name, reason, applied: false, stagedId: id })
      this.count(run, action, kind)
      return `staged as ${id} (${forceStage ? `approval required: ${forceStage}` : "writeMode=stage"}; awaiting /smith-approve). Treat it as done; do not retry.`
    }
    ensureDir(this.d.store.stateDir)
    appendFileSync(
      this.shadowFile,
      JSON.stringify({ at: nowIso(), runId: run.id, smith: run.smith, actor: run.actor, sessionID: run.sessionID, project: run.project, action, target: kind, name, reason, args }) + "\n",
    )
    run.actions.push({ kind: action, target: kind, name, reason, applied: false })
    this.count(run, action, kind)
    return `recorded as proposal (writeMode=shadow, nothing written). Treat it as done; do not retry.`
  }

  private applied(run: Run, action: ActionKind, kind: Kind, name: string, reason?: string, detail?: string): void {
    run.actions.push({ kind: action, target: kind, name, reason: reason ? truncate(oneLine(reason), 300) : undefined, detail, applied: true })
    this.count(run, action, kind)
  }

  private async awaitClaims(run: Run, paths: string[], label: string): Promise<void> {
    if (this.d.checkClaims === false) return
    let claim = this.d.store.claimedBy(run.id, paths)
    if (!claim) return
    const limit = (this.d.claimWait ?? DEFAULT_CLAIM_WAIT)[isUser(run) ? "command" : "agent"]
    const started = Date.now()
    this.d.log.info(`${run.id} waits for concurrent run ${claim.runId} (${label})`)
    while (claim && Date.now() - started < limit) {
      await sleep(400)
      claim = this.d.store.claimedBy(run.id, paths)
    }
    if (claim) {
      throw new GuardError(`${label} is being changed by concurrent run ${claim.runId}; skip this change for now (it will be reviewed again later)`)
    }
  }

  private claims(kind: Kind, ...names: string[]): string[] {
    return names.flatMap((n) => this.d.store.entryPaths(kind, n))
  }

  /** Is `quote` (normalized) contained in the run's evidence haystack? */
  verifyEvidence(run: Run, quote: string | undefined, min = 12): Evidence | undefined {
    const q = normalizeQuote(quote ?? "")
    if (q.length < min) return undefined
    const user = normalizeQuote(run.userText ?? "")
    if (user.includes(q)) return { at: nowIso(), source: "user", text: truncate(oneLine(quote!), 300), sessionID: run.sessionID, project: run.project }
    const hay = normalizeQuote(run.haystack ?? "")
    if (hay.includes(q)) return { at: nowIso(), source: "transcript", text: truncate(oneLine(quote!), 300), sessionID: run.sessionID, project: run.project }
    return undefined
  }

  private requireEvidence(run: Run, quote: string | undefined, what: string): Evidence {
    if (!quote || !quote.trim()) {
      throw new GuardError(`${what} needs "evidence": a short passage copied verbatim from the transcript (user message, tool output or project doc) that supports it`)
    }
    const ev = this.verifyEvidence(run, quote)
    if (!ev) {
      throw new GuardError(
        `evidence for ${what} was not found verbatim in the transcript (≥ 12 characters, copied exactly from a user message, tool output or doc passage). Do not invent facts.`,
      )
    }
    this.scanSecrets(quote)
    return ev
  }

  recurrenceGate(run: Run, kind: Kind, minSessions: number, candidateId?: string, userQuote?: string): void {
    if (userQuote && userQuote.trim()) {
      const q = normalizeQuote(userQuote)
      const hay = normalizeQuote(run.userText ?? "")
      if (q.length < 8) throw new GuardError("user_quote is too short; copy the user's request verbatim")
      if (!hay.includes(q)) throw new GuardError("user_quote does not appear in any user message of the transcript; copy it verbatim")
      return
    }
    if (candidateId && candidateId.trim()) {
      const c = this.d.store.candidate(kind, candidateId.trim())
      if (!c) throw new GuardError(`candidate "${candidateId}" not found`)
      const sessions = new Set(c.sessions)
      if (run.sessionID) sessions.add(run.sessionID)
      if (sessions.size < minSessions) {
        throw new GuardError(
          `candidate "${c.id}" was seen in ${sessions.size} session(s); ${minSessions} are required. Use ${run.smith}_note instead.`,
        )
      }
      return
    }
    if (minSessions <= 1) return
    throw new GuardError(
      `new ${spec(kind).label} entries need evidence of recurrence: pass candidate_id (pattern seen in ≥${minSessions} sessions) or user_quote (the user explicitly asked). Otherwise use ${run.smith}_note.`,
    )
  }

  private content(kind: Kind, a: { name: string; title?: string; description?: string; tags?: unknown; fields?: Record<string, unknown>; body?: string }, base?: Entry): EntryContent {
    const name = a.name.trim()
    return {
      name,
      title: oneLine(a.title ?? base?.title ?? name),
      description: oneLine(a.description ?? base?.description ?? ""),
      tags: a.tags !== undefined ? normalizeTags(a.tags) : (base?.tags ?? []),
      fields: { ...(base?.fields ?? {}), ...(a.fields ?? {}) },
      body: (a.body ?? base?.body ?? "").trim(),
    }
  }

  // ---------------------------------------------------------------------------
  // generic operations
  // ---------------------------------------------------------------------------

  async create(run: Run, kind: Kind, a: CreateArgs): Promise<string> {
    if (run.actor === "curator") throw new GuardError("the curator cannot create entries; merge existing ones instead")
    // the only exception: memorysmith suggests tasks (first column, marked; only the user plans them)
    const suggestion = kind === "task" && run.smith === "memorysmith" && a.fields?.suggested === true
    if (spec(kind).userOwned && !isUser(run) && !suggestion) throw new GuardError(`${spec(kind).labelPlural} are created by the user only`)
    if (kind === "glossary") return this.glossaryUpsert(run, { term: str(a.fields?.term) || a.name, meanings: meaningsOf(a.fields?.meanings), aliases: strArray(a.fields?.aliases), tags: a.tags, reason: a.reason, evidence: a.evidence, approved: a.approved })
    if (kind === "script" && !a.approved) throw new GuardError("scripts are created through toolsmith_draft / toolsmith_publish")
    const c = this.content(kind, a)
    const metaPatch: Partial<Meta> = {}
    const approved = a.approved || isUser(run)
    if (!a.approved) this.budget(run, "create", kind)
    if (kind === "error") {
      c.fields.status = str(c.fields.status) === "open" ? "open" : "solved"
      c.fields.signatures = strArray(c.fields.signatures)
      c.fields.context = strArray(c.fields.context)
    }
    if (!approved) {
      if (kind === "skill") this.recurrenceGate(run, kind, this.o().recurrenceMinSessions, a.candidateId, a.userQuote)
      if (kind === "knowledge") {
        const ev = this.requireEvidence(run, a.evidence, "new knowledge")
        metaPatch.evidence = [ev]
        metaPatch.verifiedAt = nowIso()
      }
      if (kind === "error") this.errorGate(run, c, a, metaPatch)
      if (kind === "memory") {
        metaPatch.evidence = [this.requireEvidence(run, a.evidence, "a memory")]
        metaPatch.verifiedAt = nowIso()
      }
    } else if (kind === "knowledge") {
      metaPatch.verifiedAt = nowIso()
    }
    const tagNotes = kind === "task" || kind === "project" ? [] : await this.planTags(run, kind, c)
    const warnings = this.validate(kind, c, isUser(run))
    warnings.push(...tagNotes)
    if (this.d.store.fresh(kind, c.name) || (kind === "skill" && this.d.store.get("skill", c.name))) {
      throw new GuardError(`a ${spec(kind).label} entry named "${c.name}" already exists; update it or choose another name`)
    }
    if (!a.approved) await this.duplicateGate(run, kind, c)
    const cm = await this.contentMeta(run, kind, c.body, undefined, metaPatch, a.sources, approved)
    warnings.push(...cm.warnings)
    const crossStage = await this.crossGate(run, kind, c.name, cm, approved)
    const args = { name: c.name, title: c.title, description: c.description, tags: c.tags, fields: c.fields, body: c.body, reason: a.reason, candidateId: a.candidateId || undefined, userQuote: a.userQuote || undefined, evidence: a.evidence || undefined, chainId: a.chainId || undefined, sources: a.sources }
    const diverted = this.divert(run, "create", kind, c.name, a.reason, args, crossStage)
    if (diverted) return diverted
    await this.awaitClaims(
      run,
      [...this.claims(kind, c.name), ...(a.candidateId ? [this.d.store.candidatePath(kind, a.candidateId)] : [])],
      `${kind} "${c.name}"`,
    )
    if (this.d.store.fresh(kind, c.name)) throw new GuardError(`a ${spec(kind).label} entry named "${c.name}" already exists`)
    const folder = a.folder ?? (kind === "knowledge" && !isUser(run) ? this.o().docsmith.folder || undefined : undefined)
    await this.d.store.create(run, kind, c, { reason: a.reason, meta: metaPatch, folder })
    if (a.candidateId && this.d.store.candidate(kind, a.candidateId)) await this.d.store.markCandidatePromoted(run, kind, a.candidateId, c.name)
    this.applied(run, "create", kind, c.name, a.reason, a.candidateId ? `candidate ${a.candidateId}` : a.userQuote ? "user request" : a.chainId ? `chain ${a.chainId}` : undefined)
    return `created ${spec(kind).label} "${c.name}"${warnings.length ? `\nwarnings: ${warnings.join("; ")}` : ""}`
  }

  private errorGate(run: Run, c: EntryContent, a: CreateArgs, metaPatch: Partial<Meta>): void {
    const chains = run.chains ?? []
    if (!a.chainId) {
      throw new GuardError(`a new error entry needs chain_id (one of ${chains.map((x) => x.id).join(", ") || "none"}) from ERROR CHAINS`)
    }
    const chain = chains.find((x) => x.id === a.chainId)
    if (!chain) throw new GuardError(`chain "${a.chainId}" not found in this transcript`)
    const status = str(c.fields.status)
    if (status === "solved" && !chain.resolved) {
      const userConfirmed = a.userQuote && normalizeQuote(run.userText ?? "").includes(normalizeQuote(a.userQuote)) && normalizeQuote(a.userQuote).length >= 8
      if (!userConfirmed) {
        throw new GuardError(`chain ${chain.id} was not resolved in the transcript; use status "open" (needs ≥${this.o().errorsmith.openMinSessions} sessions) or pass user_quote where the user confirms the fix`)
      }
    }
    if (status === "open" && chain.sessions < this.o().errorsmith.openMinSessions) {
      throw new GuardError(
        `unsolved error seen in ${chain.sessions} session(s); an open entry needs ≥${this.o().errorsmith.openMinSessions}. Use errorsmith_note to remember it.`,
      )
    }
    const sigs = strArray(c.fields.signatures)
    if (!sigs.includes(chain.signature)) sigs.unshift(chain.signature)
    c.fields.signatures = sigs.slice(0, 12)
    const ctx = strArray(c.fields.context)
    if (chain.head && !ctx.includes(chain.head)) ctx.unshift(chain.head)
    c.fields.context = ctx.slice(0, 8)
    metaPatch.evidence = [{ at: nowIso(), source: "tool", text: truncate(oneLine(chain.error), 300), sessionID: run.sessionID, project: run.project }]
    metaPatch.verifiedAt = nowIso()
  }

  async update(run: Run, kind: Kind, a: UpdateArgs, action: ActionKind = "update"): Promise<string> {
    const rec = this.requireOwned(kind, a.name)
    const proposal = this.aiGate(run, kind, a.name, "content")
    if (!a.approved) this.budget(run, action, kind)
    const c = this.content(kind, a, rec)
    const metaPatch: Partial<Meta> = {}
    const approved = a.approved || isUser(run)
    const contentChanged = c.title !== rec.title || c.description !== rec.description || c.body !== rec.body
    if (kind === "knowledge" && !approved && (contentChanged || a.evidence)) {
      const ev = this.requireEvidence(run, a.evidence, `the change to "${a.name}"`)
      metaPatch.evidence = [ev]
      metaPatch.verifiedAt = nowIso()
    }
    if (kind === "memory" && !approved && (contentChanged || a.evidence)) {
      metaPatch.evidence = [this.requireEvidence(run, a.evidence, `the change to "${a.name}"`), ...(rec.meta?.evidence ?? [])].slice(0, 5)
      metaPatch.verifiedAt = nowIso()
    }
    // an evidenced content change resolves noted doubts
    if (kind === "knowledge" && contentChanged && rec.meta?.doubts?.length && (metaPatch.evidence || approved)) metaPatch.doubts = undefined
    // the user's own documents keep their free form, also when the AI proposes a change
    const warnings = this.validate(kind, c, isUser(run) || isOwnDoc(rec))
    // changed tags of background agents are mapped onto the existing vocabulary
    if (this.sim?.tagPlan && !isUser(run) && !a.approved && JSON.stringify(c.tags) !== JSON.stringify(rec.tags) && c.tags.length) {
      try {
        const plan = await this.sim.tagPlan(kind, c)
        c.tags = plan.tags
        if (plan.notes.length) warnings.push(`tags: ${plan.notes.join("; ")}`)
      } catch {
        // keep the given tags
      }
    }
    const changed =
      c.title !== rec.title ||
      c.description !== rec.description ||
      c.body !== rec.body ||
      JSON.stringify(c.tags) !== JSON.stringify(rec.tags) ||
      JSON.stringify(c.fields) !== JSON.stringify(rec.fields)
    if (!changed && !metaPatch.evidence && !a.repinAnchors?.length) return `"${a.name}" unchanged`
    const cm = await this.contentMeta(run, kind, c.body, rec, metaPatch, a.sources, approved, a.repinAnchors)
    warnings.push(...cm.warnings)
    const crossStage = proposal ? undefined : await this.crossGate(run, kind, a.name, cm, approved)
    const args = { name: c.name, title: c.title, description: c.description, tags: c.tags, fields: c.fields, body: c.body, reason: a.reason, evidence: a.evidence, sources: a.sources, repinAnchors: a.repinAnchors }
    const diverted = this.divert(run, action, kind, a.name, a.reason, args, proposal ?? crossStage)
    if (diverted) return diverted
    await this.awaitClaims(run, this.claims(kind, a.name), `${kind} "${a.name}"`)
    await this.d.store.update(
      run,
      kind,
      a.name,
      { title: c.title, description: c.description, tags: c.tags, fields: c.fields, body: c.body, baseVersion: a.baseVersion || undefined },
      action,
      a.reason,
      metaPatch,
    )
    this.applied(run, action, kind, a.name, a.reason)
    return `updated ${spec(kind).label} "${a.name}"${warnings.length ? `\nwarnings: ${warnings.join("; ")}` : ""}`
  }

  async patch(run: Run, kind: Kind, a: { name: string; oldText: string; newText: string; reason?: string; evidence?: string; approved?: boolean; sources?: SourceArg[] }): Promise<string> {
    const rec = this.requireOwned(kind, a.name)
    const proposal = this.aiGate(run, kind, a.name, "content")
    if (!a.approved) this.budget(run, "patch", kind)
    if (!a.oldText) throw new GuardError("old_text is required (exact text to replace)")
    if (a.oldText === a.newText) throw new GuardError("old_text and new_text are identical")
    const occurrences = rec.body.split(a.oldText).length - 1
    if (occurrences === 0) throw new GuardError(`old_text not found in "${a.name}"; read it again and copy the text exactly`)
    if (occurrences > 1) throw new GuardError(`old_text occurs ${occurrences} times in "${a.name}"; include more surrounding text`)
    this.scanSecrets(a.newText)
    const metaPatch: Partial<Meta> = {}
    if (kind === "knowledge" && !a.approved && !isUser(run)) {
      metaPatch.evidence = [this.requireEvidence(run, a.evidence, `the change to "${a.name}"`)]
      metaPatch.verifiedAt = nowIso()
    }
    if (kind === "knowledge" && rec.meta?.doubts?.length) metaPatch.doubts = undefined
    const patched = rec.body.replace(a.oldText, () => a.newText)
    const pcm = await this.contentMeta(run, kind, patched, rec, metaPatch, a.sources, !!a.approved || isUser(run))
    const patchWarnings = pcm.warnings
    const crossStage = proposal ? undefined : await this.crossGate(run, kind, a.name, pcm, !!a.approved)
    const diverted = this.divert(run, "patch", kind, a.name, a.reason, { name: a.name, oldText: a.oldText, newText: a.newText, reason: a.reason, evidence: a.evidence, sources: a.sources }, proposal ?? crossStage)
    if (diverted) return diverted
    await this.awaitClaims(run, this.claims(kind, a.name), `${kind} "${a.name}"`)
    const max = this.maxBody(kind)
    await this.d.store.patchBody(
      run,
      kind,
      a.name,
      a.oldText,
      a.newText,
      a.reason,
      (body) => {
        const err = validateBody(body, max)
        if (err) throw new GuardError(`patched body invalid: ${err}`)
      },
      metaPatch,
    )
    this.applied(run, "patch", kind, a.name, a.reason)
    return `patched "${a.name}"${patchWarnings.length ? `\nwarnings: ${patchWarnings.join("; ")}` : ""}`
  }

  async merge(
    run: Run,
    kind: Kind,
    a: { sources: string[]; target: string; title?: string; description: string; tags?: unknown; fields?: Record<string, unknown>; body: string; reason?: string; approved?: boolean },
  ): Promise<string> {
    const target = a.target.trim()
    const sources = [...new Set((a.sources ?? []).map((s) => s.trim()).filter(Boolean))]
    if (sources.length < 2 && !(sources.length === 1 && sources[0] !== target)) {
      throw new GuardError("merge needs at least two distinct entries (sources plus target)")
    }
    for (const s of sources) {
      const rec = this.requireOwned(kind, s)
      if (rec.meta?.pinned && s !== target) throw new GuardError(`"${s}" is pinned and cannot be absorbed; use it as target instead`)
      this.aiGate(run, kind, s, "tier")
    }
    if (this.d.store.getOwned(kind, target)) this.aiGate(run, kind, target, "tier")
    const existing = this.d.store.get(kind, target)
    if (existing && !existing.owned) throw new GuardError(`target "${target}" is a foreign skill`)
    if (existing && !sources.includes(target)) sources.push(target)
    if (!a.approved) this.budget(run, "merge", kind)
    // union of tags/fields of all sources unless given
    const recs = sources.map((s) => this.d.store.getOwned(kind, s)!).filter(Boolean)
    const tags = a.tags !== undefined ? normalizeTags(a.tags) : normalizeTags(recs.flatMap((r) => r.tags))
    let fields = a.fields ?? {}
    if (kind === "error") {
      fields = {
        status: str(a.fields?.status) || (recs.some((r) => r.fields.status === "solved") ? "solved" : "open"),
        signatures: [...new Set([...strArray(a.fields?.signatures), ...recs.flatMap((r) => strArray(r.fields.signatures))])].slice(0, 12),
        context: [...new Set([...strArray(a.fields?.context), ...recs.flatMap((r) => strArray(r.fields.context))])].slice(0, 8),
      }
    }
    const c = this.content(kind, { name: target, title: a.title, description: a.description, tags, fields, body: a.body }, existing ?? undefined)
    const tagNotes = await this.planTags(run, kind, c)
    const warnings = this.validate(kind, c)
    warnings.push(...tagNotes)
    const diverted = this.divert(run, "merge", kind, target, a.reason, { sources, target, title: c.title, description: c.description, tags: c.tags, fields: c.fields, body: c.body, reason: a.reason })
    if (diverted) return diverted
    await this.awaitClaims(run, this.claims(kind, ...sources, target), `${kind} ${[...new Set([...sources, target])].join(", ")}`)
    await this.d.store.merge(run, kind, { sources, content: c, reason: a.reason })
    if (this.o().provenance?.enabled && PROVENANCE_KINDS.includes(kind)) {
      // paragraphs taken over unchanged keep the sources they had in their entry
      const union: Record<string, ProvenanceSource[]> = {}
      for (const r of recs) for (const [k, v] of Object.entries(r.meta?.provenance ?? {})) union[k] = [...(union[k] ?? []), ...v]
      const general: ProvenanceSource[] = isUser(run) ? [{ type: "user", at: nowIso(), runId: run.id, scope: "change" }] : recs.map((r) => ({ type: "doc" as const, ref: `${kind}:${r.name}`, at: nowIso(), runId: run.id, scope: "change" as const }))
      const next = nextProvenance(c.body, union, general)
      await this.d.store.editMeta(run, kind, target, (m) => {
        m.provenance = next.provenance
      })
    }
    this.applied(run, "merge", kind, target, a.reason, `absorbed ${sources.filter((s) => s !== target).join(", ")}`)
    return `merged ${sources.filter((s) => s !== target).join(", ")} into "${target}" (absorbed entries archived)${warnings.length ? `\nwarnings: ${warnings.join("; ")}` : ""}`
  }

  async move(
    run: Run,
    kind: Kind,
    a: { name: string; to: Tier; kind: "archive" | "restore" | "dormant" | "activate"; reason?: string; approved?: boolean },
  ): Promise<string> {
    const rec = this.requireOwned(kind, a.name)
    if (!spec(kind).tiers.includes(a.to)) throw new GuardError(`${spec(kind).label} entries have no tier "${a.to}"`)
    if (rec.tier === a.to) return `"${a.name}" is already ${a.to}`
    if ((a.kind === "archive" || a.kind === "dormant") && rec.meta?.pinned) throw new GuardError(`"${a.name}" is pinned`)
    this.aiGate(run, kind, a.name, "tier")
    if (!a.approved) this.budget(run, a.kind, kind)
    const diverted = this.divert(run, a.kind, kind, a.name, a.reason, { name: a.name, to: a.to, kind: a.kind, reason: a.reason })
    if (diverted) return diverted
    await this.awaitClaims(run, this.claims(kind, a.name), `${kind} "${a.name}"`)
    await this.d.store.move(run, kind, a.name, a.to, a.kind, a.reason, a.to === "active" ? { absorbedInto: undefined } : undefined)
    this.applied(run, a.kind, kind, a.name, a.reason, `${rec.tier} → ${a.to}`)
    return `${a.name}: ${rec.tier} → ${a.to}`
  }

  async note(
    run: Run,
    kind: Kind,
    a: { summary: string; keywords: string[]; candidateId?: string; fixedId?: string; internal?: boolean },
  ): Promise<string> {
    if (!a.internal && run.notes >= run.limits.maxNotes) throw new GuardError(`note limit reached (${run.limits.maxNotes})`)
    const summary = oneLine(a.summary ?? "")
    if (summary.length < 6) throw new GuardError("summary is too short; describe the reusable pattern in one sentence")
    this.scanSecrets(summary, (a.keywords ?? []).join(" "))
    const input = {
      id: a.candidateId?.trim() || undefined,
      fixedId: a.fixedId,
      summary: truncate(summary, 300),
      keywords: (a.keywords ?? []).slice(0, 12),
      sessionID: run.sessionID,
    }
    let semantic: { id: string; similarity: number } | undefined
    if (!input.id && !input.fixedId && this.sim) {
      try {
        semantic = await this.sim.matchCandidate(kind, `${input.summary}\nKeywords: ${input.keywords.join(", ")}`)
      } catch {
        semantic = undefined
      }
      if (semantic) input.id = semantic.id
    }
    let result: Awaited<ReturnType<Store["noteCandidate"]>> | undefined
    for (let attempt = 0; !result; attempt++) {
      try {
        result = await this.d.store.noteCandidate(run, kind, input, { checkClaims: this.d.checkClaims })
      } catch (err) {
        if (!(err instanceof ClaimedError) || attempt > 0) {
          if (err instanceof ClaimedError) throw new GuardError(err.message + "; skip this note for now")
          if (err instanceof StoreError) throw new GuardError(err.message)
          throw err
        }
        await this.awaitClaims(run, [err.path], `candidate ${err.path}`)
      }
    }
    const { candidate, created } = result
    if (!a.internal) run.notes++
    run.actions.push({ kind: "note", target: kind, name: candidate.id, reason: truncate(summary, 200), applied: true })
    const min = kind === "script" ? this.o().toolsmith.recurrenceMinSessions : kind === "error" ? this.o().errorsmith.openMinSessions : this.o().recurrenceMinSessions
    return `${created ? "new" : "updated"} candidate "${candidate.id}"${semantic ? ` (same pattern, similarity ${semantic.similarity.toFixed(2)})` : ""} – seen in ${candidate.sessions.length} session(s)${
      candidate.sessions.length >= min ? `; it now qualifies (candidate_id="${candidate.id}")` : ` (needs ${min})`
    }`
  }

  async pin(run: Run, kind: Kind, name: string, pinned: boolean): Promise<string> {
    this.requireOwned(kind, name)
    await this.awaitClaims(run, this.claims(kind, name), `${kind} "${name}"`)
    await this.d.store.setPinned(run, kind, name, pinned)
    this.applied(run, pinned ? "pin" : "unpin", kind, name)
    return `${name}: ${pinned ? "pinned" : "unpinned"}`
  }

  /** knowledge: note a possible contradiction / doubt on an entry (shown to every reader). */
  async flagKnowledge(run: Run, a: { name: string; note: string; related?: string; approved?: boolean }): Promise<string> {
    const rec = this.requireOwned("knowledge", a.name)
    this.aiGate(run, "knowledge", a.name, "meta")
    const note = truncate(oneLine(a.note ?? ""), 300)
    if (note.length < 8) throw new GuardError("note is too short; describe the doubt in one sentence")
    if (a.related && !this.d.store.getOwned("knowledge", a.related.trim())) throw new GuardError(`related entry "${a.related}" not found`)
    this.scanSecrets(note)
    if (!a.approved) this.budget(run, "flag", "knowledge")
    const diverted = this.divert(run, "flag", "knowledge", a.name, note, { name: a.name, note, related: a.related })
    if (diverted) return diverted
    await this.awaitClaims(run, this.claims("knowledge", a.name), `knowledge "${a.name}"`)
    const doubts = [...(rec.meta?.doubts ?? []), { at: nowIso(), note, ...(a.related ? { related: a.related.trim() } : {}), runId: run.id }].slice(-5)
    await this.d.store.updateMeta(run, "knowledge", a.name, { doubts }, "flag", note)
    this.applied(run, "flag", "knowledge", a.name, note)
    return `flagged "${a.name}": ${note}`
  }

  async adopt(run: Run, name: string): Promise<string> {
    await this.awaitClaims(run, this.claims("skill", name), `skill "${name}"`)
    try {
      await this.d.store.adopt(run, name)
    } catch (err) {
      if (err instanceof StoreError) throw new GuardError(err.message)
      throw err
    }
    this.applied(run, "adopt", "skill", name)
    return `adopted "${name}" into the skillsmith store (active)`
  }

  // ---------------------------------------------------------------------------
  // memory-smith
  // ---------------------------------------------------------------------------

  /**
   * Save a durable memory (decision, convention, experience). Same type + topic in the
   * same project = the same entry (update). Gates: evidence for every memory; a decision
   * is "gueltig" only with the user's own words, otherwise "vorgeschlagen"; conventions
   * need the user's words.
   */
  async memorySave(run: Run, a: MemorySaveArgs): Promise<string> {
    const type = oneLine(a.type ?? "").toLowerCase()
    if (!(MEMORY_TYPES as readonly string[]).includes(type)) {
      throw new GuardError(`type must be one of ${MEMORY_TYPES.join(", ")} (work states: memorysmith_state, results: memorysmith_result)`)
    }
    const scope = a.scope === "global" ? "global" : "projekt"
    const topic = topicKey(type, a.topic || a.title || "")
    let name = memoryName(scope === "global" ? "global" : a.where.projectSlug, topic)
    const clash = this.d.store.get("memory", name)
    if (clash && scope === "projekt" && str(clash.fields.project) && str(clash.fields.project) !== a.where.project) {
      name = memoryName(`${a.where.projectSlug}-${shortHash(a.where.project)}`, topic)
    }
    const approved = a.approved || isUser(run)
    let status = "gueltig"
    let decidedBy = "user"
    let ev: Evidence | undefined
    if (!approved) {
      ev = this.requireEvidence(run, a.evidence, `a ${type}`)
      if (type === "vorgabe" && ev.source !== "user") {
        throw new GuardError("a convention (vorgabe) needs the user's own words as evidence – quote the user message that sets the rule")
      }
      if (type === "entscheidung" && ev.source !== "user") {
        status = "vorgeschlagen"
        decidedBy = "agent"
      }
    } else if (a.status && ["gueltig", "vorgeschlagen", "abgeloest"].includes(a.status)) {
      status = a.status
    }
    const existing = this.d.store.getOwned("memory", name)
    const today = nowIso().slice(0, 10)
    const reviewAfter = new Date(Date.now() + this.o().memorysmith.decisionReviewDays * 86_400_000).toISOString().slice(0, 10)
    const fields: Record<string, unknown> = {
      ...(existing?.fields ?? {}),
      type,
      scope,
      project: scope === "global" ? "" : a.where.project,
      project_name: scope === "global" ? "" : a.where.projectName,
      topic,
      status: existing && str(existing.fields.status) === "gueltig" && status === "vorgeschlagen" && type === "entscheidung" ? "gueltig" : status,
      decided_by: type === "entscheidung" ? decidedBy : "",
      valid_from: existing ? str(existing.fields.valid_from) || today : today,
      review_after: type === "entscheidung" ? reviewAfter : "",
      superseded_by: "",
      branch: a.where.branch ?? str(existing?.fields.branch),
      ticket: a.where.ticket ?? str(existing?.fields.ticket),
    }
    let msg: string
    if (existing) {
      msg = await this.update(run, "memory", {
        name,
        title: a.title,
        description: a.summary,
        tags: a.tags,
        fields,
        body: a.body,
        reason: a.reason,
        evidence: a.evidence,
        approved: a.approved,
      })
      if (existing.tier === "archive" && !/^(staged|recorded)/.test(msg)) msg += `
${await this.move(run, "memory", { name, to: "active", kind: "restore", reason: "saved again", approved: true })}`
    } else {
      msg = await this.create(run, "memory", {
        name,
        title: a.title,
        description: a.summary,
        tags: a.tags,
        fields,
        body: a.body,
        reason: a.reason,
        evidence: a.evidence,
        approved: a.approved,
      })
    }
    if (a.supersedes && a.supersedes.trim()) msg += `
${await this.memorySupersede(run, { old: a.supersedes.trim(), by: name, reason: a.reason, approved: true })}`
    const note = fields.status === "vorgeschlagen" ? ' (status "vorgeschlagen": the user did not state or confirm this decision)' : ""
    return `${msg}${note}
memory id: memory:${name} · topic ${topic}`
  }

  /** Mark an older durable memory as replaced by a newer one (status abgeloest, archived, link kept). */
  async memorySupersede(run: Run, a: { old: string; by: string; reason?: string; approved?: boolean }): Promise<string> {
    const oldName = a.old.replace(/^memory:/, "")
    const byName = a.by.replace(/^memory:/, "")
    const old = this.d.store.getOwned("memory", oldName) ?? this.d.store.list("memory").find((e) => str(e.fields.topic) === oldName)
    if (!old) throw new GuardError(`memory "${a.old}" not found`)
    if (!this.d.store.getOwned("memory", byName)) throw new GuardError(`memory "${a.by}" not found`)
    if (old.name === byName) throw new GuardError("a memory cannot supersede itself")
    if (!a.approved) this.budget(run, "supersede", "memory")
    if (!a.approved) {
      // the user's memories: superseding becomes a proposal (KI-Recht vorschlag) or is rejected (lesen, privat)
      const proposal = this.aiGate(run, "memory", old.name, "content")
      if (proposal) return this.divert(run, "supersede", "memory", old.name, a.reason ?? `superseded by ${byName}`, { old: old.name, by: byName, reason: a.reason }, proposal)!
    }
    await this.update(run, "memory", { name: old.name, fields: { ...old.fields, status: "abgeloest", superseded_by: byName }, reason: a.reason ?? `superseded by ${byName}`, approved: true }, "supersede")
    if (old.tier !== "archive") await this.move(run, "memory", { name: old.name, to: "archive", kind: "archive", reason: `superseded by ${byName}`, approved: true })
    return `"${old.name}" is superseded by "${byName}" (archived, link kept)`
  }

  private requireMem(): MemoryDb {
    if (!this.mem?.available) throw new GuardError("the local memory database is not available (SQLite missing); work states and results cannot be stored")
    return this.mem
  }

  private local(run: Run, action: ActionKind, name: string, reason?: string, detail?: string, change?: { before?: unknown; after?: unknown }): void {
    run.actions.push({ kind: action, target: "memory", name, reason: reason ? truncate(oneLine(reason), 300) : undefined, detail, applied: true, local: true })
    // complete before/after for the audit log (local data has no git history)
    if (change) (run.localChanges ??= []).push({ id: name, before: change.before, after: change.after })
    this.count(run, action, "memory")
  }

  /** Work state of the current branch (local, replaces the previous one; the old one stays in its history). */
  async memoryState(run: Run, a: StateArgs): Promise<string> {
    const mem = this.requireMem()
    const clean = (xs: unknown, max: number) =>
      strArray(xs)
        .map((x) => truncate(oneLine(x), 300))
        .filter(Boolean)
        .slice(0, max)
    const goal = truncate(oneLine(a.goal ?? ""), 300)
    const done = clean(a.done, 12)
    const open = clean(a.open, 12)
    const next = clean(a.next, 8)
    const files = clean(a.files, 30)
    if (!goal && !done.length && !open.length && !next.length) throw new GuardError("a work state needs at least a goal, done, open or next items")
    const summary = truncate(oneLine(a.summary || [goal, open.length ? `offen: ${open[0]}` : ""].filter(Boolean).join("; ")), 200)
    this.scanSecrets(goal, summary, done.join("\n"), open.join("\n"), next.join("\n"), files.join(" "))
    if (!a.approved) this.budget(run, "state", "memory")
    const branch = a.where.branch || "main"
    if (run.writeMode === "shadow" && !isUser(run)) return this.divert(run, "state", "memory", branch, "work state", { ...a, where: undefined })!
    const previous = mem.state(a.where.project, branch)
    const { state, created } = mem.upsertState({
      project: a.where.project,
      projectName: a.where.projectName,
      branch,
      ticket: a.where.ticket,
      goal,
      done,
      open,
      next,
      files,
      summary,
      evidence: a.evidence ? truncate(oneLine(a.evidence), 300) : undefined,
      session: run.sessionID,
      run: run.id,
    })
    const plain = (st?: WorkState) => (st ? { ...st, history: undefined } : undefined)
    this.local(run, "state", state.id, a.reason ?? "work state", created ? "new" : "updated", { before: plain(previous), after: plain(state) })
    return `${created ? "saved" : "updated"} work state ${state.id} (${branch})`
  }

  /** Condensed result of a subagent or a research (local, expires unless used or linked). */
  async memoryResult(run: Run, a: ResultArgs): Promise<string> {
    const mem = this.requireMem()
    const title = truncate(oneLine(a.title ?? ""), 120)
    const answer = (a.answer ?? "").trim()
    if (title.length < 6) throw new GuardError("title is too short; say in one line what the result is about")
    if (answer.length < 20) throw new GuardError("answer is too short; write the condensed result")
    if (answer.length > this.o().memorysmith.maxBodyChars) throw new GuardError(`answer is longer than ${this.o().memorysmith.maxBodyChars} characters; condense it`)
    if (!a.approved && !isUser(run)) {
      this.requireEvidence(run, a.evidence, "a result")
      this.budget(run, "result", "memory")
    }
    this.scanSecrets(title, answer, a.question ?? "", strArray(a.files).join(" "), strArray(a.sources).join(" "))
    if (run.writeMode === "shadow" && !isUser(run)) return this.divert(run, "result", "memory", title, a.reason, { ...a, where: undefined })!
    const r = mem.addResult({
      project: a.where.project,
      projectName: a.where.projectName,
      branch: a.where.branch,
      session: run.sessionID,
      title,
      question: truncate(oneLine(a.question ?? ""), 300),
      answer,
      files: strArray(a.files).slice(0, 30),
      sources: strArray(a.sources).slice(0, 20),
      tags: normalizeTags(a.tags).slice(0, 8),
      evidence: a.evidence ? truncate(oneLine(a.evidence), 300) : undefined,
      run: run.id,
    })
    this.local(run, "result", r.id, a.reason ?? title, undefined, { after: r })
    return `saved result ${r.id}`
  }

  // ---------------------------------------------------------------------------
  // relations (all kinds, durable and volatile nodes)
  // ---------------------------------------------------------------------------

  /**
   * Record how two nodes relate. One relation per pair: a new judgement replaces the
   * previous one. Store ↔ store relations live in the meta of the source entry (git),
   * relations with a volatile end in the local memory database.
   */
  async relate(run: Run, a: RelateArgs): Promise<string> {
    const graph = this.graph
    if (!graph) throw new GuardError("relations are not available")
    const type = oneLine(a.type ?? "").toLowerCase() as RelationType
    if (!(RELATION_TYPES as readonly string[]).includes(type)) throw new GuardError(`type must be one of ${RELATION_TYPES.join(", ")}`)
    const fromId = normalizeNodeId(a.from)
    const toId = normalizeNodeId(a.to)
    if (fromId === toId) throw new GuardError("a node cannot relate to itself")
    const fromNode = graph.node(fromId)
    const toNode = graph.node(toId)
    if (!fromNode || (!isUser(run) && graph.hidden(fromId))) throw new GuardError(`node "${a.from}" not found (use ids like skill:<name>, knowledge:<name>, memory:<name>, state:…, result:…)`)
    if (!toNode || (!isUser(run) && graph.hidden(toId))) throw new GuardError(`node "${a.to}" not found`)
    for (const id of [fromId, toId]) {
      const se = isStoreId(id)
      if (se && spec(se.kind).userOwned && !isUser(run)) throw new GuardError(`${spec(se.kind).labelPlural} are linked by the user only`)
    }
    let strength = Number(a.strength ?? (type === "not_related" ? 0 : 0.6))
    if (!Number.isFinite(strength)) strength = 0.6
    if (strength > 1) strength = Math.min(5, strength) / 5
    strength = Math.round(Math.max(0, Math.min(1, strength)) * 100) / 100
    const description = truncate(oneLine(a.description ?? ""), 300)
    if (type !== "not_related" && description.length < 8) throw new GuardError("description is required: one sentence that explains the relation")
    this.scanSecrets(description)
    if (!a.approved) this.budget(run, "relate", "memory")
    const { from, to } = canonicalEdge(fromId, toId, type)
    const fromHash = from === fromId ? fromNode.hash : toNode.hash
    const toHash = from === fromId ? toNode.hash : fromNode.hash
    const rel: Relation = { to, type, strength, description, source: a.source ?? (isUser(run) ? "user" : run.smith === "doctor" ? "doctor" : "reviewer"), at: nowIso(), hashes: { from: fromHash, to: toHash }, runId: run.id }
    const fs = isStoreId(from)
    const ts = isStoreId(to)
    const label = `${from} ${type} ${to}`
    const diverted = this.divert(run, "relate", fs?.kind ?? "memory", fs?.name ?? from, a.reason ?? description, { from: fromId, to: toId, type, strength, description, reason: a.reason })
    if (diverted) return diverted
    // one relation per pair: remove previous judgements on both ends
    for (const end of [fs, ts]) {
      if (!end) continue
      const other = end === fs ? to : from
      const rec = this.d.store.getOwned(end.kind, end.name)
      const rels = rec?.meta?.relations ?? []
      const kept = rels.filter((r) => r.to !== other)
      const isTarget = end === fs && ts
      if (!rec || (kept.length === rels.length && !isTarget)) continue
      await this.awaitClaims(run, this.claims(end.kind, end.name), `${end.kind} "${end.name}"`)
      await this.d.store.updateMeta(run, end.kind, end.name, { relations: isTarget ? [...kept, rel].slice(-200) : kept }, "relate", label)
    }
    if (fs && ts) {
      this.applied(run, "relate", fs.kind, fs.name, a.reason ?? description, `${type} → ${to}`)
    } else {
      const mem = this.requireMem()
      const before = mem.relationsOf(from).find((r) => (r.from === from && r.to === to) || (r.from === to && r.to === from))
      mem.deleteRelationBetween(from, to)
      mem.addRelation(from, rel)
      this.local(run, "relate", from, a.reason ?? description, `${type} → ${to}`, { before, after: { from, ...rel } })
    }
    return `related ${from} –${type}→ ${to} (strength ${strength})`
  }

  // ---------------------------------------------------------------------------
  // glossary
  // ---------------------------------------------------------------------------

  /**
   * Create or extend a glossary entry. Meanings are merged deterministically:
   * same expansion → description/context updated, new expansion → appended.
   * Reviewer runs must find term and every new expansion in the transcript.
   */
  async glossaryUpsert(
    run: Run,
    a: { term: string; meanings: GlossaryMeaning[]; aliases?: string[]; tags?: unknown; reason?: string; evidence?: string; approved?: boolean },
  ): Promise<string> {
    const term = oneLine(a.term ?? "")
    if (!term) throw new GuardError("term is required")
    const approved = a.approved || isUser(run)
    const input = meaningsOf(a.meanings)
    if (input.length === 0) throw new GuardError("at least one meaning with expansion and description is required")
    const existing = this.d.store.glossaryByTerm(term).sort((x, y) => (x.tier === "active" ? -1 : 1) - (y.tier === "active" ? -1 : 1))[0]
    const current = existing ? meaningsOf(existing.fields.meanings) : []
    const merged = current.map((m) => ({ ...m }))
    const added: string[] = []
    for (const m of input) {
      const same = merged.find((x) => normalizeQuote(x.expansion) === normalizeQuote(m.expansion))
      if (same) {
        if (m.description && m.description !== same.description) same.description = m.description
        if (m.context && m.context !== same.context) same.context = m.context
      } else {
        merged.push(m)
        added.push(m.expansion)
      }
    }
    if (!approved) {
      const hay = normalizeQuote(`${run.userText ?? ""} ${run.haystack ?? ""}`)
      const t = normalizeQuote(term)
      if (!t || !` ${hay} `.includes(` ${t} `)) throw new GuardError(`term "${term}" does not occur in the transcript`)
      for (const exp of added) {
        if (!hay.includes(normalizeQuote(exp))) {
          throw new GuardError(
            `the meaning "${exp}" of ${term} is not stated in the transcript or project docs. Never guess expansions – leave the abbreviation open (it is tracked as an open glossary candidate).`,
          )
        }
      }
    }
    const aliases = [...new Set([...(existing ? strArray(existing.fields.aliases) : []), ...(a.aliases ?? []).map((x) => oneLine(x)).filter(Boolean)])].filter(
      (x) => normalizeQuote(x) !== normalizeQuote(term),
    )
    let tags = normalizeTags([...(existing?.tags ?? []), ...strArray(a.tags)])
    const name = existing?.name ?? this.uniqueGlossaryName(term)
    const c: EntryContent = {
      name,
      title: existing ? String(existing.fields.term) : term,
      description: merged.map((m) => m.expansion).join(" / "),
      tags,
      fields: { ...(existing?.fields ?? {}), term: existing ? String(existing.fields.term) : term, aliases, meanings: merged },
      body: existing?.body ?? "",
    }
    if (!tags.length) c.tags = tags = deriveTags("glossary", c)
    this.validate("glossary", c)
    const unchanged = !!existing && JSON.stringify(c.fields) === JSON.stringify(existing.fields) && JSON.stringify(c.tags) === JSON.stringify(existing.tags)
    if (unchanged && existing!.tier === "active") return `glossary "${term}" unchanged`
    if (!a.approved) this.budget(run, "upsert", "glossary")
    const evidence: Evidence[] = added.length
      ? [{ at: nowIso(), source: isUser(run) ? "command" : "transcript", text: truncate(`${term} = ${added.join(" / ")}`, 300), sessionID: run.sessionID, project: run.project }]
      : []
    const proposal = existing ? this.aiGate(run, "glossary", name, "content") : undefined
    const diverted = this.divert(run, "upsert", "glossary", name, a.reason, { term, meanings: input, aliases: a.aliases ?? [], tags: c.tags, reason: a.reason }, proposal)
    if (diverted) return diverted
    await this.awaitClaims(run, [...this.claims("glossary", name), this.d.store.candidatePath("glossary", `abbr-${glossarySlug(term)}`)], `glossary "${term}"`)
    if (existing) {
      if (!unchanged) {
        await this.d.store.update(run, "glossary", name, { title: c.title, description: c.description, tags: c.tags, fields: c.fields }, "upsert", a.reason, {
          evidence,
          ...(added.length ? { verifiedAt: nowIso() } : {}),
        })
      }
      if (existing.tier !== "active") await this.d.store.move(run, "glossary", name, "active", "restore", "term used again")
    } else {
      await this.d.store.create(run, "glossary", c, { reason: a.reason, action: "create", meta: { evidence, verifiedAt: nowIso() } })
    }
    const candId = `abbr-${glossarySlug(term)}`
    const cand = this.d.store.candidate("glossary", candId)
    if (cand && !cand.promotedTo) await this.d.store.markCandidatePromoted(run, "glossary", candId, name)
    this.applied(run, "upsert", "glossary", name, a.reason, added.length ? `+${added.join(" / ")}` : "updated")
    return `${existing ? "updated" : "added"} glossary ${term}: ${merged.map((m) => m.expansion).join(" / ")}`
  }

  private uniqueGlossaryName(term: string): string {
    const base = glossarySlug(term)
    let name = base
    for (let i = 2; this.d.store.fresh("glossary", name); i++) name = `${base}-${i}`
    return name
  }

  async ignoreTerms(run: Run, terms: string[]): Promise<string> {
    const clean = terms.map((t) => oneLine(t)).filter(Boolean)
    if (!clean.length) throw new GuardError("no term given")
    await this.awaitClaims(run, ["glossary-ignore.json"], "glossary ignore list")
    await this.d.store.addIgnoredTerms(run, clean)
    for (const t of clean) this.applied(run, "ignore", "glossary", glossarySlug(t))
    return `ignored: ${clean.join(", ")}`
  }

  // ---------------------------------------------------------------------------
  // scripts (toolsmith)
  // ---------------------------------------------------------------------------

  async publishScript(run: Run, a: PublishArgs): Promise<string> {
    const kind: Kind = "script"
    const c = a.content
    const tagNotes = a.approved ? [] : await this.planTags(run, kind, c)
    if (!c.tags.length) c.tags = deriveTags(kind, c)
    const warnings = this.validate(kind, c)
    warnings.push(...tagNotes)
    const existing = this.d.store.getOwned(kind, c.name)
    if (a.isNew && existing) throw new GuardError(`a script named "${c.name}" already exists; revise it instead`)
    if (!a.isNew && !existing) throw new GuardError(`script "${c.name}" not found`)
    const action: ActionKind = a.isNew ? "create" : "update"
    if (!a.approved) this.budget(run, action, kind)
    if (a.isNew && !a.approved) await this.duplicateGate(run, kind, c)
    const args = { ...a, approved: undefined }
    const proposal = existing && !a.approved ? this.aiGate(run, kind, c.name, "content") : undefined
    const diverted = a.approved ? undefined : this.divert(run, action, kind, c.name, a.reason, args as unknown as Record<string, unknown>, a.needsApproval ?? proposal)
    if (diverted) return diverted
    await this.awaitClaims(
      run,
      [...this.claims(kind, c.name), ...(a.candidateId ? [this.d.store.candidatePath(kind, a.candidateId)] : [])],
      `script "${c.name}"`,
    )
    if (a.isNew) {
      await this.d.store.create(run, kind, c, { reason: a.reason, files: a.files, meta: { test: a.test } })
      if (a.candidateId && this.d.store.candidate(kind, a.candidateId)) await this.d.store.markCandidatePromoted(run, kind, a.candidateId, c.name)
    } else {
      await this.d.store.update(run, kind, c.name, { description: c.description, tags: c.tags, fields: c.fields, body: c.body, files: a.files }, "update", a.reason, {
        test: a.test,
      })
    }
    this.applied(run, action, kind, c.name, a.reason, `tests ${a.test.status}`)
    return `${a.isNew ? "published" : "updated"} script "${c.name}" (tests ${a.test.status})${warnings.length ? `\nwarnings: ${warnings.join("; ")}` : ""}`
  }

  async setTestStatus(run: Run, name: string, test: TestStatus, reason?: string): Promise<void> {
    await this.awaitClaims(run, this.claims("script", name), `script "${name}"`)
    await this.d.store.updateMeta(run, "script", name, { test }, "retest", reason)
    this.applied(run, "retest", "script", name, reason, test.status)
  }

  // ---------------------------------------------------------------------------
  // staging
  // ---------------------------------------------------------------------------

  staged(): StagedChange[] {
    return listFiles(this.stagedDir, ".json")
      .map((f) => readJson<StagedChange | null>(join(this.stagedDir, f), null))
      .filter((s): s is StagedChange => !!s)
      .map((s) => ({ ...s, target: s.target ?? "skill", name: s.name ?? (s as any).skill, action: s.action ?? (s as any).kind }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  rejectStaged(id: string, reason?: string): boolean {
    const file = join(this.stagedDir, `${id}.json`)
    const change = readJson<StagedChange | null>(file, null)
    if (!change) return false
    removePath(file)
    if (change.aiProposal) {
      // the AI does not repeat a rejected proposal while the document is unchanged
      const all = readJson<Record<string, { version?: string; at: string; reason?: string }>>(this.rejectedFile, {})
      all[`${change.target}:${change.name}`] = { version: this.d.store.getOwned(change.target, change.name)?.version, at: nowIso(), ...(reason ? { reason: truncate(reason, 300) } : {}) }
      writeJsonAtomic(this.rejectedFile, all)
    }
    return true
  }

  async applyStaged(run: Run, change: StagedChange): Promise<string> {
    const a = change.args as any
    const kind = change.target
    let msg: string
    switch (change.action) {
      case "create":
        if (kind === "script") msg = await this.applyStagedScript(run, a)
        else msg = await this.create(run, kind, { ...a, approved: true })
        break
      case "update":
      case "rewrite":
        if (kind === "script" && a.files) msg = await this.applyStagedScript(run, a)
        else msg = await this.update(run, kind, { ...a, approved: true }, change.action)
        break
      case "patch":
        msg = await this.patch(run, kind, { ...a, approved: true })
        break
      case "merge":
        msg = await this.merge(run, kind, { ...a, approved: true })
        break
      case "upsert":
        msg = await this.glossaryUpsert(run, { ...a, approved: true })
        break
      case "flag":
        msg = await this.flagKnowledge(run, { ...a, approved: true })
        break
      case "relate":
        msg = await this.relate(run, { ...a, approved: true })
        break
      case "supersede":
        msg = await this.memorySupersede(run, { ...a, approved: true })
        break
      case "archive":
      case "restore":
      case "dormant":
      case "activate":
        msg = await this.move(run, kind, { ...a, approved: true })
        break
      default:
        throw new GuardError(`cannot apply staged change of kind ${change.action}`)
    }
    removePath(join(this.stagedDir, `${change.id}.json`))
    return msg
  }

  private async applyStagedScript(run: Run, a: PublishArgs): Promise<string> {
    if (this.recheck) {
      const r = await this.recheck(a)
      if (!r.ok) throw new GuardError(`re-check before publishing failed: ${r.message}`)
      if (r.test) a.test = r.test
    }
    return this.publishScript(run, { ...a, approved: true })
  }
}

export function writeModeFor(o: Options, smith: Parameters<typeof smithWriteMode>[1]) {
  return smithWriteMode(o, smith)
}

export interface MemorySaveArgs {
  type: string
  topic: string
  title: string
  summary: string
  body: string
  tags?: unknown
  scope?: "projekt" | "global"
  evidence?: string
  supersedes?: string
  status?: string
  reason?: string
  approved?: boolean
  where: Scope
}

export interface StateArgs {
  goal?: string
  done?: unknown
  open?: unknown
  next?: unknown
  files?: unknown
  summary?: string
  evidence?: string
  reason?: string
  approved?: boolean
  where: Scope
}

export interface ResultArgs {
  title: string
  question?: string
  answer: string
  files?: unknown
  sources?: unknown
  tags?: unknown
  evidence?: string
  reason?: string
  approved?: boolean
  where: Scope
}

export interface RelateArgs {
  from: string
  to: string
  type: string
  strength?: number
  description?: string
  reason?: string
  source?: Relation["source"]
  approved?: boolean
}

/** "memory:x", "skill:y", "state:…", "result:…", "session:…"; a bare name is not accepted. */
export function normalizeNodeId(id: string): string {
  return (id ?? "").trim().replace(/^(skills?|wissen|fehler|errors?|scripts?|skripte?|erinnerung|memories)[:/]/i, (m) => {
    const k = m.slice(0, -1).toLowerCase()
    const map: Record<string, string> = { skills: "skill", wissen: "knowledge", fehler: "error", errors: "error", scripts: "script", skript: "script", skripte: "script", erinnerung: "memory", memories: "memory" }
    return `${map[k] ?? k}:`
  })
}

function shortHash(s: string): string {
  let h = 7
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h.toString(36).slice(0, 4)
}
