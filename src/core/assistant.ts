/**
 * The read-only assistant of the web view (agent "smith-assistant"): drafts documents from
 * sessions, work states or templates, checks a document against newer knowledge, answers
 * questions with [[links]] to its sources (idea 23). It has only the plugin's read tools,
 * private documents do not exist for it, and nothing it says is stored without the user.
 */
import { unwrap } from "./agent-runner"
import { runAgentSession } from "./agent-runner"
import type { Ctx } from "./context"
import { modelCatalog, modelErrorHint } from "./models"
import { GuardError } from "./ops"
import { ASSISTANT_AGENT } from "./prompts"
import { resolveModel } from "./reviewer"
import { buildTranscript, type Msg } from "./transcript"
import { truncate } from "../util/text"

export async function askAssistant(ctx: Ctx, prompt: string, title: string): Promise<string> {
  const model = resolveModel(ctx, "docsmith", "reviewer")
  const res = await runAgentSession({
    client: ctx.client,
    agent: ASSISTANT_AGENT,
    title: `skillsmith-assistant · ${truncate(title, 60)}`,
    prompt: ctx.redactor.redact(prompt),
    timeoutMs: ctx.options.reviewTimeoutMin * 60_000,
    keepSession: ctx.options.keepAgentSessions,
    log: ctx.log,
    model,
    collectText: true,
  })
  if (!res.ok && !res.text) {
    const hint = modelErrorHint(res.error, await modelCatalog(ctx.client))
    throw new GuardError(`Der Assistent hat nicht geantwortet: ${res.error ?? "unbekannter Fehler"}${hint ? ` – ${hint}` : ""}`)
  }
  return ctx.redactor.redact(res.text ?? "")
}

/** Redacted transcript of a session (drafts "aus Session dokumentieren"). */
export async function sessionTranscript(ctx: Ctx, sessionID: string, maxChars = ctx.options.transcriptMaxChars): Promise<{ text: string; title?: string }> {
  const msgs = unwrap<Msg[]>(await ctx.client.session.messages({ path: { id: sessionID } }))
  let title: string | undefined
  try {
    title = unwrap<{ title?: string }>(await ctx.client.session.get({ path: { id: sessionID } }))?.title
  } catch {
    title = undefined
  }
  const t = buildTranscript(msgs ?? [], { maxChars, redact: (s) => ctx.redactor.redact(s) })
  return { text: t.text, title }
}
