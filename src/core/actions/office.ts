/**
 * Office documents (PowerPoint, Word): upload, create (blank or from a .potx/.dotx), save from
 * the editor, edit by prompt (AI draft, live), accept / discard the draft, use as template.
 * Restoring a version goes through entry.restoreVersion (→ OfficeDocs.restore).
 */
import { AI_ACCESS } from "../../types"
import { str } from "../frontmatter"
import { GuardError } from "../ops"
import { familyOf, retype, type OfficeFormat } from "../office"
import type { Ctx } from "../context"
import type { ActionDef } from "./types"
import { defineAction } from "./types"
import { parseId } from "./util"

const target = { t: "id" } as const

function office(ctx: Ctx) {
  if (!ctx.office) throw new GuardError("Office-Dokumente nicht verfügbar")
  return ctx.office
}

function nameOf(id: string): string {
  const { kind, name } = parseId(id)
  if (kind !== "office") throw new GuardError("kein Office-Dokument")
  return name
}

export const OFFICE_ACTIONS: ActionDef[] = [
  defineAction({
    name: "office.upload",
    label: "Office-Datei hochladen",
    area: "dokument",
    smith: "docsmith",
    args: {
      fileName: { t: "string", max: 200, min: 3 },
      title: { t: "string", max: 160, optional: true },
      description: { t: "string", max: 300, optional: true },
      tags: { t: "list", max: 12, item: 40, optional: true },
      ai: { t: "enum", values: AI_ACCESS, optional: true },
    },
    async run({ ctx, payload }, run, a) {
      if (!payload?.length) throw new GuardError("leere Datei")
      const e = await office(ctx).upload(run, { fileName: a.fileName, bytes: payload, title: a.title, description: a.description, tags: a.tags, ai: a.ai })
      return { message: `„${e.title}“ hochgeladen (${str(e.fields.format)}, ${e.fields.pages ?? 0} ${familyOf(str(e.fields.format) as OfficeFormat) === "pptx" ? "Folie(n)" : "Absätze"})`, target: `office:${e.name}`, open: `#/office/${e.name}` }
    },
  }),
  defineAction({
    name: "office.create",
    label: "Office-Dokument anlegen",
    area: "neu",
    smith: "docsmith",
    args: {
      format: { t: "enum", values: ["pptx", "docx"] },
      title: { t: "string", max: 160, min: 1 },
      template: { t: "id", optional: true },
      description: { t: "string", max: 300, optional: true },
      tags: { t: "list", max: 12, item: 40, optional: true },
      ai: { t: "enum", values: AI_ACCESS, optional: true },
      prompt: { t: "string", max: 8000, multiline: true, optional: true },
    },
    async run({ ctx }, run, a) {
      const e = await office(ctx).create(run, { family: a.format, title: a.title, template: a.template ? nameOf(a.template) : undefined, description: a.description, tags: a.tags, ai: a.ai })
      const prompt = (a.prompt ?? "").trim()
      return {
        message: `„${e.title}“ angelegt${prompt ? " – die KI erstellt den Inhalt" : ""}`,
        target: `office:${e.name}`,
        open: `#/office/${e.name}`,
        // after the commit: the AI fills the new document as a draft
        after: prompt
          ? async () => {
              office(ctx).edit(e.name, prompt, { isNew: true })
              return undefined
            }
          : undefined,
      }
    },
  }),
  defineAction({
    name: "office.save",
    label: "Office-Dokument speichern",
    area: "dokument",
    smith: "docsmith",
    args: { target, base: { t: "string", max: 40, optional: true }, reason: { t: "string", max: 300, optional: true } },
    version: ({ ctx }, a) => ctx.store.getOwned("office", nameOf(a.target))?.version,
    async run({ ctx, payload }, run, a) {
      if (!payload?.length) throw new GuardError("leere Datei")
      const msg = await office(ctx).save(run, nameOf(a.target), payload, { reason: a.reason })
      return { message: msg, target: a.target }
    },
  }),
  defineAction({
    name: "office.edit",
    label: "Von der KI bearbeiten lassen",
    area: "dokument",
    smith: "docsmith",
    local: true,
    args: { target, prompt: { t: "string", max: 8000, min: 3, multiline: true } },
    async run({ ctx }, _run, a) {
      const d = office(ctx).edit(nameOf(a.target), a.prompt)
      return { message: "Die KI plant die Änderungen – der Entwurf aktualisiert sich live", target: a.target, data: d }
    },
  }),
  defineAction({
    name: "office.accept",
    label: "KI-Entwurf übernehmen",
    area: "dokument",
    smith: "docsmith",
    args: { target, force: { t: "boolean", optional: true } },
    async run({ ctx }, run, a) {
      const msg = await office(ctx).accept(run, nameOf(a.target), a.force === true)
      return { message: msg, target: a.target }
    },
  }),
  defineAction({
    name: "office.discard",
    label: "KI-Entwurf verwerfen",
    area: "dokument",
    smith: "docsmith",
    local: true,
    args: { target },
    async run({ ctx }, _run, a) {
      office(ctx).discard(nameOf(a.target))
      return { message: "Entwurf verworfen", target: a.target }
    },
  }),
  defineAction({
    name: "office.asTemplate",
    label: "Als Vorlage speichern",
    area: "dokument",
    smith: "docsmith",
    args: { target, title: { t: "string", max: 160, optional: true } },
    async run({ ctx }, run, a) {
      const o = office(ctx)
      const e = o.entry(nameOf(a.target))
      const format = o.formatOf(e)
      const to: OfficeFormat = familyOf(format) === "pptx" ? "potx" : "dotx"
      if (format === to) throw new GuardError("Das ist schon eine Vorlage")
      const bytes = await retype(o.bytes(e), to)
      const t = await o.upload(run, { fileName: `${e.name}.${to}`, bytes, title: a.title ?? `Vorlage ${e.title}`, description: `Vorlage aus ${e.title}`, tags: e.tags, ai: str(e.fields.ai) || undefined })
      return { message: `Vorlage „${t.title}“ angelegt`, target: `office:${t.name}`, open: `#/office/${t.name}` }
    },
  }),
]
