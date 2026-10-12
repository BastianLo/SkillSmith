/**
 * Tool argument schemas without a hard dependency: uses zod from
 * @opencode-ai/plugin when it is resolvable (opencode installs it into every
 * config directory), otherwise plain JSON Schema (supported since 1.14.49).
 */
export type ArgKind = "string" | "number" | "boolean" | "string[]"

export interface ArgSpec {
  kind: ArgKind
  description: string
  optional?: boolean
}

export type ArgSpecs = Record<string, ArgSpec>

let zodCache: any | null | undefined

export async function loadZod(): Promise<any | null> {
  if (zodCache !== undefined) return zodCache
  if (process.env.SKILLSMITH_FORCE_JSON_SCHEMA === "1") return (zodCache = null)
  try {
    const mod: any = await import("@opencode-ai/plugin")
    zodCache = mod?.tool?.schema ?? null
  } catch {
    zodCache = null
  }
  return zodCache
}

export function buildArgs(specs: ArgSpecs, z: any | null): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, spec] of Object.entries(specs)) {
    if (z) {
      let t: any
      if (spec.kind === "string") t = z.string()
      else if (spec.kind === "number") t = z.number()
      else if (spec.kind === "boolean") t = z.boolean()
      else t = z.array(z.string())
      t = t.describe(spec.description)
      if (spec.optional) t = t.optional()
      out[name] = t
    } else {
      const description = spec.optional ? `${spec.description} (optional – use an empty value if not needed)` : spec.description
      if (spec.kind === "string[]") out[name] = { type: "array", items: { type: "string" }, description }
      else out[name] = { type: spec.kind, description }
    }
  }
  return out
}
