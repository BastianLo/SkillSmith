/**
 * Library actions: run a script through call_script (5e); snippets and prompts (5j).
 */
import { contextValues, fillPrompt, fillSnippet, liveTemplates, parsePromptArgs, snippetCode } from "../library"
import { errorSignature } from "../signals"
import { GuardError } from "../ops"
import { expandPath } from "../projects"
import { callScript } from "../scripts"
import { requireEntry, uniqueName } from "./util"
import type { ActionDef } from "./types"
import { defineAction } from "./types"

export const LIBRARY_ACTIONS: ActionDef[] = [
  defineAction({
    name: "script.run",
    label: "Skript ausführen",
    area: "eintrag",
    smith: "toolsmith",
    local: true,
    // runs code on this machine (like pipeline commands)
    strongToken: "pipeline",
    args: { target: { t: "id" }, params: { t: "object", optional: true }, args: { t: "list", max: 50, item: 2000, optional: true } },
    async run({ ctx, session }, _run, a) {
      const name = String(a.target).replace(/^script:/, "")
      if (!String(a.target).startsWith("script:")) throw new GuardError("nur Skripte lassen sich ausführen")
      const r = await callScript(ctx, name, { params: a.params, args: a.args, origin: "web", session })
      return { message: r.ok ? `${name}: ok (${r.ms} ms)` : `${name}: fehlgeschlagen – ${r.error ?? `exit ${r.exit}`}`, data: r }
    },
  }),
  defineAction({
    name: "snippet.fill",
    label: "Snippet ausfüllen",
    area: "eintrag",
    smith: "skillsmith",
    local: true,
    readOnlySafe: true,
    args: { target: { t: "id" }, values: { t: "object", optional: true } },
    async run({ ctx }, _run, a) {
      const e = requireEntry(ctx, a.target)
      if (e.kind !== "snippet") throw new GuardError("kein Snippet")
      const r = fillSnippet(snippetCode(e), Object.fromEntries(Object.entries((a.values ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)])))
      ctx.usage.recordLoad("snippet", e.name, { origin: "web" } as any)
      return { message: r.missing.length ? `offen: ${r.missing.join(", ")}` : "ausgefüllt", data: r }
    },
  }),
  defineAction({
    name: "prompt.fill",
    label: "Prompt ausfüllen",
    area: "eintrag",
    smith: "skillsmith",
    local: true,
    readOnlySafe: true,
    args: { target: { t: "id" }, values: { t: "object", optional: true }, text: { t: "string", max: 20_000, multiline: true, optional: true } },
    async run({ ctx }, _run, a) {
      const e = requireEntry(ctx, a.target)
      if (e.kind !== "prompt") throw new GuardError("kein Prompt")
      const values = { ...contextValues(ctx), ...Object.fromEntries(Object.entries((a.values ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)])) }
      if (a.text) values.auswahl ??= a.text
      const r = fillPrompt(e.body, values)
      await ctx.library?.promptUsed(e)
      return { message: r.missing.length ? `offen: ${r.missing.join(", ")}` : "ausgefüllt", data: { ...r, agent: e.fields.agent ?? null, model: e.fields.model ?? null } }
    },
  }),
  defineAction({
    name: "prompt.feedback",
    label: "Prompt-Ergebnis bewerten",
    area: "eintrag",
    smith: "skillsmith",
    local: true,
    args: { target: { t: "id" }, good: { t: "boolean" } },
    async run({ ctx }, _run, a) {
      const e = requireEntry(ctx, a.target)
      await ctx.library?.promptFeedback(e, a.good)
      return { message: a.good ? "als gut vermerkt" : "als nachgebessert/verworfen vermerkt" }
    },
  }),
  defineAction({
    name: "snippet.adopt",
    label: "Als Snippet übernehmen",
    area: "neu",
    smith: "skillsmith",
    args: { id: { t: "string", max: 40 }, title: { t: "string", max: 160, min: 1 }, description: { t: "string", max: 300, optional: true }, tags: { t: "list", max: 12, item: 40, optional: true } },
    async run({ ctx }, run, a) {
      const c = ctx.library?.candidates().find((x) => x.id === a.id)
      if (!c) throw new GuardError("Kandidat nicht gefunden")
      const name = uniqueName(ctx, "snippet", a.title)
      await ctx.ops.create(run, "snippet", { name, title: a.title, description: a.description || a.title, tags: a.tags, fields: { author: "user", language: c.language, origin: `sessions ${c.sessions.slice(0, 5).join(", ")}` }, body: `\`\`\`${c.language}\n${c.code}\n\`\`\``, reason: `in ${c.sessions.length} Sessions wiederholt`, approved: true })
      await ctx.library!.dismissCandidate(a.id)
      return { message: `Snippet „${a.title}“ angelegt`, target: `snippet:${name}`, open: `#/editor/snippet:${name}` }
    },
  }),
  defineAction({
    name: "snippet.dismiss",
    label: "Snippet-Kandidat verwerfen",
    area: "neu",
    smith: "skillsmith",
    local: true,
    args: { id: { t: "string", max: 40 } },
    async run({ ctx }, _run, a) {
      await ctx.library?.dismissCandidate(a.id)
      return { message: "verworfen" }
    },
  }),
  defineAction({
    name: "review.confirm",
    label: "Review-Kandidat bestätigen",
    area: "erinnerung",
    smith: (a) => (a.as === "skill" ? "skillsmith" : "memorysmith"),
    args: { id: { t: "string", max: 40 }, as: { t: "enum", values: ["vorgabe", "skill"] }, scope: { t: "enum", values: ["projekt", "global"], optional: true }, title: { t: "string", max: 120, min: 3 }, text: { t: "string", max: 4000, min: 10, multiline: true } },
    async run({ ctx }, run, a) {
      if (!ctx.reviews) throw new GuardError("Review-Wissen nicht verfügbar")
      const target = await ctx.reviews.confirm(run, a.id, { as: a.as, scope: a.scope ?? "projekt", title: a.title, text: a.text })
      return { message: `${a.as === "skill" ? "Skill" : "Vorgabe"} „${a.title}“ angelegt`, target, open: target ? `#/eintrag/${target}` : undefined }
    },
  }),
  defineAction({
    name: "review.reject",
    label: "Review-Kandidat ablehnen",
    area: "erinnerung",
    smith: "memorysmith",
    local: true,
    args: { id: { t: "string", max: 40 } },
    async run({ ctx }, _run, a) {
      await ctx.reviews?.reject(a.id)
      return { message: "abgelehnt (wird nicht erneut vorgeschlagen)" }
    },
  }),
  defineAction({
    name: "review.prCheck",
    label: "Vor-PR-Prüfung",
    area: "projekt",
    smith: "memorysmith",
    local: true,
    readOnlySafe: true,
    args: { project: { t: "string", max: 64, optional: true }, dir: { t: "string", max: 1000, optional: true }, base: { t: "string", max: 200, optional: true, pattern: /^[\w./~^-]*$/ } },
    async run({ ctx }, _run, a) {
      if (!ctx.reviews) throw new GuardError("Review-Wissen nicht verfügbar")
      const p = a.project ? ctx.projects.get(a.project) : undefined
      if (a.project && !p?.homePath) throw new GuardError(`Projekt ${a.project} hat kein home_path`)
      // the smith CLI passes its working directory (a git repository of the user; read only)
      if (a.dir && !/^\//.test(a.dir)) throw new GuardError("dir muss ein absoluter Pfad sein")
      const r = await ctx.reviews.prCheck(a.dir || (p?.homePath ? expandPath(p.homePath) : ctx.worktree), a.base || undefined)
      return { message: r.summary, data: r }
    },
  }),
  defineAction({
    name: "error.lookup",
    label: "Fehler nachschlagen",
    area: "eintrag",
    smith: "errorsmith",
    local: true,
    readOnlySafe: true,
    // the IntelliJ plugin sends failing run output; the occurrence is counted for errorsmith
    args: { text: { t: "string", max: 20_000, min: 5, multiline: true }, command: { t: "string", max: 500, optional: true }, source: { t: "string", max: 40, optional: true } },
    async run({ ctx }, _run, a) {
      const text = ctx.redactor.redact(a.text)
      const sig = errorSignature("run", a.command ?? a.source ?? "ide", text)
      const known = ctx.store.list("error").filter((e) => e.tier !== "archive" && (e.fields.signatures as string[] | undefined)?.some((s) => s === sig.signature))
      const hits = known.length ? [] : await ctx.retriever.search(text.slice(0, 2000), { kinds: ["error"], tiers: ["active", "dormant"], limit: 3, purpose: "error" }).catch(() => [])
      const found = known.length ? known.map((e) => ({ id: `error:${e.name}`, title: e.title, score: 1 })) : hits.filter((h) => Math.max(h.confidence, h.similarity ?? 0) >= ctx.options.errorsmith.hintMinScore).map((h) => ({ id: `error:${h.name}`, title: h.title, score: Math.round(Math.max(h.confidence, h.similarity ?? 0) * 100) / 100 }))
      ctx.occurrences.record({ sigKey: sig.sigKey, signature: sig.signature, tool: "ide", head: sig.head, sample: text.slice(0, 1000), project: ctx.project, entry: found[0]?.id.slice(6) })
      await ctx.occurrences.flush().catch(() => undefined)
      const top = found[0] ? ctx.store.getOwned("error", found[0].id.slice(6)) : undefined
      const solution = top ? (/##\s+(lösung|loesung|solution|fix)[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i.exec(top.body)?.[2] ?? "").trim() : ""
      return { message: found.length ? `bekannter Fehler: ${found[0].title}` : "kein bekannter Fehler – vermerkt für errorsmith", data: { signature: sig.signature, found, solution } }
    },
  }),
]

export { liveTemplates, parsePromptArgs }
