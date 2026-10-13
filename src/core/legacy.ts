/**
 * Records written by skillsmith v1 (skills only) that are still read today: the run journal
 * (state/journal.jsonl) and the shadow log. v1 had no `target` (every entry was a skill),
 * named the entry `skill` instead of `name` and wrote no `smith`.
 */

export interface JournalAction {
  kind: string
  target: string
  name: string
  reason?: string
  detail?: string
  applied?: boolean
  local?: boolean
  stagedId?: string
  [key: string]: unknown
}

/** One journal action in today's shape (v1: {kind, skill} → {kind, target: "skill", name}). */
export function journalAction(a: any): JournalAction {
  const name = [a?.name, a?.skill, a?.entry].find((x) => typeof x === "string" && x) ?? ""
  const target = typeof a?.target === "string" && a.target ? a.target : "skill"
  return { ...a, kind: String(a?.kind ?? ""), target, name }
}

/** Id of an action ("skill:deploy"), the plain name for local data, undefined when v1 left no name. */
export function journalTarget(a: JournalAction): string | undefined {
  if (!a.name) return undefined
  return a.local ? a.name : `${a.target}:${a.name}`
}

/** One journal line in today's shape (v1 lines have no smith). */
export function journalLine(j: any): any {
  return { ...j, smith: j?.smith ?? "skillsmith", actions: Array.isArray(j?.actions) ? j.actions.map(journalAction) : [] }
}

/** One shadow-log line in today's shape. */
export function shadowLine(s: any): any {
  const a = journalAction({ ...s, kind: s?.kind })
  return { ...s, smith: s?.smith ?? "skillsmith", target: a.target, name: a.name, action: s?.action ?? s?.kind }
}
