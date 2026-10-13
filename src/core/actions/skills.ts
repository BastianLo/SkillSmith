/** Skill packages: upload (zip/.skill, SKILL.md or a folder) with supporting files such as references/*.md. */
import { parseSkillPackage } from "../skill-package"
import { GuardError } from "../ops"
import { ConfirmNeeded } from "../tasks"
import type { ActionDef } from "./types"
import { defineAction } from "./types"

export const SKILL_ACTIONS: ActionDef[] = [
  defineAction({
    name: "skill.upload",
    label: "Skill hochladen",
    area: "neu",
    smith: "skillsmith",
    args: { fileName: { t: "string", max: 200, min: 3 }, force: { t: "boolean", optional: true } },
    async run({ ctx, payload }, run, a) {
      if (!payload?.length) throw new GuardError("leere Datei")
      const pkg = parseSkillPackage(a.fileName, payload)
      const exists = !!ctx.store.fresh("skill", pkg.name)
      if (exists && !a.force) throw new ConfirmNeeded(`Den Skill „${pkg.name}“ gibt es schon. Ersetzen (SKILL.md und alle Dateien)?`)
      const msg = await ctx.ops.skillPackage(run, { ...pkg, replace: exists, reason: `hochgeladen: ${a.fileName}` })
      const refs = Object.keys(pkg.files)
      return {
        message: `${exists ? "Skill ersetzt" : "Skill angelegt"}: ${pkg.name} – ${refs.length} zusätzliche Datei(en)`,
        target: `skill:${pkg.name}`,
        open: `#/eintrag/skill%3A${pkg.name}`,
        warnings: pkg.warnings,
        data: { name: pkg.name, files: refs, detail: msg },
      }
    },
  }),
]
