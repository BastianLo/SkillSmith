/** Document import actions (5h): create from an upload, start / stop the extraction, apply, delete. */
import { AI_ACCESS } from "../../types"
import { FINDING_TYPES } from "../importer"
import { GuardError } from "../ops"
import type { ActionDef } from "./types"
import { defineAction } from "./types"

export const IMPORT_ACTIONS: ActionDef[] = [
  defineAction({
    name: "import.create",
    label: "Datei importieren",
    area: "dokument",
    smith: "docsmith",
    local: true,
    args: { name: { t: "string", max: 200, min: 3 }, ai: { t: "enum", values: AI_ACCESS, optional: true }, start: { t: "boolean", optional: true } },
    async run({ ctx, payload }, _run, a) {
      if (!ctx.importer) throw new GuardError("Import nicht verfügbar")
      if (!payload?.length) throw new GuardError("leere Datei")
      const j = await ctx.importer.create(a.name, payload, a.ai)
      if (a.start !== false) ctx.importer.start(j.id)
      return { message: `${j.pages.length} ${j.pages[0]?.label ?? "Seite"}(n) gelesen – Extraktion ${a.start !== false ? "läuft" : "bereit"}`, data: { id: j.id, pages: j.pages.length }, open: `#/import/${j.id}` }
    },
  }),
  defineAction({
    name: "import.start",
    label: "Extraktion starten / fortsetzen",
    area: "dokument",
    smith: "docsmith",
    local: true,
    args: { id: { t: "string", max: 120 } },
    async run({ ctx }, _run, a) {
      const j = ctx.importer!.start(a.id)
      return { message: `Extraktion von ${j.file} läuft` }
    },
  }),
  defineAction({
    name: "import.stop",
    label: "Extraktion anhalten",
    area: "dokument",
    smith: "docsmith",
    local: true,
    args: { id: { t: "string", max: 120 } },
    async run({ ctx }, _run, a) {
      ctx.importer!.stop(a.id)
      return { message: "wird nach dem laufenden Abschnitt angehalten" }
    },
  }),
  defineAction({
    name: "import.apply",
    label: "Funde übernehmen",
    area: "dokument",
    smith: "docsmith",
    args: { id: { t: "string", max: 120 }, edits: { t: "array", max: 2000, optional: true } },
    async run({ ctx }, run, a) {
      const edits = ((a.edits ?? []) as Array<Record<string, unknown>>).map((e) => ({
        index: Number(e.index),
        ...(typeof e.selected === "boolean" ? { selected: e.selected } : {}),
        ...(typeof e.title === "string" ? { title: e.title.slice(0, 160) } : {}),
        ...(typeof e.text === "string" ? { text: e.text.slice(0, 20_000) } : {}),
        ...(typeof e.type === "string" && (FINDING_TYPES as readonly string[]).includes(e.type) ? { type: e.type as (typeof FINDING_TYPES)[number] } : {}),
        ...(typeof e.target === "string" && /^[a-z]+:[\w.-]+$/.test(e.target) ? { target: e.target } : {}),
      }))
      const r = await ctx.importer!.apply(run, a.id, edits)
      return { message: r.message, data: r }
    },
  }),
  defineAction({
    name: "import.delete",
    label: "Import verwerfen",
    area: "dokument",
    smith: "docsmith",
    local: true,
    args: { id: { t: "string", max: 120 } },
    async run({ ctx }, _run, a) {
      ctx.importer!.remove(a.id)
      return { message: "Import verworfen" }
    },
  }),
]
