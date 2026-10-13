/**
 * /prompt <name> [var=wert …] [text]: fills a prompt of the library (5j) – variables from the
 * arguments, the remaining text as {{auswahl}}, the rest from the context (branch, ticket,
 * project, date, task of the branch). The filled text replaces the command as the user's
 * message; nothing else is registered, so new prompts work without a restart.
 */
import type { Ctx } from "../core/context"
import { contextValues, fillPrompt, parsePromptArgs, promptVariables } from "../core/library"

export const LIBRARY_COMMANDS = [
  { name: "prompt", usage: "/prompt <name> [variable=wert …] [text]", description: "skillsmith: Prompt aus der Bibliothek ausfüllen und senden (Variablen wie {{ticket}} aus dem Kontext)" },
  { name: "smith-pr-check", usage: "/smith-pr-check [basis]", description: "skillsmith: Diff des Branches gegen die Vorgaben aus Reviews prüfen (Vor-PR-Prüfung)" },
]

/** /smith-pr-check [base]: findings at file and line with the rule and the original comments. */
export async function prCheckCommand(ctx: Ctx, base: string): Promise<string> {
  if (!ctx.reviews) return "Review-Wissen ist nicht verfügbar."
  const r = await ctx.reviews.prCheck(ctx.worktree, base.trim() || undefined)
  if (!r.findings.length) return `Vor-PR-Prüfung (gegen ${r.base.slice(0, 10)}): ${r.summary}`
  const lines = r.findings.map((f) => {
    const src = f.comments.map((id) => ctx.reviews!.comment(id)).filter(Boolean).slice(0, 2).map((c) => c!.url ?? `${c!.repo}#${c!.pr}`)
    return `- ${f.file ? `\`${f.file}${f.line ? `:${f.line}` : ""}\`` : "(ohne Datei)"} – ${f.text} (${f.rule}${src.length ? `; aus Reviews: ${src.join(", ")}` : ""})`
  })
  return `**Vor-PR-Prüfung** gegen ${r.base.slice(0, 10)}: ${r.summary}\n\n${lines.join("\n")}`
}

export async function promptCommand(ctx: Ctx, raw: string): Promise<{ ok: boolean; text: string }> {
  const { name, values, rest } = parsePromptArgs(raw)
  const prompts = ctx.store.list("prompt").filter((e) => e.tier === "active")
  const list = () => prompts.map((p) => `- \`${p.name}\` – ${p.description}${promptVariables(p.body).length ? ` (${promptVariables(p.body).map((v) => `{{${v}}}`).join(", ")})` : ""}`).join("\n") || "(keine Prompts – in der Weboberfläche unter Bibliothek → Prompts anlegen)"
  if (!name) return { ok: false, text: `**Prompts der Bibliothek**\n\n${list()}` }
  const e = prompts.find((p) => p.name === name) ?? prompts.find((p) => p.title.toLowerCase() === name.toLowerCase())
  if (!e) return { ok: false, text: `Prompt „${name}“ nicht gefunden.\n\n${list()}` }
  const all = { ...contextValues(ctx), ...values }
  const vars = promptVariables(e.body)
  if (rest) {
    const target = vars.includes("auswahl") && !values.auswahl ? "auswahl" : vars.find((v) => all[v] === undefined)
    if (target) all[target] = rest
  }
  const r = fillPrompt(e.body, all)
  if (r.missing.length) return { ok: false, text: `Prompt „${e.name}“: es fehlen ${r.missing.map((m) => `{{${m}}}`).join(", ")} – z. B. \`/prompt ${e.name} ${r.missing.map((m) => `${m}=…`).join(" ")}\`` }
  await ctx.library?.promptUsed(e)
  const hint = e.fields.agent || e.fields.model ? `\n\n<!-- empfohlen: ${[e.fields.agent ? `Agent ${String(e.fields.agent)}` : "", e.fields.model ? `Modell ${String(e.fields.model)}` : ""].filter(Boolean).join(", ")} -->` : ""
  return { ok: true, text: `${r.text}${hint}` }
}
