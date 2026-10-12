/**
 * Model choice for every session skillsmith starts (background smiths, assistant, agent tasks).
 *
 * opencode reads a model as "provider/model". A name without provider ("Hermes" – e.g. a
 * router combo) becomes providerID "Hermes" with an empty model id and fails with
 * "Model not found: Hermes/." – the TUI hides that because it validates the agent's and the
 * configured model and silently falls back to a recent one. Sessions started through the API
 * get no such fallback, so skillsmith validates every candidate against config.providers(),
 * repairs unambiguous names ("Hermes" → "9router/Hermes") and always passes an explicit model.
 */
export type ModelRef = { providerID: string; modelID: string }

/** SDK result → data (own copy: agent-runner imports this module). */
function unwrap<T = any>(res: any): T {
  if (res && typeof res === "object" && "error" in res && res.error) throw new Error(typeof res.error === "string" ? res.error : JSON.stringify(res.error))
  if (res && typeof res === "object" && "data" in res) return res.data as T
  return res as T
}

export interface ModelCatalog {
  /** every offered model as "provider/model" */
  specs: string[]
  /** opencode's default model per provider (only offered ones) */
  defaults: string[]
}

export interface ModelChoice {
  model?: ModelRef
  spec?: string
  /** what was repaired or skipped – shown at the job, in logs and errors */
  note?: string
}

export interface ModelCandidate {
  spec?: string
  label: string
  /** an explicitly chosen model: unknown → error instead of falling back */
  strict?: boolean
}

export class ModelChoiceError extends Error {}

type Client = any

const providerOf = (spec: string) => spec.slice(0, spec.indexOf("/"))
const idOf = (spec: string) => spec.slice(spec.indexOf("/") + 1)

const cache = new WeakMap<object, { at: number; catalog: ModelCatalog | undefined }>()
const MAX_AGE_MS = 30_000

/** Offered models of opencode (cached 30 s per client); undefined when opencode does not tell. */
export async function modelCatalog(client: Client, fresh = false): Promise<ModelCatalog | undefined> {
  const hit = client && typeof client === "object" ? cache.get(client) : undefined
  if (hit && !fresh && Date.now() - hit.at < MAX_AGE_MS) return hit.catalog
  let catalog: ModelCatalog | undefined
  try {
    const data = unwrap<any>(await client.config.providers())
    const providers: any[] = Array.isArray(data?.providers) ? data.providers : []
    const specs: string[] = []
    for (const p of providers) {
      if (!p?.id) continue
      const models = p.models ?? {}
      const ids = Array.isArray(models) ? models.map((m: any) => m?.id) : Object.entries(models).map(([k, m]: [string, any]) => m?.id ?? k)
      for (const id of ids) if (typeof id === "string" && id) specs.push(`${p.id}/${id}`)
    }
    // providers of the user's opencode.json first (opencode also lists providers enabled by
    // environment variables, e.g. github-copilot) – the fallback must be one the user set up
    let configured: string[] = []
    try {
      configured = Object.keys(unwrap<any>(await client.config.get())?.provider ?? {})
    } catch {
      configured = []
    }
    const rank = (spec: string) => {
      const i = configured.indexOf(providerOf(spec))
      return i < 0 ? configured.length : i
    }
    const order = (xs: string[]) => xs.map((x, i) => ({ x, i })).sort((a, b) => rank(a.x) - rank(b.x) || a.i - b.i).map((e) => e.x)
    const defaults = Object.entries((data?.default ?? {}) as Record<string, string>)
      .map(([p, m]) => `${p}/${m}`)
      .filter((s) => specs.includes(s))
    catalog = specs.length ? { specs: order(specs), defaults: order(defaults) } : undefined
  } catch {
    catalog = undefined
  }
  if (client && typeof client === "object") cache.set(client, { at: Date.now(), catalog })
  return catalog
}

/** "provider/model" of a ref or string; provider-less refs ({providerID:"Hermes", modelID:""}) become "Hermes". */
export function specOf(m: ModelRef | string | undefined | null): string | undefined {
  if (!m) return undefined
  if (typeof m === "string") return m.trim().replace(/\/+$/, "") || undefined
  const p = (m.providerID ?? "").trim()
  const id = (m.modelID ?? "").trim()
  if (p && id) return `${p}/${id}`
  return p || id || undefined
}

export function refOf(spec: string): ModelRef {
  const i = spec.indexOf("/")
  return i > 0 ? { providerID: spec.slice(0, i), modelID: spec.slice(i + 1) } : { providerID: "", modelID: spec }
}


/** The offered model a spec means: exact, case-insensitive, model id without provider, or a provider with one model. */
export function matchModel(spec: string | undefined, catalog: ModelCatalog): { spec: string; repaired: boolean } | undefined {
  const s = specOf(spec)
  if (!s) return undefined
  if (catalog.specs.includes(s)) return { spec: s, repaired: false }
  const lower = s.toLowerCase()
  const exact = catalog.specs.filter((x) => x.toLowerCase() === lower)
  if (exact.length === 1) return { spec: exact[0], repaired: true }
  const i = s.indexOf("/")
  const name = (i > 0 ? s.slice(i + 1) : s).toLowerCase()
  const byId = catalog.specs.filter((x) => idOf(x).toLowerCase() === name)
  if (byId.length === 1) return { spec: byId[0], repaired: true }
  if (i < 0) {
    const byProvider = catalog.specs.filter((x) => providerOf(x).toLowerCase() === lower)
    if (byProvider.length === 1) return { spec: byProvider[0], repaired: true }
  }
  return undefined
}

function listOf(catalog: ModelCatalog, max = 12): string {
  const shown = catalog.specs.slice(0, max).join(", ")
  return catalog.specs.length > max ? `${shown} … (${catalog.specs.length})` : shown
}

/** Human hint for an opencode "Model not found" error. */
export function modelErrorHint(message: string | undefined, catalog?: ModelCatalog): string | undefined {
  if (!message || !/ProviderModelNotFound|Model not found/i.test(message)) return undefined
  const m = /Model not found:\s*([^\s(]+?)\.?(?:\s|$)/i.exec(message)
  const bad = m?.[1]?.replace(/\/+$/, "")
  const fix = bad && catalog ? matchModel(bad, catalog) : undefined
  return [
    `opencode erwartet Modelle als provider/modell${bad ? ` – „${bad}“ hat ${bad.includes("/") ? "kein passendes Modell" : "keinen Provider"}` : ""}.`,
    fix ? `Gemeint ist vermutlich ${fix.spec}.` : catalog ? `Verfügbar: ${listOf(catalog)}.` : "",
    "Prüfen Sie `model` im Agenten (Datei unter agent/ oder \"agent\" in opencode.json) und `model` in opencode.json.",
  ]
    .filter(Boolean)
    .join(" ")
}

/**
 * First usable candidate. Unknown strict candidates throw; others are skipped with a note.
 * Without candidates (or none usable) opencode's default model is taken. Without a catalog
 * (opencode does not list providers) the first candidate in provider/model form is used as is.
 */
export async function chooseModel(client: Client, candidates: ModelCandidate[]): Promise<ModelChoice> {
  const catalog = await modelCatalog(client)
  const notes: string[] = []
  if (!catalog) {
    for (const c of candidates) {
      const s = specOf(c.spec)
      if (s && s.includes("/")) return { model: refOf(s), spec: s }
    }
    return {}
  }
  for (const c of candidates) {
    const s = specOf(c.spec)
    if (!s) continue
    const hit = matchModel(s, catalog)
    if (hit) {
      if (hit.repaired) notes.push(`${c.label} „${s}“ → ${hit.spec}`)
      return { model: refOf(hit.spec), spec: hit.spec, note: notes.join("; ") || undefined }
    }
    if (c.strict) throw new ModelChoiceError(`Model not found: ${s} – ${c.label} „${s}“ gibt es in opencode nicht (Format provider/modell). Verfügbar: ${listOf(catalog)}`)
    notes.push(`${c.label} „${s}“ ist in opencode unbekannt`)
  }
  const fallback = catalog.defaults[0] ?? catalog.specs[0]
  notes.push(`verwendet opencodes Standard ${fallback}`)
  return { model: refOf(fallback), spec: fallback, note: notes.join("; ") }
}

/** The model an agent is configured with ("provider/model", or the bare name opencode could not split). */
export async function agentModelSpec(client: Client, agent: string): Promise<string | undefined> {
  try {
    const list = unwrap<any[]>(await client.app.agents())
    return specOf((list ?? []).find((a) => a?.name === agent)?.model)
  } catch {
    return undefined
  }
}

/** `model` of opencode.json. */
export async function configModelSpec(client: Client): Promise<string | undefined> {
  try {
    return specOf(unwrap<any>(await client.config.get())?.model)
  } catch {
    return undefined
  }
}
