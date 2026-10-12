/** Agent task actions (step 4f): assign, approve or revise, questions, messages, abort, fix, discard, accept, rules. */
import { str } from "../frontmatter"
import { GuardError } from "../ops"
import type { ActionDef } from "./types"
import { defineAction } from "./types"
import { requireEntry } from "./util"

const job = { t: "string", max: 60 } as const

export const AGENT_ACTIONS: ActionDef[] = [
  defineAction({
    name: "agent.brief",
    label: "Auftrag ansehen",
    area: "agent",
    smith: "memorysmith",
    local: true,
    readOnlySafe: true,
    args: { target: { t: "id" }, instructions: { t: "string", multiline: true, max: 20_000, optional: true } },
    async run({ ctx }, _run, a) {
      const e = requireEntry(ctx, a.target)
      const b = ctx.agentTasks.composeBrief(e, { instructions: a.instructions })
      return { message: "Auftrag zusammengestellt", data: { brief: b.text, included: b.included, similar: ctx.agentTasks.similar(e) } }
    },
  }),
  defineAction({
    name: "agent.assign",
    label: "An Agent übergeben",
    area: "agent",
    smith: "memorysmith",
    strongToken: "tasks",
    args: {
      target: { t: "id" },
      agent: { t: "string", max: 80, min: 1 },
      model: { t: "string", max: 200, optional: true },
      workplace: { t: "enum", values: ["worktree", "home"], optional: true },
      instructions: { t: "string", multiline: true, max: 20_000, optional: true },
    },
    async preview({ ctx }, a) {
      const e = requireEntry(ctx, a.target)
      const b = ctx.agentTasks.composeBrief(e, { instructions: a.instructions })
      return { message: "So sieht der Auftrag aus", data: { brief: b.text, included: b.included } }
    },
    async run({ ctx }, run, a) {
      const e = requireEntry(ctx, a.target)
      if (e.kind !== "task") throw new GuardError("Nur Aufgaben lassen sich übergeben")
      const j = await ctx.agentTasks.assign(run, { task: e.name, agent: a.agent, model: a.model, workplace: a.workplace, instructions: a.instructions })
      return { message: `${str(e.fields.id)} an ${a.agent} übergeben – der Agent plant (nur lesend)`, target: a.target, open: `#/agenten/${j.id}`, data: { job: j.id } }
    },
  }),
  defineAction({
    name: "agent.approve",
    label: "Vorschlag freigeben",
    area: "agent",
    smith: "memorysmith",
    strongToken: "tasks",
    args: { job, comments: { t: "string", multiline: true, max: 20_000, optional: true }, answers: { t: "string", multiline: true, max: 20_000, optional: true } },
    async run({ ctx }, run, a) {
      const j = await ctx.agentTasks.approve(run, a.job, { comments: a.comments, answers: a.answers })
      return { message: "freigegeben – der Agent setzt jetzt um", target: `task:${j.task}` }
    },
  }),
  defineAction({
    name: "agent.revise",
    label: "Überarbeiten lassen",
    area: "agent",
    smith: "memorysmith",
    local: true,
    args: { job, comments: { t: "string", multiline: true, max: 20_000, min: 3 } },
    async run({ ctx }, _run, a) {
      const j = await ctx.agentTasks.revise(a.job, a.comments)
      return { message: "der Agent überarbeitet den Vorschlag", target: `task:${j.task}` }
    },
  }),
  defineAction({
    name: "agent.permission",
    label: "Rückfrage beantworten",
    area: "agent",
    smith: "memorysmith",
    local: true,
    args: { job, permission: { t: "string", max: 120 }, response: { t: "enum", values: ["once", "always", "reject"] } },
    async run({ ctx }, _run, a) {
      await ctx.agentTasks.permission(a.job, a.permission, a.response)
      return { message: a.response === "reject" ? "abgelehnt" : a.response === "always" ? "immer erlaubt" : "einmal erlaubt" }
    },
  }),
  defineAction({
    name: "agent.message",
    label: "Nachricht an den Agenten",
    area: "agent",
    smith: "memorysmith",
    local: true,
    args: { job, text: { t: "string", multiline: true, max: 20_000, min: 1 }, session: { t: "string", max: 120, optional: true } },
    async run({ ctx }, _run, a) {
      await ctx.agentTasks.message(a.job, a.text, a.session)
      return { message: "Nachricht gesendet" }
    },
  }),
  defineAction({
    name: "agent.abort",
    label: "Abbrechen",
    area: "agent",
    smith: "memorysmith",
    local: true,
    args: { job, session: { t: "string", max: 120, optional: true } },
    async run({ ctx }, _run, a) {
      await ctx.agentTasks.abort(a.job, a.session)
      return { message: a.session ? "Session abgebrochen" : "Auftrag abgebrochen" }
    },
  }),
  defineAction({
    name: "agent.improve",
    label: "Nachbessern",
    area: "agent",
    smith: "memorysmith",
    args: { job, text: { t: "string", multiline: true, max: 20_000, min: 3 } },
    async run({ ctx }, run, a) {
      const j = await ctx.agentTasks.improve(run, a.job, a.text)
      return { message: "der Agent bessert nach", target: `task:${j.task}` }
    },
  }),
  defineAction({
    name: "agent.fixFromPipeline",
    label: "Agent bessert nach (Pipeline)",
    area: "agent",
    smith: "memorysmith",
    args: { job },
    async run({ ctx }, run, a) {
      const j = ctx.agentTasks.get(a.job)
      if (!j?.project) throw new GuardError("Auftrag nicht gefunden")
      const last = ctx.pipeline.lastOfTask(j.task)
      if (!last || last.status === "success") throw new GuardError("Keine rote Pipeline zu diesem Auftrag")
      const log = ctx.pipeline.log(last.project, last.id).text.slice(-6000)
      await ctx.agentTasks.improve(run, a.job, `Die Pipeline ist rot (${last.stages.find((s) => s.status !== "success" && s.status !== "skipped")?.name ?? "?"}). Ende des Logs:\n\`\`\`\n${log}\n\`\`\``)
      return { message: "Fehlerausgabe an den Agenten geschickt", target: `task:${j.task}` }
    },
  }),
  defineAction({
    name: "agent.discard",
    label: "Änderungen verwerfen",
    area: "agent",
    smith: "memorysmith",
    confirm: "undo",
    args: { job },
    async preview({ ctx }, a) {
      const j = ctx.agentTasks.get(a.job)
      if (!j) throw new GuardError("Auftrag nicht gefunden")
      const files = await ctx.agentTasks.diff(j).catch(() => [])
      return { message: `${files.length} geänderte Datei(en) werden zurückgesetzt`, affected: files.map((f) => ({ id: f.path, title: f.path, detail: `+${f.additions}/−${f.deletions}` })) }
    },
    async run({ ctx }, run, a) {
      const j = await ctx.agentTasks.discard(run, a.job)
      return { message: "Änderungen verworfen", target: `task:${j.task}` }
    },
  }),
  defineAction({
    name: "agent.accept",
    label: "Abnehmen",
    area: "agent",
    smith: "memorysmith",
    strongToken: "tasks",
    args: { job, mode: { t: "enum", values: ["merge", "pr", "keep", "discard"] } },
    async run({ ctx }, run, a) {
      const r = await ctx.agentTasks.accept(run, a.job, a.mode)
      const j = ctx.agentTasks.get(a.job)
      return { message: r.message, target: j ? `task:${j.task}` : undefined, data: r }
    },
  }),
  defineAction({
    name: "agent.prepare",
    label: "Vorschläge jetzt vorbereiten",
    area: "agent",
    smith: "memorysmith",
    strongToken: "tasks",
    local: true,
    args: {},
    async run({ ctx }) {
      const n = await ctx.agentTasks.prepareProposals("manual")
      return { message: n ? `${n} Vorschlag/Vorschläge werden vorbereitet` : "keine eingeplanten Agenten-Aufgaben ohne Vorschlag" }
    },
  }),
  defineAction({
    name: "rule.decide",
    label: "Regel bestätigen oder verwerfen",
    area: "agent",
    smith: "memorysmith",
    args: { id: { t: "string", max: 40 }, decision: { t: "enum", values: ["confirm", "dismiss"] }, text: { t: "string", max: 400, optional: true } },
    async run({ ctx }, run, a) {
      const msg = await ctx.agentTasks.decideRule(run, a.id, a.decision, a.text)
      return { message: a.decision === "confirm" ? `als Vorgabe gespeichert – der nächste Agent bekommt sie mit (${msg.split("\n")[0]})` : "verworfen" }
    },
  }),
]
