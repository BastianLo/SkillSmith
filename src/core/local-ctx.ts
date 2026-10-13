/**
 * A context without opencode (5g): the smith CLI opens the store directly when no instance
 * runs – for notes, tasks and search. Same services as the plugin, but no client: anything
 * that needs a model (ask, prompts, checks by agents) reports that opencode must run.
 */
import { basename, join, resolve } from "node:path"
import { loadOptions } from "../config"
import { createLogger } from "../log"
import type { Ctx } from "./context"
import { GitTracker } from "./git"
import { Graph } from "./graph"
import { HintEngine } from "./hints"
import { MemoryDb } from "./memory-db"
import { Ops } from "./ops"
import { createRedactor } from "./redact"
import { Retriever } from "./retrieval"
import { RunRegistry } from "./runs"
import { ScopeResolver } from "./scope"
import { SearchIndex } from "./search"
import { attachServices } from "./services"
import { SessionHistory } from "./session-history"
import { OccurrenceStore, SessionStore, UsageStore } from "./state"
import { Store } from "./store"
import { Workshop } from "./toolsmith"

const noModel = () => {
  throw new Error("dafür muss opencode laufen (skillsmith start) – ohne Instanz gibt es kein Modell")
}

export function createLocalCtx(storeDir: string, directory = process.cwd()): Ctx {
  const { options } = loadOptions({ storeDir })
  const log = createLogger(join(options.storeDir, "state", "log"), { level: () => options.log.level }, undefined, "cli")
  const store = new Store(options.storeDir, log.child("store"))
  store.init()
  const redactor = createRedactor(options.redact)
  const index = new SearchIndex(store, false)
  const dir = resolve(directory)
  const client = new Proxy({}, { get: () => new Proxy({}, { get: () => noModel }) })
  const ctx = {
    options,
    log,
    store,
    index,
    retriever: new Retriever({ store, index, semantic: undefined, options }),
    git: new GitTracker(store, options.git.enabled, options.git.binary, log.child("git")),
    usage: new UsageStore(store.stateDir, store.locksDir),
    occurrences: new OccurrenceStore(store.stateDir, store.locksDir),
    sessions: new SessionStore(store.stateDir),
    redactor,
    ops: new Ops({ store, options, redactor, log }),
    runs: new RunRegistry(),
    client,
    directory: dir,
    worktree: dir,
    project: basename(dir) || "project",
    toast() {},
  } as unknown as Ctx
  if (options.history.enabled) ctx.history = new SessionHistory(store.stateDir, store.locksDir, options, log.child("history"), (s) => redactor.redact(s))
  const mem = new MemoryDb(store.stateDir, log.child("memory"))
  ctx.mem = mem.available ? mem : undefined
  ctx.scopes = new ScopeResolver(options.git.binary, options.memorysmith.ticketPattern)
  ctx.scope = () => ctx.scopes.resolve(dir, dir)
  ctx.graph = new Graph(store, ctx.mem, ctx.history)
  ctx.ops.setMemory(ctx.mem, ctx.graph)
  attachServices(ctx, undefined, { storeDir })
  ctx.hints = new HintEngine(ctx)
  ctx.workshop = new Workshop(ctx)
  ctx.ops.setScriptRecheck(ctx.workshop.recheck)
  ctx.ops.setSimilarity(ctx.retriever.similarity())
  return ctx
}
