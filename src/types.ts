import type { SmithName, WriteMode } from "./config"

export type Smith = SmithName
export type Kind = "skill" | "knowledge" | "glossary" | "error" | "script" | "memory" | "task" | "project" | "agent"
export const KINDS: Kind[] = ["skill", "knowledge", "glossary", "error", "script", "memory", "task", "project", "agent"]
/** kinds the smiths maintain (reviewers, curator, doctor); tasks and projects belong to the user */
export const CONTENT_KINDS: Kind[] = ["skill", "knowledge", "glossary", "error", "script", "memory"]

/** AI access per entry: frei (change), vorschlag (proposals only), lesen (read only), privat (invisible to the AI) */
export type AiAccess = "frei" | "vorschlag" | "lesen" | "privat"
export const AI_ACCESS: AiAccess[] = ["frei", "vorschlag", "lesen", "privat"]

/** memory-smith: durable types live in the store (kind "memory"), volatile ones in state/memory.sqlite */
export const MEMORY_TYPES = ["entscheidung", "vorgabe", "erfahrung"] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]
export const VOLATILE_TYPES = ["arbeitsstand", "ergebnis"] as const
export type VolatileType = (typeof VOLATILE_TYPES)[number]

/** Relations between any two nodes (store entries "kind:name", volatile memories "state:…" / "result:…", sessions "session:…"). */
export const RELATION_TYPES = [
  "not_related",
  "related",
  "supplements",
  "duplicates",
  "contradicts",
  "supersedes",
  "depends_on",
  "part_of",
  "solves",
  "caused_by",
  "derived_from",
  "uses",
  "example_of",
  "references",
] as const
export type RelationType = (typeof RELATION_TYPES)[number]
export const SYMMETRIC_RELATIONS = new Set<RelationType>(["not_related", "related", "duplicates", "contradicts"])

export interface Relation {
  /** node id of the other end */
  to: string
  type: RelationType
  /** 0–1: how useful it is to see `to` when this entry is found */
  strength: number
  description: string
  source: "doctor" | "reviewer" | "deterministic" | "user"
  at: string
  /** content hashes of both ends when the relation was judged (stale detection) */
  hashes?: { from: string; to: string }
  runId?: string
}

export type Tier = "active" | "dormant" | "archive"
export const TIERS: Tier[] = ["active", "dormant", "archive"]

export type Actor = "reviewer" | "curator" | "command" | "web"

/** commands and web actions come from the user: approvals and gates for agents do not apply */
export const isUser = (run: { actor: Actor }): boolean => run.actor === "command" || run.actor === "web"

export interface HistoryEntry {
  at: string
  runId: string
  actor: Actor
  action: string
  reason?: string
}

export interface Evidence {
  at: string
  source: "user" | "tool" | "doc" | "command" | "transcript"
  text: string
  sessionID?: string
  project?: string
}

export interface TestStatus {
  status: "passed" | "failed" | "untested"
  at: string
  python?: string
  sandbox?: string
  summary?: string
}

/** Tracked metadata of every entry (meta/<kind>/<name>.json). Changes only through runs. */
export interface Meta {
  kind: Kind
  name: string
  createdAt: string
  createdBy: Actor
  updatedAt: string
  tierChangedAt: string
  pinned?: boolean
  absorbedInto?: string
  origin?: {
    runId?: string
    sessionID?: string
    agent?: string
    project?: string
    adoptedFrom?: string
  }
  /** projects in which this entry was created/confirmed */
  projects?: string[]
  /** grounding for knowledge / glossary (latest first, capped) */
  evidence?: Evidence[]
  /** last time the content was confirmed by evidence */
  verifiedAt?: string
  /** related entries as "kind:name" */
  related?: string[]
  /** scripts: result of the last test run */
  test?: TestStatus
  /** knowledge: possible contradictions / doubts noted by docsmith (cleared by an evidenced update) */
  doubts?: Array<{ at: string; note: string; related?: string; runId?: string }>
  /** outgoing relations (symmetric ones are stored on the lexicographically smaller node) */
  relations?: Relation[]
  /** code anchors of the text ([[code:…]]): what was anchored and the hash of the code then */
  anchors?: AnchorRecord[]
  /** sources per paragraph (key = hash of the paragraph text) */
  provenance?: Record<string, ProvenanceSource[]>
  history: HistoryEntry[]
}

/** A pinned code anchor (5c). */
export interface AnchorRecord {
  /** reference as written ("TokenStore#revoke", "src/a.ts#L4-L9") */
  ref: string
  /** project (name of a project entry, or the plugin's project) */
  project?: string
  /** file relative to the project root */
  path: string
  kind: "file" | "class" | "method" | "lines"
  symbol?: string
  member?: string
  lines?: [number, number]
  /** declaration line of a class / method */
  signature?: string
  /** hash of the anchored code (whitespace-insensitive) */
  hash: string
  /** HEAD of the project repository when anchored (diff "then ↔ now") */
  commit?: string
  at: string
}

export const PROVENANCE_TYPES = ["transcript", "user", "session", "commit", "ticket", "confluence", "code", "doc", "file", "comment", "url"] as const
export type ProvenanceType = (typeof PROVENANCE_TYPES)[number]

/** Where a statement of a paragraph comes from (5c). */
export interface ProvenanceSource {
  type: ProvenanceType
  /** id of the source: session id, commit, ticket, url, code ref, "kind:name", "datei.pdf#S3" */
  ref?: string
  /** verbatim quote of the source supporting the paragraph */
  quote?: string
  at: string
  runId?: string
  /** the source was given for the whole change, not for this paragraph alone */
  scope?: "paragraph" | "change"
}

export interface GlossaryMeaning {
  expansion: string
  description: string
  context?: string
}

/** A parsed store entry of any kind. */
export interface Entry {
  kind: Kind
  name: string
  title: string
  description: string
  tags: string[]
  /** kind-specific frontmatter fields (term, aliases, meanings, status, signatures, usage, …) */
  fields: Record<string, unknown>
  body: string
  /** owned entries: tier; foreign skills: "foreign" */
  tier: Tier | "foreign"
  owned: boolean
  /** directory of the entry (dir layout) or of its tier (file layout) */
  dir: string
  /** main file */
  file: string
  /** content hash of the main file (12 hex chars) */
  version: string
  meta?: Meta
  /** foreign: discovery root label */
  source?: string
  /** knowledge: folder below the tier ("" = main folder, "projekte/shop") */
  folder?: string
}

/** Back-compat alias used by older call sites. */
export type SkillRecord = Entry

export interface Candidate {
  kind: Kind
  id: string
  summary: string
  keywords: string[]
  sessions: string[]
  count: number
  createdAt: string
  updatedAt: string
  promotedTo?: string
}

/** Untracked usage telemetry (state/usage.json), keyed "kind:name". */
export interface UsageEntry {
  loads: number
  lastUsedAt?: string
  hintsShown: number
  hintsFollowed: number
  reviewedLoads: number
  loadsWithIssues: number
  lastIssue?: string
  lastIssueAt?: string
  /** errors: live hint led to a successful retry / to the same error again */
  helped?: number
  failed?: number
}

export type ActionKind =
  | "create"
  | "update"
  | "merge"
  | "patch"
  | "rewrite"
  | "upsert"
  | "restore"
  | "activate"
  | "dormant"
  | "archive"
  | "pin"
  | "unpin"
  | "adopt"
  | "note"
  | "ignore"
  | "retest"
  | "migrate"
  | "flag"
  | "relate"
  | "supersede"
  | "state"
  | "result"
  | "anchor"

/** Non-entry files a run may change: settings.json, gym tasks, review knowledge. */
export type SystemTarget = "settings" | "gym"
export const SYSTEM_TARGETS: SystemTarget[] = ["settings", "gym"]
export const isSystemTarget = (t: string): t is SystemTarget => (SYSTEM_TARGETS as string[]).includes(t)

export interface RunAction {
  kind: ActionKind
  /** kind of the affected entry (or a system file like settings.json) */
  target: Kind | SystemTarget
  name: string
  reason?: string
  detail?: string
  applied: boolean
  stagedId?: string
  /** written only to local state (state/memory.sqlite) – no commit expected */
  local?: boolean
}

/** Deterministically extracted error chain (error → attempts → success?). */
export interface ErrorChain {
  id: string
  tool: string
  head: string
  command: string
  error: string
  signature: string
  sigKey: string
  attempts: string[]
  resolved: boolean
  resolution?: string
  userCorrection?: string
  label: string
  /** distinct sessions in which this signature was seen (occurrence store) */
  sessions: number
}

export interface Run {
  id: string
  smith: Smith
  actor: Actor
  trigger: string
  writeMode: WriteMode
  directory: string
  project: string
  sessionID?: string
  sessionAgent?: string
  parentSessionID?: string
  agentSessionID?: string
  limits: { maxNew: number; maxChanges: number; maxNotes: number }
  created: number
  changes: number
  notes: number
  actions: RunAction[]
  /** store-relative paths touched by this run (for exact git commits) */
  touched: Set<string>
  /** user text of the reviewed transcript (quote verification) */
  userText?: string
  /** redacted transcript text incl. tool outputs and doc passages (evidence verification) */
  haystack?: string
  /** errorsmith: chains extracted from the transcript */
  chains?: ErrorChain[]
  /** toolsmith: drafts of this run (name → draft) */
  drafts?: Map<string, unknown>
  /** docsmith: project docs that look outdated ("file:line – why") */
  outdatedDocs?: string[]
  summary?: string
  subject?: string
  startedAt: string
  /** memorysmith: project / branch / ticket the reviewed session worked in */
  scope?: { project: string; projectName: string; projectSlug: string; branch?: string; ticket?: string }
  /** memorysmith: captures shown in the prompt (consumed after a successful run) */
  captureIds?: string[]
  /** local changes (no git): complete before/after for the audit log */
  /** work started by this run that must wait until its commit is done and its claims are released (finalizeRun) */
  followUps?: Array<() => Promise<void>>
  localChanges?: Array<{ id: string; before?: unknown; after?: unknown }>
  /** actions the gates rejected (audit log) */
  rejections?: Array<{ at: string; tool?: string; target?: string; message: string }>
  /** model of the background agent (audit / metrics) */
  model?: string
  /** doctor: pairs of this run ("P1" → conflict) */
  doctorPairs?: Record<string, { conflict: string; a: string; b: string; aHash: string; bHash: string; decided?: string }>
}

export type JobReason = "threshold" | "idle" | "subagent" | "manual" | "catchup" | "compaction" | "remember"

export interface ReviewJob {
  sessionID: string
  directory: string
  reason: JobReason
  enqueuedAt: string
  force?: boolean
  attempts: number
  rerun?: boolean
  notBefore?: string
  /** last configuration error (model/provider) – the job waits and retries, it is never dropped */
  lastError?: string
}

export interface SessionState {
  id: string
  directory: string
  parentID?: string | null
  agent?: string
  userMsgsSinceReview: number
  thresholdReached?: boolean
  lastReviewedMessageID?: string
  lastReviewedAt?: string
  lastActivityAt: string
  reviewFailures: number
  /** messageID → injected hint text (kept for prompt-cache stability) */
  hints: Record<string, string>
  /** messageID → hinted entries "kind:name" */
  hinted: Record<string, string[]>
  /** entries loaded/read in this session ("kind:name"; legacy: plain skill names) */
  loaded: string[]
  /** glossary terms already explained in this session (folded) */
  explained?: string[]
  /** last model used in this session */
  model?: { providerID: string; modelID: string }
  /** smiths that already finished the current (failed/partial) review range */
  reviewProgress?: { lastMessageID: string; done: Smith[] }
  /** memory-smith: the stand block was attached to this message */
  standMessageID?: string
  /** "merk dir …" in the last message → review as soon as the turn is finished */
  rememberRequested?: boolean
  /** /remember texts not yet reviewed (count as the user's words) */
  rememberNotes?: string[]
}

export interface SearchHit {
  kind: Kind
  name: string
  title: string
  tier: Tier | "foreign"
  owned: boolean
  description: string
  tags: string[]
  score: number
  confidence: number
  /** cosine similarity of the semantic search (when embeddings are available) */
  similarity?: number
  matched: string[]
  snippet: string
  file: string
}

export const key = (kind: Kind, name: string): string => `${kind}:${name}`
