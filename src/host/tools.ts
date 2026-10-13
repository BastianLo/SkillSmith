/**
 * Tools of all smiths.
 *  - read tools (main agent + background agents): skill_search, skill_list,
 *    skill_read, knowledge_search, knowledge_list, knowledge_read,
 *    glossary_lookup, glossary_list, error_lookup, error_list, script_search,
 *    script_list, script_read, docs_search (project .md files),
 *    history_search (earlier sessions), memory_search, memory_list, memory_read,
 *    graph_neighbors (memories and relations)
 *  - write tools (only inside background runs of the matching smith):
 *    skillsmith_*, docsmith_*, errorsmith_*, toolsmith_*, memorysmith_*, doctor_*
 */
import { sessionSignals } from "../core/agent-runner"
import type { Ctx } from "../core/context"
import { sessionInfo } from "../core/services"
import { str as fmStr, strArray } from "../core/frontmatter"
import { isPrivate, meaningsOf, scriptFiles, scriptLanguage, spec, TIER_LABEL } from "../core/kinds"
import { isStoreId, nodeLabel, RELATION_LABEL } from "../core/graph"
import { formatMemoryEntry, formatResult, formatState, memoryLine, relationLine, relationLines } from "../core/memory-format"
import { GuardError, normalizeNodeId, normalizeQuote } from "../core/ops"
import { Retriever } from "../core/retrieval"
import { formatRecord } from "../core/session-history"
import { StoreError } from "../core/store"
import type { Entry, Kind, Run, SearchHit, Smith, Tier } from "../types"
import { key } from "../types"
import { errorMessage, fold, nowIso, tokenize, truncate } from "../util/text"
import { buildArgs, type ArgSpecs } from "./schema"
import { callScript } from "../core/scripts"

/** A JSON object given as string (schemas of toolsmith_draft). */
function jsonObj(v: unknown, what: string): Record<string, unknown> | undefined {
  const s = typeof v === "string" ? v.trim() : ""
  if (!s) return undefined
  let o: unknown
  try {
    o = JSON.parse(s)
  } catch {
    throw new GuardError(`${what} must be a JSON object`)
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new GuardError(`${what} must be a JSON object`)
  return o as Record<string, unknown>
}

export const READ_TOOLS = [
  "skill_search",
  "skill_list",
  "skill_read",
  "knowledge_search",
  "knowledge_list",
  "knowledge_read",
  "glossary_lookup",
  "glossary_list",
  "error_lookup",
  "error_list",
  "script_search",
  "script_list",
  "script_read",
  "docs_search",
  "history_search",
  "memory_search",
  "memory_list",
  "memory_read",
  "graph_neighbors",
] as const
export const WRITE_TOOL_PREFIXES = ["skillsmith_", "docsmith_", "errorsmith_", "toolsmith_", "memorysmith_", "doctor_"] as const
/** @deprecated v1 */
export const WRITE_TOOL_PREFIX = "skillsmith_"

interface ToolCtx {
  sessionID: string
  agent?: string
  directory?: string
  /** set by the wrapper in createTools (audit of rejected actions) */
  __tool?: string
  __target?: string
}

type ToolDef = {
  description: string
  args: Record<string, unknown>
  execute(args: any, context: ToolCtx): Promise<string>
}

const AI_STORES = new WeakMap<Ctx, ReturnType<typeof aiStore>>()
function aiStoreOf(ctx: Ctx): ReturnType<typeof aiStore> {
  let s = AI_STORES.get(ctx)
  if (!s) AI_STORES.set(ctx, (s = aiStore(ctx)))
  return s
}

/** The store as the AI sees it: private documents (KI-Recht privat) do not exist. */
function aiStore(ctx: Ctx) {
  const hide = (e?: Entry): Entry | undefined => (e && !isPrivate(e) ? e : undefined)
  return {
    getOwned: (kind: Kind, name: string) => hide(ctx.store.getOwned(kind, name)),
    get: (kind: Kind, name: string) => hide(ctx.store.get(kind, name)),
    list: (kind: Kind) => ctx.store.list(kind).filter((e) => !isPrivate(e)),
    glossaryByTerm: (term: string) => ctx.store.glossaryByTerm(term).filter((e) => !isPrivate(e)),
  }
}

/** [[links]] of an entry as ids the agent can follow (private targets left out). */
function linkLine(ctx: Ctx, id: string): string {
  try {
    const ids = [...new Set(ctx.links.outgoingOf(id).map((l) => l.id).filter((x): x is string => !!x && !ctx.graph.hidden(x)))]
    return ids.length ? `links: ${ids.slice(0, 30).join(", ")} (open with the read tool of each kind)` : ""
  } catch {
    return ""
  }
}

const bool = (v: unknown) => v === true || v === "true"
const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v))
const opt = (v: unknown) => str(v).trim() || undefined
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : typeof v === "string" && v.trim() ? v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean) : []
const optList = (v: unknown): string[] | undefined => {
  const l = list(v)
  return l.length ? l : undefined
}

function tiersFor(kind: Kind, includeArchived: boolean): Array<Tier | "foreign"> {
  const t: Array<Tier | "foreign"> = spec(kind).tiers.filter((x) => x !== "archive")
  if (includeArchived) t.push("archive")
  if (kind === "skill") t.push("foreign")
  return t
}

function tierLabel(t: string): string {
  return TIER_LABEL[t] ?? t
}

function hitLine(h: SearchHit, i: number, extra = ""): string {
  const title = h.title && h.title !== h.name ? ` – ${truncate(h.title, 100)}` : ""
  return `${i + 1}. ${h.name} [${tierLabel(h.tier)}${h.owned ? "" : " · read-only"}] (score ${Retriever.display(h).toFixed(2)})${title} – ${truncate(h.description, 200)}${
    h.tags.length ? ` {${h.tags.slice(0, 6).join(", ")}}` : ""
  }${extra}${h.snippet ? `\n   match: ${h.snippet}` : ""}`
}

export function formatGlossary(e: Entry, withNotes = true): string {
  const ms = meaningsOf(e.fields.meanings)
  const aliases = strArray(e.fields.aliases)
  const lines = [`${String(e.fields.term)}${e.tier !== "active" ? ` [${tierLabel(e.tier)}]` : ""}${aliases.length ? ` (auch: ${aliases.join(", ")})` : ""}`]
  for (const m of ms) lines.push(`  • ${m.expansion}${m.context ? ` [${m.context}]` : ""}: ${m.description}`)
  if (e.tags.length) lines.push(`  tags: ${e.tags.join(", ")}`)
  if (withNotes && e.body.trim()) lines.push(`  ${truncate(e.body.trim().replace(/\n+/g, " "), 400)}`)
  return lines.join("\n")
}

/** Arg specs shared by all list tools: no query, archive off by default (search uses a different default). */
const listSpecs = (what: string): ArgSpecs => ({
  include_archived: { kind: "boolean", description: `Also list archived ${what} (default false)`, optional: true },
  tags: { kind: "string[]", description: "Only entries carrying all of these tags", optional: true },
  limit: { kind: "number", description: "Max entries per tier (default 100)", optional: true },
})

/** Visible entries of a kind (AI view: private entries never appear), tier/tag filtered, sorted by name. */
function listEntries(ctx: Ctx, kind: Kind, args: any, filter?: (e: Entry) => boolean): Entry[] {
  const tiers = tiersFor(kind, bool(args.include_archived))
  const tags = list(args.tags)
  const base = aiStoreOf(ctx).list(kind)
  // store.list does not contain foreign skills; skill_list merges them (read-only), private ones left out
  const all = kind === "skill" ? [...base, ...ctx.store.listForeign().filter((e) => !isPrivate(e))] : base
  return all
    .filter((e) => tiers.includes(e.tier) && tags.every((t) => e.tags.includes(t)) && (!filter || filter(e)))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** One line per entry – like hitLine, but for an Entry (no score). */
function entryLine(e: Entry, i: number, extra = ""): string {
  const title = e.title && e.title !== e.name ? ` – ${truncate(e.title, 100)}` : ""
  return `${i + 1}. ${e.name} [${tierLabel(e.tier)}${e.owned ? "" : " · read-only"}]${e.meta?.pinned ? " 📌" : ""}${title} – ${truncate(e.description, 200)}${
    e.tags.length ? ` {${e.tags.slice(0, 6).join(", ")}}` : ""
  }${extra}`
}

/** Grouped, limited output (analogous to listKind): one head per tier + "… N weitere". */
function formatList(kind: Kind, entries: Entry[], opts: { line?: (e: Entry, i: number) => string; perTier?: number } = {}): string {
  const perTier = Math.max(1, Number(opts.perTier) || 100)
  const order: Array<Tier | "foreign"> = [...spec(kind).tiers, ...(kind === "skill" ? (["foreign"] as Array<Tier | "foreign">) : [])]
  const line = opts.line ?? ((e: Entry, i: number) => entryLine(e, i))
  const lines: string[] = []
  for (const t of order) {
    const items = entries.filter((e) => e.tier === t)
    if (!items.length) continue
    lines.push(`**${spec(kind).labelPlural} – ${tierLabel(t)} (${items.length})**`)
    items.slice(0, perTier).forEach((e, i) => lines.push(line(e, i)))
    if (items.length > perTier) lines.push(`- … ${items.length - perTier} weitere`)
    lines.push("")
  }
  return lines.join("\n").trim() || `Keine ${spec(kind).labelPlural}-Einträge.`
}

function section(body: string, re: RegExp): string | undefined {
  return new RegExp(`^##\\s+(${re.source})[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, "im").exec(body)?.[2]?.trim()
}

export function createTools(ctx: Ctx, z: any | null): Record<string, ToolDef> {
  const def = (description: string, specs: ArgSpecs, execute: ToolDef["execute"]): ToolDef => ({
    description,
    args: buildArgs(specs, z),
    execute,
  })

  const withRun = async (context: ToolCtx, smith: Smith, fn: (run: Run) => Promise<string>): Promise<string> => {
    const run = ctx.runs.forAgentSession(context.sessionID)
    if (!run) return "This tool is only available inside skillsmith background runs."
    if (run.smith !== smith) return `This tool belongs to ${smith}; this is a ${run.smith} run.`
    try {
      return await fn(run)
    } catch (err) {
      if (err instanceof GuardError || err instanceof StoreError) {
        // the audit log keeps every rejected attempt (where gates or prompts need work)
        ;(run.rejections ??= []).push({ at: nowIso(), tool: context.__tool, target: context.__target, message: err.message })
        return `Rejected: ${err.message}`
      }
      ctx.log.error("tool failed", errorMessage(err))
      return `Failed: ${errorMessage(err)}`
    }
  }

  /** usage tracking for the main agent (not for background runs) */
  const used = (context: ToolCtx | undefined, kind: Kind, name: string) => {
    const sid = context?.sessionID
    if (!sid || ctx.runs.isAgentSession(sid) || sessionSignals().isInternal(sid)) return
    try {
      ctx.usage.recordLoad(kind, name, { session: sid, agent: context?.agent })
      ctx.sessions.update(sid, ctx.directory, (s) => {
        const k = key(kind, name)
        if (!s.loaded.includes(k)) s.loaded.push(k)
      })
      ctx.hints.onEntryUsed(sid, kind, name)
    } catch (err) {
      ctx.log.debug("usage tracking failed", errorMessage(err))
    }
  }

  const searchSpecs = (what: string): ArgSpecs => ({
    query: { kind: "string", description: `What you are looking for (${what})` },
    include_archived: { kind: "boolean", description: "Also search archived entries (default true)", optional: true },
    tags: { kind: "string[]", description: "Only entries carrying all of these tags", optional: true },
    limit: { kind: "number", description: "Max results (default 8)", optional: true },
  })

  const search = async (kind: Kind, args: any, extra?: (h: SearchHit) => string): Promise<string> => {
    const query = str(args.query).trim()
    const tags = list(args.tags)
    if (!query && !tags.length) return "Please provide a query."
    const includeArchived = args.include_archived === undefined || args.include_archived === "" ? true : bool(args.include_archived)
    const limit = Math.min(20, Math.max(1, Number(args.limit) || 8))
    let hits: SearchHit[]
    if (query) {
      hits = await ctx.retriever.search(query, { kinds: [kind], tiers: tiersFor(kind, includeArchived), limit, tags, project: ctx.project, purpose: "search" })
    } else {
      // tag-only listing
      hits = ctx.store
        .list(kind)
        .filter((e) => tiersFor(kind, includeArchived).includes(e.tier) && tags.every((t) => e.tags.includes(t)))
        .slice(0, limit)
        .map((e) => ({ kind, name: e.name, title: e.title, tier: e.tier, owned: e.owned, description: e.description, tags: e.tags, score: 0, confidence: 1, matched: [], snippet: "", file: e.file }))
    }
    const label = spec(kind).labelPlural
    if (hits.length === 0) return `No ${label} entries match "${truncate(query || tags.join(", "), 80)}".`
    return `${hits.length} result(s):\n${hits.map((h, i) => hitLine(h, i, extra?.(h) ?? "")).join("\n")}`
  }

  const notFound = (kind: Kind, name: string): string => {
    const hits = ctx.index.search(name.replace(/-/g, " "), { kinds: [kind], tiers: tiersFor(kind, true), limit: 5 })
    return `${spec(kind).label} "${name}" not found.${hits.length ? ` Did you mean: ${hits.map((h) => h.name).join(", ")}?` : ""}`
  }

  const tools: Record<string, ToolDef> = {
    // -------------------------------------------------------------------------
    // read tools
    // -------------------------------------------------------------------------
    skill_search: def(
      "Full-text search over all skills, including dormant and archived skills that are not listed in the system prompt. Use it when no listed skill fits a task, or to find older procedures. Returns names, status and a matching line; load a result with skill_read.",
      searchSpecs("task, tool, error message, keywords"),
      async (args) => {
        const out = await search("skill", args)
        return out.startsWith("No ") ? out : `${out}\n\nLoad one with skill_read(name).`
      },
    ),

    skill_read: def(
      "Load the full instructions of a skill by name – works for every skill, including dormant and archived ones and skills created after this session started. Skills can have reference files (references/…): pass file=<relative path> to read one.",
      {
        name: { kind: "string", description: "Exact skill name (from skill_search or the skill list)" },
        file: { kind: "string", description: "Relative path of a file of the skill (e.g. references/styleguide.md)", optional: true },
      },
      async (args, context) => {
        const name = str(args.name).trim()
        const rec = aiStoreOf(ctx).get("skill", name)
        if (!rec) return notFound("skill", name)
        const file = str(args.file).trim().replace(/^\.?\/+/, "")
        if (file) {
          if (file.split("/").some((p) => p === ".." || p === "") || !/\.(md|markdown|txt|json|ya?ml|csv|tsv|xml|html|css|svg|py|ts|js|sh)$/i.test(file)) return `"${file}" is not a readable text file of skill "${rec.name}".`
          const text = ctx.store.readFileOf(rec, file)
          if (text === undefined) return `Skill "${rec.name}" has no file "${file}". Files: ${ctx.store.supportFiles(rec, 40).map((f) => f.slice(rec.dir.length + 1)).join(", ") || "none"}`
          used(context, "skill", rec.name)
          return `<skill_file skill="${rec.name}" path="${file}">\n${truncate(text, 60_000)}\n</skill_file>`
        }
        used(context, "skill", rec.name)
        const files = ctx.store.supportFiles(rec, 15)
        const owner = rec.owned ? "skillsmith" : `foreign (${rec.source ?? "read-only"})`
        const absorbed = rec.meta?.absorbedInto ? `\nNote: this skill was merged into "${rec.meta.absorbedInto}" – prefer that one.` : ""
        return [
          `<skill_content name="${rec.name}" tier="${rec.tier}" owner="${owner}" version="${rec.version}">`,
          `# Skill: ${rec.name}`,
          `description: ${rec.description}${absorbed}`,
          rec.tags.length ? `tags: ${rec.tags.join(", ")}` : "",
          "",
          rec.body,
          "",
          `Base directory for this skill: ${rec.dir}`,
          "Relative paths in this skill are relative to this base directory.",
          files.length ? `<skill_files>\n${files.map((f) => `<file>${f}</file>`).join("\n")}\n</skill_files>\nRead a file with skill_read(name="${rec.name}", file="<path relative to the base directory>").` : "",
          "</skill_content>",
        ]
          .filter((l) => l !== "")
          .join("\n")
      },
    ),

    skill_list: def(
      "List all skills of a kind, grouped by tier (active, dormant, and with include_archived also archived), including foreign read-only skills. Optional tags filter (all must match). Does not replace /smith-list – use skill_read to load one.",
      listSpecs("skills"),
      async (args) => formatList("skill", listEntries(ctx, "skill", args), { perTier: Number(args.limit) || 100, line: (e, i) => entryLine(e, i, e.source ? ` · ${e.source}` : "") }),
    ),

    knowledge_search: def(
      "Full-text search in the knowledge base (documentation about the user's systems, projects, data, interfaces and conventions, maintained by docsmith). Load a result with knowledge_read.",
      searchSpecs("system, component, topic, identifier, keywords"),
      async (args) => {
        const out = await search("knowledge", args)
        return out.startsWith("No ") ? out : `${out}\n\nRead one with knowledge_read(name).`
      },
    ),

    knowledge_read: def(
      "Read a knowledge base entry by name.",
      { name: { kind: "string", description: "Entry name (from knowledge_search)" } },
      async (args, context) => {
        const name = str(args.name).trim()
        const rec = aiStoreOf(ctx).getOwned("knowledge", name)
        if (!rec) return notFound("knowledge", name)
        used(context, "knowledge", rec.name)
        const m = rec.meta
        const absorbed = m?.absorbedInto ? `\nNote: merged into "${m.absorbedInto}" – prefer that entry.` : ""
        return [
          `<knowledge name="${rec.name}" tier="${rec.tier}" version="${rec.version}"${m?.verifiedAt ? ` verified="${m.verifiedAt.slice(0, 10)}"` : ""}>`,
          `# ${rec.title}`,
          `${rec.description}${absorbed}`,
          rec.tags.length ? `tags: ${rec.tags.join(", ")}` : "",
          m?.projects?.length ? `projects: ${m.projects.join(", ")}` : "",
          m?.doubts?.length
            ? `⚠ possible contradictions – verify before relying on these facts:\n${m.doubts.map((d) => `  - ${d.at.slice(0, 10)}: ${d.note}${d.related ? ` (see ${d.related})` : ""}`).join("\n")}`
            : "",
          linkLine(ctx, `knowledge:${rec.name}`),
          "",
          rec.body,
          "</knowledge>",
        ]
          .filter((l) => l !== "")
          .join("\n")
      },
    ),

    knowledge_list: def(
      "List all knowledge base entries, grouped by tier (active, and with include_archived also archived). Optional tags filter (all must match). Does not replace /knowledge – use knowledge_read to read one.",
      listSpecs("knowledge entries"),
      async (args) =>
        formatList("knowledge", listEntries(ctx, "knowledge", args), {
          perTier: Number(args.limit) || 100,
          line: (e, i) => entryLine(e, i, `${e.folder ? ` · Ordner: ${e.folder}` : ""}${e.meta?.doubts?.length ? " · ⚠ Widerspruch" : ""}`),
        }),
    ),

    glossary_lookup: def(
      "Look up abbreviations and terms in the glossary (full-text: abbreviation, literal meaning and description). Returns every meaning with its short description.",
      {
        query: { kind: "string", description: "Abbreviation or words of its meaning/description" },
        limit: { kind: "number", description: "Max results (default 5)", optional: true },
      },
      async (args, context) => {
        const query = str(args.query).trim()
        if (!query) return "Please provide an abbreviation or search words."
        const limit = Math.min(20, Math.max(1, Number(args.limit) || 5))
        const exact = aiStoreOf(ctx).glossaryByTerm(query)
        const hits = await ctx.retriever.search(query, { kinds: ["glossary"], tiers: ["active", "archive"], limit: limit + exact.length, purpose: "search" })
        const entries: Entry[] = [...exact]
        for (const h of hits) {
          if (entries.length >= limit) break
          const e = aiStoreOf(ctx).getOwned("glossary", h.name)
          if (e && !entries.some((x) => x.name === e.name)) entries.push(e)
        }
        if (!entries.length) {
          const open = ctx.store.candidates("glossary").find((c) => !c.promotedTo && c.keywords.some((k) => fold(k) === fold(query)))
          return `No glossary entry for "${truncate(query, 60)}".${open ? ` It is an open abbreviation (seen in ${open.sessions.length} session(s), meaning unknown) – ask the user if it matters.` : ""}`
        }
        for (const e of exact) used(context, "glossary", e.name)
        return entries.map((e) => formatGlossary(e)).join("\n\n")
      },
    ),

    glossary_list: def(
      "List all glossary entries, one line each (TERM = meaning · also alias), grouped by tier. Optional tags filter (all must match). Does not replace /glossary – use glossary_lookup to look one up.",
      listSpecs("glossary entries"),
      async (args) =>
        formatList("glossary", listEntries(ctx, "glossary", args), {
          perTier: Number(args.limit) || 100,
          line: (e, i) => `${i + 1}. ${formatGlossary(e, false).split("\n").map((s) => s.trim().replace(/^•\s*/, "")).filter(Boolean).join(" · ")}`,
        }),
    ),

    error_lookup: def(
      "Search the documented errors (maintained by errorsmith) by error message, tool or keywords – or read one entry by name. Use it when a command fails with an error that might have happened before.",
      {
        query: { kind: "string", description: "Error message or keywords (leave empty when passing name)", optional: true },
        name: { kind: "string", description: "Exact entry name to read", optional: true },
        include_archived: { kind: "boolean", description: "Also search archived entries (default false)", optional: true },
        tags: { kind: "string[]", description: "Only entries carrying all of these tags", optional: true },
        limit: { kind: "number", description: "Max results (default 5)", optional: true },
      },
      async (args, context) => {
        const name = str(args.name).trim()
        if (name) {
          const rec = aiStoreOf(ctx).getOwned("error", name)
          if (!rec) return notFound("error", name)
          used(context, "error", rec.name)
          return [
            `<error_entry name="${rec.name}" tier="${rec.tier}" status="${fmStr(rec.fields.status)}" version="${rec.version}">`,
            `# ${rec.title}`,
            rec.description,
            strArray(rec.fields.context).length ? `context: ${strArray(rec.fields.context).join(", ")}` : "",
            rec.tags.length ? `tags: ${rec.tags.join(", ")}` : "",
            strArray(rec.fields.signatures).length ? `signatures:\n${strArray(rec.fields.signatures).slice(0, 5).map((s) => `  - ${s}`).join("\n")}` : "",
            "",
            rec.body,
            "</error_entry>",
          ]
            .filter((l) => l !== "")
            .join("\n")
        }
        const query = str(args.query).trim()
        if (!query) return "Please provide a query (error message) or a name."
        const limit = Math.min(20, Math.max(1, Number(args.limit) || 5))
        const hits = await ctx.retriever.search(query, { kinds: ["error"], tiers: tiersFor("error", bool(args.include_archived)), limit, tags: list(args.tags), purpose: "error" })
        if (!hits.length) return `No documented error matches "${truncate(query, 80)}".`
        const best = hits[0]
        let detail = ""
        if (Retriever.display(best) >= 0.55) {
          const rec = aiStoreOf(ctx).getOwned("error", best.name)
          if (rec) {
            used(context, "error", rec.name)
            const fix = section(rec.body, /lösung|loesung|solution|fix|behebung/)
            detail = `\n\nBest match "${rec.name}" (${fmStr(rec.fields.status)}):\n${truncate(fix ?? rec.body, 1500)}`
          }
        }
        return `${hits.length} result(s):\n${hits
          .map((h, i) => hitLine(h, i, ` <${fmStr(aiStoreOf(ctx).getOwned("error", h.name)?.fields.status) || "?"}>`))
          .join("\n")}${detail}\n\nRead one with error_lookup(name=…).`
      },
    ),

    error_list: def(
      "List all documented errors, grouped by tier (active, dormant, and with include_archived also archived), with their status (solved/open). Optional tags filter (all must match). Does not replace /errors – use error_lookup to search or read one.",
      listSpecs("errors"),
      async (args) =>
        formatList("error", listEntries(ctx, "error", args), {
          perTier: Number(args.limit) || 100,
          line: (e, i) => entryLine(e, i, ` <${fmStr(e.fields.status) || "?"}>`),
        }),
    ),

    script_search: def(
      "Search the library of tested Python scripts (maintained by toolsmith). Prefer running an existing script over re-implementing the same steps. Read usage with script_read.",
      searchSpecs("task, input/output format, keywords"),
      async (args) => {
        const out = await search("script", args, (h) => {
          const rec = aiStoreOf(ctx).getOwned("script", h.name)
          const t = rec?.meta?.test?.status
          return rec ? `\n   usage: ${truncate(fmStr(rec.fields.usage), 160)}${t ? ` · tests: ${t}` : ""}` : ""
        })
        return out.startsWith("No ") ? out : `${out}\n\nDetails with script_read(name).`
      },
    ),

    script_list: def(
      "List all tested Python scripts, grouped by tier (active, dormant, and with include_archived also archived), with usage and test status. Optional tags filter (all must match). Does not replace /scripts – use script_read for details.",
      listSpecs("scripts"),
      async (args) =>
        formatList("script", listEntries(ctx, "script", args), {
          perTier: Number(args.limit) || 100,
          line: (e, i) => entryLine(e, i, `\n   usage: ${truncate(fmStr(e.fields.usage), 160)}${e.meta?.test?.status ? ` · tests: ${e.meta.test.status}` : ""}`),
        }),
    ),

    call_script: def(
      "Run a published, tested script of the store: call_script(name, params). params is a JSON object that matches the script's params schema (see script_read); the result comes back as JSON {ok, data, error}. Older scripts without schema take args (command line) instead. Runs with a time limit (and in the sandbox for risky scripts).",
      {
        name: { kind: "string", description: "Script name (script_search / script_list)" },
        params: { kind: "string", description: 'JSON object with the parameters, e.g. {"input": "a.csv"}', optional: true },
        args: { kind: "string[]", description: "Command line arguments (only scripts without params schema)", optional: true },
      },
      async (args, context) => {
        let params: unknown
        if (str(args.params).trim()) {
          try {
            params = JSON.parse(str(args.params))
          } catch {
            return "params must be a JSON object"
          }
        }
        try {
          const r = await callScript(ctx, str(args.name).trim(), { params, args: list(args.args), cwd: (context as ToolCtx).directory ?? ctx.directory, origin: "agent", session: (context as ToolCtx).sessionID })
          return JSON.stringify({ ok: r.ok, ...(r.data !== undefined ? { data: r.data } : {}), ...(r.error ? { error: r.error } : {}), ...(r.stdout !== undefined ? { stdout: r.stdout } : {}), ms: r.ms }, null, 2)
        } catch (err) {
          return `call_script failed: ${errorMessage(err)}`
        }
      },
    ),

    docs_search: def(
      "Search the documentation of THIS project (its .md files: README, docs/, ADRs …) by meaning and keywords. Returns file:line, the section heading and the passage – read the file for more.",
      {
        query: { kind: "string", description: "What you are looking for" },
        limit: { kind: "number", description: "Max results (default 5)", optional: true },
      },
      async (args, context) => {
        const query = str(args.query).trim()
        if (!query) return "Please provide a query."
        if (!ctx.projectDocs?.enabled) return "The project documentation index is disabled (docsmith.projectIndex)."
        const hits = await ctx.projectDocs.search(query, { limit: Math.min(15, Math.max(1, Number(args.limit) || 5)), purpose: "search" })
        if (!hits.length) return `No documentation passage of this project matches "${truncate(query, 80)}".`
        // background runs: passages found here count as PROJECT DOCS evidence
        const run = context?.sessionID ? ctx.runs.forAgentSession(context.sessionID) : undefined
        if (run) run.haystack = `${run.haystack ?? ""}\n${hits.map((h) => truncate(h.text, 700)).join("\n")}`
        return hits
          .map(
            (h, i) =>
              `${i + 1}. ${h.file}:${h.line}${h.heading ? ` – ${h.heading}` : ""}${h.similarity !== undefined ? ` (similarity ${h.similarity.toFixed(2)})` : ""}\n${truncate(h.text, 700)
                .split("\n")
                .map((l) => `   ${l}`)
                .join("\n")}`,
          )
          .join("\n\n")
      },
    ),

    history_search: def(
      "Search summaries of EARLIER sessions (all projects): what was asked, which errors came up and how they were solved, which skills/knowledge/errors/scripts were created or used. Use it when a problem looks familiar.",
      {
        query: { kind: "string", description: "Problem, error message or task" },
        limit: { kind: "number", description: "Max results (default 5)", optional: true },
      },
      async (args, context) => {
        const query = str(args.query).trim()
        if (!query) return "Please provide a query."
        if (!ctx.history?.enabled) return "The session history is disabled (history.enabled)."
        const hits = await ctx.history.search(query, {
          limit: Math.min(10, Math.max(1, Number(args.limit) || 5)),
          exclude: context?.sessionID,
          purpose: "search",
        })
        if (!hits.length) return `No earlier session matches "${truncate(query, 80)}".`
        return `${hits.length} earlier session(s):\n\n${hits
          .map((h, i) => `${i + 1}. ${formatRecord(h.record, { currentProject: ctx.project, detail: true })}`)
          .join("\n\n")}\n\nOpen linked entries with skill_read / knowledge_read / error_lookup / script_read.`
      },
    ),

    script_read: def(
      "Show a script's documentation, usage, path to run it, capabilities and test status.",
      { name: { kind: "string", description: "Script name (from script_search)" } },
      async (args, context) => {
        const name = str(args.name).trim()
        const rec = aiStoreOf(ctx).getOwned("script", name)
        if (!rec) return notFound("script", name)
        used(context, "script", rec.name)
        const f = scriptFiles(rec.name, scriptLanguage(rec))
        const entry = fmStr(rec.fields.entry) || f.code
        const t = rec.meta?.test
        const caps = strArray(rec.fields.capabilities)
        const reqs = strArray(rec.fields.requirements)
        return [
          `<script name="${rec.name}" tier="${rec.tier}" version="${rec.version}">`,
          `# ${rec.name}`,
          rec.description,
          `usage: ${fmStr(rec.fields.usage)}`,
          `run: ${ctx.options.toolsmith.python} ${rec.dir}/${entry} --help`,
          `files: ${rec.dir}/${entry} · tests: ${rec.dir}/${f.test}`,
          `python: ${fmStr(rec.fields.python) || ctx.options.toolsmith.pythonTarget}${reqs.length ? ` · requirements: ${reqs.join(", ")}` : " · standard library only"}`,
          `capabilities: ${caps.length ? caps.join(", ") : "none (pure computation, reads its inputs)"}`,
          t ? `tests: ${t.status}${t.summary ? ` (${truncate(t.summary, 200)})` : ""} · ${t.at.slice(0, 10)}${t.sandbox ? ` · sandbox ${t.sandbox}` : ""}` : "tests: unknown",
          rec.tags.length ? `tags: ${rec.tags.join(", ")}` : "",
          "",
          rec.body,
          "</script>",
        ]
          .filter((l) => l !== "")
          .join("\n")
      },
    ),
  }

  // ---------------------------------------------------------------------------
  // shared write-tool factories
  // ---------------------------------------------------------------------------

  const archiveRestore = (smith: Smith, kind: Kind, what: string) => ({
    [`${smith}_${kind === "skill" || kind === "error" || kind === "script" ? "" : `${kind}_`}archive`]: def(
      `Archive a ${what} that is redundant, obsolete or wrong (it stays searchable and restorable).`,
      {
        name: { kind: "string", description: `${what} name` },
        reason: { kind: "string", description: "Why (one sentence, for the git log)" },
      },
      (args, context) => withRun(context, smith, (run) => ctx.ops.move(run, kind, { name: str(args.name).trim(), to: "archive", kind: "archive", reason: str(args.reason) })),
    ),
    [`${smith}_${kind === "skill" || kind === "error" || kind === "script" ? "" : `${kind}_`}restore`]: def(
      `Move a dormant or archived ${what} back to active.`,
      {
        name: { kind: "string", description: `${what} name` },
        reason: { kind: "string", description: "Why (one sentence, for the git log)" },
      },
      (args, context) => withRun(context, smith, (run) => ctx.ops.move(run, kind, { name: str(args.name).trim(), to: "active", kind: "restore", reason: str(args.reason) })),
    ),
  })

  const noteTool = (smith: Smith, kind: Kind, what: string) =>
    def(
      `Record a candidate pattern seen in this session that may deserve ${what} once it recurs. Reuse candidate_id from OPEN CANDIDATES when it is the same pattern.`,
      {
        summary: { kind: "string", description: "One sentence describing the reusable pattern (no session details)" },
        keywords: { kind: "string[]", description: "3–8 search keywords" },
        candidate_id: { kind: "string", description: "Existing candidate to update", optional: true },
      },
      (args, context) => withRun(context, smith, (run) => ctx.ops.note(run, kind, { summary: str(args.summary), keywords: list(args.keywords), candidateId: opt(args.candidate_id) })),
    )

  const doneTool = (smith: Smith, extra: ArgSpecs = {}, onDone?: (run: Run, args: any) => void) =>
    def(
      "Finish the run with a short summary of what changed and why (or why nothing changed). Call exactly once, at the end.",
      { summary: { kind: "string", description: "Short summary" }, ...extra },
      (args, context) =>
        withRun(context, smith, async (run) => {
          run.summary = truncate(str(args.summary).trim(), 1000)
          onDone?.(run, args)
          return "Recorded. The run is complete – stop now."
        }),
    )

  /** after a knowledge change: list related entries so the agent can check them for contradictions */
  const withRelated = async (msg: string, name: string): Promise<string> => {
    if (!/^(created|updated|patched)\b/.test(msg)) return msg
    try {
      const rel = await ctx.retriever.related("knowledge", name)
      if (!rel.length) return msg
      return `${msg}\nRelated entries – check that they do not contradict this content (update with evidence, or docsmith_knowledge_flag):\n${rel
        .map((r) => `- ${r.entry.name} (${r.score.toFixed(2)}): ${truncate(r.entry.description, 160)}`)
        .join("\n")}`
    } catch {
      return msg
    }
  }

  const tagSpec = { kind: "string[]" as const, description: "2–8 lowercase keywords (technology, system, component, task type)" }

  // ---------------------------------------------------------------------------
  // skillsmith
  // ---------------------------------------------------------------------------

  Object.assign(tools, {
    skillsmith_create: def(
      "Create a NEW skill (only when no existing skill fits). Requires evidence: candidate_id of a pattern seen in enough sessions, or user_quote – the user's explicit request copied verbatim.",
      {
        name: { kind: "string", description: "kebab-case name, 2–5 words, specific" },
        description: { kind: "string", description: "One line: what the skill does + words a future request would contain" },
        tags: tagSpec,
        body: { kind: "string", description: "Markdown body with ## When to use / ## Steps / ## Pitfalls / ## Verification" },
        reason: { kind: "string", description: "Why this skill is needed (one sentence, for the git log)" },
        candidate_id: { kind: "string", description: "Id of the recurring candidate this skill is based on", optional: true },
        user_quote: { kind: "string", description: "Verbatim user request to remember this / make it a skill", optional: true },
      },
      (args, context) =>
        withRun(context, "skillsmith", (run) =>
          ctx.ops.create(run, "skill", {
            name: str(args.name).trim(),
            description: str(args.description),
            tags: list(args.tags),
            body: str(args.body),
            reason: str(args.reason),
            candidateId: opt(args.candidate_id),
            userQuote: opt(args.user_quote),
          }),
        ),
    ),

    skillsmith_patch: def(
      "Targeted edit of a skillsmith skill: replace old_text (must occur exactly once in the body) with new_text. Preferred way to improve a skill.",
      {
        name: { kind: "string", description: "Skill name" },
        old_text: { kind: "string", description: "Exact text currently in the skill body (copy from skill_read)" },
        new_text: { kind: "string", description: "Replacement text" },
        reason: { kind: "string", description: "Why (one sentence, for the git log)" },
      },
      (args, context) =>
        withRun(context, "skillsmith", (run) => ctx.ops.patch(run, "skill", { name: str(args.name).trim(), oldText: str(args.old_text), newText: str(args.new_text), reason: str(args.reason) })),
    ),

    skillsmith_rewrite: def(
      "Replace the whole body (and optionally description/tags) of a skillsmith skill – for restructuring. Pass base_version from skill_read to avoid overwriting concurrent changes.",
      {
        name: { kind: "string", description: "Skill name" },
        body: { kind: "string", description: "Complete new markdown body" },
        description: { kind: "string", description: "New one-line description", optional: true },
        tags: { ...tagSpec, optional: true },
        base_version: { kind: "string", description: "version attribute from skill_read", optional: true },
        reason: { kind: "string", description: "Why (one sentence, for the git log)" },
      },
      (args, context) =>
        withRun(context, "skillsmith", (run) =>
          ctx.ops.update(
            run,
            "skill",
            { name: str(args.name).trim(), body: str(args.body), description: opt(args.description), tags: optList(args.tags), baseVersion: opt(args.base_version), reason: str(args.reason) },
            "rewrite",
          ),
        ),
    ),

    skillsmith_update: def(
      "Change only the metadata of a skillsmith skill: description and/or tags (keywords for search).",
      {
        name: { kind: "string", description: "Skill name" },
        description: { kind: "string", description: "New one-line description", optional: true },
        tags: { ...tagSpec, optional: true },
        reason: { kind: "string", description: "Why (one sentence, for the git log)" },
      },
      (args, context) =>
        withRun(context, "skillsmith", (run) =>
          ctx.ops.update(run, "skill", { name: str(args.name).trim(), description: opt(args.description), tags: optList(args.tags), reason: str(args.reason) }),
        ),
    ),

    skillsmith_merge: def(
      "Merge overlapping skillsmith skills into one umbrella skill. The target receives the combined content (it may be one of the sources or a new name); all other sources are archived with a pointer to the target.",
      {
        sources: { kind: "string[]", description: "Names of the skills to merge" },
        target: { kind: "string", description: "Name of the resulting skill" },
        description: { kind: "string", description: "One-line description of the umbrella skill" },
        tags: { ...tagSpec, optional: true },
        body: { kind: "string", description: "Complete markdown body preserving every valid rule from the sources" },
        reason: { kind: "string", description: "Why (one sentence, for the git log)" },
      },
      (args, context) =>
        withRun(context, "skillsmith", (run) =>
          ctx.ops.merge(run, "skill", { sources: list(args.sources), target: str(args.target).trim(), description: str(args.description), tags: optList(args.tags), body: str(args.body), reason: str(args.reason) }),
        ),
    ),
    ...archiveRestore("skillsmith", "skill", "skillsmith skill"),
    skillsmith_note: noteTool("skillsmith", "skill", "a skill"),
    skillsmith_done: doneTool("skillsmith"),
  })

  // ---------------------------------------------------------------------------
  // docsmith
  // ---------------------------------------------------------------------------

  const evidenceSpec = {
    kind: "string" as const,
    description: "A passage (≥ 12 characters) copied VERBATIM from the transcript (user message, tool output) or a PROJECT DOCS passage that supports the content",
  }

  Object.assign(tools, {
    docsmith_knowledge_create: def(
      "Create a knowledge base entry (durable facts about the user's systems, projects, data, interfaces, conventions). Needs verbatim evidence from the transcript or project docs.",
      {
        name: { kind: "string", description: "kebab-case name, 2–6 words" },
        title: { kind: "string", description: "Title (one line)" },
        description: { kind: "string", description: "One line summary with the words a future question would contain" },
        tags: tagSpec,
        body: { kind: "string", description: "Markdown body: short sections, facts as bullet points" },
        evidence: evidenceSpec,
        reason: { kind: "string", description: "Why (one sentence, for the git log)" },
      },
      (args, context) =>
        withRun(context, "docsmith", async (run) =>
          withRelated(
            await ctx.ops.create(run, "knowledge", {
              name: str(args.name).trim(),
              title: str(args.title),
              description: str(args.description),
              tags: list(args.tags),
              body: str(args.body),
              evidence: str(args.evidence),
              reason: str(args.reason),
            }),
            str(args.name).trim(),
          ),
        ),
    ),

    docsmith_knowledge_update: def(
      "Update a knowledge entry (title/description/tags/body). Content changes need verbatim evidence; tag-only changes do not. Pass base_version from knowledge_read.",
      {
        name: { kind: "string", description: "Entry name" },
        title: { kind: "string", description: "New title", optional: true },
        description: { kind: "string", description: "New one-line description", optional: true },
        tags: { ...tagSpec, optional: true },
        body: { kind: "string", description: "Complete new body", optional: true },
        base_version: { kind: "string", description: "version attribute from knowledge_read", optional: true },
        evidence: { ...evidenceSpec, optional: true },
        reason: { kind: "string", description: "Why (one sentence, for the git log)" },
      },
      (args, context) =>
        withRun(context, "docsmith", async (run) =>
          withRelated(
            await ctx.ops.update(run, "knowledge", {
              name: str(args.name).trim(),
              title: opt(args.title),
              description: opt(args.description),
              tags: optList(args.tags),
              body: opt(args.body),
              baseVersion: opt(args.base_version),
              evidence: opt(args.evidence),
              reason: str(args.reason),
            }),
            str(args.name).trim(),
          ),
        ),
    ),

    docsmith_knowledge_patch: def(
      "Targeted edit of a knowledge entry: replace old_text (exactly once in the body) with new_text. Needs verbatim evidence.",
      {
        name: { kind: "string", description: "Entry name" },
        old_text: { kind: "string", description: "Exact text currently in the body (copy from knowledge_read)" },
        new_text: { kind: "string", description: "Replacement text" },
        evidence: evidenceSpec,
        reason: { kind: "string", description: "Why (one sentence, for the git log)" },
      },
      (args, context) =>
        withRun(context, "docsmith", async (run) =>
          withRelated(
            await ctx.ops.patch(run, "knowledge", { name: str(args.name).trim(), oldText: str(args.old_text), newText: str(args.new_text), evidence: str(args.evidence), reason: str(args.reason) }),
            str(args.name).trim(),
          ),
        ),
    ),

    docsmith_knowledge_merge: def(
      "Merge knowledge entries that describe the same thing into one. Other sources are archived with a pointer to the target.",
      {
        sources: { kind: "string[]", description: "Names of the entries to merge" },
        target: { kind: "string", description: "Name of the resulting entry" },
        title: { kind: "string", description: "Title of the merged entry" },
        description: { kind: "string", description: "One-line description" },
        tags: { ...tagSpec, optional: true },
        body: { kind: "string", description: "Complete body preserving every fact from the sources" },
        reason: { kind: "string", description: "Why (one sentence, for the git log)" },
      },
      (args, context) =>
        withRun(context, "docsmith", (run) =>
          ctx.ops.merge(run, "knowledge", {
            sources: list(args.sources),
            target: str(args.target).trim(),
            title: str(args.title),
            description: str(args.description),
            tags: optList(args.tags),
            body: str(args.body),
            reason: str(args.reason),
          }),
        ),
    ),
    ...archiveRestore("docsmith", "knowledge", "knowledge entry"),

    docsmith_knowledge_flag: def(
      "Note a possible contradiction or doubt on a knowledge entry when you cannot tell which version is right. Readers see the note until an evidenced update resolves it.",
      {
        name: { kind: "string", description: "Entry name" },
        note: { kind: "string", description: "One sentence: what may be wrong and why" },
        related: { kind: "string", description: "Name of the entry or source that contradicts it", optional: true },
      },
      (args, context) =>
        withRun(context, "docsmith", (run) => ctx.ops.flagKnowledge(run, { name: str(args.name).trim(), note: str(args.note), related: opt(args.related) })),
    ),

    docsmith_glossary_upsert: def(
      "Add an abbreviation to the glossary or add/refresh one of its meanings. The expansion must be stated literally in the transcript or project docs – never guess. One call per meaning.",
      {
        term: { kind: "string", description: "The abbreviation exactly as written, e.g. KWG, DB2, M&A" },
        expansion: { kind: "string", description: "Literal meaning (what the letters stand for), exactly as stated" },
        description: { kind: "string", description: "Short description (1–2 sentences): what it is / what it is used for" },
        context: { kind: "string", description: "Context that distinguishes this meaning (system, team, domain)", optional: true },
        aliases: { kind: "string[]", description: "Other spellings of the abbreviation", optional: true },
        tags: { ...tagSpec, optional: true },
        reason: { kind: "string", description: "Why (one sentence, for the git log)" },
      },
      (args, context) =>
        withRun(context, "docsmith", (run) =>
          ctx.ops.glossaryUpsert(run, {
            term: str(args.term).trim(),
            meanings: [{ expansion: str(args.expansion).trim(), description: str(args.description).trim(), ...(opt(args.context) ? { context: opt(args.context) } : {}) }],
            aliases: list(args.aliases),
            tags: list(args.tags),
            reason: str(args.reason),
          }),
        ),
    ),

    docsmith_glossary_archive: def(
      "Archive a glossary entry that is wrong or no longer used.",
      {
        term: { kind: "string", description: "Abbreviation" },
        reason: { kind: "string", description: "Why (one sentence, for the git log)" },
      },
      (args, context) =>
        withRun(context, "docsmith", async (run) => {
          const e = aiStoreOf(ctx).glossaryByTerm(str(args.term).trim())[0]
          if (!e) throw new GuardError(`no glossary entry for "${str(args.term)}"`)
          return ctx.ops.move(run, "glossary", { name: e.name, to: "archive", kind: "archive", reason: str(args.reason) })
        }),
    ),
    docsmith_note: noteTool("docsmith", "knowledge", "a knowledge entry"),
    docsmith_done: doneTool(
      "docsmith",
      { outdated_docs: { kind: "string[]", description: 'Project docs that look outdated after the session\'s changes, as "file:line – why"', optional: true } },
      (run, args) => {
        const docs = list(args.outdated_docs).map((d) => truncate(d, 200)).slice(0, 10)
        if (docs.length) run.outdatedDocs = docs
      },
    ),
  })

  // ---------------------------------------------------------------------------
  // errorsmith
  // ---------------------------------------------------------------------------

  const chainFields = (run: Run, ids: string[]): { signatures: string[]; context: string[] } => {
    const chains = run.chains ?? []
    const out = { signatures: [] as string[], context: [] as string[] }
    for (const id of ids) {
      const c = chains.find((x) => x.id === id)
      if (!c) throw new GuardError(`chain "${id}" not found in this transcript (known: ${chains.map((x) => x.id).join(", ") || "none"})`)
      out.signatures.push(c.signature)
      if (c.head) out.context.push(c.head)
    }
    return out
  }

  Object.assign(tools, {
    errorsmith_create: def(
      "Document a NEW error with its solution (status solved) or – when seen in enough sessions but unsolved – as open. Needs chain_id from ERROR CHAINS; the error signature is attached automatically.",
      {
        name: { kind: "string", description: "kebab-case name describing the error" },
        title: { kind: "string", description: "The error in one line (core message)" },
        description: { kind: "string", description: "One line: error + cause + fix keywords" },
        status: { kind: "string", description: '"solved" or "open"' },
        body: { kind: "string", description: "## Symptom / ## Ursache / ## Lösung / ## Prüfung (open: ## Symptom / ## Bisherige Versuche / ## Vermutung)" },
        tags: tagSpec,
        context: { kind: "string[]", description: "Tools/commands/components where it occurs", optional: true },
        chain_id: { kind: "string", description: "Id from ERROR CHAINS (E1, P1, …)" },
        user_quote: { kind: "string", description: "Verbatim user message confirming the fix (when the chain was not resolved by a tool call)", optional: true },
        reason: { kind: "string", description: "Why (one sentence, for the git log)" },
      },
      (args, context) =>
        withRun(context, "errorsmith", (run) =>
          ctx.ops.create(run, "error", {
            name: str(args.name).trim(),
            title: str(args.title),
            description: str(args.description),
            tags: list(args.tags),
            body: str(args.body),
            fields: { status: str(args.status).trim().toLowerCase() === "open" ? "open" : "solved", context: list(args.context) },
            chainId: opt(args.chain_id),
            userQuote: opt(args.user_quote),
            reason: str(args.reason),
          }),
        ),
    ),

    errorsmith_update: def(
      "Update an error entry: improve title/description/body/status/tags/context and attach the signatures of further chains (chain_ids) so live hints match them.",
      {
        name: { kind: "string", description: "Entry name" },
        title: { kind: "string", description: "New title", optional: true },
        description: { kind: "string", description: "New one-line description", optional: true },
        status: { kind: "string", description: '"solved" or "open"', optional: true },
        body: { kind: "string", description: "Complete new body", optional: true },
        tags: { ...tagSpec, optional: true },
        context: { kind: "string[]", description: "Additional tools/components", optional: true },
        chain_ids: { kind: "string[]", description: "Chains from ERROR CHAINS that are this same error", optional: true },
        base_version: { kind: "string", description: "version attribute from error_lookup", optional: true },
        reason: { kind: "string", description: "Why (one sentence, for the git log)" },
      },
      (args, context) =>
        withRun(context, "errorsmith", async (run) => {
          const name = str(args.name).trim()
          const rec = aiStoreOf(ctx).getOwned("error", name)
          if (!rec) throw new GuardError(`error entry "${name}" not found`)
          const add = chainFields(run, list(args.chain_ids))
          const fields: Record<string, unknown> = {}
          const status = opt(args.status)?.toLowerCase()
          if (status) fields.status = status === "open" ? "open" : "solved"
          const sigs = [...new Set([...add.signatures, ...strArray(rec.fields.signatures)])].slice(0, 12)
          const ctxs = [...new Set([...strArray(rec.fields.context), ...list(args.context), ...add.context])].slice(0, 8)
          if (JSON.stringify(sigs) !== JSON.stringify(strArray(rec.fields.signatures))) fields.signatures = sigs
          if (JSON.stringify(ctxs) !== JSON.stringify(strArray(rec.fields.context))) fields.context = ctxs
          return ctx.ops.update(run, "error", {
            name,
            title: opt(args.title),
            description: opt(args.description),
            body: opt(args.body),
            tags: optList(args.tags),
            fields,
            baseVersion: opt(args.base_version),
            reason: str(args.reason),
          })
        }),
    ),

    errorsmith_patch: def(
      "Targeted edit of an error entry: replace old_text (exactly once in the body) with new_text.",
      {
        name: { kind: "string", description: "Entry name" },
        old_text: { kind: "string", description: "Exact text currently in the body (copy from error_lookup)" },
        new_text: { kind: "string", description: "Replacement text" },
        reason: { kind: "string", description: "Why (one sentence, for the git log)" },
      },
      (args, context) =>
        withRun(context, "errorsmith", (run) => ctx.ops.patch(run, "error", { name: str(args.name).trim(), oldText: str(args.old_text), newText: str(args.new_text), reason: str(args.reason) })),
    ),

    errorsmith_merge: def(
      "Merge error entries that describe the same error and cause. Signatures and context are combined automatically; other sources are archived.",
      {
        sources: { kind: "string[]", description: "Names of the entries to merge" },
        target: { kind: "string", description: "Name of the resulting entry" },
        title: { kind: "string", description: "Title (the error in one line)" },
        description: { kind: "string", description: "One-line description" },
        tags: { ...tagSpec, optional: true },
        body: { kind: "string", description: "Complete body (## Symptom / ## Ursache / ## Lösung / ## Prüfung)" },
        reason: { kind: "string", description: "Why (one sentence, for the git log)" },
      },
      (args, context) =>
        withRun(context, "errorsmith", (run) =>
          ctx.ops.merge(run, "error", {
            sources: list(args.sources),
            target: str(args.target).trim(),
            title: str(args.title),
            description: str(args.description),
            tags: optList(args.tags),
            body: str(args.body),
            reason: str(args.reason),
          }),
        ),
    ),
    ...archiveRestore("errorsmith", "error", "error entry"),
    errorsmith_note: noteTool("errorsmith", "error", "an error entry"),
    errorsmith_done: doneTool("errorsmith"),
  })

  // ---------------------------------------------------------------------------
  // toolsmith
  // ---------------------------------------------------------------------------

  const capSpec = { kind: "string[]" as const, description: "Everything the script does: network, subprocess, delete, filesystem-write, env (empty for pure computation)", optional: true }

  Object.assign(tools, {
    toolsmith_draft: def(
      "Write a script draft (new script, or a new version of an existing script when the name exists) and run the full check: Python syntax for the target version, imports, capabilities, unit tests, --help. Returns the check report.",
      {
        name: { kind: "string", description: "kebab-case, verb-first (e.g. convert-csv-to-json); module = name with _" },
        description: { kind: "string", description: "One line: what the script does" },
        usage: { kind: "string", description: "One-line usage, e.g. python3 convert_csv_to_json.py INPUT.csv [--delimiter ;]" },
        code: { kind: "string", description: "Complete <module>.py (argparse, main(argv=None), __main__ guard)" },
        tests: { kind: "string", description: "Complete test_<module>.py (unittest.TestCase, imports the module)" },
        docs: { kind: "string", description: "SCRIPT.md body: ## Zweck / ## Aufruf / ## Ein- und Ausgabe / ## Grenzen" },
        capabilities: capSpec,
        requirements: { kind: "string[]", description: "pip packages (only if unavoidable and allowed)", optional: true },
        tags: tagSpec,
        language: { kind: "string", description: 'python (default) or typescript (node ≥ 22.18 / bun: <module>.ts + <module>.test.ts with node:test; no enum/namespace/parameter properties, relative imports with .ts)', optional: true },
        params_schema: { kind: "string", description: "JSON schema of the parameters for call_script (params as JSON on stdin; helper: from smith_script import run / import { run } from \"./smith-script.ts\")", optional: true },
        result_schema: { kind: "string", description: "JSON schema of the result (data of the {ok, data} envelope)", optional: true },
      },
      (args, context) =>
        withRun(context, "toolsmith", (run) =>
          ctx.workshop.draft(run, {
            language: str(args.language) === "typescript" ? "typescript" : str(args.language) === "python" ? "python" : undefined,
            params: jsonObj(args.params_schema, "params_schema"),
            result: jsonObj(args.result_schema, "result_schema"),
            name: str(args.name),
            description: str(args.description),
            usage: str(args.usage),
            code: str(args.code),
            tests: str(args.tests),
            docs: str(args.docs),
            capabilities: list(args.capabilities),
            requirements: list(args.requirements),
            tags: list(args.tags),
          }),
        ),
    ),

    toolsmith_revise: def(
      "Revise the current draft (only the parts you pass are replaced) and re-run the full check.",
      {
        name: { kind: "string", description: "Draft name" },
        code: { kind: "string", description: "Complete new code", optional: true },
        tests: { kind: "string", description: "Complete new tests", optional: true },
        docs: { kind: "string", description: "New docs", optional: true },
        description: { kind: "string", description: "New description", optional: true },
        usage: { kind: "string", description: "New usage line", optional: true },
        capabilities: capSpec,
        requirements: { kind: "string[]", description: "pip packages", optional: true },
        tags: { ...tagSpec, optional: true },
      },
      (args, context) =>
        withRun(context, "toolsmith", (run) =>
          ctx.workshop.revise(run, str(args.name), {
            code: opt(args.code),
            tests: opt(args.tests),
            docs: opt(args.docs),
            description: opt(args.description),
            usage: opt(args.usage),
            capabilities: optList(args.capabilities),
            requirements: optList(args.requirements),
            tags: optList(args.tags),
          }),
        ),
    ),

    toolsmith_publish: def(
      "Publish the checked draft into the script library (only after CHECK PASSED). New scripts need candidate_id (recurring pattern) or user_quote (explicit user request).",
      {
        name: { kind: "string", description: "Draft name" },
        reason: { kind: "string", description: "Why (one sentence, for the git log)" },
        candidate_id: { kind: "string", description: "Recurring candidate (new scripts)", optional: true },
        user_quote: { kind: "string", description: "Verbatim user request for a script/automation (new scripts)", optional: true },
      },
      (args, context) =>
        withRun(context, "toolsmith", (run) => ctx.workshop.publish(run, { name: str(args.name), reason: str(args.reason), candidateId: opt(args.candidate_id), userQuote: opt(args.user_quote) })),
    ),

    toolsmith_update: def(
      "Change only the metadata of a published script: description, usage line and/or tags.",
      {
        name: { kind: "string", description: "Script name" },
        description: { kind: "string", description: "New one-line description", optional: true },
        usage: { kind: "string", description: "New usage line", optional: true },
        tags: { ...tagSpec, optional: true },
        reason: { kind: "string", description: "Why (one sentence, for the git log)" },
      },
      (args, context) =>
        withRun(context, "toolsmith", (run) =>
          ctx.ops.update(run, "script", {
            name: str(args.name).trim(),
            description: opt(args.description),
            tags: optList(args.tags),
            fields: opt(args.usage) ? { usage: opt(args.usage) } : undefined,
            reason: str(args.reason),
          }),
        ),
    ),
    ...archiveRestore("toolsmith", "script", "script"),
    toolsmith_note: noteTool("toolsmith", "script", "a script"),
    toolsmith_done: doneTool("toolsmith"),
  })

  Object.assign(tools, memoryTools(ctx, def, withRun, used, evidenceSpec, tagSpec))
  // tool name and target for the audit log of rejected actions
  for (const [name, t] of Object.entries(tools)) {
    const execute = t.execute
    t.execute = (args: any, context: any) => {
      if (context && typeof context === "object") {
        context.__tool = name
        const target = [args?.name, args?.term, args?.id, args?.from, args?.topic, args?.title].find((x) => typeof x === "string" && x.trim())
        context.__target = target ? truncate(String(target).trim(), 120) : undefined
      }
      if (!/_(search|lookup|list)$/.test(name) || !ctx.metrics) return execute(args, context)
      // search metrics: duration and number of hits (never the query)
      const started = Date.now()
      return execute(args, context).then((out) => {
        const hits = (String(out).match(/^\s*(\d+\.|- |\[)/gm) ?? []).length
        ctx.metrics?.record({ type: "search.query", entry: `tool:${name}`, ...sessionInfo(ctx, context?.sessionID), project: ctx.project, value: Date.now() - started, extra: { hits, semantic: ctx.semantic?.client.status.state === "ready" } })
        return out
      })
    }
  }
  return tools
}

type Def = (description: string, specs: ArgSpecs, execute: ToolDef["execute"]) => ToolDef
type WithRun = (context: ToolCtx, smith: Smith, fn: (run: Run) => Promise<string>) => Promise<string>
type Used = (context: ToolCtx | undefined, kind: Kind, name: string) => void

/** Overlap score of a query with a text (volatile memories have no index; there are few of them). */
function overlap(query: string, text: string): number {
  const q = [...new Set(tokenize(query))]
  if (!q.length) return 0
  const t = new Set(tokenize(text))
  return q.filter((x) => t.has(x)).length / q.length
}

function memoryTools(ctx: Ctx, def: Def, withRun: WithRun, used: Used, evidenceSpec: ArgSpecs[string], tagSpec: ArgSpecs[string]): Record<string, ToolDef> {
  const scopeOf = (run?: Run) => run?.scope ?? ctx.scope()
  const graph = () => ctx.graph

  /** "memory:x", "x" (memory name or topic), "state:…", "result:…", "knowledge:y" … → node id */
  const resolveId = (raw: string): string | undefined => {
    const id = normalizeNodeId(raw)
    if (!id || graph().hidden(id)) return undefined
    if (graph().node(id)) return id
    if (!id.includes(":")) {
      if (aiStoreOf(ctx).get("memory", id)) return `memory:${id}`
      const scope = ctx.scope()
      const byTopic = aiStoreOf(ctx).list("memory").find((e) => fmStr(e.fields.topic) === id && (!fmStr(e.fields.project) || fmStr(e.fields.project) === scope.project))
      if (byTopic) return `memory:${byTopic.name}`
    }
    return undefined
  }

  const strength = (v: unknown): number | undefined => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }

  const read: Record<string, ToolDef> = {
    memory_search: def(
      "Search the memories of this project (maintained by memorysmith): decisions, conventions, experiences, the work state of each branch and condensed results of earlier subagents/research. Read one with memory_read(id).",
      {
        query: { kind: "string", description: "What you are looking for (topic, component, question)" },
        type: { kind: "string", description: "Only one type: entscheidung, vorgabe, erfahrung, arbeitsstand, ergebnis", optional: true },
        all_projects: { kind: "boolean", description: "Also memories of other projects (default false)", optional: true },
        include_archived: { kind: "boolean", description: "Also archived/superseded memories (default false)", optional: true },
        limit: { kind: "number", description: "Max results (default 8)", optional: true },
      },
      async (args) => {
        const query = str(args.query).trim()
        if (!query) return "Please provide a query."
        const type = str(args.type).trim().toLowerCase()
        const all = bool(args.all_projects) || ctx.options.memorysmith.crossProject
        const limit = Math.min(20, Math.max(1, Number(args.limit) || 8))
        const scope = ctx.scope()
        const lines: string[] = []
        if (!type || ["entscheidung", "vorgabe", "erfahrung"].includes(type)) {
          const hits = await ctx.retriever.search(query, { kinds: ["memory"], tiers: bool(args.include_archived) ? ["active", "archive"] : ["active"], limit: limit * 3, purpose: "search" })
          for (const h of hits) {
            const e = aiStoreOf(ctx).getOwned("memory", h.name)
            if (!e) continue
            const p = fmStr(e.fields.project)
            if (!all && p && p !== scope.project) continue
            if (type && fmStr(e.fields.type) !== type) continue
            lines.push(`${memoryLine(e)}${p && p !== scope.project ? ` (Projekt ${fmStr(e.fields.project_name) || p})` : ""} (score ${Retriever.display(h).toFixed(2)})`)
            if (lines.length >= limit) break
          }
        }
        if (ctx.mem?.available && (!type || type === "arbeitsstand" || type === "ergebnis")) {
          const project = all ? undefined : scope.project
          if (!type || type === "arbeitsstand") {
            for (const s of ctx.mem.states(project)) {
              const text = formatState(s)
              if (type !== "arbeitsstand" && overlap(query, text) < 0.5) continue
              lines.push(`${s.id} [Arbeitsstand${s.status !== "gueltig" ? `, ${s.status}` : ""}] Branch ${s.branch}${s.ticket ? ` (${s.ticket})` : ""} – ${truncate(s.summary || s.goal, 160)}`)
            }
          }
          if (!type || type === "ergebnis") {
            const results = ctx.mem
              .results(project)
              .map((r) => ({ r, score: overlap(query, `${r.title}\n${r.question}\n${r.answer}\n${r.tags.join(" ")}`) }))
              .filter((x) => type === "ergebnis" || x.score >= 0.5)
              .sort((a, b) => b.score - a.score)
              .slice(0, 5)
            for (const { r } of results) lines.push(formatResult(r))
          }
        }
        if (!lines.length) return `No memory matches "${truncate(query, 80)}".`
        return `${lines.length} result(s):\n${lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}\n\nRead one with memory_read(id).`
      },
    ),

    memory_list: def(
      "List durable memories of this project and global ones (decisions, conventions, experiences), grouped by tier. Foreign projects only with all_projects. Volatile work states and results are not listed here. Optional tags filter (all must match). Does not replace /memory – use memory_read for details.",
      {
        ...listSpecs("memories"),
        all_projects: { kind: "boolean", description: "Also list memories of other projects (default false)", optional: true },
      },
      async (args) => {
        const all = bool(args.all_projects) || ctx.options.memorysmith.crossProject
        const scope = ctx.scope()
        const entries = listEntries(ctx, "memory", args, (e) => {
          const p = fmStr(e.fields.project)
          return !p || p === scope.project || all
        })
        return formatList("memory", entries, {
          perTier: Number(args.limit) || 100,
          line: (e, i) => `${i + 1}. ${memoryLine(e)} (topic ${fmStr(e.fields.topic)})`,
        })
      },
    ),

    memory_read: def(
      "Read a memory completely, with its connections: a decision, convention or experience (memory:<name>), a work state (state:…), a result (result:…) – or any other entry id (knowledge:…, skill:…, error:…, script:…) to see how it is connected.",
      { id: { kind: "string", description: "Id from memory_search, a hint or graph_neighbors (memory:<name>, state:…, result:…)" } },
      async (args, context) => {
        const raw = str(args.id).trim()
        const id = resolveId(raw)
        if (!id) return `Memory "${truncate(raw, 80)}" not found. Search with memory_search.`
        const g = graph()
        const s = isStoreId(id)
        if (s?.kind === "memory") {
          const e = aiStoreOf(ctx).getOwned("memory", s.name)!
          used(context, "memory", e.name)
          return formatMemoryEntry(e, g)
        }
        const rel = relationLines(g, id, 15)
        const relText = rel.length ? `\n\nVerknüpfungen:\n${rel.map((l) => `  ${l}`).join("\n")}` : ""
        if (id.startsWith("state:")) {
          const st = ctx.mem?.getState(id)
          if (!st) return `Work state ${id} not found.`
          return `<work_state id="${id}">\n${formatState(st, { history: true })}${relText}\n</work_state>`
        }
        if (id.startsWith("result:")) {
          const r = ctx.mem?.getResult(id)
          if (!r) return `Result ${id} not found.`
          if (context?.sessionID && !ctx.runs.isAgentSession(context.sessionID)) ctx.mem?.markResultUsed(id)
          return `<result id="${id}">\n${formatResult(r, true)}${relText}\n</result>`
        }
        const n = g.node(id)!
        return `<entry id="${id}" kind="${nodeLabel(n.kind, n.type)}">\n# ${n.title}\n${n.summary}\n\n${truncate(n.text, 3000)}${relText}\n</entry>`
      },
    ),

    graph_neighbors: def(
      "Show how an entry is connected to other entries (skills, knowledge, errors, scripts, memories): relation type, direction, strength and description. Useful to find related decisions, background knowledge or the script that solves an error.",
      {
        id: { kind: "string", description: "Entry id, e.g. knowledge:<name>, memory:<name>, error:<name>, state:…" },
        depth: { kind: "number", description: "Steps (1–2, default 1)", optional: true },
        min_strength: { kind: "number", description: "Only relations at least this strong (0–1, default 0.3)", optional: true },
      },
      async (args) => {
        const raw = str(args.id).trim()
        const id = resolveId(raw)
        if (!id) return `Entry "${truncate(raw, 80)}" not found.`
        const g = graph()
        const depth = Math.min(2, Math.max(1, Number(args.depth) || 1))
        const min = args.min_strength === undefined || args.min_strength === "" ? 0.3 : Math.max(0, Math.min(1, Number(args.min_strength) || 0))
        const nb = g.neighbourhood(id, depth, min)
        nb.edges = nb.edges.filter((e) => !g.hidden(e.from) && !g.hidden(e.to))
        if (!nb.edges.length) return `${id} has no connections${min > 0 ? ` with strength ≥ ${min}` : ""}.`
        const center = g.node(id)!
        const lines = nb.edges
          .sort((a, b) => b.strength - a.strength)
          .slice(0, 30)
          .map((e) => (e.from === id || e.to === id ? relationLine(g, id, e) : `   ${e.from} –${RELATION_LABEL[e.type]}→ ${e.to} (${e.strength.toFixed(1)}) – ${truncate(e.description, 120)}`))
        return `${nodeLabel(center.kind, center.type)} „${truncate(center.title, 80)}“ (${id}):\n${lines.join("\n")}\n\nOpen an entry with memory_read(id) or the read tool of its kind.`
      },
    ),
  }

  // ---------------------------------------------------------------------------
  // memorysmith
  // ---------------------------------------------------------------------------
  const suggestedPerRun = new Map<string, number>()
  const oneLineOf = (t: string) => truncate(t.replace(/\s+/g, " ").trim(), 200)
  const memorysmith: Record<string, ToolDef> = {
    memorysmith_save: def(
      "Save a durable memory of this project: a decision (entscheidung), a convention set by the user (vorgabe) or a specific experience (erfahrung). Same type + topic in this project updates the existing memory.",
      {
        type: { kind: "string", description: "entscheidung | vorgabe | erfahrung" },
        topic: { kind: "string", description: "Short subject that names the memory (e.g. token-speicherung, lombok, t2-auth-header)" },
        title: { kind: "string", description: "One line: the decision/rule/finding itself" },
        summary: { kind: "string", description: "One line with the words a future question would contain" },
        body: { kind: "string", description: "Markdown. Decisions: ## Entscheidung, ## Begründung, ## Alternativen. Conventions: the rule in the user's words. Experiences: what happened, what holds, how to use it." },
        tags: tagSpec,
        scope: { kind: "string", description: "projekt (default) or global – global only when the user says it applies everywhere", optional: true },
        evidence: evidenceSpec,
        supersedes: { kind: "string", description: "Name of an older memory this one replaces (it is archived as superseded)", optional: true },
        reason: { kind: "string", description: "Why this is worth remembering (one sentence, for the git log)" },
      },
      (args, context) =>
        withRun(context, "memorysmith", (run) =>
          ctx.ops.memorySave(run, {
            type: str(args.type),
            topic: str(args.topic),
            title: str(args.title),
            summary: str(args.summary),
            body: str(args.body),
            tags: list(args.tags),
            scope: str(args.scope).trim() === "global" ? "global" : "projekt",
            evidence: opt(args.evidence),
            supersedes: opt(args.supersedes),
            reason: str(args.reason),
            where: scopeOf(run),
          }),
        ),
    ),

    memorysmith_state: def(
      "Save the work state of the current branch (replaces the previous one; keep items that are still open). Call it whenever work happened in the reviewed part.",
      {
        goal: { kind: "string", description: "What the work on this branch is about (one line)" },
        done: { kind: "string[]", description: "Finished steps (short)", optional: true },
        open: { kind: "string[]", description: "Still open items and open questions", optional: true },
        next: { kind: "string[]", description: "Next steps", optional: true },
        files: { kind: "string[]", description: "Changed or important files", optional: true },
        summary: { kind: "string", description: "One line: where the work stands", optional: true },
        evidence: { kind: "string", description: "A verbatim passage of the transcript that shows the state (optional)", optional: true },
        reason: { kind: "string", description: "Why the state changed (one sentence)", optional: true },
      },
      (args, context) =>
        withRun(context, "memorysmith", (run) =>
          ctx.ops.memoryState(run, {
            goal: str(args.goal),
            done: list(args.done),
            open: list(args.open),
            next: list(args.next),
            files: list(args.files),
            summary: opt(args.summary),
            evidence: opt(args.evidence),
            reason: opt(args.reason),
            where: scopeOf(run),
          }),
        ),
    ),

    memorysmith_result: def(
      "Keep the condensed result of a subagent or research for the next days (expires unless it is used or linked).",
      {
        title: { kind: "string", description: "What the result is about (one line)" },
        question: { kind: "string", description: "The question/task that was answered", optional: true },
        answer: { kind: "string", description: "The condensed answer (facts, findings; no chatter)" },
        files: { kind: "string[]", description: "Relevant files", optional: true },
        sources: { kind: "string[]", description: "Sources (files, URLs, docs)", optional: true },
        tags: { ...tagSpec, optional: true },
        evidence: evidenceSpec,
        reason: { kind: "string", description: "Why it is worth keeping (one sentence)", optional: true },
      },
      (args, context) =>
        withRun(context, "memorysmith", (run) =>
          ctx.ops.memoryResult(run, {
            title: str(args.title),
            question: opt(args.question),
            answer: str(args.answer),
            files: list(args.files),
            sources: list(args.sources),
            tags: list(args.tags),
            evidence: opt(args.evidence),
            reason: opt(args.reason),
            where: scopeOf(run),
          }),
        ),
    ),

    memorysmith_relate: def(
      "Record how two entries are connected (memories, knowledge, skills, errors, scripts, work states, results). One relation per pair – a new one replaces the old.",
      {
        from: { kind: "string", description: "Id of the source, e.g. memory:<name>" },
        to: { kind: "string", description: "Id of the target, e.g. knowledge:<name>, state:…" },
        type: { kind: "string", description: "related | supplements | depends_on | part_of | solves | caused_by | derived_from | uses | example_of | supersedes" },
        strength: { kind: "number", description: "1–5: how useful it is to see the target when the source is found" },
        description: { kind: "string", description: "One sentence that explains the connection" },
        reason: { kind: "string", description: "Why (optional)", optional: true },
      },
      (args, context) =>
        withRun(context, "memorysmith", async (run) => {
          const type = str(args.type).trim().toLowerCase()
          if (type === "contradicts" || type === "not_related" || type === "duplicates") {
            throw new GuardError(`${type} is decided by the doctor; record supplementing relations only`)
          }
          return ctx.ops.relate(run, { from: str(args.from), to: str(args.to), type, strength: strength(args.strength), description: str(args.description), reason: opt(args.reason) })
        }),
    ),

    memorysmith_supersede: def(
      "Mark an older memory as replaced by a newer one (it is archived with status abgeloest; the link is kept).",
      {
        old: { kind: "string", description: "Name of the outdated memory" },
        by: { kind: "string", description: "Name of the memory that replaces it" },
        reason: { kind: "string", description: "Why (one sentence)" },
      },
      (args, context) => withRun(context, "memorysmith", (run) => ctx.ops.memorySupersede(run, { old: str(args.old).trim(), by: str(args.by).trim(), reason: str(args.reason) })),
    ),

    memorysmith_merge: def(
      "Merge memories of the same project that say the same into one (the target keeps its type and topic; the others are archived).",
      {
        sources: { kind: "string[]", description: "Names of the memories to merge (including the target)" },
        target: { kind: "string", description: "Name of the memory that remains" },
        title: { kind: "string", description: "Title of the merged memory", optional: true },
        summary: { kind: "string", description: "One-line summary" },
        body: { kind: "string", description: "Merged body: every still valid fact of all sources" },
        tags: { ...tagSpec, optional: true },
        reason: { kind: "string", description: "Why (one sentence)" },
      },
      (args, context) =>
        withRun(context, "memorysmith", async (run) => {
          const sources = list(args.sources)
          const target = str(args.target).trim()
          const projects = new Set([...sources, target].map((n) => fmStr(aiStoreOf(ctx).getOwned("memory", n)?.fields.project)))
          if (projects.size > 1) throw new GuardError("memories of different projects are not merged")
          return ctx.ops.merge(run, "memory", { sources, target, title: opt(args.title), description: str(args.summary), tags: optList(args.tags), body: str(args.body), reason: str(args.reason) })
        }),
    ),

    memorysmith_archive: def(
      "Archive a memory that is obsolete or wrong (stays searchable and restorable).",
      {
        name: { kind: "string", description: "Memory name" },
        reason: { kind: "string", description: "Why (one sentence)" },
      },
      (args, context) => withRun(context, "memorysmith", (run) => ctx.ops.move(run, "memory", { name: str(args.name).replace(/^memory:/, "").trim(), to: "archive", kind: "archive", reason: str(args.reason) })),
    ),

    ...(ctx.options.memorysmith.proposeTasks
      ? {
          memorysmith_task: def(
            "Suggest a task for the user's board when something is explicitly left for later in the conversation (\"das machen wir später\", \"später noch …\", \"TODO für morgen\"). It lands in the first column marked as a suggestion; only the user plans it. At most 2 per run; never for things already done or already on the board.",
            {
              title: { kind: "string", description: "Imperative, one line (e.g. 'Logout-Endpunkt absichern')" },
              body: { kind: "string", description: "Markdown: what is to do and why, with the context needed later (files, decisions). Short." },
              evidence: { kind: "string", description: "The user's words that leave it for later, copied verbatim (≥ 12 characters)" },
              priority: { kind: "string", description: "niedrig | normal | hoch (default normal)", optional: true },
              reason: { kind: "string", description: "Why it should not be forgotten (one sentence)", optional: true },
            },
            (args, context) =>
              withRun(context, "memorysmith", async (run) => {
                const done = (suggestedPerRun.get(run.id) ?? 0)
                if (done >= 2) throw new GuardError("at most 2 task suggestions per run")
                const title = truncate(str(args.title).replace(/\s+/g, " ").trim(), 120)
                if (title.length < 6) throw new GuardError("title is required (imperative, one line)")
                const ev = ctx.ops.verifyEvidence(run, opt(args.evidence))
                if (!ev) {
                  throw new GuardError('evidence must be the user\'s words that leave the work for later, copied verbatim (≥ 12 characters)')
                }
                const project = ctx.projects.forDirectory(run.directory ?? ctx.directory)
                const words = (t: string) => new Set(tokenize(t))
                const mine = words(title)
                const last = ctx.tasks.columns(project?.name).at(-1)
                for (const t of ctx.tasks.list({ project: project?.name ?? "*" })) {
                  if (t.status === last) continue
                  const other = words(t.title)
                  const inter = [...mine].filter((w) => other.has(w)).length
                  const union = new Set([...mine, ...other]).size || 1
                  if (fold(t.title) === fold(title) || inter / union >= 0.7) throw new GuardError(`already on the board: ${t.id} „${t.title}“`)
                }
                const priority = ["niedrig", "normal", "hoch"].includes(str(args.priority).trim()) ? str(args.priority).trim() : "normal"
                const body = `${str(args.body).trim()}\n\n> ${ev.text}\n\n_Vorschlag von memorysmith${opt(args.reason) ? `: ${oneLineOf(str(args.reason))}` : ""}_`.trim()
                const e = await ctx.tasks.create(run, { title, body, project: project?.name, priority, suggested: true })
                suggestedPerRun.set(run.id, done + 1)
                return `suggested ${String(e.fields.id)} „${title}“${project ? ` in project ${project.name}` : ""} (first column, the user decides)`
              }),
          ),
        }
      : {}),

    memorysmith_done: def(
      "Finish the run with a short summary of what was remembered (or why nothing). Call exactly once, at the end.",
      { summary: { kind: "string", description: "Short summary" } },
      (args, context) =>
        withRun(context, "memorysmith", async (run) => {
          run.summary = truncate(str(args.summary).trim(), 1000)
          return "Recorded. The run is complete – stop now."
        }),
    ),
  }

  // ---------------------------------------------------------------------------
  // doctor
  // ---------------------------------------------------------------------------
  const pairOf = (run: Run, raw: unknown) => {
    const id = str(raw).trim().toUpperCase().replace(/^PAIR\s*/, "")
    const p = run.doctorPairs?.[id.startsWith("P") ? id : `P${id}`]
    if (!p) throw new GuardError(`pair "${str(raw)}" is not part of this run (use P1, P2 …)`)
    return { id: id.startsWith("P") ? id : `P${id}`, ...p }
  }
  const doctor = (run: Run) => {
    if (!ctx.doctor) throw new GuardError("the doctor is not available")
    return ctx.doctor
  }

  const doctorTools: Record<string, ToolDef> = {
    doctor_relate: def(
      "Verdict for a pair: the entries are distinct but connected. The relation goes from A to B (reverse=true: from B to A).",
      {
        pair: { kind: "string", description: "Pair id (P1, P2 …)" },
        type: { kind: "string", description: "related | supplements | depends_on | part_of | solves | caused_by | derived_from | uses | example_of | supersedes | duplicates" },
        strength: { kind: "number", description: "1–5: how useful it is to see B when A is found" },
        description: { kind: "string", description: "One sentence that explains the connection" },
        reverse: { kind: "boolean", description: "The relation goes from B to A", optional: true },
      },
      (args, context) =>
        withRun(context, "doctor", async (run) => {
          const p = pairOf(run, args.pair)
          const type = str(args.type).trim().toLowerCase()
          if (type === "not_related") throw new GuardError("use doctor_not_related")
          if (type === "contradicts") throw new GuardError("contradictions: doctor_correct (clear case) or doctor_conflict (for the user)")
          const [from, to] = bool(args.reverse) ? [p.b, p.a] : [p.a, p.b]
          const msg = await ctx.ops.relate(run, { from, to, type, strength: strength(args.strength), description: str(args.description), source: "doctor" })
          doctor(run).decide(run, p.id, `relate:${type}`, { status: "resolved", resolution: `${RELATION_LABEL[type as keyof typeof RELATION_LABEL] ?? type}: ${truncate(str(args.description), 200)}` })
          return msg
        }),
    ),

    doctor_not_related: def(
      "Verdict for a pair: only the words are similar, there is no meaningful connection.",
      {
        pair: { kind: "string", description: "Pair id (P1, P2 …)" },
        reason: { kind: "string", description: "Why (optional)", optional: true },
      },
      (args, context) =>
        withRun(context, "doctor", async (run) => {
          const p = pairOf(run, args.pair)
          const msg = await ctx.ops.relate(run, { from: p.a, to: p.b, type: "not_related", strength: 0, description: str(args.reason) || "kein inhaltlicher Bezug", source: "doctor" })
          doctor(run).decide(run, p.id, "not_related", { status: "resolved", resolution: "kein Bezug" })
          return msg
        }),
    ),

    doctor_merge: def(
      "Verdict for a pair: duplicates of the same kind → one entry that keeps every still valid fact of both; the other is archived.",
      {
        pair: { kind: "string", description: "Pair id (P1, P2 …)" },
        keep: { kind: "string", description: "A or B – the entry that remains" },
        title: { kind: "string", description: "Title of the merged entry", optional: true },
        summary: { kind: "string", description: "One-line summary of the merged entry" },
        body: { kind: "string", description: "Merged body" },
        tags: { ...tagSpec, optional: true },
        reason: { kind: "string", description: "Why they are duplicates (one sentence)" },
      },
      (args, context) =>
        withRun(context, "doctor", async (run) => {
          const p = pairOf(run, args.pair)
          const a = isStoreId(p.a)
          const b = isStoreId(p.b)
          if (!a || !b || a.kind !== b.kind) throw new GuardError("only entries of the same kind can be merged; use doctor_relate (duplicates) instead")
          if (a.kind === "glossary" || a.kind === "script") throw new GuardError(`${a.kind} entries are not merged by the doctor; use doctor_relate`)
          const keep = str(args.keep).trim().toUpperCase() === "B" ? b : a
          const other = keep === a ? b : a
          const msg = await ctx.ops.merge(run, a.kind, {
            sources: [keep.name, other.name],
            target: keep.name,
            title: opt(args.title),
            description: str(args.summary),
            tags: optList(args.tags),
            body: str(args.body),
            reason: str(args.reason),
          })
          doctor(run).decide(run, p.id, "merge", { status: "resolved", resolution: `zusammengeführt in ${a.kind}:${keep.name}` })
          return msg
        }),
    ),

    doctor_correct: def(
      "Verdict for a pair: they contradict each other and one is clearly outdated → replace the wrong passage in the outdated entry with the fact from the other one.",
      {
        pair: { kind: "string", description: "Pair id (P1, P2 …)" },
        target: { kind: "string", description: "A or B – the OUTDATED entry that gets corrected" },
        old_text: { kind: "string", description: "Exact passage of the outdated entry to replace" },
        new_text: { kind: "string", description: "Corrected passage" },
        evidence: { kind: "string", description: "Passage copied verbatim from the OTHER entry that proves the correction" },
        reason: { kind: "string", description: "Why the other entry is right (newer, verified …)" },
      },
      (args, context) =>
        withRun(context, "doctor", async (run) => {
          if (!ctx.options.doctor.autoResolve) throw new GuardError("automatic corrections are off (doctor.autoResolve) – use doctor_conflict")
          const p = pairOf(run, args.pair)
          const targetIsB = str(args.target).trim().toUpperCase() === "B"
          const targetId = targetIsB ? p.b : p.a
          const otherId = targetIsB ? p.a : p.b
          const t = isStoreId(targetId)
          if (!t || t.kind === "glossary") throw new GuardError("only knowledge, memories, errors, skills and scripts can be corrected; use doctor_conflict")
          const rec = aiStoreOf(ctx).getOwned(t.kind, t.name)
          if (!rec) throw new GuardError(`${targetId} not found`)
          if (t.kind === "memory" && ["entscheidung", "vorgabe"].includes(fmStr(rec.fields.type))) {
            throw new GuardError("decisions and conventions belong to the user – use doctor_conflict")
          }
          const evidence = str(args.evidence)
          const other = ctx.graph.node(otherId)
          if (normalizeQuote(evidence).length < 12 || !other || !normalizeQuote(other.text).includes(normalizeQuote(evidence))) {
            throw new GuardError("evidence must be a passage (≥ 12 characters) copied verbatim from the other entry of the pair")
          }
          const msg = await ctx.ops.patch(run, t.kind, { name: t.name, oldText: str(args.old_text), newText: str(args.new_text), evidence, reason: str(args.reason) })
          doctor(run).decide(run, p.id, "correct", { status: "resolved", resolution: `${targetId} korrigiert: ${truncate(str(args.reason), 200)}` })
          return msg
        }),
    ),

    doctor_conflict: def(
      "Verdict for a pair: a contradiction you cannot resolve with certainty (or one about decisions/conventions) → shown to the user.",
      {
        pair: { kind: "string", description: "Pair id (P1, P2 …)" },
        note: { kind: "string", description: "One sentence: what contradicts what" },
      },
      (args, context) =>
        withRun(context, "doctor", async (run) => {
          const p = pairOf(run, args.pair)
          const note = truncate(str(args.note).trim(), 400)
          if (note.length < 8) throw new GuardError("note is required: say what contradicts")
          doctor(run).decide(run, p.id, "conflict", { status: "needs_user", note })
          run.actions.push({ kind: "flag", target: isStoreId(p.a)?.kind ?? "memory", name: p.a, reason: note, detail: `conflict with ${p.b}`, applied: true, local: true })
          return `conflict ${p.conflict} handed to the user`
        }),
    ),

    doctor_done: def(
      "Finish the run with a short summary. Call exactly once, at the end.",
      { summary: { kind: "string", description: "Short summary" } },
      (args, context) =>
        withRun(context, "doctor", async (run) => {
          run.summary = truncate(str(args.summary).trim(), 1000)
          return "Recorded. The run is complete – stop now."
        }),
    ),
  }

  return { ...read, ...memorysmith, ...doctorTools }
}
