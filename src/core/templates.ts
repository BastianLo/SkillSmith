/**
 * Document templates: built-in ones (How-to, Runbook, Troubleshooting, ADR, meeting,
 * onboarding, daily note) plus the user's own templates – documents in the folder
 * "_vorlagen". Placeholders: {{titel}}, {{datum}}, {{projekt}}, {{branch}}.
 */
import type { Ctx } from "./context"

export interface Template {
  id: string
  title: string
  description: string
  body: string
  own?: boolean
}

export const TEMPLATE_FOLDER = "_vorlagen"

const BUILTIN: Template[] = [
  {
    id: "howto",
    title: "How-to",
    description: "Schritt-für-Schritt-Anleitung für eine wiederkehrende Aufgabe",
    body: "## Ziel\n\n## Voraussetzungen\n\n- \n\n## Schritte\n\n1. \n2. \n3. \n\n## Prüfen\n\n## Siehe auch\n\n",
  },
  {
    id: "runbook",
    title: "Runbook",
    description: "Betrieb: Start, Stopp, Überwachung, typische Störungen",
    body: "## Zweck\n\n## Zuständig\n\n## Normalbetrieb\n\n## Überwachung\n\n## Störungen\n\n### Symptom\n\n### Maßnahme\n\n## Eskalation\n\n",
  },
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    description: "Fehlerbild, Ursache, Lösung",
    body: "## Symptom\n\n```\n\n```\n\n## Ursache\n\n## Lösung\n\n## Vorbeugen\n\n",
  },
  {
    id: "adr",
    title: "Entscheidung (ADR)",
    description: "Architekturentscheidung mit Kontext, Optionen und Folgen",
    body: "## Status\n\nvorgeschlagen · {{datum}}\n\n## Kontext\n\n## Entscheidung\n\n## Alternativen\n\n- \n\n## Folgen\n\n",
  },
  {
    id: "besprechung",
    title: "Besprechung",
    description: "Notizen einer Besprechung mit Beschlüssen und Aufgaben",
    body: "**Datum:** {{datum}}  \n**Teilnehmende:** \n\n## Themen\n\n## Beschlüsse\n\n- \n\n## Aufgaben\n\n- [ ] \n",
  },
  {
    id: "onboarding",
    title: "Onboarding",
    description: "Einstieg in ein System oder Projekt",
    body: "## Überblick\n\n## Zugänge\n\n- [ ] \n\n## Lokale Einrichtung\n\n## Wichtige Begriffe\n\n## Ansprechpartner\n\n## Erste Aufgaben\n\n",
  },
  {
    id: "tagesnotiz",
    title: "Tagesnotiz",
    description: "Ein Dokument pro Tag mit Standup-Entwurf",
    body: "## Notizen\n\n",
  },
]

export function templates(ctx: Ctx): Template[] {
  const own = ctx.store
    .list("knowledge")
    .filter((e) => e.folder === TEMPLATE_FOLDER || e.folder?.startsWith(`${TEMPLATE_FOLDER}/`))
    .map((e) => ({ id: `knowledge:${e.name}`, title: e.title, description: e.description || "eigene Vorlage", body: e.body, own: true }))
  return [...BUILTIN, ...own]
}

export function fillTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => vars[k.toLowerCase()] ?? m)
}

export function templateById(ctx: Ctx, id: string): Template | undefined {
  return templates(ctx).find((t) => t.id === id)
}
