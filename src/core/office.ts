/**
 * Office documents (PowerPoint, Word): read, describe and change .pptx/.docx files on the server.
 *
 * The ooxml libraries (ChristopherVR/ooxml, Apache-2.0) are vendored as one Bun bundle
 * (src/vendor/office-core.js, built by tools/vendor/office/build.sh) and loaded lazily – the
 * plugin keeps working without them, only office documents are unavailable.
 *
 *   inspect()   text (Markdown for search, embeddings, links), outline for the AI, layouts/styles
 *   applyOps()  the AI's edit plan (JSON operations), step by step – every step yields the
 *               file again so the web view shows the change live
 *   blank() / fromTemplate()   new documents (templates: .potx/.dotx → .pptx/.docx)
 *
 * PowerPoint placeholders (title, subtitle, body) of a layout only exist after the slide was
 * written once: add_slide therefore saves and reloads before it fills them, so the text
 * keeps the formatting of the template.
 */
import { unzip } from "./importer"
import { truncate } from "../util/text"

export type OfficeFormat = "pptx" | "docx" | "potx" | "dotx"
export type OfficeFamily = "pptx" | "docx"
export const OFFICE_FORMATS: OfficeFormat[] = ["pptx", "docx", "potx", "dotx"]

const OOXML = "application/vnd.openxmlformats-officedocument"
export const OFFICE_MIME: Record<OfficeFormat, string> = {
  pptx: `${OOXML}.presentationml.presentation`,
  potx: `${OOXML}.presentationml.template`,
  docx: `${OOXML}.wordprocessingml.document`,
  dotx: `${OOXML}.wordprocessingml.template`,
}
/** content type of the main part in [Content_Types].xml */
const MAIN_PART: Record<OfficeFormat, string> = {
  pptx: `${OOXML}.presentationml.presentation.main+xml`,
  potx: `${OOXML}.presentationml.template.main+xml`,
  docx: `${OOXML}.wordprocessingml.document.main+xml`,
  dotx: `${OOXML}.wordprocessingml.template.main+xml`,
}

export const familyOf = (f: OfficeFormat): OfficeFamily => (f === "pptx" || f === "potx" ? "pptx" : "docx")
export const isTemplateFormat = (f: OfficeFormat): boolean => f === "potx" || f === "dotx"
export const FORMAT_LABEL: Record<OfficeFormat, string> = { pptx: "PowerPoint", potx: "PowerPoint-Vorlage", docx: "Word", dotx: "Word-Vorlage" }

export function formatOfName(name: string): OfficeFormat | undefined {
  const ext = /\.([a-z]+)$/i.exec(name)?.[1]?.toLowerCase()
  return (OFFICE_FORMATS as string[]).includes(ext ?? "") ? (ext as OfficeFormat) : undefined
}

/** Format from the package itself ([Content_Types].xml) – macro files (.pptm/.docm) and others are refused. */
export function sniffFormat(data: Uint8Array): OfficeFormat | undefined {
  let files: Map<string, Uint8Array>
  try {
    files = unzip(data)
  } catch {
    return undefined
  }
  const ct = files.get("[Content_Types].xml")
  if (!ct) return undefined
  const xml = new TextDecoder().decode(ct)
  for (const f of OFFICE_FORMATS) if (xml.includes(`"${MAIN_PART[f]}"`)) return f
  return undefined
}

// ---------------------------------------------------------------------------
// library (lazy)
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
interface OfficeLib {
  PptxHandler: new () => any
  Presentation: { create(o: { title?: string }): Promise<any> }
  automation: Record<string, (ctx: any, params: any) => any>
  loadDocx(bytes: Uint8Array): Promise<{ model: any; save(model?: any): Promise<Uint8Array> }>
  saveDocx(model: any): Promise<Uint8Array>
  createDocument(): any
  JSZip: { loadAsync(data: Uint8Array): Promise<any> }
}

let libPromise: Promise<OfficeLib> | undefined

export function officeLib(): Promise<OfficeLib> {
  libPromise ??= import(new URL("../vendor/office-core.js", import.meta.url).href).catch((err) => {
    libPromise = undefined
    throw new Error(`Office-Bibliothek nicht verfügbar (src/vendor/office-core.js): ${(err as Error).message}`)
  }) as Promise<OfficeLib>
  return libPromise
}

const buf = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer
const u8 = (x: Uint8Array | ArrayBuffer): Uint8Array => (x instanceof Uint8Array ? x : new Uint8Array(x))

async function loadPptx(bytes: Uint8Array): Promise<{ h: any; d: any }> {
  const L = await officeLib()
  const h = new L.PptxHandler()
  const d = await h.load(buf(bytes))
  return { h, d }
}

async function savePptx(h: any, d: any): Promise<Uint8Array> {
  return u8(await h.save(d.slides))
}

/** Rewrite the main content type (template ↔ document). */
export async function retype(bytes: Uint8Array, to: OfficeFormat): Promise<Uint8Array> {
  const L = await officeLib()
  const zip = await L.JSZip.loadAsync(bytes)
  const file = zip.file("[Content_Types].xml")
  if (!file) throw new Error("keine Office-Datei ([Content_Types].xml fehlt)")
  let xml: string = await file.async("string")
  for (const f of OFFICE_FORMATS) xml = xml.replace(`"${MAIN_PART[f]}"`, `"${MAIN_PART[to]}"`)
  zip.file("[Content_Types].xml", xml)
  return u8(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }))
}

// ---------------------------------------------------------------------------
// new documents
// ---------------------------------------------------------------------------

export async function blank(family: OfficeFamily, title: string): Promise<Uint8Array> {
  const L = await officeLib()
  if (family === "pptx") {
    const p = await L.Presentation.create({ title })
    return u8(await p.save())
  }
  const m = L.createDocument()
  if (m.properties && typeof m.properties === "object") m.properties.title = title
  else m.properties = { title }
  return u8(await L.saveDocx(m))
}

/** A new document from a template (.potx/.dotx or an existing document): same masters, layouts and styles, no content. */
export async function fromTemplate(template: Uint8Array, format: OfficeFormat, opts: { keepContent?: boolean } = {}): Promise<Uint8Array> {
  const family = familyOf(format)
  let bytes = isTemplateFormat(format) ? await retype(template, family) : template
  if (opts.keepContent) return bytes
  if (family === "pptx") {
    const { h, d } = await loadPptx(bytes)
    if (d.slides.length) {
      d.slides.splice(0, d.slides.length)
      bytes = await savePptx(h, d)
    }
    return bytes
  }
  const L = await officeLib()
  const doc = await L.loadDocx(bytes)
  doc.model.blocks = [{ type: "paragraph", id: "p0", runs: [{ text: "" }] }]
  return u8(await doc.save(doc.model))
}

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

export interface OfficeInfo {
  family: OfficeFamily
  /** Markdown text of the content (search, embeddings, links) */
  text: string
  /** slides or paragraphs */
  pages: number
  /** compact structure for the AI (slide/element or block references) */
  outline: string
  layouts: string[]
  styles: string[]
}

const PPT_MINOR = new Set(["sldnum", "dt", "ftr", "hdr"])

function phType(e: any): string {
  return String(e?.placeholderType ?? "").toLowerCase()
}

function elementText(e: any): string {
  // the library prefixes rendered bullets ("• Punkt") – the text itself has none
  if (typeof e?.text === "string" && e.text.trim()) return e.text.trim().split("\n").map((l: string) => l.replace(/^[•▪◦‣]\s*/, "")).join("\n")
  if (e?.type === "table" && Array.isArray(e.tableData?.rows)) {
    return e.tableData.rows.map((r: any) => (r.cells ?? []).map((c: any) => String(c.text ?? "").trim()).join(" | ")).join("\n")
  }
  return ""
}

function elementRole(e: any): string {
  const t = phType(e)
  if (t === "title" || t === "ctrtitle") return "title"
  if (t === "subtitle") return "subtitle"
  if (t === "body" || t === "obj") return "body"
  if (PPT_MINOR.has(t)) return t
  return String(e?.type ?? "element")
}

function slideTitle(s: any): string {
  const t = (s.elements ?? []).find((e: any) => elementRole(e) === "title")
  return t ? elementText(t).replace(/\s+/g, " ") : ""
}

function pptxInfo(d: any): OfficeInfo {
  const md: string[] = []
  const outline: string[] = [`Folienformat ${Math.round(d.width)}×${Math.round(d.height)} px, ${d.slides.length} Folie(n)`]
  d.slides.forEach((s: any, i: number) => {
    const title = slideTitle(s)
    md.push(`## Folie ${i + 1}${title ? `: ${title}` : ""}`)
    outline.push(`Folie ${i + 1}${s.layoutName ? ` [Layout: ${s.layoutName}]` : ""}${s.hidden ? " (ausgeblendet)" : ""}`)
    ;(s.elements ?? []).forEach((e: any, k: number) => {
      const role = elementRole(e)
      const text = elementText(e)
      if (PPT_MINOR.has(role)) return
      if (text && role !== "title") md.push(text.split("\n").map((l: string) => (role === "body" ? `- ${l}` : l)).join("\n"))
      outline.push(`  e${k + 1} (${role}${e.type === "image" ? ", Bild" : ""}) ${Math.round(e.x)},${Math.round(e.y)} ${Math.round(e.width)}×${Math.round(e.height)}${text ? `: "${truncate(text.replace(/\n/g, " / "), 160)}"` : ""}`)
    })
    const notes = String(s.notes ?? "").trim()
    if (notes) {
      md.push(`> Notizen: ${notes.replace(/\n/g, " ")}`)
      outline.push(`  Notizen: "${truncate(notes.replace(/\n/g, " / "), 160)}"`)
    }
    md.push("")
  })
  const layouts = (d.layoutOptions ?? []).map((l: any) => String(l.name ?? "")).filter(Boolean)
  return { family: "pptx", text: md.join("\n").trim(), pages: d.slides.length, outline: outline.join("\n"), layouts, styles: [] }
}

const HEADING_MD: Record<string, string> = { title: "#", heading1: "##", heading2: "###", heading3: "####", heading4: "####" }

function runsText(p: any): string {
  return (p?.runs ?? []).map((r: any) => (typeof r.text === "string" ? r.text : "")).join("")
}

function tableRows(t: any): string[][] {
  return (t.rows ?? []).map((row: any[]) => row.map((c: any) => (c.paragraphs ?? []).map(runsText).join(" ").trim()))
}

function styleIds(model: any): string[] {
  const s = model?.paragraphStyles?.styles
  const list = Array.isArray(s) ? s : s && typeof s === "object" ? Object.values(s) : []
  return list.map((x: any) => String(x?.id ?? "")).filter(Boolean)
}

function docxInfo(model: any): OfficeInfo {
  const md: string[] = []
  const outline: string[] = []
  let pages = 0
  for (const b of model.blocks ?? []) {
    if (b.type === "paragraph") {
      const text = runsText(b).trim()
      const style = String(b.style ?? "")
      const key = style.toLowerCase()
      pages++
      outline.push(`${b.id} [${style || "Normal"}${b.pageBreakBefore ? ", neue Seite" : ""}]${text ? ` ${truncate(text, 200)}` : " (leer)"}`)
      if (!text) continue
      if (HEADING_MD[key]) md.push(`${HEADING_MD[key]} ${text}`)
      else if (/list/.test(key)) md.push(`- ${text}`)
      else md.push(text)
    } else if (b.type === "table") {
      const rows = tableRows(b)
      outline.push(`${b.id} [Tabelle ${rows.length}×${rows[0]?.length ?? 0}] ${truncate(rows.map((r) => r.join(" | ")).join(" / "), 200)}`)
      if (rows.length) {
        md.push(`| ${rows[0].join(" | ")} |`, `|${rows[0].map(() => " --- ").join("|")}|`, ...rows.slice(1).map((r) => `| ${r.join(" | ")} |`))
      }
    } else {
      outline.push(`${b.id ?? "?"} [${b.type}]`)
    }
  }
  return { family: "docx", text: md.join("\n\n").trim(), pages, outline: outline.join("\n"), layouts: [], styles: styleIds(model) }
}

export async function inspect(format: OfficeFormat, bytes: Uint8Array): Promise<OfficeInfo> {
  if (familyOf(format) === "pptx") {
    const { d } = await loadPptx(bytes)
    return pptxInfo(d)
  }
  const L = await officeLib()
  const doc = await L.loadDocx(bytes)
  return docxInfo(doc.model)
}

// ---------------------------------------------------------------------------
// operations (the AI's edit plan)
// ---------------------------------------------------------------------------

export type OfficeOp = Record<string, unknown> & { op: string }

export interface OpsResult {
  bytes: Uint8Array
  done: string[]
  errors: string[]
}

export type StepListener = (step: { index: number; total: number; label: string; bytes: Uint8Array; error?: string }) => void | Promise<void>

/** {"summary": …, "ops": [...]} from the answer (first JSON block). */
export function parsePlan(text: string): { summary: string; ops: OfficeOp[] } | undefined {
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1])
  if (!blocks.length) {
    const i = text.indexOf("{")
    const j = text.lastIndexOf("}")
    if (i >= 0 && j > i) blocks.push(text.slice(i, j + 1))
  }
  for (const raw of blocks) {
    try {
      const v = JSON.parse(raw)
      const ops = Array.isArray(v) ? v : Array.isArray(v?.ops) ? v.ops : undefined
      if (!ops) continue
      const clean = ops.filter((o: unknown): o is OfficeOp => !!o && typeof o === "object" && typeof (o as OfficeOp).op === "string").slice(0, 200)
      return { summary: typeof v?.summary === "string" ? truncate(v.summary, 600) : "", ops: clean }
    } catch {
      continue
    }
  }
  return undefined
}

const s = (v: unknown, max = 20_000): string => (typeof v === "string" ? v.slice(0, max) : typeof v === "number" ? String(v) : "")
const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : undefined)
const lines = (v: unknown): string => (Array.isArray(v) ? v.map((x) => s(x, 2000)).filter((x) => x !== "").join("\n") : s(v))

export function opLabel(o: OfficeOp): string {
  const at = n(o.slide) !== undefined ? ` (Folie ${n(o.slide)})` : typeof o.block === "string" ? ` (${o.block})` : ""
  const label: Record<string, string> = {
    add_slide: "Folie hinzufügen",
    set_text: "Text setzen",
    add_text: "Textfeld hinzufügen",
    add_table: "Tabelle hinzufügen",
    delete_slide: "Folie löschen",
    move_slide: "Folie verschieben",
    duplicate_slide: "Folie duplizieren",
    delete_element: "Element löschen",
    set_notes: "Notizen setzen",
    set_background: "Hintergrund setzen",
    set_layout: "Layout wechseln",
    replace_text: "Text ersetzen",
    insert: "Absätze einfügen",
    set_style: "Formatvorlage setzen",
    delete: "Block löschen",
    page_break: "Seitenumbruch",
    table: "Tabelle einfügen",
  }
  return `${label[o.op] ?? o.op}${at}${typeof o.title === "string" && o.title ? `: ${truncate(o.title, 60)}` : ""}`
}

export async function applyOps(format: OfficeFormat, bytes: Uint8Array, ops: OfficeOp[], onStep?: StepListener): Promise<OpsResult> {
  return familyOf(format) === "pptx" ? applyPptx(bytes, ops, onStep) : applyDocx(bytes, ops, onStep)
}

// ----- PowerPoint -------------------------------------------------------------

class PptxEditor {
  h: any
  d: any
  constructor(
    private L: OfficeLib,
    loaded: { h: any; d: any },
  ) {
    this.h = loaded.h
    this.d = loaded.d
  }

  get ctx(): { pptxData: any } {
    return { pptxData: this.d }
  }

  call(tool: string, params: Record<string, unknown>): any {
    const fn = this.L.automation[tool]
    if (!fn) throw new Error(`${tool} fehlt in der Office-Bibliothek`)
    const r = fn(this.ctx, params)
    if (r?.pptxData) this.d = r.pptxData
    const res = r?.result
    if (res && typeof res === "object" && typeof res.error === "string") throw new Error(res.error)
    return res
  }

  async flush(): Promise<Uint8Array> {
    const out = await savePptx(this.h, this.d)
    const re = await loadPptx(out)
    this.h = re.h
    this.d = re.d
    return out
  }

  slideIndex(v: unknown): number {
    const i = n(v)
    if (i === undefined || !Number.isInteger(i) || i < 1 || i > this.d.slides.length) throw new Error(`Folie ${String(v)} gibt es nicht (1–${this.d.slides.length})`)
    return i - 1
  }

  layoutName(want: string, hint: "title" | "content" | "blank"): string | undefined {
    const names: string[] = (this.d.layoutOptions ?? []).map((l: any) => String(l.name ?? ""))
    if (want) {
      const exact = names.find((x) => x.toLowerCase() === want.toLowerCase())
      if (exact) return exact
      const part = names.find((x) => x.toLowerCase().includes(want.toLowerCase()))
      if (part) return part
    }
    const prefs =
      hint === "title" ? [/^title slide$/i, /titelfolie/i, /title/i] : hint === "blank" ? [/^blank$/i, /leer/i] : [/^title and content$/i, /titel und inhalt/i, /content/i, /inhalt/i]
    for (const re of prefs) {
      const m = names.find((x) => re.test(x))
      if (m) return m
    }
    return names[0]
  }

  element(slide: number, ref: unknown): any {
    const els: any[] = this.d.slides[slide].elements ?? []
    const r = s(ref).trim().toLowerCase()
    const m = /^e(\d+)$/.exec(r)
    if (m) {
      const e = els[Number(m[1]) - 1]
      if (!e) throw new Error(`Element ${r} gibt es auf Folie ${slide + 1} nicht`)
      return e
    }
    const role = r === "untertitel" ? "subtitle" : r === "titel" ? "title" : r === "inhalt" || r === "text" ? "body" : r
    let e = els.find((x) => elementRole(x) === role)
    // body placeholder without type (python-pptx, some templates): the first text element that is not the title
    if (!e && role === "body") e = els.find((x) => typeof x.text === "string" && !["title", "subtitle", ...PPT_MINOR].includes(elementRole(x)))
    if (!e) throw new Error(`Folie ${slide + 1} hat kein ${role}-Feld`)
    return e
  }

  /** Text box in percent of the slide (0–100). */
  addText(slide: number, text: string, o: Record<string, unknown>): void {
    const W = this.d.width
    const H = this.d.height
    const pct = (v: unknown, def: number) => Math.max(0, Math.min(100, n(v) ?? def)) / 100
    this.call("addElement", {
      slideIndex: slide,
      type: "text",
      x: Math.round(pct(o.x, 8) * W),
      y: Math.round(pct(o.y, 8) * H),
      width: Math.round(pct(o.w ?? o.width, 84) * W),
      height: Math.round(pct(o.h ?? o.height, 16) * H),
      text,
      ...(n(o.size ?? o.fontSize) ? { fontSize: n(o.size ?? o.fontSize) } : {}),
      ...(o.bold === true ? { bold: true } : {}),
      ...(o.italic === true ? { italic: true } : {}),
      ...(s(o.color) ? { fontColor: s(o.color, 20) } : {}),
      ...(["left", "center", "right", "justify"].includes(s(o.align)) ? { alignment: s(o.align) } : {}),
    })
  }

  setText(slide: number, ref: unknown, text: string): void {
    const e = this.element(slide, ref)
    this.call("updateElement", { slideIndex: slide, elementId: e.id, text })
  }

  move(from: number, to: number): void {
    const count = this.d.slides.length
    const order = [...Array(count).keys()]
    const [x] = order.splice(from, 1)
    order.splice(Math.max(0, Math.min(count - 1, to)), 0, x)
    this.call("reorderSlides", { newOrder: order })
  }

  async addSlide(o: OfficeOp): Promise<void> {
    const title = s(o.title, 500)
    const subtitle = s(o.subtitle, 1000)
    const body = lines(o.body ?? o.bullets)
    const hint = s(o.layout) ? "content" : title && !body && (subtitle || o.cover === true) ? "title" : !title && !body ? "blank" : "content"
    const layout = this.layoutName(s(o.layout, 120), hint)
    const res = this.call("addSlide", {})
    let i: number = res?.newSlideIndex ?? this.d.slides.length - 1
    if (layout) this.call("applyLayout", { slideIndex: i, layoutName: layout })
    const at = n(o.at ?? o.position)
    if (at !== undefined && Number.isInteger(at) && at >= 1 && at - 1 !== i) {
      this.move(i, at - 1)
      i = at - 1
    }
    // the layout's placeholders appear after a write
    await this.flush()
    const fill = (role: string, text: string, box: Record<string, unknown>) => {
      if (!text) return
      try {
        this.setText(i, role, text)
      } catch {
        this.addText(i, text, box)
      }
    }
    fill("title", title, { x: 6, y: 6, w: 88, h: 16, size: 32, bold: true })
    fill("subtitle", subtitle, { x: 10, y: 58, w: 80, h: 14, size: 20 })
    fill("body", body, { x: 6, y: 26, w: 88, h: 64, size: 18 })
    // empty placeholders the plan did not fill (text "Click to add …" stays only in the editor)
    const notes = lines(o.notes)
    if (notes) this.call("updateSlideProperties", { slideIndex: i, notes })
  }
}

async function applyPptx(bytes: Uint8Array, ops: OfficeOp[], onStep?: StepListener): Promise<OpsResult> {
  const L = await officeLib()
  const ed = new PptxEditor(L, await loadPptx(bytes))
  const done: string[] = []
  const errors: string[] = []
  let current = bytes
  for (let k = 0; k < ops.length; k++) {
    const o = ops[k]
    const label = opLabel(o)
    let error: string | undefined
    try {
      switch (o.op) {
        case "add_slide":
          await ed.addSlide(o)
          break
        case "set_text":
          ed.setText(ed.slideIndex(o.slide), o.element ?? o.field ?? "body", lines(o.text))
          break
        case "add_text":
          ed.addText(ed.slideIndex(o.slide), lines(o.text), o)
          break
        case "add_table": {
          const i = ed.slideIndex(o.slide)
          const rows = Array.isArray(o.rows) ? (o.rows as unknown[]).filter(Array.isArray).map((r) => (r as unknown[]).map((c) => s(c, 500))) : []
          if (!rows.length) throw new Error("rows fehlt")
          const cols = Math.max(...rows.map((r) => r.length))
          const W = ed.d.width
          const H = ed.d.height
          const pct = (v: unknown, def: number) => (Math.max(0, Math.min(100, n(v) ?? def)) / 100)
          ed.call("addElement", {
            slideIndex: i,
            type: "table",
            x: Math.round(pct(o.x, 6) * W),
            y: Math.round(pct(o.y, 26) * H),
            width: Math.round(pct(o.w, 88) * W),
            height: Math.round(pct(o.h, Math.min(64, rows.length * 8)) * H),
            rows: rows.length,
            columns: cols,
            cellData: rows.map((r) => [...r, ...Array(cols - r.length).fill("")]),
          })
          break
        }
        case "delete_slide":
          if (ed.d.slides.length <= 1) throw new Error("die letzte Folie bleibt")
          ed.call("deleteSlides", { slideIndexes: [ed.slideIndex(o.slide)] })
          break
        case "move_slide":
          ed.move(ed.slideIndex(o.slide), (n(o.to) ?? 1) - 1)
          break
        case "duplicate_slide": {
          const from = ed.slideIndex(o.slide)
          const r = ed.call("duplicateSlide", { slideIndex: from })
          const to = n(o.to)
          if (to !== undefined && r?.newSlideIndex !== undefined) ed.move(r.newSlideIndex, to - 1)
          break
        }
        case "delete_element": {
          const i = ed.slideIndex(o.slide)
          ed.call("deleteElements", { slideIndex: i, elementIds: [ed.element(i, o.element).id] })
          break
        }
        case "set_notes":
          ed.call("updateSlideProperties", { slideIndex: ed.slideIndex(o.slide), notes: lines(o.text) })
          break
        case "set_background": {
          const color = s(o.color, 20)
          if (!/^#?[0-9a-f]{6}$/i.test(color)) throw new Error("Farbe als #RRGGBB")
          ed.call("updateSlideProperties", { slideIndex: ed.slideIndex(o.slide), backgroundColor: color.startsWith("#") ? color : `#${color}` })
          break
        }
        case "set_layout": {
          const i = ed.slideIndex(o.slide)
          const layout = ed.layoutName(s(o.layout, 120), "content")
          if (!layout) throw new Error("kein Layout")
          ed.call("applyLayout", { slideIndex: i, layoutName: layout })
          break
        }
        case "replace_text": {
          const find = s(o.find, 500)
          if (!find) throw new Error("find fehlt")
          const r = ed.call("replaceText", { query: find, replacement: s(o.replace, 2000), caseSensitive: o.caseSensitive === true })
          if (!r?.replacementCount) throw new Error(`„${truncate(find, 40)}“ nicht gefunden`)
          break
        }
        default:
          throw new Error(`unbekannte Operation ${o.op}`)
      }
      current = await ed.flush()
      done.push(label)
    } catch (err) {
      error = `${label}: ${(err as Error).message}`
      errors.push(error)
    }
    await onStep?.({ index: k, total: ops.length, label, bytes: current, error })
  }
  return { bytes: current, done, errors }
}

// ----- Word -------------------------------------------------------------------

let idSeq = 0
const newId = (p: string) => `${p}${Date.now().toString(36)}${(idSeq++).toString(36)}`

/** "**fett** und *kursiv*" → runs */
export function inlineRuns(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*/g
  let last = 0
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index) })
    out.push(m[1] !== undefined ? { text: m[1], bold: true } : { text: m[2], italic: true })
    last = m.index! + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out.length ? out : [{ text: "" }]
}

const STYLE_ALIAS: Record<string, string> = {
  titel: "Title",
  title: "Title",
  untertitel: "Subtitle",
  subtitle: "Subtitle",
  h1: "Heading1",
  h2: "Heading2",
  h3: "Heading3",
  "überschrift 1": "Heading1",
  "überschrift 2": "Heading2",
  "überschrift 3": "Heading3",
  normal: "Normal",
  standard: "Normal",
  zitat: "Quote",
  quote: "Quote",
  liste: "ListBullet",
  aufzählung: "ListBullet",
  bullet: "ListBullet",
  nummerierung: "ListNumber",
}

class DocxEditor {
  constructor(
    public model: any,
    private save: (m: any) => Promise<Uint8Array>,
  ) {}

  get blocks(): any[] {
    return this.model.blocks
  }

  style(raw: unknown): string | undefined {
    const v = s(raw, 60).trim()
    if (!v) return undefined
    const ids = styleIds(this.model)
    const want = STYLE_ALIAS[v.toLowerCase()] ?? v.replace(/\s+/g, "")
    return ids.find((x) => x.toLowerCase() === want.toLowerCase()) ?? want
  }

  hasStyle(id: string): boolean {
    return styleIds(this.model).some((x) => x.toLowerCase() === id.toLowerCase())
  }

  index(ref: unknown): number {
    const r = s(ref, 80).trim()
    const i = this.blocks.findIndex((b) => b.id === r)
    if (i < 0) throw new Error(`Block ${r || "?"} gibt es nicht`)
    return i
  }

  position(after: unknown, before: unknown): number {
    if (typeof before === "string" && before) return before === "start" ? 0 : this.index(before)
    const a = s(after, 80)
    if (!a || a === "end") return this.blocks.length
    if (a === "start") return 0
    return this.index(a) + 1
  }

  paragraph(b: Record<string, unknown>): any {
    let text = s(b.text, 20_000)
    let style = this.style(b.style)
    const list = s(b.list)
    if (list) style = this.style(list === "number" || list === "nummer" ? "ListNumber" : "ListBullet")
    // a list style the document does not know: plain paragraph with a bullet
    if (style && /^list/i.test(style) && !this.hasStyle(style)) {
      text = `${/number/i.test(style) ? "–" : "•"} ${text}`
      style = undefined
    }
    const runs = inlineRuns(text)
    if (b.bold === true) for (const r of runs) r.bold = true
    if (b.italic === true) for (const r of runs) r.italic = true
    const p: Record<string, unknown> = { type: "paragraph", id: newId("sp"), runs }
    if (style && style !== "Normal") p.style = style
    if (b.pageBreakBefore === true || b.page_break === true) p.pageBreakBefore = true
    if (["left", "center", "right", "both"].includes(s(b.align))) p.align = s(b.align)
    return p
  }

  table(rows: string[][]): any {
    const cols = Math.max(...rows.map((r) => r.length))
    const width = Math.floor(9000 / Math.max(1, cols))
    return {
      type: "table",
      id: newId("st"),
      rows: rows.map((r) => [...r, ...Array(cols - r.length).fill("")].map((c) => ({ paragraphs: [{ type: "paragraph", id: newId("sp"), runs: inlineRuns(c) }], widthTwips: width }))),
      grid: Array(cols).fill(width),
      structureEditable: true,
      look: { firstRow: true, lastRow: false, firstColumn: false, lastColumn: false, noHBand: false, noVBand: true },
    }
  }

  setText(p: any, text: string): void {
    p.runs = inlineRuns(text)
    delete p.sourceParagraphXml
  }

  replace(find: string, repl: string, caseSensitive: boolean): number {
    let count = 0
    const flags = caseSensitive ? "g" : "gi"
    const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags)
    const visit = (p: any) => {
      if (p?.type !== "paragraph") return
      let inRun = false
      for (const r of p.runs ?? []) {
        if (typeof r.text === "string" && re.test(r.text)) {
          re.lastIndex = 0
          count += (r.text.match(re) ?? []).length
          r.text = r.text.replace(re, () => repl)
          inRun = true
        }
        re.lastIndex = 0
      }
      if (inRun) return
      // spread over several runs: the paragraph becomes one run (formatting of the first run)
      const all = runsText(p)
      if (re.test(all)) {
        re.lastIndex = 0
        count += (all.match(re) ?? []).length
        const first = { ...(p.runs?.[0] ?? {}) }
        p.runs = [{ ...first, text: all.replace(re, () => repl) }]
      }
      re.lastIndex = 0
    }
    for (const b of this.blocks) {
      if (b.type === "paragraph") visit(b)
      else if (b.type === "table") for (const row of b.rows ?? []) for (const c of row) for (const p of c.paragraphs ?? []) visit(p)
    }
    return count
  }

  bytes(): Promise<Uint8Array> {
    return this.save(this.model)
  }
}

async function applyDocx(bytes: Uint8Array, ops: OfficeOp[], onStep?: StepListener): Promise<OpsResult> {
  const L = await officeLib()
  const doc = await L.loadDocx(bytes)
  const ed = new DocxEditor(doc.model, async (m) => u8(await doc.save(m)))
  const done: string[] = []
  const errors: string[] = []
  let current = bytes
  for (let k = 0; k < ops.length; k++) {
    const o = ops[k]
    const label = opLabel(o)
    let error: string | undefined
    try {
      switch (o.op) {
        case "insert": {
          const items = Array.isArray(o.blocks) ? (o.blocks as Array<Record<string, unknown>>) : [o]
          let at = ed.position(o.after, o.before)
          for (const b of items.slice(0, 200)) {
            if (!b || typeof b !== "object") continue
            const rows = Array.isArray(b.rows) ? (b.rows as unknown[]).filter(Array.isArray).map((r) => (r as unknown[]).map((c) => s(c, 2000))) : undefined
            ed.blocks.splice(at++, 0, rows?.length ? ed.table(rows) : ed.paragraph(b))
          }
          break
        }
        case "set_text": {
          const b = ed.blocks[ed.index(o.block)]
          if (b.type !== "paragraph") throw new Error(`${o.block} ist kein Absatz`)
          ed.setText(b, s(o.text))
          if (o.style !== undefined) {
            const st = ed.style(o.style)
            if (st && st !== "Normal") b.style = st
            else delete b.style
          }
          break
        }
        case "set_style": {
          const b = ed.blocks[ed.index(o.block)]
          const st = ed.style(o.style)
          if (st && st !== "Normal") b.style = st
          else delete b.style
          delete b.sourceParagraphPropertiesXml
          break
        }
        case "delete":
          ed.blocks.splice(ed.index(o.block), 1)
          if (!ed.blocks.length) ed.blocks.push({ type: "paragraph", id: newId("sp"), runs: [{ text: "" }] })
          break
        case "page_break": {
          const b = ed.blocks[ed.index(o.before ?? o.block)]
          b.pageBreakBefore = true
          break
        }
        case "table": {
          const rows = Array.isArray(o.rows) ? (o.rows as unknown[]).filter(Array.isArray).map((r) => (r as unknown[]).map((c) => s(c, 2000))) : []
          if (!rows.length) throw new Error("rows fehlt")
          ed.blocks.splice(ed.position(o.after, o.before), 0, ed.table(rows))
          break
        }
        case "replace_text": {
          const find = s(o.find, 500)
          if (!find) throw new Error("find fehlt")
          if (!ed.replace(find, s(o.replace, 5000), o.caseSensitive === true)) throw new Error(`„${truncate(find, 40)}“ nicht gefunden`)
          break
        }
        default:
          throw new Error(`unbekannte Operation ${o.op}`)
      }
      current = await ed.bytes()
      done.push(label)
    } catch (err) {
      error = `${label}: ${(err as Error).message}`
      errors.push(error)
    }
    await onStep?.({ index: k, total: ops.length, label, bytes: current, error })
  }
  return { bytes: current, done, errors }
}

// ---------------------------------------------------------------------------
// prompt for the AI
// ---------------------------------------------------------------------------

const PPTX_OPS = `Operationen (Folien zählen ab 1, immer der Stand nach den vorherigen Operationen):
- {"op":"add_slide","at":1,"layout":"Title Slide","title":"…","subtitle":"…","body":["Punkt 1","Punkt 2"],"notes":"…"}  (at/layout/notes optional; ohne layout wählt das Plugin passend: nur title+subtitle → Titelfolie)
- {"op":"set_text","slide":2,"element":"title|subtitle|body|e3","text":"…"}  (Zeilen mit \\n)
- {"op":"add_text","slide":2,"text":"…","x":10,"y":70,"w":80,"h":10,"size":14,"bold":false,"color":"#1F4E79","align":"left"}  (x/y/w/h in Prozent der Folie)
- {"op":"add_table","slide":3,"rows":[["Kopf A","Kopf B"],["1","2"]],"x":6,"y":26,"w":88}
- {"op":"set_notes","slide":2,"text":"…"}
- {"op":"set_layout","slide":2,"layout":"Two Content"}
- {"op":"set_background","slide":1,"color":"#F2F2F2"}
- {"op":"move_slide","slide":5,"to":2}, {"op":"duplicate_slide","slide":2,"to":3}, {"op":"delete_slide","slide":4}, {"op":"delete_element","slide":2,"element":"e4"}
- {"op":"replace_text","find":"alt","replace":"neu"}`

const DOCX_OPS = `Operationen (Blöcke über ihre Id aus der Gliederung, z. B. p3; neue Blöcke haben keine Id für dich):
- {"op":"insert","after":"start|end|<id>","blocks":[{"style":"Title","text":"…"},{"style":"Heading1","text":"…"},{"text":"Absatz mit **fett** und *kursiv*"},{"list":"bullet","text":"Punkt"},{"rows":[["Kopf A","Kopf B"],["1","2"]]},{"text":"…","pageBreakBefore":true}]}  (oder "before":"<id>")
- {"op":"set_text","block":"p3","text":"…","style":"Heading2"}  (style optional)
- {"op":"set_style","block":"p3","style":"Heading1"}
- {"op":"delete","block":"p4"}
- {"op":"page_break","before":"p7"}  (p7 beginnt auf einer neuen Seite)
- {"op":"table","after":"p5","rows":[["A","B"],["1","2"]]}
- {"op":"replace_text","find":"alt","replace":"neu"}`

export function editPrompt(o: { family: OfficeFamily; title: string; info: OfficeInfo; request: string; history?: string[]; templateName?: string; isNew?: boolean }): string {
  const what = o.family === "pptx" ? "die PowerPoint-Präsentation" : "das Word-Dokument"
  return [
    `Du bearbeitest ${what} „${o.title}“ im Auftrag des Nutzers. Du änderst die Datei nicht selbst: du antwortest mit einem Plan aus Operationen, die das Plugin Schritt für Schritt ausführt (der Nutzer sieht dabei live zu).`,
    o.isNew ? "Das Dokument ist neu und noch leer – lege den Inhalt vollständig an." : "",
    o.templateName ? `Es basiert auf der Vorlage „${o.templateName}“ – nutze deren Layouts bzw. Formatvorlagen, keine eigenen Farben oder Schriften, wenn es nicht verlangt ist.` : "",
    "Inhalt aus der Wissensbasis darfst du mit den Lesewerkzeugen suchen (skill_search, docs_search, memory_search …); erfinde keine Fakten. Schreibe in der Sprache des Dokuments bzw. der Anfrage.",
    "",
    "## Anfrage",
    o.request,
    ...(o.history?.length ? ["", "## Frühere Anfragen an diesem Entwurf", ...o.history.map((h) => `- ${truncate(h, 300)}`)] : []),
    "",
    "## Aktueller Stand",
    o.info.outline || "(leer)",
    ...(o.family === "pptx" && o.info.layouts.length ? ["", `Layouts: ${o.info.layouts.join(", ")}`] : []),
    ...(o.family === "docx" && o.info.styles.length ? ["", `Formatvorlagen: ${o.info.styles.slice(0, 60).join(", ")}`] : []),
    "",
    "## Antwort",
    o.family === "pptx" ? PPTX_OPS : DOCX_OPS,
    "",
    'Antworte mit genau einem JSON-Block: ```json\n{"summary": "was du geändert hast, 1–2 Sätze", "ops": [ … ]}\n```',
  ]
    .filter((x) => x !== "")
    .join("\n")
}
