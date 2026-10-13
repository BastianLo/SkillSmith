import { homedir } from "node:os"
import { readFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { checkCron } from "./util/cron"

export type WriteMode = "auto" | "stage" | "shadow"
export type SmithName = "skillsmith" | "docsmith" | "errorsmith" | "toolsmith" | "memorysmith" | "doctor"

export interface SmithCommon {
  enabled: boolean
  /** overrides the global writeMode for this smith */
  writeMode?: WriteMode
  /** "provider/model" for this smith's background agents (overrides reviewerModel) */
  model?: string
}

export interface Options {
  /** Master switch (env SKILLSMITH_DISABLED=1 also disables). */
  enabled: boolean
  /** Store location. Default: $SKILLSMITH_HOME or $XDG_DATA_HOME/skillsmith or ~/.local/share/skillsmith */
  storeDir: string
  /** auto = write directly, stage = queue changes for approval, shadow = only log proposals. */
  writeMode: WriteMode

  // --- review triggers -------------------------------------------------------
  reviewThreshold: number
  idleReview: boolean
  idleDelayMin: number
  idleMinNewMessages: number
  reviewSubagents: boolean
  subagentMinToolCalls: number
  /** Parallel review jobs (sessions) per opencode process; further jobs wait (never dropped). */
  reviewConcurrency: number
  /** Parallel background agent runs (all smiths) per opencode process. */
  agentConcurrency: number
  reviewTimeoutMin: number
  catchUpOnStart: boolean

  // --- background agents ---------------------------------------------------------
  /** "provider/model" for all background agents; default = model of the reviewed session. */
  reviewerModel?: string
  curatorModel?: string
  agentSteps: number
  skillLanguage: string
  transcriptMaxChars: number

  // --- skillsmith ----------------------------------------------------------------
  skillsmith: SmithCommon
  maxNewSkillsPerReview: number
  maxChangesPerReview: number
  recurrenceMinSessions: number
  maxDescriptionChars: number
  maxBodyChars: number
  activeBudget: { maxSkills: number; maxChars: number }
  staleDays: number
  archiveDays: number

  // --- docsmith ------------------------------------------------------------------
  docsmith: SmithCommon & {
    maxBodyChars: number
    maxChangesPerReview: number
    /** knowledge not confirmed for this many days is marked "zu prüfen" */
    reviewAfterDays: number
    /** read .md files of the project (read-only) as evidence for changed code */
    repoDocs: boolean
    repoDocsMaxChars: number
    changesMaxChars: number
    detectAbbreviations: boolean
    ignoreAbbreviations: string[]
    /** index the project's .md files (sections) for docsmith and the docs_search tool */
    projectIndex: boolean
    projectIndexMaxFiles: number
    projectIndexMaxChunks: number
    /** folder below the tier where docsmith files new knowledge ("" = main folder) */
    folder: string
  }

  // --- errorsmith ----------------------------------------------------------------
  errorsmith: SmithCommon & {
    maxBodyChars: number
    maxChangesPerReview: number
    /** append known solutions to failing tool output */
    liveHints: boolean
    hintMinScore: number
    /** an unsolved error needs this many sessions before an "open" entry is created */
    openMinSessions: number
    staleDays: number
    archiveDays: number
  }

  // --- toolsmith -----------------------------------------------------------------
  toolsmith: SmithCommon & {
    python: string
    /** syntax/feature target, e.g. "3.9" */
    pythonTarget: string
    allowPipInstall: boolean
    /** "auto" = use OS sandbox when available, "off", "required" = never run tests without sandbox */
    sandbox: "auto" | "off" | "required"
    testTimeoutSec: number
    minTests: number
    maxIterations: number
    recurrenceMinSessions: number
    minSignalScore: number
    /** capabilities that always require approval (/smith-approve) */
    requireApprovalFor: string[]
    staleDays: number
    archiveDays: number
  }

  // --- memorysmith (specific memories: decisions, conventions, experiences, work states, results) ---
  memorysmith: SmithCommon & {
    maxChangesPerReview: number
    maxBodyChars: number
    /** a work state without activity expires after this many days */
    stateDays: number
    /** results (subagents, research) are deleted after this many days unless used or linked */
    resultDays: number
    /** experiences unused for this many days are archived */
    experienceArchiveDays: number
    /** decisions are marked "prüfen?" after this many days */
    decisionReviewDays: number
    /** attach the project's stand block to the first message of a session */
    standBlock: boolean
    standMaxChars: number
    /** ticket ids in branch names / messages */
    ticketPattern: string
    /** keep raw results of finished subagents for the reviewer */
    captureSubagents: boolean
    /** memories of other projects show up in hints/search only when global */
    crossProject: boolean
    /** earlier versions kept per work state */
    stateHistory: number
    /** propose tasks when something stays open in a conversation */
    proposeTasks: boolean
  }

  // --- doctor (conflicts + relations across all kinds) ------------------------------
  doctor: SmithCommon & {
    /** pairs judged per doctor run */
    maxPairsPerRun: number
    /** similar entries considered per new/changed entry */
    candidates: number
    /** contradictions in knowledge/experiences may be resolved by the doctor when evidence is clearly newer */
    autoResolve: boolean
    /** entries of the existing stock checked per run on first use (backfill) */
    backfillPerRun: number
  }

  // --- web ui ------------------------------------------------------------------------
  web: {
    /** address the server binds to; anything but 127.0.0.1 requires the token */
    host: string
    port: number
    /** further ports tried when `port` is taken */
    portFallback: number
    /** token required for the API (false = off; still local address, host, origin and JSON checks) */
    token: boolean
    /** new token on every start (false = kept in state/web.json, bookmarks keep working) */
    tokenRotate: boolean
    allowedHosts: string[]
    /** Origin check for POST */
    checkOrigin: boolean
    /** block every write action */
    readOnly: boolean
    maxBodyKB: number
    /** confirmation per action: "name" (type the name), "preview" (diff first) or "none" */
    confirm: { delete: "name" | "preview" | "none"; undo: "name" | "preview" | "none"; restore: "name" | "preview" | "none"; merge: "name" | "preview" | "none"; rename: "name" | "preview" | "none" }
    /** security events in the audit log at most this often per minute and cause */
    securityLogPerMinute: number
    autostart: boolean
    /** diffs longer than this are cut (load the rest on demand) */
    diffMaxLines: number
    /** server-sent events for live updates */
    liveUpdates: boolean
  }

  // --- audit log -------------------------------------------------------------------
  audit: {
    /** keep events this many days (0 = forever) */
    days: number
    hashChain: boolean
    /** log actions the gates rejected */
    logRejected: boolean
  }

  // --- metrics (every use with a timestamp, state/metrics.sqlite) ----------------------
  metrics: {
    enabled: boolean
    rawDays: number
    toolCalls: boolean
    tokens: boolean
    webViews: boolean
    flushMs: number
  }

  // --- knowledge graph -----------------------------------------------------------------
  graph: {
    relevance: { weights: { usage: number; network: number; importance: number }; halfLifeDays: number; newDays: number }
  }

  // --- knowledge base (documents) ------------------------------------------------------
  docs: {
    /** AI access for new documents of the user: frei | vorschlag | lesen | privat */
    defaultAiAccess: "frei" | "vorschlag" | "lesen" | "privat"
    /** start values per folder ("projekte/shop": "lesen") */
    folderAiAccess: Record<string, "frei" | "vorschlag" | "lesen" | "privat">
    maxBodyChars: number
    attachmentMaxMB: number
    /** hint score bonus of the user's own documents */
    ownBoost: number
    /** private documents in embeddings (default off: only local full text search) */
    privateEmbeddings: boolean
    journalFolder: string
    inboxDoc: string
  }

  // --- links ---------------------------------------------------------------------------
  links: {
    /** URL template of tickets, "{ticket}" is replaced (e.g. https://jira.example/browse/{ticket}) */
    ticketUrl: string
  }

  // --- tasks, projects, agents ----------------------------------------------------------
  tasks: {
    columns: string[]
    wipLimits: Record<string, number>
    maxDepth: number
    idPrefix: string
    /** delegate tasks to opencode agents from the web UI */
    agents: boolean
    /** agent start and approval need the token even when web.token is off */
    requireToken: boolean
    /** bash in the proposal phase */
    planAllowBash: boolean
    /** tools that count as writing (blocked in the proposal phase) */
    writeTools: string[]
    /** own git worktree per agent task */
    worktree: boolean
    maxParallel: number
    /** automatic fix rounds when the pipeline is red after an agent run */
    autoFixRounds: number
    /** prepare proposals for planned agent tasks at these local times ("09:00"); empty = only at start */
    prepareAt: string[]
    /** prepare proposals at all (planned tasks assigned to an agent) */
    prepare: boolean
    /** read-only review session before acceptance (idea 16) */
    review: boolean
    /** agent of the review session ("" = the agent of the task) */
    reviewAgent: string
    /** similar finished tasks in the brief (idea 18) */
    similar: number
    /** deleted lines per file from which the review flags a large deletion */
    largeDeletion: number
    /** workflow per column (5b): step, agent, model, checks, onSuccess/onFailure, gate, maxLoops */
    flow: Record<string, FlowConfigOption>
    /** back jumps (test/verification failed) before a card halts and asks the user */
    maxLoops: number
    /** moving a card into a column with an agent step starts the agent */
    autoStart: boolean
  }

  pipeline: {
    maxParallel: number
    keepRuns: number
    /** per stage, minutes (overridable per stage) */
    timeoutMin: number
    /** marking a red task as done: "warn" | "block" | "off" */
    requireGreen: "warn" | "block" | "off"
    requireToken: boolean
    /** macOS sandbox-exec around pipeline commands */
    sandbox: boolean
    logMaxKB: number
  }

  notify: {
    toast: boolean
    browser: boolean
    macos: boolean
    events: string[]
  }

  // --- inbox "Zu prüfen" -----------------------------------------------------------
  inbox: {
    /** per message type (or "change.<smith>"): an = shown, gebuendelt = one collapsed row, aus = hidden */
    types: Record<string, "an" | "gebuendelt" | "aus">
    /** changes of the AI older than this many days are not listed (even without a visit) */
    changesDays: number
    /** at most this many rows per group (the rest behind "mehr") */
    maxPerGroup: number
  }

  // --- structured log (state/log/<day>.jsonl) -----------------------------------------
  log: {
    level: "debug" | "info" | "warn" | "error"
    /** level per area, e.g. { "pipeline": "debug" } */
    areas: Record<string, "debug" | "info" | "warn" | "error">
    /** keep log files this many days */
    days: number
    /** and at most this many MB in total */
    maxMB: number
  }

  /** schedules of the recurring jobs by id (see src/core/jobs.ts); unset fields keep the job's default */
  jobs: Record<string, JobConfig>

  // --- quality: code anchors, provenance, quality score (5c) ------------------------------
  anchors: {
    /** pin [[code:…]] anchors on every write and check them after new commits */
    enabled: boolean
  }
  provenance: {
    enabled: boolean
    /** sources per paragraph from the smiths: aus | warnen (hint to the agent) | pflicht (rejected without) */
    perParagraph: "aus" | "warnen" | "pflicht"
  }
  crosscheck: {
    enabled: boolean
    /** "provider/model" of the checker – a different model than the writer; empty = no cross-check */
    model: string
    /** kinds whose AI-written paragraphs are checked */
    kinds: string[]
  }
  gym: {
    enabled: boolean
    /** model of both arms ("" = last used model) */
    model: string
    /** opencode agent that works on the gym tasks */
    agent: string
    runsPerArm: number
    timeoutMin: number
    /** gym tasks per job run */
    maxTasksPerRun: number
    /** bericht = report only; archivieren = archive after 2 confirmed rounds on different days */
    consequence: "bericht" | "archivieren"
  }
  quality: {
    /** weights of the components (0 = not counted) */
    weights: { belegt: number; frische: number; hinweise: number; zweifel: number; anker: number; gym: number }
    /** below this score an entry is listed in the inbox ("Qualität prüfen") */
    lowThreshold: number
    /** hints prefer entries with a high score (0 = off) */
    hintBoost: number
    /** confirmation older than this many days counts as stale (freshness 0) */
    freshDays: number
  }

  // --- curator -------------------------------------------------------------------
  curatorIntervalDays: number
  curatorMaxChanges: number
  consolidate: boolean
  similarityThreshold: number
  needsReviewMinLoads: number
  needsReviewRate: number

  // --- hints -------------------------------------------------------------------
  hints: {
    enabled: boolean
    max: number
    minScore: number
    includeSubagents: boolean
    glossary: boolean
    knowledge: boolean
    errors: boolean
    scripts: boolean
    maxGlossary: number
    /** similar earlier sessions (needs history.enabled) */
    sessions: boolean
    /** relevance (graph) as weak tie breaker between hint candidates; 0 = off */
    relevanceBoost: number
  }

  // --- session history (similar earlier sessions) ------------------------------------
  history: {
    enabled: boolean
    /** keep records for this many days */
    days: number
    maxRecords: number
  }

  // --- embeddings (semantic search) ---------------------------------------------
  embedding: {
    /** semantic search on top of BM25; silently off when no endpoint/model can be resolved */
    enabled: boolean
    /** opencode provider whose baseURL/apiKey are used (default: a provider whose id contains "litellm") */
    provider?: string
    /** model id as the endpoint knows it; empty = auto-detect an embedding model via GET /models */
    model?: string
    baseURL?: string
    apiKey?: string
    /** environment variable with the API key (fallback) */
    apiKeyEnv: string
    /** truncate vectors to this many dimensions (Matryoshka models such as Qwen3-Embedding); 0 = full */
    dimensions: number
    /** "auto" = Qwen-style query instruction for Qwen models, "qwen", "none" */
    instructionFormat: "auto" | "qwen" | "none"
    /** where vectors are kept: SQLite (incremental, default) or one file per namespace (fallback) */
    storage: "sqlite" | "file"
    timeoutMs: number
    batchSize: number
    /** wait at most this long for a semantic hint before falling back to BM25 */
    hintWaitMs: number
    searchMinSimilarity: number
    hintMinSimilarity: number
    candidateSimilarity: number
    duplicateSimilarity: number
    errorSimilarity: number
    /** curator: entries this similar form a consolidation cluster */
    clusterSimilarity: number
    /** related but distinct entries (contradiction check, related notes) */
    relatedSimilarity: number
    /** tag variants this similar are mapped to the existing tag */
    tagSimilarity: number
    /** earlier sessions shown as hint from this similarity */
    sessionHintSimilarity: number
  }

  // --- misc ----------------------------------------------------------------------
  git: { enabled: boolean; binary?: string }
  indexForeignSkills: boolean
  /** curator unifies tag variants ("deploy"/"deployment", semantically equal tags) */
  unifyTags: boolean
  redact: { extraPatterns: string[]; emails: boolean }
  keepAgentSessions: boolean
  debug: boolean
}

/** "1"/"true"/"yes"/"on" (any case) → true, everything else → false. For env flags. */
export function envFlag(value: string | undefined): boolean {
  if (value === undefined) return false
  return /^(1|true|yes|on)$/i.test(value.trim())
}

export const DEFAULT_TASK_COLUMNS = ["neu", "planung", "umsetzung", "test", "verifikation", "erledigt"]
export const STEP_KIND_VALUES = ["plan", "implement", "test", "verify", "keiner"] as const
export const EXIT_CHECK_VALUES = ["pipeline", "tests", "criteria", "review", "pr-check"] as const

/** Workflow of one column in the options (tasks.flow.<column>); see src/core/workflow.ts. */
export interface FlowConfigOption {
  step?: (typeof STEP_KIND_VALUES)[number]
  agent?: string
  model?: string
  checks?: Array<(typeof EXIT_CHECK_VALUES)[number]>
  onSuccess?: string
  onFailure?: string
  gate?: boolean
  maxLoops?: number
}

export interface JobConfig {
  enabled?: boolean
  start?: boolean
  daily?: string[]
  weekdays?: string[]
  intervalMin?: number
  idleMin?: number
  cron?: string
  afterReview?: boolean
  catchUp?: "once" | "skip"
  params?: Record<string, string>
}

export function defaultStoreDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SKILLSMITH_HOME) return expandHome(env.SKILLSMITH_HOME)
  const base = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(homedir(), ".local", "share")
  return join(base, "skillsmith")
}

export function expandHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return path
}

export const CAPABILITIES = ["network", "subprocess", "delete", "filesystem-write", "env"] as const

export function defaults(env: NodeJS.ProcessEnv = process.env): Options {
  return {
    enabled: true,
    storeDir: defaultStoreDir(env),
    writeMode: "auto",
    reviewThreshold: 5,
    idleReview: true,
    idleDelayMin: 3,
    idleMinNewMessages: 2,
    reviewSubagents: false,
    subagentMinToolCalls: 6,
    reviewConcurrency: 4,
    agentConcurrency: 8,
    reviewTimeoutMin: 15,
    catchUpOnStart: true,
    reviewerModel: undefined,
    curatorModel: undefined,
    agentSteps: 40,
    skillLanguage: "auto",
    transcriptMaxChars: 24000,
    skillsmith: { enabled: true },
    maxNewSkillsPerReview: 1,
    maxChangesPerReview: 3,
    recurrenceMinSessions: 2,
    maxDescriptionChars: 300,
    maxBodyChars: 8000,
    activeBudget: { maxSkills: 20, maxChars: 6000 },
    staleDays: 14,
    archiveDays: 60,
    docsmith: {
      enabled: true,
      maxBodyChars: 6000,
      maxChangesPerReview: 6,
      reviewAfterDays: 180,
      repoDocs: true,
      repoDocsMaxChars: 4000,
      changesMaxChars: 6000,
      detectAbbreviations: true,
      ignoreAbbreviations: [],
      projectIndex: true,
      projectIndexMaxFiles: 1000,
      projectIndexMaxChunks: 5000,
      folder: "",
    },
    errorsmith: {
      enabled: true,
      maxBodyChars: 5000,
      maxChangesPerReview: 4,
      liveHints: true,
      hintMinScore: 0.5,
      openMinSessions: 2,
      staleDays: 90,
      archiveDays: 365,
    },
    toolsmith: {
      enabled: true,
      python: "python3",
      pythonTarget: "3.9",
      allowPipInstall: false,
      sandbox: "auto",
      testTimeoutSec: 60,
      minTests: 3,
      maxIterations: 5,
      recurrenceMinSessions: 2,
      minSignalScore: 3,
      requireApprovalFor: ["network", "subprocess", "delete"],
      staleDays: 60,
      archiveDays: 180,
    },
    memorysmith: {
      enabled: true,
      maxChangesPerReview: 8,
      maxBodyChars: 4000,
      stateDays: 14,
      resultDays: 14,
      experienceArchiveDays: 180,
      decisionReviewDays: 180,
      standBlock: true,
      standMaxChars: 1500,
      ticketPattern: "[A-Z][A-Z0-9]+-\\d+",
      captureSubagents: true,
      crossProject: false,
      stateHistory: 50,
      proposeTasks: true,
    },
    doctor: { enabled: true, maxPairsPerRun: 10, candidates: 8, autoResolve: true, backfillPerRun: 40 },
    web: {
      host: "127.0.0.1",
      port: 4747,
      portFallback: 10,
      token: true,
      tokenRotate: true,
      allowedHosts: ["127.0.0.1", "localhost"],
      checkOrigin: true,
      readOnly: false,
      maxBodyKB: 1024,
      confirm: { delete: "name", undo: "preview", restore: "preview", merge: "preview", rename: "preview" },
      securityLogPerMinute: 1,
      autostart: false,
      diffMaxLines: 2000,
      liveUpdates: true,
    },
    audit: { days: 0, hashChain: true, logRejected: true },
    metrics: { enabled: true, rawDays: 365, toolCalls: true, tokens: true, webViews: true, flushMs: 2000 },
    graph: { relevance: { weights: { usage: 0.5, network: 0.35, importance: 0.15 }, halfLifeDays: 30, newDays: 14 } },
    docs: {
      defaultAiAccess: "vorschlag",
      folderAiAccess: {},
      maxBodyChars: 50_000,
      attachmentMaxMB: 5,
      ownBoost: 0.1,
      privateEmbeddings: false,
      journalFolder: "journal",
      inboxDoc: "eingang",
    },
    links: { ticketUrl: "" },
    tasks: {
      columns: DEFAULT_TASK_COLUMNS,
      wipLimits: {},
      maxDepth: 2,
      idPrefix: "T",
      agents: true,
      requireToken: true,
      planAllowBash: false,
      writeTools: ["edit", "write", "patch", "multiedit"],
      worktree: true,
      maxParallel: 3,
      autoFixRounds: 1,
      prepareAt: [],
      prepare: true,
      review: true,
      reviewAgent: "",
      similar: 3,
      largeDeletion: 200,
      flow: {},
      maxLoops: 3,
      autoStart: true,
    },
    pipeline: { maxParallel: 2, keepRuns: 20, timeoutMin: 15, requireGreen: "warn", requireToken: true, sandbox: false, logMaxKB: 2048 },
    notify: { toast: true, browser: true, macos: false, events: ["proposal", "permission", "pipeline", "agent-done", "agent-error", "job-failed", "halted"] },
    inbox: { types: { change: "gebuendelt" }, changesDays: 14, maxPerGroup: 50 },
    log: { level: "info", areas: {}, days: 14, maxMB: 50 },
    jobs: {},
    anchors: { enabled: true },
    provenance: { enabled: true, perParagraph: "warnen" },
    crosscheck: { enabled: true, model: "", kinds: ["knowledge", "memory", "skill"] },
    gym: { enabled: true, model: "", agent: "build", runsPerArm: 3, timeoutMin: 10, maxTasksPerRun: 2, consequence: "bericht" },
    quality: { weights: { belegt: 0.35, frische: 0.15, hinweise: 0.2, zweifel: 0.15, anker: 0.15, gym: 0.2 }, lowThreshold: 40, hintBoost: 0.15, freshDays: 365 },
    curatorIntervalDays: 7,
    curatorMaxChanges: 5,
    consolidate: true,
    similarityThreshold: 0.45,
    needsReviewMinLoads: 3,
    needsReviewRate: 0.5,
    hints: {
      enabled: true,
      max: 3,
      minScore: 0.35,
      includeSubagents: true,
      glossary: true,
      knowledge: true,
      errors: true,
      scripts: true,
      maxGlossary: 5,
      sessions: true,
      relevanceBoost: 0,
    },
    history: { enabled: true, days: 180, maxRecords: 2000 },
    embedding: {
      enabled: true,
      provider: undefined,
      model: undefined,
      baseURL: undefined,
      apiKey: undefined,
      apiKeyEnv: "LITELLM_API_KEY",
      dimensions: 1024,
      instructionFormat: "auto",
      storage: "sqlite",
      timeoutMs: 4000,
      batchSize: 16,
      hintWaitMs: 2500,
      searchMinSimilarity: 0.4,
      hintMinSimilarity: 0.55,
      candidateSimilarity: 0.85,
      duplicateSimilarity: 0.92,
      errorSimilarity: 0.6,
      clusterSimilarity: 0.82,
      relatedSimilarity: 0.7,
      tagSimilarity: 0.92,
      sessionHintSimilarity: 0.7,
    },
    git: { enabled: true, binary: undefined },
    indexForeignSkills: true,
    unifyTags: true,
    redact: { extraPatterns: [], emails: true },
    keepAgentSessions: false,
    debug: false,
  }
}

/**
 * What a value looks like – read by the settings page to build its form (type, limits,
 * allowed values) and by the validators below.
 */
export type ValueSpec =
  | { t: "int"; min: number; max: number }
  | { t: "num"; min: number; max: number }
  | { t: "bool" }
  | { t: "str"; optional?: boolean; format?: "python" | "regex" | "idPrefix" | "cron" }
  | { t: "enum"; values: string[]; optional?: boolean }
  | { t: "list"; values?: string[]; format?: "times" | "columns"; nonEmpty?: boolean }
  | { t: "record"; item: ValueSpec }
  | { t: "object"; fields: Record<string, ValueSpec> }

export type Validator = ((value: unknown) => unknown) & { spec: ValueSpec }
const mk = (spec: ValueSpec, fn: (value: unknown) => unknown): Validator => Object.assign(fn, { spec })

const int = (min: number, max = Number.MAX_SAFE_INTEGER): Validator =>
  mk({ t: "int", min, max }, (v) => {
    const n = typeof v === "string" ? Number(v) : v
    if (typeof n !== "number" || !Number.isFinite(n)) throw new Error("expected a number")
    return Math.min(max, Math.max(min, Math.round(n)))
  })
const num = (min: number, max: number): Validator =>
  mk({ t: "num", min, max }, (v) => {
    const n = typeof v === "string" ? Number(v) : v
    if (typeof n !== "number" || !Number.isFinite(n)) throw new Error("expected a number")
    return Math.min(max, Math.max(min, n))
  })
const bool: Validator = mk({ t: "bool" }, (v) => {
  if (typeof v === "boolean") return v
  if (v === "true" || v === 1) return true
  if (v === "false" || v === 0) return false
  throw new Error("expected true/false")
})
const asStr = (v: unknown): string => {
  if (typeof v !== "string") throw new Error("expected a string")
  return v
}
const str: Validator = mk({ t: "str" }, asStr)
const optStr: Validator = mk({ t: "str", optional: true }, (v) => (v === undefined || v === null || v === "" ? undefined : asStr(v)))
const asList = (v: unknown): string[] => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error("expected a list of strings")
  return v as string[]
}
const strList: Validator = mk({ t: "list" }, asList)
const oneOf = (...values: string[]): Validator =>
  mk({ t: "enum", values }, (v) => {
    if (typeof v !== "string" || !values.includes(v)) throw new Error(`expected one of ${values.join(", ")}`)
    return v
  })
const optOneOf = (...values: string[]): Validator =>
  mk({ t: "enum", values, optional: true }, (v) => (v === undefined || v === null || v === "" ? undefined : oneOf(...values)(v)))
const listOf = (...values: string[]): Validator =>
  mk({ t: "list", values }, (v) => {
    const list = asList(v)
    const bad = list.filter((x) => !values.includes(x))
    if (bad.length) throw new Error(`unknown value(s) ${bad.join(", ")}; allowed: ${values.join(", ")}`)
    return list
  })

const smithCommon = {
  enabled: bool,
  writeMode: optOneOf("auto", "stage", "shadow"),
  model: optStr,
}

const ACCESS = ["frei", "vorschlag", "lesen", "privat"]
const recordOf = (item: Validator): Validator =>
  mk({ t: "record", item: item.spec }, (v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("expected an object")
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      try {
        out[k] = item(x)
      } catch (err) {
        throw new Error(`${k}: ${(err as Error).message}`)
      }
    }
    return out
  })
/** An object with known optional fields (jobs, column flow): unknown fields are an error, missing ones stay unset. */
const objectOf = (fields: Record<string, Validator>): Validator =>
  mk({ t: "object", fields: Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, f.spec])) }, (v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("expected an object")
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const f = fields[k]
      if (!f) throw new Error(`unknown field "${k}"`)
      if (x === undefined || x === null) continue
      try {
        out[k] = f(x)
      } catch (err) {
        throw new Error(`${k}: ${(err as Error).message}`)
      }
    }
    return out
  })
const nonEmptyList: Validator = mk({ t: "list", nonEmpty: true }, (v) => {
  const l = asList(v)
  if (!l.length) throw new Error("expected at least one value")
  return l
})
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/
const times: Validator = mk({ t: "list", format: "times" }, (v) => {
  const l = asList(v)
  for (const t of l) if (!TIME_RE.test(t)) throw new Error(`"${t}" is not a time like 09:00`)
  return l
})
const slugList: Validator = mk({ t: "list", format: "columns", nonEmpty: true }, (v) => {
  const l = asList(v)
  if (!l.length) throw new Error("expected at least one value")
  for (const c of l) if (!/^[a-z][a-z0-9_]{0,30}$/.test(c)) throw new Error(`"${c}" is not a valid column id (a-z, 0-9, _)`)
  if (new Set(l).size !== l.length) throw new Error("column ids must be unique")
  return l
})
const formatted = (format: "python" | "regex" | "idPrefix" | "cron", check: (s: string) => string): Validator => mk({ t: "str", format }, (v) => check(asStr(v)))
const confirmMode = oneOf("name", "preview", "none")
const LEVELS = ["debug", "info", "warn", "error"]
const INBOX_MODES = ["an", "gebuendelt", "aus"]
export const NOTIFY_EVENTS = ["proposal", "permission", "pipeline", "agent-done", "agent-error", "job-failed", "halted", "inbox"] as const

/** Schedule of a job (src/core/jobs.ts); every field optional – unset fields keep the job's default. */
const jobConfig = objectOf({
  enabled: bool,
  start: bool,
  daily: times,
  weekdays: mk({ t: "list", values: ["1", "2", "3", "4", "5", "6", "7"] }, (v) => {
    const l = (Array.isArray(v) ? v : []).map((x) => String(x))
    if (!Array.isArray(v) || l.some((x) => !/^[1-7]$/.test(x))) throw new Error("expected weekdays 1 (Monday) … 7 (Sunday)")
    return l
  }),
  intervalMin: num(0, 525_600),
  idleMin: num(0, 10_080),
  cron: mk({ t: "str", optional: true, format: "cron" }, (v) => (v === undefined || v === null || v === "" ? "" : checkCron(asStr(v)))),
  afterReview: bool,
  catchUp: oneOf("once", "skip"),
  params: mk({ t: "record", item: { t: "str" } }, (v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("expected an object")
    return v
  }),
})

type Rule = Validator | { [key: string]: Rule }

const SCHEMA: Record<string, Rule> = {
  enabled: bool,
  storeDir: str,
  writeMode: oneOf("auto", "stage", "shadow"),
  reviewThreshold: int(1, 1000),
  idleReview: bool,
  idleDelayMin: num(0, 1440),
  idleMinNewMessages: int(1, 1000),
  reviewSubagents: bool,
  subagentMinToolCalls: int(0, 10000),
  reviewConcurrency: int(1, 64),
  agentConcurrency: int(1, 128),
  reviewTimeoutMin: num(1, 240),
  catchUpOnStart: bool,
  reviewerModel: optStr,
  curatorModel: optStr,
  agentSteps: int(5, 500),
  skillLanguage: str,
  transcriptMaxChars: int(2000, 400000),
  skillsmith: { ...smithCommon },
  maxNewSkillsPerReview: int(0, 20),
  maxChangesPerReview: int(1, 50),
  recurrenceMinSessions: int(1, 20),
  maxDescriptionChars: int(40, 1024),
  maxBodyChars: int(500, 100000),
  activeBudget: { maxSkills: int(1, 1000), maxChars: int(200, 1_000_000) },
  staleDays: num(0.01, 3650),
  archiveDays: num(0.01, 3650),
  docsmith: {
    ...smithCommon,
    maxBodyChars: int(500, 100000),
    maxChangesPerReview: int(1, 50),
    reviewAfterDays: num(1, 3650),
    repoDocs: bool,
    repoDocsMaxChars: int(0, 100000),
    changesMaxChars: int(0, 100000),
    detectAbbreviations: bool,
    ignoreAbbreviations: strList,
    projectIndex: bool,
    projectIndexMaxFiles: int(1, 100_000),
    projectIndexMaxChunks: int(1, 1_000_000),
    folder: str,
  },
  errorsmith: {
    ...smithCommon,
    maxBodyChars: int(500, 100000),
    maxChangesPerReview: int(1, 50),
    liveHints: bool,
    hintMinScore: num(0, 1),
    openMinSessions: int(1, 50),
    staleDays: num(0.01, 3650),
    archiveDays: num(0.01, 3650),
  },
  toolsmith: {
    ...smithCommon,
    python: str,
    pythonTarget: formatted("python", (s) => {
      if (!/^3\.\d{1,2}$/.test(s)) throw new Error('expected a Python version like "3.9"')
      return s
    }),
    allowPipInstall: bool,
    sandbox: oneOf("auto", "off", "required"),
    testTimeoutSec: int(5, 3600),
    minTests: int(1, 50),
    maxIterations: int(1, 20),
    recurrenceMinSessions: int(1, 20),
    minSignalScore: num(0, 100),
    requireApprovalFor: listOf(...CAPABILITIES),
    staleDays: num(0.01, 3650),
    archiveDays: num(0.01, 3650),
  },
  memorysmith: {
    ...smithCommon,
    maxChangesPerReview: int(1, 50),
    maxBodyChars: int(500, 100000),
    stateDays: num(0.01, 3650),
    resultDays: num(0.01, 3650),
    experienceArchiveDays: num(1, 3650),
    decisionReviewDays: num(1, 3650),
    standBlock: bool,
    standMaxChars: int(200, 20000),
    ticketPattern: formatted("regex", (s) => {
      new RegExp(s)
      return s
    }),
    captureSubagents: bool,
    crossProject: bool,
    stateHistory: int(1, 1000),
    proposeTasks: bool,
  },
  doctor: { ...smithCommon, maxPairsPerRun: int(1, 100), candidates: int(1, 50), autoResolve: bool, backfillPerRun: int(0, 10000) },
  web: {
    host: str,
    port: int(1, 65535),
    portFallback: int(0, 100),
    token: bool,
    tokenRotate: bool,
    allowedHosts: nonEmptyList,
    checkOrigin: bool,
    readOnly: bool,
    maxBodyKB: int(16, 1024 * 64),
    confirm: { delete: confirmMode, undo: confirmMode, restore: confirmMode, merge: confirmMode, rename: confirmMode },
    securityLogPerMinute: int(0, 1000),
    autostart: bool,
    diffMaxLines: int(50, 1_000_000),
    liveUpdates: bool,
  },
  audit: { days: int(0, 36500), hashChain: bool, logRejected: bool },
  metrics: { enabled: bool, rawDays: int(1, 36500), toolCalls: bool, tokens: bool, webViews: bool, flushMs: int(200, 600_000) },
  graph: { relevance: { weights: { usage: num(0, 1), network: num(0, 1), importance: num(0, 1) }, halfLifeDays: num(1, 3650), newDays: num(0, 365) } },
  docs: {
    defaultAiAccess: oneOf(...ACCESS),
    folderAiAccess: recordOf(oneOf(...ACCESS)),
    maxBodyChars: int(1000, 2_000_000),
    attachmentMaxMB: num(0.1, 200),
    ownBoost: num(0, 1),
    privateEmbeddings: bool,
    journalFolder: str,
    inboxDoc: str,
  },
  links: { ticketUrl: str },
  tasks: {
    columns: slugList,
    wipLimits: recordOf(int(0, 10_000)),
    maxDepth: int(1, 5),
    idPrefix: formatted("idPrefix", (s) => {
      if (!/^[A-Z]{1,6}$/.test(s)) throw new Error("expected 1–6 capital letters")
      return s
    }),
    agents: bool,
    requireToken: bool,
    planAllowBash: bool,
    writeTools: strList,
    worktree: bool,
    maxParallel: int(1, 32),
    autoFixRounds: int(0, 10),
    prepareAt: times,
    prepare: bool,
    review: bool,
    reviewAgent: str,
    similar: int(0, 10),
    largeDeletion: int(10, 100_000),
    flow: recordOf(
      objectOf({
        step: oneOf(...STEP_KIND_VALUES),
        agent: str,
        model: str,
        checks: listOf(...EXIT_CHECK_VALUES),
        onSuccess: str,
        onFailure: str,
        gate: bool,
        maxLoops: int(0, 20),
      }),
    ),
    maxLoops: int(0, 20),
    autoStart: bool,
  },
  pipeline: {
    maxParallel: int(1, 16),
    keepRuns: int(1, 1000),
    timeoutMin: num(0.1, 24 * 60),
    requireGreen: oneOf("warn", "block", "off"),
    requireToken: bool,
    sandbox: bool,
    logMaxKB: int(16, 1024 * 1024),
  },
  notify: { toast: bool, browser: bool, macos: bool, events: listOf(...NOTIFY_EVENTS) },
  inbox: { types: recordOf(oneOf(...INBOX_MODES)), changesDays: num(1, 3650), maxPerGroup: int(5, 1000) },
  log: { level: oneOf(...LEVELS), areas: recordOf(oneOf(...LEVELS)), days: num(1, 3650), maxMB: num(1, 10_000) },
  jobs: recordOf(jobConfig),
  anchors: { enabled: bool },
  provenance: { enabled: bool, perParagraph: oneOf("aus", "warnen", "pflicht") },
  crosscheck: { enabled: bool, model: str, kinds: listOf("knowledge", "memory", "skill", "error", "glossary") },
  gym: { enabled: bool, model: str, agent: str, runsPerArm: int(1, 20), timeoutMin: num(1, 240), maxTasksPerRun: int(1, 50), consequence: oneOf("bericht", "archivieren") },
  quality: {
    weights: { belegt: num(0, 1), frische: num(0, 1), hinweise: num(0, 1), zweifel: num(0, 1), anker: num(0, 1), gym: num(0, 1) },
    lowThreshold: int(0, 100),
    hintBoost: num(0, 1),
    freshDays: num(1, 3650),
  },
  curatorIntervalDays: num(0.01, 365),
  curatorMaxChanges: int(1, 100),
  consolidate: bool,
  similarityThreshold: num(0.05, 0.99),
  needsReviewMinLoads: int(1, 1000),
  needsReviewRate: num(0, 1),
  hints: {
    enabled: bool,
    max: int(1, 10),
    minScore: num(0, 1),
    includeSubagents: bool,
    glossary: bool,
    knowledge: bool,
    errors: bool,
    scripts: bool,
    maxGlossary: int(1, 20),
    sessions: bool,
    relevanceBoost: num(0, 1),
  },
  history: { enabled: bool, days: num(1, 3650), maxRecords: int(10, 100_000) },
  embedding: {
    enabled: bool,
    provider: optStr,
    model: optStr,
    baseURL: optStr,
    apiKey: optStr,
    apiKeyEnv: str,
    dimensions: int(0, 16384),
    instructionFormat: oneOf("auto", "qwen", "none"),
    storage: oneOf("sqlite", "file"),
    timeoutMs: int(200, 120_000),
    batchSize: int(1, 256),
    hintWaitMs: int(0, 30_000),
    searchMinSimilarity: num(0, 1),
    hintMinSimilarity: num(0, 1),
    candidateSimilarity: num(0, 1),
    duplicateSimilarity: num(0, 1),
    errorSimilarity: num(0, 1),
    clusterSimilarity: num(0, 1),
    relatedSimilarity: num(0, 1),
    tagSimilarity: num(0, 1),
    sessionHintSimilarity: num(0, 1),
  },
  git: { enabled: bool, binary: optStr },
  indexForeignSkills: bool,
  unifyTags: bool,
  redact: { extraPatterns: strList, emails: bool },
  keepAgentSessions: bool,
  debug: bool,
}

/** Where a value comes from: default < opencode.json < settings page (settings.json in the store) < environment. */
export type OptionSource = "standard" | "opencode" | "einstellungen" | "umgebung"

export interface ResolvedOptions {
  options: Options
  warnings: string[]
  /** source of every value that is not the default ("web.port" → "einstellungen") */
  sources: Record<string, OptionSource>
}

/** Never taken from settings.json: the store itself and secrets (they stay out of git). */
export const SETTINGS_DENY = new Set(["storeDir", "embedding.apiKey"])

/** Every configurable value with its spec ("hints.max" → int 1–10). Records (wipLimits, jobs) are one value. */
export function optionLeaves(): Array<{ path: string; spec: ValueSpec }> {
  const out: Array<{ path: string; spec: ValueSpec }> = []
  const walk = (schema: Record<string, Rule>, prefix: string) => {
    for (const [k, rule] of Object.entries(schema)) {
      if (typeof rule === "function") out.push({ path: `${prefix}${k}`, spec: rule.spec })
      else walk(rule, `${prefix}${k}.`)
    }
  }
  walk(SCHEMA, "")
  return out
}

/** Validates one value of a leaf ("web.port", 4848) → normalised value; throws with the reason. */
export function validateOption(path: string, value: unknown): unknown {
  let rule: Rule | undefined = { ...SCHEMA }
  for (const part of path.split(".")) {
    if (!rule || typeof rule === "function") throw new Error(`unknown option "${path}"`)
    rule = (rule as Record<string, Rule>)[part]
  }
  if (typeof rule !== "function") throw new Error(`"${path}" is a group, not a value`)
  return rule(value)
}

/** Value at a dotted path of an options-like object. */
export function valueAt(obj: unknown, path: string): unknown {
  let cur: any = obj
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined
    cur = cur[part]
  }
  return cur
}

export function resolveOptions(raw: unknown, env: NodeJS.ProcessEnv = process.env, settings?: unknown): ResolvedOptions {
  const options = defaults(env)
  const warnings: string[] = []
  const sources: Record<string, OptionSource> = {}
  // nested objects are validated key by key; an invalid value keeps the previous one
  const apply = (schema: Record<string, Rule>, target: Record<string, any>, values: Record<string, unknown>, prefix: string, source: OptionSource, origin: string) => {
    for (const [key, value] of Object.entries(values)) {
      const rule = schema[key]
      const label = `${prefix}${key}`
      if (!rule) {
        warnings.push(`unknown option "${label}" ignored${origin}`)
        continue
      }
      if (source === "einstellungen" && SETTINGS_DENY.has(label)) {
        warnings.push(`option "${label}" is not taken from settings.json${origin}`)
        continue
      }
      if (typeof rule === "function") {
        try {
          target[key] = rule(value)
          sources[label] = source
        } catch (err) {
          warnings.push(`option "${label}": ${(err as Error).message} (previous value kept)${origin}`)
        }
        continue
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        warnings.push(`option "${label}": expected an object (previous value kept)${origin}`)
        continue
      }
      target[key] ??= {}
      apply(rule, target[key], value as Record<string, unknown>, `${label}.`, source, origin)
    }
  }
  const asObject = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
  apply(SCHEMA, options as unknown as Record<string, any>, asObject(raw), "", "opencode", "")
  if (settings !== undefined) apply(SCHEMA, options as unknown as Record<string, any>, asObject(settings), "", "einstellungen", " (settings.json)")
  const fromEnv = (path: string) => (sources[path] = "umgebung")
  if (env.SKILLSMITH_DISABLED === "1") (options.enabled = false), fromEnv("enabled")
  if (env.SKILLSMITH_DEBUG === "1") (options.debug = true), fromEnv("debug")
  if (env.SKILLSMITH_EMBEDDINGS === "0") (options.embedding.enabled = false), fromEnv("embedding.enabled")
  // standalone CLI: environment wins over the config file, so `skillsmith start` and the plugin agree
  if (env.SKILLSMITH_STORE_DIR) (options.storeDir = expandHome(env.SKILLSMITH_STORE_DIR)), fromEnv("storeDir")
  if (env.SKILLSMITH_WEB_AUTOSTART !== undefined) (options.web.autostart = envFlag(env.SKILLSMITH_WEB_AUTOSTART)), fromEnv("web.autostart")
  if (env.SKILLSMITH_WEB_HOST) (options.web.host = env.SKILLSMITH_WEB_HOST), fromEnv("web.host")
  if (env.SKILLSMITH_WEB_PORT) {
    const p = Number(env.SKILLSMITH_WEB_PORT)
    if (Number.isInteger(p) && p > 0 && p <= 65535) (options.web.port = p), fromEnv("web.port")
  }
  if (env.SKILLSMITH_HOME && !sources.storeDir) sources.storeDir = "umgebung"
  options.storeDir = resolve(expandHome(options.storeDir))
  for (const [label, o] of [
    ["", options],
    ["errorsmith.", options.errorsmith],
    ["toolsmith.", options.toolsmith],
  ] as const) {
    if (o.archiveDays < o.staleDays) {
      warnings.push(`${label}archiveDays < ${label}staleDays: archiveDays raised to staleDays`)
      o.archiveDays = o.staleDays
    }
  }
  return { options, warnings, sources }
}

export const SETTINGS_FILE = "settings.json"

/** Overrides of the settings page (settings.json in the store); {} when missing or unreadable. */
export function readSettingsFile(storeDir: string): { values: Record<string, unknown>; error?: string } {
  let text: string
  try {
    text = readFileSync(join(storeDir, SETTINGS_FILE), "utf8")
  } catch {
    return { values: {} }
  }
  try {
    const v = JSON.parse(text)
    return { values: v && typeof v === "object" && !Array.isArray(v) ? v : {} }
  } catch (err) {
    return { values: {}, error: `settings.json is not valid JSON: ${(err as Error).message}` }
  }
}

/**
 * Options of a plugin instance: opencode.json first (it may move the store), then the settings
 * page of that store on top. The environment wins over both.
 */
export function loadOptions(raw: unknown, env: NodeJS.ProcessEnv = process.env): ResolvedOptions & { settings: Record<string, unknown> } {
  const first = resolveOptions(raw, env)
  const file = readSettingsFile(first.options.storeDir)
  const second = resolveOptions(raw, env, file.values)
  if (file.error) second.warnings.push(file.error)
  return { ...second, settings: file.values }
}

/** "provider/model" → SDK model ref (modelID may itself contain "/"). */
export function parseModel(spec: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!spec) return undefined
  const i = spec.indexOf("/")
  if (i <= 0 || i === spec.length - 1) return undefined
  return { providerID: spec.slice(0, i), modelID: spec.slice(i + 1) }
}

export function smithWriteMode(o: Options, smith: SmithName): WriteMode {
  return o[smith].writeMode ?? o.writeMode
}
