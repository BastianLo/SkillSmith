/**
 * Operations of the workplace itself (5a): settings page, inbox switches, jobs.
 * Settings are written to settings.json in one run (one commit, undo); security relevant
 * values need the token (always) and a confirmation (428 → "force").
 */
import { NOTIFY_EVENTS, valueAt } from "../../config"
import { dismiss, INBOX_TYPES } from "../inbox"
import { GuardError } from "../ops"
import { SMITHS } from "../prompts"
import type { SettingChange } from "../settings"
import { isSecurity, metaOf } from "../settings-meta"
import { ConfirmNeeded } from "../tasks"
import type { ActionDef } from "./types"
import { defineAction } from "./types"

const changesOf = (a: { values?: Record<string, unknown>; reset?: string[] }): SettingChange[] => [
  ...Object.entries(a.values ?? {}).map(([path, value]) => ({ path, value })),
  ...(a.reset ?? []).map((path) => ({ path, reset: true })),
]

const INBOX_KEYS = new Set([...INBOX_TYPES.map((t) => t.type), ...SMITHS.map((s) => `change.${s}`)])

export const OPERATION_ACTIONS: ActionDef[] = [
  defineAction({
    name: "settings.set",
    label: "Einstellungen ändern",
    area: "system",
    smith: "skillsmith",
    // security relevant values need the token even when web.token is off
    strongToken: (_env, a) => (changesOf(a).some((c) => isSecurity(c.path)) ? "always" : undefined),
    args: { values: { t: "object", optional: true }, reset: { t: "list", max: 300, item: 120, optional: true }, reason: { t: "string", max: 300, optional: true }, force: { t: "boolean", optional: true } },
    async preview({ ctx }, a) {
      const changes = changesOf(a)
      const lines = changes.map((c) => `${metaOf(c.path).label} (${c.path}): ${JSON.stringify(valueAt(ctx.options, c.path))} → ${c.reset ? "Standard/opencode.json" : JSON.stringify(c.value)}`)
      return { message: lines.join("\n") }
    },
    async run({ ctx }, run, a) {
      if (!ctx.settings) throw new GuardError("Einstellungen nicht verfügbar")
      const changes = changesOf(a)
      const security = changes.filter((c) => isSecurity(c.path))
      if (security.length && !a.force) {
        throw new ConfirmNeeded(`Sicherheitsrelevant: ${security.map((c) => `${metaOf(c.path).label} (${c.path})`).join(", ")}. Wirklich ändern? Die Änderung steht mit Vorher/Nachher im Audit-Log.`)
      }
      const r = await ctx.settings.change(run, changes, a.reason)
      if (security.length) ctx.audit?.security("settings", `Sicherheitseinstellung geändert: ${r.changed.map((c) => `${c.path} ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`).join("; ")}`, { result: "ok" })
      return { message: r.message, data: r }
    },
  }),
  defineAction({
    name: "inbox.configure",
    label: "Meldungsart im Eingang ein-/ausschalten",
    area: "system",
    smith: "skillsmith",
    args: { type: { t: "string", max: 60 }, mode: { t: "enum", values: ["an", "gebuendelt", "aus", "standard"] } },
    async run({ ctx }, run, a) {
      if (!ctx.settings) throw new GuardError("Einstellungen nicht verfügbar")
      if (!INBOX_KEYS.has(a.type)) throw new GuardError(`Unbekannte Meldungsart „${a.type}“`)
      const types = { ...ctx.options.inbox.types }
      if (a.mode === "standard") delete types[a.type]
      else types[a.type] = a.mode
      // switching all changes resets the per-smith switches (one clear state)
      if (a.type === "change") for (const s of SMITHS) delete types[`change.${s}`]
      const label = INBOX_TYPES.find((t) => t.type === a.type)?.label ?? a.type
      const r = await ctx.settings.change(run, [{ path: "inbox.types", value: types }], `Eingang: ${label} ${a.mode === "aus" ? "ausgeblendet" : a.mode === "gebuendelt" ? "gebündelt" : "angezeigt"}`)
      ctx.bus.emit("inbox.changed", { reason: "configure" })
      return { message: a.mode === "aus" ? `„${label}“ erscheint nicht mehr im Eingang` : a.mode === "gebuendelt" ? `„${label}“ wird gebündelt` : `„${label}“ wird angezeigt`, data: r }
    },
  }),
  defineAction({
    name: "notify.configure",
    label: "Benachrichtigungen einstellen",
    area: "system",
    smith: "skillsmith",
    args: { events: { t: "list", max: 20, item: 30, optional: true }, toast: { t: "boolean", optional: true }, browser: { t: "boolean", optional: true }, macos: { t: "boolean", optional: true } },
    async run({ ctx }, run, a) {
      if (!ctx.settings) throw new GuardError("Einstellungen nicht verfügbar")
      const changes: Array<{ path: string; value: unknown }> = []
      if (a.events) {
        const bad = a.events.filter((e: string) => !(NOTIFY_EVENTS as readonly string[]).includes(e))
        if (bad.length) throw new GuardError(`Unbekannte Ereignisse: ${bad.join(", ")}`)
        changes.push({ path: "notify.events", value: a.events })
      }
      for (const k of ["toast", "browser", "macos"] as const) if (a[k] !== undefined) changes.push({ path: `notify.${k}`, value: a[k] })
      if (!changes.length) throw new GuardError("Keine Änderung")
      const r = await ctx.settings.change(run, changes, "Benachrichtigungen")
      return { message: r.message, data: r }
    },
  }),
  defineAction({
    name: "inbox.dismiss",
    label: "Meldungen als erledigt markieren",
    area: "system",
    smith: "skillsmith",
    local: true,
    args: { ids: { t: "list", max: 1000, item: 300 }, sigs: { t: "list", max: 1000, item: 40, optional: true } },
    async run({ ctx }, _run, a) {
      const n = await dismiss(
        ctx,
        a.ids.map((id: string, i: number) => ({ id, sig: a.sigs?.[i] })),
      )
      ctx.bus.emit("inbox.changed", { reason: "dismiss" })
      return { message: `${n} Meldung(en) erledigt – sie erscheinen wieder, wenn sich etwas ändert` }
    },
  }),
  defineAction({
    name: "job.run",
    label: "Job jetzt ausführen",
    area: "system",
    smith: "skillsmith",
    local: true,
    args: { id: { t: "string", max: 80 }, params: { t: "object", optional: true } },
    async run({ ctx }, _run, a) {
      if (!ctx.jobs) throw new GuardError("Jobs laufen in diesem Prozess nicht")
      const def = ctx.jobs.def(a.id)
      if (!def) throw new GuardError(`Unbekannter Job „${a.id}“`)
      const params = Object.fromEntries(Object.entries((a.params as Record<string, unknown>) ?? {}).map(([k, v]) => [k, String(v)]))
      const t = ctx.jobs.trigger(a.id, "von Hand", params)
      return { message: `„${def.label}“ gestartet`, data: { run: t.id } }
    },
  }),
  defineAction({
    name: "job.abort",
    label: "Job abbrechen",
    area: "system",
    smith: "skillsmith",
    local: true,
    args: { id: { t: "string", max: 80 } },
    async run({ ctx }, _run, a) {
      if (!ctx.jobs?.abort(a.id)) throw new GuardError("Der Job läuft in diesem Prozess nicht")
      return { message: "Abbruch angefordert – der Job hält am nächsten Schritt an" }
    },
  }),
  defineAction({
    name: "job.pause",
    label: "Job pausieren / fortsetzen",
    area: "system",
    smith: "skillsmith",
    local: true,
    args: { id: { t: "string", max: 80 }, paused: { t: "boolean" } },
    async run({ ctx }, _run, a) {
      if (!ctx.jobs) throw new GuardError("Jobs laufen in diesem Prozess nicht")
      await ctx.jobs.pause(a.id, a.paused)
      ctx.bus.emit("job.changed", { job: a.id })
      return { message: a.paused ? "Job pausiert – er läuft nur noch von Hand" : "Job fortgesetzt" }
    },
  }),
  defineAction({
    name: "job.schedule",
    label: "Zeitplan eines Jobs ändern",
    area: "system",
    smith: "skillsmith",
    args: { id: { t: "string", max: 80 }, schedule: { t: "object", optional: true }, reset: { t: "boolean", optional: true } },
    async run({ ctx }, run, a) {
      if (!ctx.settings || !ctx.jobs) throw new GuardError("Jobs laufen in diesem Prozess nicht")
      const def = ctx.jobs.def(a.id)
      if (!def) throw new GuardError(`Unbekannter Job „${a.id}“`)
      // the given schedule replaces what was configured for this job (only differences to the default)
      const jobs = { ...ctx.options.jobs }
      if (a.reset || !a.schedule || !Object.keys(a.schedule as object).length) delete jobs[a.id]
      else jobs[a.id] = { ...(a.schedule as Record<string, unknown>) }
      const r = await ctx.settings.change(run, [{ path: "jobs", value: jobs }], `Zeitplan „${def.label}“`)
      ctx.bus.emit("job.changed", { job: a.id })
      return { message: a.reset ? `Zeitplan von „${def.label}“ auf Standard zurückgesetzt` : `Zeitplan von „${def.label}“ gespeichert`, data: r }
    },
  }),
]
