import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveOptions, type Options } from "../../src/config"
import type { Ctx } from "../../src/core/context"
import { EmbeddingClient, SemanticIndex } from "../../src/core/embeddings"
import { Doctor } from "../../src/core/doctor"
import { GitTracker } from "../../src/core/git"
import { Graph } from "../../src/core/graph"
import { MemoryDb } from "../../src/core/memory-db"
import { ScopeResolver, type Scope } from "../../src/core/scope"
import { WebServer } from "../../src/web/server"
import { HintEngine } from "../../src/core/hints"
import { Ops } from "../../src/core/ops"
import { attachServices } from "../../src/core/services"
import { ProjectDocs } from "../../src/core/project-docs"
import { createRedactor } from "../../src/core/redact"
import { Retriever } from "../../src/core/retrieval"
import { RunRegistry } from "../../src/core/runs"
import { SearchIndex } from "../../src/core/search"
import { SessionHistory } from "../../src/core/session-history"
import { OccurrenceStore, SessionStore, UsageStore } from "../../src/core/state"
import { Store } from "../../src/core/store"
import { Workshop } from "../../src/core/toolsmith"
import { openVectorStoreSync } from "../../src/core/vector-store"
import { silentLogger } from "../../src/log"
import type { Actor, Run, Smith } from "../../src/types"

export function tmp(prefix = "skillsmith-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Deterministic fake embedding endpoint: bag of "concepts" (synonym groups) hashed into 64 dims. */
export const CONCEPTS: string[][] = [
  ["deploy", "deployment", "deployen", "produktion", "prod", "ausliefern", "ausrollen", "release", "rollout"],
  ["service", "dienst", "anwendung", "app"],
  ["certificate", "zertifikat", "pkix", "truststore", "ssl", "tls", "certification"],
  ["test", "tests", "testen", "pruefen", "prüfen"],
  ["customer", "kunde", "kunden", "kundendaten", "kundenstamm"],
  ["offset", "offsets", "position", "lag"],
  ["kafka", "consumer", "topic"],
]

export function fakeVector(text: string, dims = 64): number[] {
  const t = text.includes("\nQuery:") ? text.slice(text.indexOf("\nQuery:") + 7) : text
  const v = new Array(dims).fill(0)
  const words = t.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/).filter((w) => w.length > 2)
  for (const w of words) {
    const ci = CONCEPTS.findIndex((g) => g.some((x) => w === x.normalize("NFKD").replace(/[\u0300-\u036f]/g, "") || (x.length > 4 && w.startsWith(x))))
    if (ci >= 0) v[ci] += 3
    else {
      let h = 7
      for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0
      v[8 + (h % (dims - 8))] += 1
    }
  }
  return v
}

export function fakeFetch(opts: { fail?: () => boolean; models?: string[]; calls?: { n: number } } = {}) {
  return async (url: string, init?: any) => {
    if (opts.calls) opts.calls.n++
    if (opts.fail?.()) throw new Error("connection refused")
    if (url.endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: (opts.models ?? ["chat-1", "qwen3-embedding-8b"]).map((id) => ({ id })) }), text: async () => "" }
    const body = JSON.parse(init.body)
    return { ok: true, status: 200, json: async () => ({ data: body.input.map((t: string, index: number) => ({ index, embedding: fakeVector(t) })) }), text: async () => "" }
  }
}

export function makeCtx(
  overrides: Record<string, unknown> = {},
  client: any = {},
  extra: { checkClaims?: boolean; claimWait?: { agent: number; command: number }; fetch?: any; scope?: Scope; noMemoryDb?: boolean } = {},
): Ctx {
  const root = tmp()
  const raw = { storeDir: join(root, "store"), ...overrides }
  const { options } = resolveOptions(raw, {})
  const store = new Store(options.storeDir, silentLogger)
  store.init()
  const redactor = createRedactor(options.redact)
  const index = new SearchIndex(store, options.indexForeignSkills)
  // embeddings only when a fake endpoint is given (unit tests stay offline by default)
  const semantic =
    extra.fetch && options.embedding.enabled
      ? new SemanticIndex(
          new EmbeddingClient({ ...options.embedding, baseURL: options.embedding.baseURL ?? "http://embed.test/v1" }, silentLogger, extra.fetch, {}),
          store,
          openVectorStoreSync(join(store.stateDir, "embeddings"), store.locksDir, silentLogger, options.embedding.storage),
          silentLogger,
          options.indexForeignSkills,
        )
      : undefined
  const ctx = {
    options,
    log: silentLogger,
    store,
    index,
    retriever: new Retriever({ store, index, semantic, options }),
    semantic,
    git: new GitTracker(store, options.git.enabled, options.git.binary, silentLogger),
    usage: new UsageStore(store.stateDir, store.locksDir),
    occurrences: new OccurrenceStore(store.stateDir, store.locksDir),
    sessions: new SessionStore(store.stateDir),
    redactor,
    ops: new Ops({ store, options, redactor, log: silentLogger, checkClaims: extra.checkClaims ?? false, claimWait: extra.claimWait }),
    runs: new RunRegistry(),
    client,
    directory: join(root, "project"),
    worktree: join(root, "project"),
    project: "project",
    toast() {},
  } as Ctx
  ctx.projectDocs = new ProjectDocs(ctx.worktree, options, silentLogger, (s) => redactor.redact(s), semantic)
  ctx.history = new SessionHistory(store.stateDir, store.locksDir, options, silentLogger, (s) => redactor.redact(s), semantic)
  const mem = extra.noMemoryDb ? undefined : new MemoryDb(store.stateDir, silentLogger)
  ctx.mem = mem?.available ? mem : undefined
  ctx.scopes = new ScopeResolver(options.git.binary, options.memorysmith.ticketPattern)
  const scope = extra.scope ?? TEST_SCOPE
  ctx.scope = () => ({ ...scope })
  ctx.graph = new Graph(store, ctx.mem, ctx.history)
  ctx.ops.setMemory(ctx.mem, ctx.graph)
  attachServices(ctx, undefined, raw)
  ctx.doctor = new Doctor(ctx)
  ctx.web = new WebServer(ctx)
  ctx.hints = new HintEngine(ctx)
  ctx.workshop = new Workshop(ctx)
  ctx.ops.setScriptRecheck(ctx.workshop.recheck)
  // always: tag plan works with BM25, the semantic gates only with embeddings
  ctx.ops.setSimilarity(ctx.retriever.similarity())
  return ctx
}

export const TEST_SCOPE: Scope = { project: "github.com/acme/shop", projectName: "shop", projectSlug: "shop", branch: "feature/T2-123-login", ticket: "T2-123" }

export function makeRun(ctx: Ctx, actor: Actor = "reviewer", extra: Partial<Run> = {}, opts: Partial<Options> & { smith?: Smith } = {}): Run {
  const run = ctx.runs.create({
    smith: opts.smith ?? extra.smith ?? "skillsmith",
    actor,
    trigger: "test",
    writeMode: (opts.writeMode ?? ctx.options.writeMode) as any,
    directory: ctx.directory,
    project: ctx.project,
    sessionID: "ses_test_1",
    limits: { maxNew: 1, maxChanges: 3, maxNotes: 5 },
  })
  Object.assign(run, extra)
  return run
}

export const cmdRun = (ctx: Ctx, smith: Smith = "skillsmith") =>
  makeRun(ctx, "command", { smith, limits: { maxNew: 1000, maxChanges: 1000, maxNotes: 0 } })

export const BODY = `## When to use
When resetting Kafka consumer group offsets.

## Steps
1. Run \`kafka-consumer-groups --bootstrap-server $BROKER --group $GROUP --reset-offsets --to-earliest --execute --topic $TOPIC\`
2. Verify with \`--describe\`.

## Pitfalls
- The group must be inactive; stop consumers first because active members block the reset.

## Verification
- \`--describe\` shows LAG equal to the topic size.`

export const ERROR_BODY = `## Symptom
\`\`\`
PKIX path building failed: unable to find valid certification path
\`\`\`
Appears when Maven downloads from the internal Nexus.

## Ursache
The corporate root CA is missing in the JDK truststore.

## Lösung
1. \`keytool -importcert -cacerts -alias corp-root -file corp-root.pem\`
2. Run the build again.

## Prüfung
\`mvn -U dependency:resolve\` succeeds.`
