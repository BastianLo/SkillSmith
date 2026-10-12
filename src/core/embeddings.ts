/**
 * Semantic layer on top of BM25 (optional):
 *  - EmbeddingClient: OpenAI-compatible /embeddings endpoint (LiteLLM), model
 *    auto-detection, Matryoshka truncation + re-normalisation, Qwen-style
 *    query instructions, batching, timeouts and a circuit breaker;
 *  - vector storage: see vector-store.ts (SQLite, file fallback);
 *  - SemanticIndex: keeps vectors of all entries and open candidates in sync
 *    (background, incremental) and answers similarity queries.
 * Everything degrades to BM25 when the endpoint is missing or failing.
 */
import { homedir } from "node:os"
import { join } from "node:path"
import type { Options } from "../config"
import type { Logger } from "../log"
import type { Entry, Kind, Tier } from "../types"
import { KINDS } from "../types"
import { isPrivate } from "./kinds"
import { readJson } from "../util/fs"
import { errorMessage, sha, slugify, truncate } from "../util/text"
import { meaningsOf } from "./kinds"
import type { Store } from "./store"
import type { VectorStore } from "./vector-store"

export type { VectorStore } from "./vector-store"

export type EmbedMode = "query" | "document"

export const PURPOSE_INSTRUCTIONS = {
  search: "Given a request or question from a software developer, retrieve the stored skills, documentation, glossary entries, known errors or scripts that help to answer or solve it",
  hint: "Given a message a developer sent to a coding agent, retrieve the stored skills, documentation, glossary entries, known errors or scripts that are relevant for it",
  error: "Given an error message printed by a command, retrieve the documented error with the same cause and its solution",
  context: "Given the transcript of a coding session, retrieve the stored skills, documentation, known errors or scripts that relate to it",
} as const
export type Purpose = keyof typeof PURPOSE_INSTRUCTIONS

type EmbeddingOptions = Options["embedding"]
type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>

export interface EmbeddingStatus {
  state: "off" | "unconfigured" | "detecting" | "ready" | "error" | "paused"
  provider?: string
  baseURL?: string
  model?: string
  dims?: number
  lastError?: string
  lastErrorAt?: string
  calls: number
  texts: number
  avgMs: number
  pausedUntil?: string
}

export function normalize(v: ArrayLike<number>, dims = 0): Float32Array {
  const n = dims > 0 && v.length > dims ? dims : v.length
  const out = new Float32Array(n)
  let norm = 0
  for (let i = 0; i < n; i++) {
    const x = Number(v[i]) || 0
    out[i] = x
    norm += x * x
  }
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < n; i++) out[i] /= norm
  return out
}

export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  let s = 0
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

// ---------------------------------------------------------------------------
// client
// ---------------------------------------------------------------------------

export class EmbeddingClient {
  private baseURL?: string
  private apiKey?: string
  private provider?: string
  private model?: string
  private detecting?: Promise<string | undefined>
  private detectFailedAt = 0
  private providerModels: string[] = []
  private failures = 0
  private pausedUntil = 0
  private warned = false
  readonly status: EmbeddingStatus = { state: "unconfigured", calls: 0, texts: 0, avgMs: 0 }
  /** metrics: every embedding call (duration, texts, ok) */
  onCall?: (ms: number, texts: number, ok: boolean, mode: EmbedMode) => void

  constructor(
    private o: EmbeddingOptions,
    private log: Logger,
    private fetchImpl: FetchLike = (globalThis as any).fetch,
    private env: NodeJS.ProcessEnv = process.env,
  ) {
    if (!o.enabled) this.status.state = "off"
    if (o.baseURL) this.setEndpoint(o.baseURL, o.apiKey, o.provider)
    if (o.model) this.model = o.model
    this.syncStatus()
  }

  private setEndpoint(baseURL: string, apiKey: string | undefined, provider: string | undefined): void {
    this.baseURL = baseURL.replace(/\/+$/, "")
    this.apiKey = apiKey
    this.provider = provider
  }

  /** Resolve endpoint and key from the opencode config (config hook). */
  configureFromOpencode(cfg: any): void {
    if (!this.o.enabled) return
    try {
      const providers: Record<string, any> = cfg?.provider && typeof cfg.provider === "object" ? cfg.provider : {}
      const ids = Object.keys(providers)
      let id = this.o.provider
      if (!id) id = ids.find((x) => /litellm/i.test(x))
      if (!id) {
        const withBase = ids.filter((x) => typeof providers[x]?.options?.baseURL === "string")
        if (withBase.length === 1) id = withBase[0]
      }
      const p = id ? providers[id] : undefined
      if (!this.baseURL && typeof p?.options?.baseURL === "string") this.setEndpoint(p.options.baseURL, undefined, id)
      if (this.baseURL) {
        this.provider ??= id
        this.apiKey ??= this.o.apiKey ?? (typeof p?.options?.apiKey === "string" ? p.options.apiKey : undefined) ?? this.env[this.o.apiKeyEnv] ?? this.authKey(id)
      }
      this.providerModels = p?.models && typeof p.models === "object" ? Object.keys(p.models) : []
    } catch (err) {
      this.log.warn("embedding config failed", errorMessage(err))
    }
    this.syncStatus()
  }

  /** Key stored by `opencode auth login` for this provider (fallback). */
  private authKey(provider: string | undefined): string | undefined {
    if (!provider) return undefined
    const base = this.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
    const auth = readJson<Record<string, any>>(join(base, "opencode", "auth.json"), {})
    const e = auth[provider]
    return e && typeof e.key === "string" ? e.key : undefined
  }

  private syncStatus(): void {
    const s = this.status
    if (!this.o.enabled) s.state = "off"
    else if (!this.baseURL) s.state = "unconfigured"
    else if (Date.now() < this.pausedUntil) s.state = "paused"
    else if (this.model) s.state = s.lastError && this.failures > 0 ? "error" : "ready"
    s.provider = this.provider
    s.baseURL = this.baseURL
    s.model = this.model
    s.pausedUntil = this.pausedUntil > Date.now() ? new Date(this.pausedUntil).toISOString() : undefined
  }

  get timeout(): number {
    return this.o.timeoutMs
  }

  get modelId(): string | undefined {
    return this.model
  }

  /** Configured (endpoint known) – the model may still need detection. */
  get configured(): boolean {
    return this.o.enabled && !!this.baseURL
  }

  /** Usable right now (configured, not paused). */
  available(): boolean {
    return this.configured && Date.now() >= this.pausedUntil
  }

  private headers(): Record<string, string> {
    return { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) }
  }

  /** Pick the embedding model: option → GET /models → provider config models. */
  ensureModel(): Promise<string | undefined> {
    if (this.model) return Promise.resolve(this.model)
    if (!this.available()) return Promise.resolve(undefined)
    if (this.detectFailedAt && Date.now() - this.detectFailedAt < 5 * 60_000) return Promise.resolve(undefined)
    this.detecting ??= (async () => {
      this.status.state = "detecting"
      let ids: string[] = []
      try {
        const res = await this.fetchImpl(`${this.baseURL}/models`, { headers: this.headers(), signal: AbortSignal.timeout(this.o.timeoutMs) })
        if (res.ok) {
          const data = await res.json()
          ids = (Array.isArray(data?.data) ? data.data : []).map((m: any) => String(m?.id ?? "")).filter(Boolean)
        }
      } catch (err) {
        this.log.debug("embedding model detection failed", errorMessage(err))
      }
      const pick = pickEmbeddingModel([...ids, ...this.providerModels])
      if (pick) {
        this.model = pick
        this.log.info(`embedding model: ${pick}${this.provider ? ` (provider ${this.provider})` : ""}`)
      } else {
        this.status.lastError = "no embedding model found (set embedding.model)"
        if (!this.warned) {
          this.warned = true
          this.log.info("embeddings off: no embedding model found at the endpoint (set embedding.model)")
        }
      }
      this.detectFailedAt = pick ? 0 : Date.now()
      this.syncStatus()
      if (!pick) this.status.state = "unconfigured"
      this.detecting = undefined
      return pick
    })()
    return this.detecting
  }

  instruction(): "qwen" | "none" {
    if (this.o.instructionFormat !== "auto") return this.o.instructionFormat
    return /qwen/i.test(this.model ?? "") ? "qwen" : "none"
  }

  formatQuery(text: string, purpose: Purpose): string {
    return this.instruction() === "qwen" ? `Instruct: ${PURPOSE_INSTRUCTIONS[purpose]}\nQuery:${text}` : text
  }

  /**
   * Embed texts (documents as they are, queries with instruction).
   * Returns undefined when embeddings are unavailable or the call fails.
   */
  async embed(texts: string[], mode: EmbedMode, purpose: Purpose = "search", timeoutMs = this.o.timeoutMs): Promise<Float32Array[] | undefined> {
    if (!texts.length) return []
    if (!this.available()) return undefined
    const model = await this.ensureModel()
    if (!model) return undefined
    const inputs = texts.map((t) => truncate(t, 24_000)).map((t) => (mode === "query" ? this.formatQuery(t, purpose) : t))
    const out: Float32Array[] = []
    for (let i = 0; i < inputs.length; i += this.o.batchSize) {
      const batch = inputs.slice(i, i + this.o.batchSize)
      const started = Date.now()
      try {
        const res = await this.fetchImpl(`${this.baseURL}/embeddings`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({ model, input: batch }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${truncate(await res.text().catch(() => ""), 300)}`)
        const data = await res.json()
        const items: any[] = Array.isArray(data?.data) ? [...data.data] : []
        items.sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0))
        if (items.length !== batch.length) throw new Error(`expected ${batch.length} embeddings, got ${items.length}`)
        for (const it of items) {
          const vec = it?.embedding
          if (!Array.isArray(vec) || !vec.length) throw new Error("invalid embedding in response")
          out.push(normalize(vec, this.o.dimensions))
        }
        this.failures = 0
        const ms = Date.now() - started
        this.status.calls++
        this.status.texts += batch.length
        this.status.avgMs = Math.round((this.status.avgMs * (this.status.calls - 1) + ms) / this.status.calls)
        this.status.dims = out[0]?.length
        this.status.lastError = undefined
        this.onCall?.(ms, batch.length, true, mode)
      } catch (err) {
        this.onCall?.(Date.now() - started, batch.length, false, mode)
        this.failures++
        this.status.lastError = truncate(errorMessage(err), 300)
        this.status.lastErrorAt = new Date().toISOString()
        if (this.failures >= 3) {
          this.pausedUntil = Date.now() + 5 * 60_000
          this.failures = 0
          this.log.warn("embeddings paused for 5 min after repeated failures – BM25 only", this.status.lastError)
        } else {
          this.log.debug("embedding call failed", this.status.lastError)
        }
        this.syncStatus()
        return undefined
      }
    }
    this.syncStatus()
    return out
  }

  async embedOne(text: string, mode: EmbedMode, purpose: Purpose = "search", timeoutMs?: number): Promise<Float32Array | undefined> {
    return (await this.embed([text], mode, purpose, timeoutMs))?.[0]
  }

  /** Identity of the vector space (model + dimensions) – vectors of different spaces are never mixed. */
  space(): string | undefined {
    if (!this.model) return undefined
    return `${slugify(this.model, 60) || "model"}-${this.o.dimensions || "full"}`
  }
}

export function pickEmbeddingModel(ids: string[]): string | undefined {
  const uniq = [...new Set(ids)]
  const emb = uniq.filter((id) => /embed/i.test(id))
  if (!emb.length) return undefined
  const qwen8 = emb.find((id) => /qwen/i.test(id) && /8b/i.test(id))
  if (qwen8) return qwen8
  const qwen = emb.find((id) => /qwen/i.test(id))
  if (qwen) return qwen
  return emb.sort()[0]
}

// ---------------------------------------------------------------------------
// semantic index
// ---------------------------------------------------------------------------

/** Text that represents an entry in the vector space (documents carry no instruction). */
export function entryText(e: Pick<Entry, "kind" | "name" | "title" | "description" | "tags" | "fields" | "body">): string {
  const tags = e.tags.length ? `\nTags: ${e.tags.join(", ")}` : ""
  switch (e.kind) {
    case "glossary": {
      const ms = meaningsOf(e.fields.meanings)
      const aliases = ((e.fields.aliases as string[]) ?? []).join(", ")
      return truncate(
        `${String(e.fields.term ?? e.title)}${aliases ? ` (${aliases})` : ""}: ${ms.map((m) => `${m.expansion}${m.context ? ` [${m.context}]` : ""} – ${m.description}`).join("; ")}${tags}\n${e.body}`,
        4000,
      )
    }
    case "error":
      return truncate(
        `${e.title}\n${e.description}\nSignatures: ${((e.fields.signatures as string[]) ?? []).slice(0, 4).join(" | ")}\nContext: ${((e.fields.context as string[]) ?? []).join(", ")}${tags}\n${e.body}`,
        6000,
      )
    case "script":
      return truncate(`${e.name.replace(/-/g, " ")}: ${e.description}\nUsage: ${String(e.fields.usage ?? "")}${tags}\n${e.body}`, 6000)
    default:
      return truncate(`${e.title !== e.name ? `${e.title}\n` : ""}${e.name.replace(/-/g, " ")}: ${e.description}${tags}\n${e.body}`, 6000)
  }
}

export interface SemanticHit {
  kind: Kind
  name: string
  similarity: number
  tier: Tier | "foreign"
}

export class SemanticIndex {
  private syncing?: Promise<number>
  private syncedRevision = -1
  private lastSyncAt = 0
  private pendingSync = false
  /** docs.privateEmbeddings: private documents get vectors too (still never shown to the AI) */
  privateEmbeddings = false

  constructor(
    readonly client: EmbeddingClient,
    private store: Store,
    readonly vectors: VectorStore,
    private log: Logger,
    private includeForeign: boolean,
    /** foreign (project) skills differ per project → own namespace per plugin instance */
    private foreignNs = "foreign-default",
  ) {}

  available(): boolean {
    return this.client.available()
  }

  private nsEntries(kind: Kind): string {
    return `entry-${kind}`
  }

  private nsCandidates(kind: Kind): string {
    return `cand-${kind}`
  }

  private docs(kind: Kind): Array<{ key: string; text: string }> {
    // private documents never go to the embedding endpoint (unless docs.privateEmbeddings)
    return this.store
      .list(kind)
      .filter((e) => this.privateEmbeddings || !isPrivate(e))
      .map((e) => ({ key: e.name, text: entryText(e) }))
  }

  /** Bring vectors of all entries and open candidates up to date. Returns the number of embedded texts. */
  sync(kinds: Kind[] = KINDS): Promise<number> {
    if (this.syncing) {
      this.pendingSync = true
      return this.syncing
    }
    this.syncing = (async () => {
      let embedded = 0
      try {
        const model = await this.client.ensureModel()
        const space = this.client.space()
        if (!model || !space) return 0
        const revision = this.store.revision
        for (const kind of kinds) {
          embedded += await this.syncNamespace(space, this.nsEntries(kind), this.docs(kind).map((d) => ({ key: d.key, text: d.text })))
          const cands = this.store
            .candidates(kind)
            .filter((c) => !c.promotedTo)
            .map((c) => ({ key: c.id, text: `${c.summary}\nKeywords: ${c.keywords.join(", ")}` }))
          embedded += await this.syncNamespace(space, this.nsCandidates(kind), cands)
        }
        if (this.includeForeign && kinds.includes("skill")) {
          embedded += await this.syncNamespace(
            space,
            this.foreignNs,
            this.store.listForeign().map((e) => ({ key: e.name, text: entryText(e) })),
          )
        }
        await this.vectors.flush()
        this.syncedRevision = revision
        this.lastSyncAt = Date.now()
        if (embedded) this.log.debug(`embeddings synced: ${embedded} text(s)`)
      } catch (err) {
        this.log.warn("embedding sync failed", errorMessage(err))
      } finally {
        this.syncing = undefined
        if (this.pendingSync) {
          this.pendingSync = false
          void this.sync()
        }
      }
      return embedded
    })()
    return this.syncing
  }

  private async syncNamespace(space: string, ns: string, docs: Array<{ key: string; text: string }>): Promise<number> {
    const wanted = new Map(docs.map((d) => [d.key, { text: d.text, hash: sha(d.text, 16) }]))
    for (const k of this.vectors.keys(space, ns)) if (!wanted.has(k)) this.vectors.delete(space, ns, k)
    const todo = [...wanted.entries()].filter(([k, v]) => this.vectors.get(space, ns, k)?.hash !== v.hash)
    let done = 0
    for (let i = 0; i < todo.length; i += 32) {
      const chunk = todo.slice(i, i + 32)
      // documents are long and the model may be cold: generous timeout for the background sync
      const vecs = await this.client.embed(
        chunk.map(([, v]) => v.text),
        "document",
        "search",
        Math.max(60_000, this.client.timeout),
      )
      if (!vecs) break
      chunk.forEach(([k, v], j) => this.vectors.set(space, ns, k, v.hash, vecs[j]))
      done += chunk.length
    }
    return done
  }

  /** Sync in the background when the store changed (never blocks callers). */
  touch(): void {
    if (!this.client.configured) return
    if (this.store.revision === this.syncedRevision && Date.now() - this.lastSyncAt < 10 * 60_000) return
    void this.sync()
  }

  /** Wait (bounded) for vectors of one kind to be current – used by gates that need fresh data. */
  async ensureCurrent(maxMs = 5000): Promise<void> {
    if (!this.client.available()) return
    if (this.store.revision === this.syncedRevision && !this.syncing) return
    await Promise.race([this.sync(), new Promise((r) => setTimeout(r, maxMs))])
  }

  private queryCache = new Map<string, Float32Array>()

  /** Query embedding (with instruction); small LRU cache – the same transcript is queried by several smiths. */
  async embedQuery(text: string, purpose: Purpose, timeoutMs?: number): Promise<Float32Array | undefined> {
    const k = `${this.client.space() ?? ""}|${purpose}|${sha(text, 16)}`
    const hit = this.queryCache.get(k)
    if (hit) {
      this.queryCache.delete(k)
      this.queryCache.set(k, hit)
      return hit
    }
    const vec = await this.client.embedOne(text, "query", purpose, timeoutMs)
    if (vec) {
      this.queryCache.set(k, vec)
      if (this.queryCache.size > 64) this.queryCache.delete(this.queryCache.keys().next().value as string)
    }
    return vec
  }

  embedDocument(text: string, timeoutMs?: number): Promise<Float32Array | undefined> {
    return this.client.embedOne(text, "document", "search", timeoutMs)
  }

  /** Similarity of all entries of the given kinds to a vector (filters applied by the caller). */
  score(vec: Float32Array, kinds: Kind[]): SemanticHit[] {
    const space = this.client.space()
    if (!space) return []
    const out: SemanticHit[] = []
    for (const kind of kinds) {
      const byName = new Map(this.store.list(kind).map((e) => [e.name, e]))
      for (const [name, v] of this.vectors.entries(space, this.nsEntries(kind))) {
        const rec = byName.get(name)
        if (!rec || isPrivate(rec)) continue
        out.push({ kind, name, similarity: dot(vec, v.vec), tier: rec.tier as Tier })
      }
      if (kind === "skill" && this.includeForeign) {
        const owned = new Set(this.store.list("skill").map((e) => e.name))
        for (const [name, v] of this.vectors.entries(space, this.foreignNs)) {
          if (owned.has(name)) continue
          out.push({ kind, name, similarity: dot(vec, v.vec), tier: "foreign" })
        }
      }
    }
    return out.sort((a, b) => b.similarity - a.similarity)
  }

  /** Keep vectors of a custom namespace (doc sections, sessions, tags) in sync with `docs`; returns embedded count. */
  async syncCustom(ns: string, docs: Array<{ key: string; text: string }>): Promise<number> {
    const model = await this.client.ensureModel()
    const space = this.client.space()
    if (!model || !space) return 0
    const n = await this.syncNamespace(space, ns, docs)
    await this.vectors.flush()
    return n
  }

  /** Similarities of all vectors in a custom namespace. */
  scoreCustom(vec: Float32Array, ns: string): Array<{ id: string; similarity: number }> {
    const space = this.client.space()
    if (!space) return []
    return this.vectors
      .entries(space, ns)
      .map(([id, v]) => ({ id, similarity: dot(vec, v.vec) }))
      .sort((a, b) => b.similarity - a.similarity)
  }

  /** Stored vector of an entry (if synced). */
  vectorOf(kind: Kind, name: string): Float32Array | undefined {
    const space = this.client.space()
    return space ? this.vectors.get(space, this.nsEntries(kind), name)?.vec : undefined
  }

  /** All stored entry vectors of a kind (owned entries). */
  entryVectors(kind: Kind): Map<string, Float32Array> {
    const space = this.client.space()
    const out = new Map<string, Float32Array>()
    if (!space) return out
    for (const [name, v] of this.vectors.entries(space, this.nsEntries(kind))) out.set(name, v.vec)
    return out
  }

  /** Candidate similarities (open candidates only). */
  candidateScores(vec: Float32Array, kind: Kind): Map<string, number> {
    const space = this.client.space()
    const out = new Map<string, number>()
    if (!space) return out
    for (const [id, v] of this.vectors.entries(space, this.nsCandidates(kind))) out.set(id, dot(vec, v.vec))
    return out
  }

  status(): { space?: string; counts: Record<string, number>; syncedAt?: string } {
    const space = this.client.space()
    return { space, counts: space ? this.vectors.count(space) : {}, syncedAt: this.lastSyncAt ? new Date(this.lastSyncAt).toISOString() : undefined }
  }
}
