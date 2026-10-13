/**
 * Minimal cron expressions (5 fields: minute hour day-of-month month day-of-week, local time)
 * for the job schedules. Supports `*`, lists `1,2`, ranges `1-5`, steps `*\/15`, `8-18/2`;
 * day of week 0–7 (0 and 7 = Sunday). Day-of-month and day-of-week combine like Vixie cron:
 * when both are restricted, either may match.
 */

export interface Cron {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  domAny: boolean
  dowAny: boolean
  source: string
}

const FIELDS: Array<[string, number, number]> = [
  ["Minute", 0, 59],
  ["Stunde", 0, 23],
  ["Tag", 1, 31],
  ["Monat", 1, 12],
  ["Wochentag", 0, 7],
]

function field(raw: string, [label, min, max]: [string, number, number]): Set<number> {
  const out = new Set<number>()
  for (const part of raw.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part.trim())
    if (!m) throw new Error(`${label}: „${part}“ ist kein gültiger Wert`)
    const step = m[4] ? Number(m[4]) : 1
    if (step < 1) throw new Error(`${label}: Schrittweite muss ≥ 1 sein`)
    let from = min
    let to = max
    if (m[1] !== "*") {
      from = Number(m[2])
      to = m[3] !== undefined ? Number(m[3]) : m[4] ? max : from
    }
    if (from < min || to > max || from > to) throw new Error(`${label}: ${part} liegt außerhalb von ${min}–${max}`)
    for (let v = from; v <= to; v += step) out.add(v)
  }
  return out
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error("Cron braucht 5 Felder: Minute Stunde Tag Monat Wochentag")
  const [minute, hour, dom, month, dow] = parts.map((p, i) => field(p, FIELDS[i]))
  if (dow.has(7)) dow.add(0)
  return { minute, hour, dom, month, dow, domAny: parts[2] === "*", dowAny: parts[4] === "*", source: expr.trim() }
}

function matchesDay(c: Cron, d: Date): boolean {
  const domOk = c.dom.has(d.getDate())
  const dowOk = c.dow.has(d.getDay())
  if (c.domAny && c.dowAny) return true
  if (c.domAny) return dowOk
  if (c.dowAny) return domOk
  return domOk || dowOk
}

export function cronMatches(c: Cron, d: Date): boolean {
  return c.minute.has(d.getMinutes()) && c.hour.has(d.getHours()) && c.month.has(d.getMonth() + 1) && matchesDay(c, d)
}

/** First matching minute strictly after `from` (searches up to ~366 days). */
export function cronNext(c: Cron, from: Date): Date | undefined {
  const d = new Date(from.getTime())
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  const limit = from.getTime() + 367 * 86_400_000
  while (d.getTime() <= limit) {
    if (!c.month.has(d.getMonth() + 1) || !matchesDay(c, d)) {
      d.setDate(d.getDate() + 1)
      d.setHours(0, 0, 0, 0)
      continue
    }
    if (!c.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0)
      continue
    }
    if (c.minute.has(d.getMinutes())) return d
    d.setMinutes(d.getMinutes() + 1)
  }
  return undefined
}

/** Last matching minute at or before `at` (searches back up to ~366 days). */
export function cronPrev(c: Cron, at: Date): Date | undefined {
  const d = new Date(at.getTime())
  d.setSeconds(0, 0)
  const limit = at.getTime() - 367 * 86_400_000
  while (d.getTime() >= limit) {
    if (!c.month.has(d.getMonth() + 1) || !matchesDay(c, d)) {
      d.setHours(0, 0, 0, 0)
      d.setMinutes(-1)
      continue
    }
    if (!c.hour.has(d.getHours())) {
      d.setMinutes(0, 0, 0)
      d.setMinutes(-1)
      continue
    }
    if (c.minute.has(d.getMinutes())) return d
    d.setMinutes(d.getMinutes() - 1)
  }
  return undefined
}

/** Validator for options: throws with a readable German message. */
export function checkCron(expr: string): string {
  parseCron(expr)
  return expr.trim()
}
