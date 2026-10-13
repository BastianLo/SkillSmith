/**
 * Document import (5h, idea 98): PDF, Word, PowerPoint, Markdown and text become knowledge.
 *
 *   1. reading (no new runtime dependency): PDF with pdf.js in the browser (the page sends
 *      the text per page), DOCX and PPTX as ZIP with XML, older DOC through macOS textutil,
 *      Markdown and text directly. Scanned PDFs without a text layer are reported (no OCR).
 *   2. extraction (background, live progress over the bus, abort / resume): the assistant
 *      works section by section; every finding carries file, page or slide and the verbatim
 *      quote – a quote that is not in the section is dropped (nothing that is not in the file
 *      becomes a finding). The cross-check (5d) marks unsupported findings (deselected).
 *      A finding similar to an existing entry is offered as "ergänzt Eintrag X".
 *   3. "Übernehmen" writes everything selected in one run with one commit; the original file
 *      is stored next to it as attachment (up to import.storeMaxMB, else only locally).
 */
import { execFile } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inflateRawSync } from "node:zlib"
import type { Kind, Run } from "../types"
import { ensureDir, listDirs, readJson, removePath, writeBufferAtomic, writeJsonAtomic } from "../util/fs"
import { fold, nowIso, shortId, slugify, truncate } from "../util/text"
import { askAssistant } from "./assistant"
import type { Ctx } from "./context"
import { GuardError } from "./ops"

export interface Page {
  n: number
  /** "Seite" (pdf, doc chunks), "Folie" (pptx), "Abschnitt" (md, txt, docx without page breaks) */
  label: string
  text: string
}

export const FINDING_TYPES = ["wissen", "begriff", "anforderung", "entscheidung", "ablauf", "offen"] as const
export type FindingType = (typeof FINDING_TYPES)[number]

export const FINDING_LABEL: Record<FindingType, string> = {
  wissen: "Wissenseintrag",
  begriff: "Glossar-Kandidat",
  anforderung: "Vorgabe",
  entscheidung: "Entscheidung (vorgeschlagen)",
  ablauf: "Runbook-/Skill-Kandidat",
  offen: "Aufgaben-Vorschlag",
}

export interface Finding {
  index: number
  type: FindingType
  title: string
  text: string
  quote: string
  page: number
  /** cross-check: gestuetzt / nicht_gestuetzt / widersprochen (or undefined: not checked) */
  verdict?: string
  verdictReason?: string
  /** similar existing entry ("ergänzt Eintrag X") */
  similar?: { id: string; title: string; score: number }
  selected: boolean
}

export interface ImportJob {
  id: string
  file: string
  ext: string
  size: number
  createdAt: string
  status: "bereit" | "laeuft" | "angehalten" | "fertig" | "fehler" | "uebernommen"
  pages: Page[]
  /** sections (page ranges) of the extraction */
  sections: Array<{ from: number; to: number; done: boolean }>
  findings: Finding[]
  error?: string
  /** earlier import of a file with the same name */
  previous?: string
  /** the result of "Übernehmen" */
  applied?: { at: string; commit?: string; entries: string[] }
  ai: string
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

/** Entries of a ZIP archive (central directory; stored and deflated). */
export function unzip(data: Uint8Array): Map<string, Uint8Array> {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const out = new Map<string, Uint8Array>()
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new GuardError("keine gültige ZIP-Datei (DOCX/PPTX)")
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  for (let k = 0; k < count && p + 46 <= buf.length; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20)
    const nlen = buf.readUInt16LE(p + 28)
    const elen = buf.readUInt16LE(p + 30)
    const clen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8")
    p += 46 + nlen + elen + clen
    if (buf.readUInt32LE(local) !== 0x04034b50) continue
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(start, start + csize)
    if (method === 0) out.set(name, raw)
    else if (method === 8) out.set(name, inflateRawSync(raw))
  }
  return out
}

const xmlText = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, "&")

/** Split long text into sections of about `size` characters at paragraph borders. */
export function chunk(text: string, size: number, label = "Abschnitt"): Page[] {
  const paras = text.split(/\n{2,}/)
  const pages: Page[] = []
  let cur = ""
  for (const p of paras) {
    if (cur && cur.length + p.length > size) {
      pages.push({ n: pages.length + 1, label, text: cur.trim() })
      cur = ""
    }
    cur += `${p}\n\n`
  }
  if (cur.trim()) pages.push({ n: pages.length + 1, label, text: cur.trim() })
  return pages
}

export function docxPages(data: Uint8Array, size: number): Page[] {
  const xml = new TextDecoder().decode(unzip(data).get("word/document.xml") ?? new Uint8Array())
  if (!xml) throw new GuardError("word/document.xml fehlt")
  const pages: string[][] = [[]]
  let breaks = 0
  for (const m of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const p = m[0]
    if (/<w:br [^>]*w:type="page"|<w:lastRenderedPageBreak\/>/.test(p) && pages[pages.length - 1].length) {
      pages.push([])
      breaks++
    }
    const text = [...p.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>/g)].map((t) => (t[1] !== undefined ? xmlText(t[1]) : "\t")).join("")
    if (!text.trim()) continue
    const style = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] ?? ""
    const lvl = /^(?:Heading|berschrift|Überschrift)(\d)/i.exec(style.replace(/^.*?(Heading|berschrift)/i, "$1"))?.[1]
    pages[pages.length - 1].push(lvl ? `${"#".repeat(Math.min(6, Number(lvl)))} ${text}` : /<w:numPr>/.test(p) ? `- ${text}` : text)
  }
  if (breaks) return pages.filter((p) => p.length).map((p, i) => ({ n: i + 1, label: "Seite", text: p.join("\n\n") }))
  return chunk(pages.flat().join("\n\n"), size)
}

export function pptxPages(data: Uint8Array): Page[] {
  const files = unzip(data)
  const slides = [...files.keys()]
    .map((k) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(k))
    .filter((m): m is RegExpExecArray => !!m)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
  return slides.map((m, i) => {
    const xml = new TextDecoder().decode(files.get(m[0])!)
    const paras = [...xml.matchAll(/<a:p>[\s\S]*?<\/a:p>/g)].map((p) => [...p[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => xmlText(t[1])).join("")).filter((t) => t.trim())
    const notesFile = files.get(`ppt/notesSlides/notesSlide${m[1]}.xml`)
    const notes = notesFile ? [...new TextDecoder().decode(notesFile).matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => xmlText(t[1])).join(" ").trim() : ""
    return { n: i + 1, label: "Folie", text: [...paras, ...(notes ? [`Notizen: ${notes}`] : [])].join("\n") }
  })
}

/** Markdown: sections by headings (level 1–2), long ones split. */
export function markdownPages(text: string, size: number): Page[] {
  const parts = text.split(/\n(?=#{1,2} )/)
  const out: Page[] = []
  for (const p of parts) for (const c of chunk(p, size)) out.push({ ...c, n: out.length + 1 })
  return out
}

function textutil(data: Uint8Array, ext: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.platform !== "darwin") return reject(new GuardError("Ältere .doc-Dateien lassen sich nur auf macOS (textutil) lesen – bitte als .docx speichern"))
    const dir = mkdtempSync(join(tmpdir(), "import-doc-"))
    const f = join(dir, `in${ext}`)
    writeFileSync(f, data)
    execFile("/usr/bin/textutil", ["-convert", "txt", "-stdout", f], { timeout: 60_000, maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
      rmSync(dir, { recursive: true, force: true })
      if (err) reject(new GuardError(`textutil: ${String(err.message)}`))
      else resolve(String(stdout))
    })
  })
}

export const IMPORT_TYPES = [".pdf", ".docx", ".doc", ".pptx", ".md", ".markdown", ".txt"]

/** Pages of a file. PDF: `data` is the JSON the page built with pdf.js ({pages: [{n, text}]}). */
export async function readPages(name: string, data: Uint8Array, size = 6000): Promise<Page[]> {
  const ext = (/\.[^.]+$/.exec(name.toLowerCase())?.[0] ?? "") as string
  if (!IMPORT_TYPES.includes(ext)) throw new GuardError(`Dateityp ${ext || "?"} nicht unterstützt (${IMPORT_TYPES.join(" ")})`)
  if (ext === ".pdf") {
    let j: { pages?: Array<{ n?: number; text?: string }> }
    try {
      j = JSON.parse(new TextDecoder().decode(data))
    } catch {
      throw new GuardError("PDF: der Text wird im Browser mit pdf.js gelesen – die Seite hat keinen Text gesendet")
    }
    const pages = (j.pages ?? []).map((p, i) => ({ n: Number(p.n) || i + 1, label: "Seite", text: String(p.text ?? "").replace(/[ \t]+\n/g, "\n").trim() }))
    if (!pages.length || pages.every((p) => p.text.length < 20)) throw new GuardError("Das PDF hat keine Textebene (gescannt?) – Texterkennung (OCR) gehört nicht zum Umfang")
    return pages
  }
  if (ext === ".docx") return docxPages(data, size)
  if (ext === ".pptx") return pptxPages(data)
  if (ext === ".doc") return chunk(await textutil(data, ext), size, "Seite")
  const text = new TextDecoder().decode(data)
  return ext === ".txt" ? chunk(text, size) : markdownPages(text, size)
}

// ---------------------------------------------------------------------------
// extraction
// ---------------------------------------------------------------------------

const norm = (s: string) => fold(s).replace(/[^a-z0-9]+/g, " ").trim()

export function extractionPrompt(file: string, pages: Page[]): string {
  return [
    `Lies den folgenden Ausschnitt aus der Datei „${file}“ und ziehe heraus, was als Wissen festgehalten werden sollte.`,
    "Arten: wissen (fachliche Abschnitte), begriff (Begriffe und Abkürzungen mit Bedeutung), anforderung (Anforderungen und Regeln), entscheidung (getroffene Entscheidungen), ablauf (Abläufe und Schrittfolgen), offen (offene Punkte, Aufgaben).",
    "Jeder Fund braucht ein wörtliches Zitat aus dem Ausschnitt (quote, 20–300 Zeichen, exakt kopiert) und die Seite/Folie (page). Schreibe nichts, was nicht im Text steht.",
    'Antworte nur mit JSON: ```json\n[{"type": "wissen", "title": "kurz", "text": "Inhalt in Markdown", "quote": "wörtlich", "page": 3}]\n```',
    "",
    ...pages.map((p) => `## ${p.label} ${p.n}\n${p.text}`),
  ].join("\n")
}

/** Parse and validate the findings of one section: the quote must be in the section text. */
export function parseFindings(answer: string, pages: Page[], start: number): Finding[] {
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(answer) ?? /(\[[\s\S]*\])/.exec(answer)
  if (!m) return []
  let raw: unknown
  try {
    raw = JSON.parse(m[1])
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: Finding[] = []
  for (const r of raw as Array<Record<string, unknown>>) {
    const type = String(r.type ?? "") as FindingType
    if (!(FINDING_TYPES as readonly string[]).includes(type)) continue
    const quote = String(r.quote ?? "").trim()
    const q = norm(quote)
    if (q.length < 12) continue
    // the page the quote is on (the model's page number is only a hint)
    const page = pages.find((p) => norm(p.text).includes(q))
    if (!page) continue
    out.push({ index: start + out.length, type, title: truncate(String(r.title ?? "").replace(/\s+/g, " ").trim() || quote.slice(0, 60), 120), text: truncate(String(r.text ?? quote).trim(), 6000), quote: truncate(quote, 300), page: page.n, selected: true })
  }
  return out
}

export class Importer {
  private running = new Map<string, { abort: boolean }>()

  constructor(private ctx: Ctx) {}

  private get dir(): string {
    return join(this.ctx.store.stateDir, "imports")
  }

  private file(id: string): string {
    return join(this.dir, id, "import.json")
  }

  get(id: string): ImportJob | undefined {
    if (!/^im-[\w-]+$/.test(id)) return undefined
    return readJson<ImportJob | null>(this.file(id), null) ?? undefined
  }

  list(): ImportJob[] {
    return listDirs(this.dir)
      .map((d) => this.get(d))
      .filter((j): j is ImportJob => !!j)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  private save(j: ImportJob): void {
    writeJsonAtomic(this.file(j.id), j)
  }

  private emit(j: ImportJob, extra: Record<string, unknown> = {}): void {
    this.ctx.bus?.emit("import.progress", { id: j.id, status: j.status, done: j.sections.filter((s) => s.done).length, total: j.sections.length, findings: j.findings.length, ...extra })
  }

  /** Read a file and create an import (status bereit); the original is kept locally. */
  async create(name: string, data: Uint8Array, ai?: string): Promise<ImportJob> {
    const o = this.ctx.options.import
    if (data.length > o.maxMB * 1024 * 1024) throw new GuardError(`Datei größer als ${o.maxMB} MB (import.maxMB)`)
    const pages = (await readPages(name, data, o.chunkChars)).map((p) => ({ ...p, text: this.ctx.redactor.redact(p.text) }))
    if (!pages.some((p) => p.text.trim())) throw new GuardError("Die Datei enthält keinen lesbaren Text")
    const ext = /\.[^.]+$/.exec(name.toLowerCase())?.[0] ?? ""
    const id = `im-${nowIso().slice(0, 10).replace(/-/g, "")}-${slugify(name.replace(/\.[^.]+$/, ""), 30) || "datei"}-${shortId(4)}`
    // sections of about chunkChars characters (consecutive pages)
    const sections: ImportJob["sections"] = []
    let from = 0
    let len = 0
    pages.forEach((p, i) => {
      if (len && len + p.text.length > o.chunkChars) {
        sections.push({ from, to: i - 1, done: false })
        from = i
        len = 0
      }
      len += p.text.length
    })
    sections.push({ from, to: pages.length - 1, done: false })
    const previous = this.list().find((x) => x.file === name)?.id
    const job: ImportJob = { id, file: name, ext, size: data.length, createdAt: nowIso(), status: "bereit", pages, sections, findings: [], ai: ai || o.defaultAi, ...(previous ? { previous } : {}) }
    ensureDir(join(this.dir, id))
    // the original stays local until "Übernehmen" (PDF: the text the page sent)
    writeBufferAtomic(join(this.dir, id, `original${ext}`), data)
    this.save(job)
    return job
  }

  /** Start or resume the extraction in the background. */
  start(id: string): ImportJob {
    const j = this.get(id)
    if (!j) throw new GuardError("Import nicht gefunden")
    if (j.status === "uebernommen") throw new GuardError("Import ist schon übernommen")
    if (this.running.has(id)) return j
    const flag = { abort: false }
    this.running.set(id, flag)
    j.status = "laeuft"
    j.error = undefined
    this.save(j)
    this.emit(j)
    void this.work(id, flag).finally(() => this.running.delete(id))
    return j
  }

  stop(id: string): void {
    const f = this.running.get(id)
    if (f) f.abort = true
  }

  /** Waits for a running extraction (tests, CLI). */
  async wait(id: string, timeoutMs = 600_000): Promise<ImportJob | undefined> {
    const t0 = Date.now()
    while (this.running.has(id) && Date.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 50))
    return this.get(id)
  }

  private async work(id: string, flag: { abort: boolean }): Promise<void> {
    let j = this.get(id)!
    try {
      for (let k = 0; k < j.sections.length; k++) {
        if (flag.abort) {
          j.status = "angehalten"
          this.save(j)
          this.emit(j)
          return
        }
        const s = j.sections[k]
        if (s.done) continue
        const pages = j.pages.slice(s.from, s.to + 1)
        const answer = await askAssistant(this.ctx, extractionPrompt(j.file, pages), `Import ${j.file} ${k + 1}/${j.sections.length}`)
        const found = parseFindings(answer, pages, j.findings.length)
        for (const f of found) await this.enrich(j, f)
        j = this.get(id) ?? j
        j.findings.push(...found)
        j.sections[k].done = true
        this.save(j)
        this.emit(j, { section: k + 1 })
      }
      j.status = "fertig"
      this.save(j)
      this.emit(j)
    } catch (err) {
      j.status = "fehler"
      j.error = truncate(String(err instanceof Error ? err.message : err), 500)
      this.save(j)
      this.emit(j)
    }
  }

  /** Similar existing entry and cross-check of one finding. */
  private async enrich(j: ImportJob, f: Finding): Promise<void> {
    const kinds: Kind[] = f.type === "begriff" ? ["glossary"] : f.type === "anforderung" || f.type === "entscheidung" ? ["memory"] : f.type === "ablauf" ? ["skill", "knowledge"] : f.type === "offen" ? ["task"] : ["knowledge"]
    const hits = await this.ctx.retriever.search(`${f.title} ${f.text}`, { kinds, tiers: ["active"], limit: 1, includeForeign: false }).catch(() => [])
    const h = hits[0]
    if (h && Math.max(h.confidence, h.similarity ?? 0) >= 0.6) f.similar = { id: `${h.kind}:${h.name}`, title: h.title, score: Math.round(Math.max(h.confidence, h.similarity ?? 0) * 100) / 100 }
    const cc = this.ctx.crosscheck
    if (cc && this.ctx.options.import.crosscheck && this.ctx.options.crosscheck.model) {
      const run = { smith: "docsmith", model: undefined, userText: "", haystack: j.pages.find((p) => p.n === f.page)?.text ?? "" } as unknown as Run
      const r = await cc.check(run, "knowledge", j.file, [{ index: 0, text: f.text, sources: [{ type: "file", ref: `${j.file}#${f.page}`, quote: f.quote, at: nowIso() }] }]).catch(() => undefined)
      const v = r?.verdicts[0]
      if (v) {
        f.verdict = v.verdict
        f.verdictReason = v.reason
        if (v.verdict !== "gestuetzt") f.selected = false
      }
    }
  }

  /** Changed pages against the previous import of the same file and the entries it produced. */
  changes(id: string): { previous?: string; changed: number[]; entries: string[] } {
    const j = this.get(id)
    const p = j?.previous ? this.get(j.previous) : undefined
    if (!j || !p) return { changed: [], entries: [] }
    const changed = j.pages.filter((x) => norm(p.pages.find((y) => y.n === x.n)?.text ?? "") !== norm(x.text)).map((x) => x.n)
    return { previous: p.id, changed, entries: p.applied?.entries ?? [] }
  }

  /** Apply the selected findings in one run (one commit). */
  async apply(run: Run, id: string, edits: Array<{ index: number; selected?: boolean; title?: string; text?: string; type?: FindingType; target?: string }>): Promise<{ entries: string[]; message: string }> {
    const j = this.get(id)
    if (!j) throw new GuardError("Import nicht gefunden")
    if (j.status === "uebernommen") throw new GuardError("schon übernommen")
    if (this.running.has(id)) throw new GuardError("Die Extraktion läuft noch – anhalten oder abwarten")
    const findings = j.findings.map((f) => {
      const e = edits.find((x) => x.index === f.index)
      return { ...f, ...(e ? { selected: e.selected ?? f.selected, title: e.title ?? f.title, text: e.text ?? f.text, type: e.type ?? f.type, target: e.target } : {}) } as Finding & { target?: string }
    })
    const chosen = findings.filter((f) => f.selected)
    if (!chosen.length) throw new GuardError("nichts ausgewählt")
    const o = this.ctx.options.import
    const folder = `import/${slugify(j.file.replace(/\.[^.]+$/, ""), 60) || "datei"}`
    const label = (f: Finding) => `${j.pages.find((p) => p.n === f.page)?.label ?? "Seite"} ${f.page}`
    const entries: string[] = []
    // the original next to the entries (attachment) when small enough
    let attachment: string | undefined
    const original = join(this.dir, id, `original${j.ext}`)
    const size = (() => {
      try {
        return readFileSync(original).length
      } catch {
        return 0
      }
    })()
    if (size && size <= o.storeMaxMB * 1024 * 1024 && j.ext !== ".pdf") {
      attachment = `knowledge/_anhaenge/${nowIso().slice(0, 7)}/${slugify(j.file.replace(/\.[^.]+$/, ""), 50) || "import"}-${shortId(4)}${j.ext}`
      await this.ctx.store.writeAttachment(run, attachment, readFileSync(original))
    }
    const sourceLine = (f: Finding) => `\n\n_Quelle: ${j.file}, ${label(f)}${attachment ? ` · [Original](anhang:${attachment.replace(/^knowledge\/_anhaenge\//, "")})` : ""}_`
    const addSource = async (kind: Kind, name: string, f: Finding, paragraph: string) => {
      await this.ctx.ops.addSource(run, kind, name, { paragraph, type: "file", ref: `${j.file}#${label(f)}`, quote: f.quote }).catch(() => undefined)
    }
    const scope = (() => {
      try {
        return this.ctx.scope()
      } catch {
        return undefined
      }
    })()
    for (const f of chosen as Array<Finding & { target?: string }>) {
      const target = f.target
      const firstPara = f.text.split(/\n{2,}/)[0]
      if (target) {
        // "ergänzt Eintrag X": a section is appended to the existing entry
        const i = target.indexOf(":")
        const kind = target.slice(0, i) as Kind
        const name = target.slice(i + 1)
        const e = this.ctx.store.getOwned(kind, name)
        if (!e) throw new GuardError(`${target} nicht gefunden`)
        await this.ctx.ops.update(run, kind, { name, body: `${e.body.trim()}\n\n## ${f.title} (aus ${j.file})\n${f.text}${sourceLine(f)}`, reason: `ergänzt aus ${j.file}, ${label(f)}` })
        await addSource(kind, name, f, firstPara)
        entries.push(target)
        continue
      }
      if (f.type === "wissen" || f.type === "ablauf") {
        const { createDocument } = await import("./actions/docs")
        const name = await createDocument(this.ctx, run, { title: f.title, folder, body: `${f.text}${sourceLine(f)}`, description: truncate(f.text.replace(/\s+/g, " "), 200), tags: ["import", ...(f.type === "ablauf" ? ["runbook"] : [])], ai: j.ai })
        await addSource("knowledge", name, f, firstPara)
        entries.push(`knowledge:${name}`)
        if (f.type === "ablauf") await this.ctx.ops.note(run, "skill", { summary: `Ablauf aus ${j.file}: ${f.title}`, keywords: ["import", ...f.title.toLowerCase().split(/\s+/).slice(0, 4)], internal: true }).catch(() => undefined)
      } else if (f.type === "begriff") {
        await this.ctx.ops.note(run, "glossary", { summary: `${f.title}: ${truncate(f.text.replace(/\s+/g, " "), 200)} (${j.file}, ${label(f)})`, keywords: [f.title.split(/[\s:–-]/)[0]], internal: true })
        entries.push(`candidate:glossary:${f.title}`)
      } else if (f.type === "anforderung" || f.type === "entscheidung") {
        if (!scope) throw new GuardError("kein Projekt-Kontext für Erinnerungen")
        const msg = await this.ctx.ops.memorySave(run, { type: f.type === "anforderung" ? "vorgabe" : "entscheidung", scope: "projekt", topic: f.title, title: f.title, summary: truncate(f.text.replace(/\s+/g, " "), 280), body: `${f.text}${sourceLine(f)}`, tags: ["import"], where: scope, reason: `aus ${j.file}, ${label(f)}`, approved: true, ...(f.type === "entscheidung" ? { status: "vorgeschlagen" } : {}) } as any)
        const mid = /memory id: (memory:[^\s]+)/.exec(msg)?.[1]
        if (mid) {
          await addSource("memory", mid.slice(7), f, firstPara)
          entries.push(mid)
        }
      } else if (f.type === "offen") {
        const t = await this.ctx.tasks.create(run, { title: f.title, body: `${f.text}${sourceLine(f)}`, suggested: true, ...(scope ? {} : {}) } as any)
        entries.push(`task:${(t as any)?.name ?? ""}`)
      }
    }
    j.status = "uebernommen"
    j.applied = { at: nowIso(), entries }
    j.findings = findings
    this.save(j)
    if (!o.keepOriginal) removePath(original)
    return { entries, message: `${chosen.length} Fund/Funde übernommen${attachment ? " (Original als Anhang)" : ""}` }
  }

  remove(id: string): void {
    this.stop(id)
    if (this.get(id)) removePath(join(this.dir, id))
  }
}
