/**
 * Library actions: run a script through call_script (5e); snippets and prompts (5j).
 */
import { GuardError } from "../ops"
import { callScript } from "../scripts"
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
]
