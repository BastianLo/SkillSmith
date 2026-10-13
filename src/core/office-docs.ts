/**
 * Office documents in the store (kind "office"): office/<tier>/<name>/OFFICE.md + the file.
 *
 *   OFFICE.md   frontmatter (format, file, sha, size, pages, template, KI-Recht) and the text
 *               of the file as Markdown – search, embeddings, links and the graph use it
 *   <file>      .pptx / .docx / .potx / .dotx, versioned in git like every entry
 *
 * Changes:
 *   upload / create (blank or from a template) / save from the editor in the browser /
 *   restore a version   → one run of the user, one commit
 *   AI by prompt        → a draft in state/office/<name>/ (never committed): the AI plans
 *                         operations, the plugin applies them step by step and publishes every
 *                         step on the bus (office.draft) – the web view reloads the preview.
 *                         "Übernehmen" writes the draft as a new version (one commit);
 *                         KI-Recht lesen/privat: no AI edits at all.
 */
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { join } from "node:path"
import type { ActionKind, Entry, Run } from "../types"
import { exists, readJson, removePath, writeBufferAtomic, writeJsonAtomic, ensureDir } from "../util/fs"
import { nowIso, slugify, truncate } from "../util/text"
import { readFileSync } from "node:fs"
import { askAssistant } from "./assistant"
import type { Ctx } from "./context"
import { aiAccessOf } from "./kinds"
import { GuardError } from "./ops"
import { HASH_RE } from "./versions"
import {
  applyOps,
  blank,
  editPrompt,
  familyOf,
  FORMAT_LABEL,
  fromTemplate,
  inspect,
  isTemplateFormat,
  OFFICE_FORMATS,
  parsePlan,
  retype,
  sniffFormat,
  type OfficeFamily,
  type OfficeFormat,
} from "./office"
import { str } from "./frontmatter"

export interface DraftStep {
  at: string
  prompt: string
  summary: string
  done: string[]
  errors: string[]
}

export interface OfficeDraft {
  name: string
  format: OfficeFormat
  /** version of the entry the draft started from */
  baseVersion: string
  createdAt: string
  updatedAt: string
  /** bumped on every applied step (the web view reloads the preview) */
  rev: number
  status: "bereit" | "laeuft" | "fehler"
  steps: DraftStep[]
  current?: { prompt: string; index: number; total: number; label: string; phase: "plant" | "aendert" }
  error?: string
}

const shaOf = (b: Uint8Array) => createHash("sha256").update(b).digest("hex").slice(0, 16)

export class OfficeDocs {
  private running = new Set<string>()

  constructor(private ctx: Ctx) {}

  // ---------------------------------------------------------------------------
  // files
  // ---------------------------------------------------------------------------

  entry(name: string): Entry {
    const e = this.ctx.store.getOwned("office", name)
    if (!e) throw new GuardError(`Office-Dokument „${name}“ nicht gefunden`)
    return e
  }

  formatOf(e: Entry): OfficeFormat {
    const f = str(e.fields.format) as OfficeFormat
    if (!OFFICE_FORMATS.includes(f)) throw new GuardError(`${e.name}: unbekanntes Format ${f || "?"}`)
    return f
  }

  fileOf(e: Entry): string {
    const f = str(e.fields.file)
    if (!/^[a-z0-9][a-z0-9._-]*\.(pptx|docx|potx|dotx)$/.test(f)) throw new GuardError(`${e.name}: Datei fehlt`)
    return join(e.dir, f)
  }

  bytes(e: Entry): Uint8Array {
    return new Uint8Array(readFileSync(this.fileOf(e)))
  }

  /** The file at an older commit (any tier). */
  async bytesAt(e: Entry, hash: string): Promise<Uint8Array> {
    if (!HASH_RE.test(hash)) throw new GuardError("ungültiger Commit")
    await this.ctx.git.init()
    const bin = this.ctx.git.bin
    if (!bin) throw new GuardError("git ist nicht verfügbar")
    const file = str(e.fields.file)
    for (const tier of ["active", "archive"]) {
      const data = await new Promise<Buffer | undefined>((resolve) =>
        execFile(bin, ["show", `${hash}:office/${tier}/${e.name}/${file}`], { cwd: this.ctx.store.root, encoding: "buffer", maxBuffer: 600 * 1024 * 1024 }, (err, out) => resolve(err ? undefined : (out as Buffer))),
      )
      if (data?.length) return new Uint8Array(data)
    }
    throw new GuardError(`Version ${hash.slice(0, 8)} enthält ${e.name} nicht`)
  }

  /** Templates (.potx/.dotx) of a family. */
  templates(family?: OfficeFamily): Entry[] {
    return this.ctx.store.list("office").filter((e) => e.tier === "active" && isTemplateFormat(str(e.fields.format) as OfficeFormat) && (!family || familyOf(str(e.fields.format) as OfficeFormat) === family))
  }

  private checkSize(n: number): void {
    const max = this.ctx.options.office.maxMB
    if (n > max * 1024 * 1024) throw new GuardError(`Datei größer als ${max} MB (office.maxMB)`)
  }

  /** Fields and text of a file (the text is redacted, secrets are refused by Ops). */
  private async describe(format: OfficeFormat, bytes: Uint8Array): Promise<{ fields: Record<string, unknown>; body: string }> {
    const info = await inspect(format, bytes)
    return {
      fields: { format, sha: shaOf(bytes), size: bytes.length, pages: info.pages },
      body: this.ctx.redactor.redact(info.text),
    }
  }

  private uniqueName(title: string): string {
    const base = slugify(title, 60) || `dokument-${Date.now().toString(36)}`
    let name = base
    for (let i = 2; this.ctx.store.fresh("office", name); i++) name = `${base.slice(0, 57)}-${i}`
    return name
  }

  // ---------------------------------------------------------------------------
  // writes (one run each)
  // ---------------------------------------------------------------------------

  async upload(run: Run, a: { fileName: string; bytes: Uint8Array; title?: string; description?: string; tags?: string[]; ai?: string }): Promise<Entry> {
    this.checkSize(a.bytes.length)
    const format = sniffFormat(a.bytes)
    if (!format) throw new GuardError("Keine PowerPoint- oder Word-Datei (.pptx, .potx, .docx, .dotx; Makro-Dateien werden nicht angenommen)")
    const ext = /\.([a-z]+)$/i.exec(a.fileName)?.[1]?.toLowerCase()
    if (ext && OFFICE_FORMATS.includes(ext as OfficeFormat) && familyOf(ext as OfficeFormat) !== familyOf(format)) throw new GuardError(`Endung .${ext} passt nicht zum Inhalt (${FORMAT_LABEL[format]})`)
    const title = (a.title ?? a.fileName.replace(/\.[^.]+$/, "")).trim().slice(0, 160) || "Dokument"
    const name = this.uniqueName(title)
    const d = await this.describe(format, a.bytes)
    await this.ctx.ops.officeWrite(run, {
      name,
      isNew: true,
      title,
      description: a.description ?? `${FORMAT_LABEL[format]}, ${a.fileName}`.slice(0, 200),
      tags: a.tags,
      fields: { ...d.fields, file: `${slugify(a.fileName.replace(/\.[^.]+$/, ""), 50) || name}.${format}`, source: "upload", author: "user", ai: a.ai ?? this.ctx.options.office.defaultAi },
      body: d.body,
      file: `${slugify(a.fileName.replace(/\.[^.]+$/, ""), 50) || name}.${format}`,
      bytes: a.bytes,
      reason: `hochgeladen: ${truncate(a.fileName, 80)}`,
    })
    return this.entry(name)
  }

  async create(run: Run, a: { family: OfficeFamily; title: string; template?: string; description?: string; tags?: string[]; ai?: string; asTemplate?: boolean }): Promise<Entry> {
    let bytes: Uint8Array
    let templateName = ""
    if (a.template) {
      const t = this.entry(a.template)
      const tf = this.formatOf(t)
      if (familyOf(tf) !== a.family) throw new GuardError(`„${t.title}“ ist keine ${a.family === "pptx" ? "PowerPoint" : "Word"}-Vorlage`)
      bytes = await fromTemplate(this.bytes(t), tf)
      templateName = t.name
    } else {
      bytes = await blank(a.family, a.title)
    }
    const format: OfficeFormat = a.family
    const name = this.uniqueName(a.title)
    const d = await this.describe(format, bytes)
    const file = `${name}.${format}`
    await this.ctx.ops.officeWrite(run, {
      name,
      isNew: true,
      title: a.title,
      description: a.description ?? (templateName ? `${FORMAT_LABEL[format]} aus der Vorlage ${templateName}` : `neues ${FORMAT_LABEL[format]}-Dokument`),
      tags: a.tags,
      fields: { ...d.fields, file, source: "neu", author: "user", ai: a.ai ?? this.ctx.options.office.defaultAi, ...(templateName ? { template: templateName } : {}) },
      body: d.body,
      file,
      bytes,
      reason: templateName ? `neu aus Vorlage ${templateName}` : "neu angelegt",
    })
    return this.entry(name)
  }

  /** New version from the editor in the browser (or any other bytes of the user). */
  async save(run: Run, name: string, bytes: Uint8Array, opts: { baseVersion?: string; reason?: string; action?: ActionKind } = {}): Promise<string> {
    this.checkSize(bytes.length)
    const e = this.entry(name)
    const format = this.formatOf(e)
    const got = sniffFormat(bytes)
    if (!got || familyOf(got) !== familyOf(format)) throw new GuardError(`Die Datei ist kein ${FORMAT_LABEL[format]}-Dokument`)
    // the editor writes documents; a template keeps its content type
    const fixed = got === format ? bytes : await retype(bytes, format)
    const sha = shaOf(fixed)
    if (sha === str(e.fields.sha)) return `„${e.title}“ unverändert`
    const d = await this.describe(format, fixed)
    return this.ctx.ops.officeWrite(run, {
      name,
      isNew: false,
      fields: { ...e.fields, ...d.fields },
      body: d.body,
      file: str(e.fields.file),
      bytes: fixed,
      baseVersion: opts.baseVersion,
      reason: opts.reason ?? "im Editor bearbeitet",
      action: opts.action,
    })
  }

  async restore(run: Run, e: Entry, hash: string): Promise<{ message: string; target: string }> {
    const bytes = await this.bytesAt(e, hash)
    const msg = await this.save(run, e.name, bytes, { reason: `Version ${hash.slice(0, 8)} wiederhergestellt`, action: "restore" })
    return { message: msg, target: `office:${e.name}` }
  }

  // ---------------------------------------------------------------------------
  // AI drafts (state/office/<name>/, local)
  // ---------------------------------------------------------------------------

  private draftDir(name: string): string {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new GuardError("ungültiger Name")
    return join(this.ctx.store.stateDir, "office", name)
  }

  draft(name: string): OfficeDraft | undefined {
    return readJson<OfficeDraft | null>(join(this.draftDir(name), "draft.json"), null) ?? undefined
  }

  draftBytes(name: string): Uint8Array | undefined {
    const d = this.draft(name)
    if (!d) return undefined
    const p = join(this.draftDir(name), `draft.${d.format}`)
    return exists(p) ? new Uint8Array(readFileSync(p)) : undefined
  }

  private writeDraft(d: OfficeDraft, bytes?: Uint8Array): void {
    const dir = this.draftDir(d.name)
    ensureDir(dir)
    if (bytes) writeBufferAtomic(join(dir, `draft.${d.format}`), bytes)
    d.updatedAt = nowIso()
    writeJsonAtomic(join(dir, "draft.json"), d)
  }

  private emit(d: OfficeDraft, extra: Record<string, unknown> = {}): void {
    this.ctx.bus?.emit("office.draft", { name: d.name, rev: d.rev, status: d.status, current: d.current, error: d.error, steps: d.steps.length, ...extra })
  }

  /** Start an AI edit by prompt; runs in the background, the draft shows every step. */
  edit(name: string, prompt: string, opts: { isNew?: boolean } = {}): OfficeDraft {
    if (!this.ctx.options.office.aiEdit) throw new GuardError("KI-Bearbeitung ist aus (office.aiEdit)")
    const e = this.entry(name)
    const access = aiAccessOf(e)
    if (access === "lesen" || access === "privat") throw new GuardError(`KI-Recht „${access}“: die KI darf „${e.title}“ nicht bearbeiten`)
    if (this.running.has(name)) throw new GuardError("Die KI arbeitet schon an diesem Dokument")
    const format = this.formatOf(e)
    let d = this.draft(name)
    let bytes = d ? this.draftBytes(name) : undefined
    if (!d || !bytes) {
      bytes = this.bytes(e)
      d = { name, format, baseVersion: e.version, createdAt: nowIso(), updatedAt: nowIso(), rev: 0, status: "bereit", steps: [] }
    }
    d.status = "laeuft"
    d.error = undefined
    d.current = { prompt, index: 0, total: 0, label: "plant die Änderungen", phase: "plant" }
    this.writeDraft(d, bytes)
    this.emit(d)
    this.running.add(name)
    void this.runEdit(e, d, bytes, prompt, !!opts.isNew).finally(() => this.running.delete(name))
    return d
  }

  private async runEdit(e: Entry, d: OfficeDraft, bytes: Uint8Array, prompt: string, isNew: boolean): Promise<void> {
    const family = familyOf(d.format)
    try {
      const info = await inspect(d.format, bytes)
      const text = await askAssistant(
        this.ctx,
        editPrompt({ family, title: e.title, info, request: prompt, history: d.steps.map((s) => s.prompt), templateName: str(e.fields.template) || undefined, isNew: isNew || info.pages === 0 }),
        `Office ${e.title}`,
      )
      const plan = parsePlan(text)
      if (!plan) throw new GuardError(`Die KI hat keinen Änderungsplan geliefert: ${truncate(text.trim(), 300) || "(leer)"}`)
      if (!plan.ops.length) {
        d.steps.push({ at: nowIso(), prompt, summary: plan.summary || "keine Änderung", done: [], errors: [] })
        d.status = "bereit"
        d.current = undefined
        this.writeDraft(d)
        this.emit(d, { finished: true })
        return
      }
      const res = await applyOps(d.format, bytes, plan.ops, async (step) => {
        d.rev++
        d.current = { prompt, index: step.index + 1, total: step.total, label: step.label, phase: "aendert" }
        this.writeDraft(d, step.bytes)
        this.emit(d, step.error ? { stepError: step.error } : {})
      })
      d.steps.push({ at: nowIso(), prompt, summary: plan.summary, done: res.done, errors: res.errors })
      d.status = "bereit"
      d.current = undefined
      this.writeDraft(d, res.bytes)
      this.emit(d, { finished: true })
    } catch (err) {
      d.status = "fehler"
      d.error = (err as Error).message
      d.current = undefined
      this.writeDraft(d)
      this.emit(d, { finished: true })
      this.ctx.log.warn(`office edit ${e.name} failed`, d.error)
    }
  }

  /** Write the draft as a new version (one commit). */
  async accept(run: Run, name: string, force = false): Promise<string> {
    const d = this.draft(name)
    const bytes = this.draftBytes(name)
    if (!d || !bytes) throw new GuardError("Kein Entwurf vorhanden")
    if (d.status === "laeuft" || this.running.has(name)) throw new GuardError("Die KI arbeitet noch am Entwurf")
    const e = this.entry(name)
    if (!force && e.version !== d.baseVersion) throw new GuardError("Das Dokument wurde seit dem Entwurf geändert – Entwurf verwerfen oder trotzdem übernehmen")
    const prompts = d.steps.map((s) => truncate(s.prompt, 80))
    const msg = await this.save(run, name, bytes, { reason: `KI-Entwurf übernommen: ${prompts.join(" · ") || "Entwurf"}` })
    this.discard(name)
    return msg
  }

  discard(name: string): void {
    if (this.running.has(name)) throw new GuardError("Die KI arbeitet noch am Entwurf")
    removePath(this.draftDir(name))
    this.ctx.bus?.emit("office.draft", { name, rev: 0, status: "verworfen" })
  }

  isRunning(name: string): boolean {
    return this.running.has(name)
  }
}
