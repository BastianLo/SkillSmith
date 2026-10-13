/**
 * Quality actions (5c): code anchors ("Passt noch", "Vom Agenten beheben lassen", check now)
 * and sources of a paragraph set by the user.
 */
import { PROVENANCE_TYPES } from "../../types"
import { truncate } from "../../util/text"
import { askAssistant } from "../assistant"
import { str } from "../frontmatter"
import { GuardError } from "../ops"
import type { ActionDef } from "./types"
import { defineAction } from "./types"
import { requireEntry, smithOfId } from "./util"

export const QUALITY_ACTIONS: ActionDef[] = [
  defineAction({
    name: "anchor.accept",
    label: "Passt noch",
    area: "eintrag",
    smith: (a) => smithOfId(a.target),
    args: { target: { t: "id" }, ref: { t: "string", max: 400, min: 1 } },
    async run({ ctx }, run, a) {
      const e = requireEntry(ctx, a.target)
      const anchors = ctx.anchors
      if (!anchors) throw new GuardError("Code-Anker sind nicht verfügbar")
      const list = e.meta?.anchors ?? []
      const rec = list.find((x) => x.ref === a.ref)
      if (!rec) throw new GuardError(`Anker ${a.ref} ist nicht verankert`)
      const status = anchors.statusOf(a.target).find((s) => s.ref === a.ref)
      const fresh = await anchors.repin(rec, status?.newPath ? { path: status.newPath } : undefined)
      if (!fresh) throw new GuardError(`Der Code zu ${a.ref} ist nicht mehr auffindbar – Anker im Text anpassen oder entfernen`)
      await ctx.ops.setAnchors(run, e.kind, e.name, list.map((x) => (x.ref === a.ref ? fresh : x)), `passt noch: ${a.ref}`)
      anchors.clear(a.target, a.ref)
      return { message: `Anker ${a.ref} übernimmt den aktuellen Code${fresh.path !== rec.path ? ` (${fresh.path})` : ""}`, target: a.target }
    },
  }),
  defineAction({
    name: "anchor.fix",
    label: "Vom Agenten beheben lassen",
    area: "eintrag",
    smith: (a) => smithOfId(a.target),
    args: { target: { t: "id" }, ref: { t: "string", max: 400, min: 1 } },
    async run({ ctx }, run, a) {
      const e = requireEntry(ctx, a.target)
      if (str(e.fields.ai) === "privat") throw new GuardError("Private Dokumente sieht die KI nicht")
      const status = ctx.anchors?.statusOf(a.target).find((s) => s.ref === a.ref)
      if (!status) throw new GuardError(`Für ${a.ref} liegt kein geprüfter Stand vor – Job „Code-Anker prüfen“ ausführen`)
      const prompt = [
        `Der Code, auf den das folgende Dokument mit [[code:${a.ref}]] verweist, hat sich geändert (${status.status}${status.newPath ? `, jetzt ${status.newPath}` : ""}).`,
        `Passe nur die Stellen des Dokuments an, die der Code-Änderung widersprechen. Erfinde nichts, was nicht aus dem Code hervorgeht.`,
        `Gib den vollständigen überarbeiteten Text zwischen <dokument> und </dokument> aus und danach unter "Begründung:" kurz, was sich im Code geändert hat.`,
        `Wenn das Dokument noch stimmt, antworte nur mit: UNVERÄNDERT – und einer kurzen Begründung.`,
        "",
        "## Code vorher",
        "```",
        truncate(status.before ?? "(nicht verfügbar)", 6000),
        "```",
        "## Code jetzt",
        "```",
        truncate(status.after ?? "(gelöscht)", 6000),
        "```",
        "",
        `# ${e.title}`,
        e.description,
        "",
        e.body,
      ].join("\n")
      const answer = await askAssistant(ctx, prompt, `Code-Anker ${e.title}`)
      const doc = /<dokument>\s*([\s\S]*?)\s*<\/dokument>/.exec(answer)?.[1]
      const why = truncate((/Begründung:\s*([\s\S]*)$/.exec(answer)?.[1] ?? answer.replace(/<dokument>[\s\S]*<\/dokument>/, "")).trim(), 1500)
      if (!doc || /^UNVERÄNDERT/i.test(answer.trim()) || doc.trim() === e.body.trim()) {
        return { message: `Keine Änderung nötig: ${truncate(why || answer, 300)} – mit „Passt noch“ bestätigen`, data: { why } }
      }
      // a proposal with diff (the KI-Recht of the document applies: lesen / privat are refused)
      run.writeMode = "stage"
      run.actor = "reviewer"
      try {
        const msg = await ctx.ops.update(run, e.kind, { name: e.name, body: doc, reason: `Code geändert (${a.ref}): ${truncate(why, 260)}`, approved: true, repinAnchors: [a.ref] })
        return { message: `Vorschlag erstellt (${truncate(msg, 120)}) – im Eingang bzw. im Editor als Diff`, target: a.target, data: { why } }
      } finally {
        run.actor = "web"
      }
    },
  }),
  defineAction({
    name: "anchors.check",
    label: "Code-Anker jetzt prüfen",
    area: "system",
    smith: "docsmith",
    local: true,
    args: {},
    async run({ ctx }) {
      if (!ctx.anchors) throw new GuardError("Code-Anker sind nicht verfügbar")
      const r = await ctx.anchors.checkAll(true)
      const parts = Object.entries(r.byStatus).map(([k, v]) => `${v} ${k}`)
      return { message: `${r.checked} Anker geprüft${parts.length ? ` (${parts.join(", ")})` : ""}` }
    },
  }),
  defineAction({
    name: "provenance.set",
    label: "Quelle eines Absatzes",
    area: "eintrag",
    smith: (a) => smithOfId(a.target),
    args: {
      target: { t: "id" },
      paragraph: { t: "string", max: 400, min: 12, multiline: true },
      type: { t: "enum", values: PROVENANCE_TYPES },
      ref: { t: "string", max: 300, optional: true },
      quote: { t: "string", max: 600, optional: true, multiline: true },
    },
    async run({ ctx }, run, a) {
      const e = requireEntry(ctx, a.target)
      if (!a.ref && !a.quote && a.type !== "user") throw new GuardError("Quelle braucht eine Referenz oder ein Zitat")
      const msg = await ctx.ops.addSource(run, e.kind, e.name, { paragraph: a.paragraph, type: a.type, ref: a.ref, quote: a.quote })
      return { message: msg, target: a.target }
    },
  }),
]
