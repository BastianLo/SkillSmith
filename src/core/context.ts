import type { Options } from "../config"
import type { Logger } from "../log"
import type { Client } from "./agent-runner"
import type { AgentTasks } from "./agent-tasks"
import type { Anchors } from "./anchors"
import type { QualityEngine } from "./quality"
import type { CrossCheck } from "./crosscheck"
import type { Gym } from "./gym"
import type { Library } from "./library"
import type { ReviewKnowledge } from "./review-knowledge"
import type { Importer } from "./importer"
import type { OfficeDocs } from "./office-docs"
import type { AuditLog } from "./audit"
import type { EventBus } from "./bus"
import type { Doctor } from "./doctor"
import type { GitTracker } from "./git"
import type { Graph } from "./graph"
import type { LinkIndex } from "./links"
import type { MemoryDb } from "./memory-db"
import type { Metrics } from "./metrics"
import type { RelevanceEngine } from "./relevance"
import type { Versions } from "./versions"
import type { Scope, ScopeResolver } from "./scope"
import type { WebServer } from "../web/server"
import type { SemanticIndex } from "./embeddings"
import type { HintEngine } from "./hints"
import type { Ops } from "./ops"
import type { Pipeline } from "./pipeline"
import type { Projects } from "./projects"
import type { ReviewQueue } from "./queue"
import type { Curator } from "./curator"
import type { Tasks } from "./tasks"
import type { ProjectDocs } from "./project-docs"
import type { Redactor } from "./redact"
import type { Retriever } from "./retrieval"
import type { RunRegistry } from "./runs"
import type { SearchIndex } from "./search"
import type { SessionHistory } from "./session-history"
import type { OccurrenceStore, SessionStore, UsageStore } from "./state"
import type { Store } from "./store"
import type { Workshop } from "./toolsmith"
import type { Settings } from "./settings"
import type { JobScheduler } from "./jobs"

/** Everything a plugin instance (one per opencode project directory) works with. */
export interface Ctx {
  options: Options
  log: Logger
  store: Store
  index: SearchIndex
  /** BM25 + embeddings (falls back to BM25) */
  retriever: Retriever
  /** present when embeddings are enabled (may still be unavailable at runtime) */
  semantic?: SemanticIndex
  /** the project's .md sections (read-only index) */
  projectDocs?: ProjectDocs
  /** compact records of earlier sessions (similar-session hints, history_search) */
  history?: SessionHistory
  git: GitTracker
  usage: UsageStore
  occurrences: OccurrenceStore
  sessions: SessionStore
  redactor: Redactor
  ops: Ops
  hints: HintEngine
  workshop: Workshop
  runs: RunRegistry
  /** memory-smith: local database (work states, results, relations with a volatile end, doctor bookkeeping) */
  mem?: MemoryDb
  /** knowledge graph over all entries and memories */
  graph: Graph
  /** project / branch / ticket of a directory */
  scopes: ScopeResolver
  /** current scope of this plugin instance */
  scope(): Scope
  doctor?: Doctor
  web?: WebServer
  /** audit log (state/audit.sqlite); undefined without SQLite */
  audit?: AuditLog
  /** usage events with timestamps (state/metrics.sqlite); undefined when off or without SQLite */
  metrics?: Metrics
  /** versions and diffs of store entries (git) */
  versions: Versions
  /** node size in the graph */
  relevance: RelevanceEngine
  /** live events (web view, notifications) */
  bus: EventBus
  /** [[links]], backlinks, mentions */
  links: LinkIndex
  /** projects (home_path, board, pipeline) */
  projects: Projects
  /** tasks and the Kanban board */
  tasks: Tasks
  /** local pipeline per project */
  pipeline: Pipeline
  /** code anchors [[code:…]] (5c) */
  anchors?: Anchors
  /** quality score per entry (5c) */
  quality?: QualityEngine
  /** cross-check of AI-written paragraphs (5d) */
  crosscheck?: CrossCheck
  /** A/B runs: does an entry help the agents? (5d) */
  gym?: Gym
  /** snippets and prompts: usage, candidates (5j) */
  library?: Library
  /** review knowledge from GitHub, pre-PR check (5f) */
  reviews?: ReviewKnowledge
  /** document import (5h) */
  importer?: Importer
  /** office documents (PowerPoint, Word): upload, editor, AI drafts */
  office?: OfficeDocs
  /** tasks delegated to opencode agents */
  agentTasks: AgentTasks
  /** review queue and curator of this instance (web actions "review now", "curate") */
  queue?: ReviewQueue
  curator?: Curator
  /** settings page: overrides in settings.json, applied in place */
  settings?: Settings
  /** recurring jobs (one scheduler per store and process, shared by all instances) */
  jobs?: JobScheduler
  client: Client
  directory: string
  worktree: string
  project: string
  toast(message: string, variant?: "info" | "success" | "warning" | "error"): void
}
