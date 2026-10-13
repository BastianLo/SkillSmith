/**
 * Web view of skillsmith (/smith-web): the knowledge workplace – documents with editor,
 * board, agents, pipeline, statistics, audit log, versions, graph.
 *
 * Security (writes need all five checks; every value is an option):
 *  1. address: binds to web.host (127.0.0.1); another host only with the token,
 *  2. host header: web.allowedHosts with the port, otherwise 421 (DNS rebinding),
 *  3. token: header x-smith-token, constant-time compare, new on every start
 *     (web.tokenRotate) – switchable with web.token; agent start, approvals and pipeline
 *     changes still need it (tasks.requireToken, pipeline.requireToken),
 *  4. origin: POST needs Origin of this server (web.checkOrigin), Sec-Fetch-Site same-origin,
 *     OPTIONS is never allowed,
 *  5. content: only application/json up to web.maxBodyKB (uploads: octet-stream up to
 *     docs.attachmentMaxMB).
 * Strict CSP without inline scripts; security events go to the audit log (throttled).
 */
import { randomBytes, timingSafeEqual } from "node:crypto"
import { existsSync, readFileSync, statSync, chmodSync } from "node:fs"
import { basename, dirname, extname, join, normalize, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { ActionError, executeAction, needsStrongToken, toActionError, type ActionRequest } from "../core/actions"
import type { Ctx } from "../core/context"
import { ATTACHMENT_DIR } from "../core/store"
import { OFFICE_MIME } from "../core/office"
import { str } from "../core/frontmatter"
import { readJson, writeJsonAtomic } from "../util/fs"
import { errorMessage, nowIso, shortId, slugify } from "../util/text"
import { NotFound, ReadApi } from "./api"
import { LiveFeed } from "./live"

const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "static")
const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
}
const ATTACHMENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
}
const TEXT_ATTACHMENT = /\.(txt|md|csv|log|json|svg)$/i
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; worker-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

export interface WebInfo {
  url: string
  port: number
  token: string
  pid: number
  directory: string
  startedAt: string
  host?: string
}

type Json = object

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export class WebServer {
  private server?: { stop(force?: boolean): void; port: number }
  info?: WebInfo
  private readonly file: string
  readonly api: (path: string, q: URLSearchParams) => Promise<Json>
  private readApi: ReadApi
  private live: LiveFeed

  constructor(private ctx: Ctx) {
    this.file = join(ctx.store.stateDir, "web.json")
    this.readApi = new ReadApi(ctx)
    this.api = (path, q) => this.readApi.get(path, q)
    this.live = new LiveFeed(ctx)
  }

  get running(): boolean {
    return !!this.server
  }

  /** Start (or reuse a server another opencode process already runs on this store). */
  async start(): Promise<WebInfo> {
    if (this.server && this.info) return this.info
    const o = this.ctx.options.web
    if (o.host !== "127.0.0.1" && !o.token) throw new Error(`web.host ${o.host} ohne Token ist nicht erlaubt (web.token: true setzen)`)
    const other = readJson<WebInfo | null>(this.file, null)
    if (other && other.pid !== process.pid && alive(other.pid)) {
      try {
        const r = await fetch(`http://127.0.0.1:${other.port}/api/ping`, { headers: { "x-smith-token": other.token }, signal: AbortSignal.timeout(1500) })
        if (r.ok) return other
      } catch {
        // stale file – start our own
      }
    }
    const Bun = (globalThis as any).Bun
    if (!Bun?.serve) throw new Error("the web view needs the Bun runtime (opencode runs plugins in Bun)")
    const token = !o.tokenRotate && other?.token && /^[0-9a-f]{48}$/.test(other.token) ? other.token : randomBytes(24).toString("hex")
    const base = o.port
    let lastErr: unknown
    for (let port = base; port <= base + o.portFallback; port++) {
      try {
        this.server = Bun.serve({ hostname: o.host, port, idleTimeout: 0, fetch: (req: Request) => this.handle(req, port, token) })
        // the token is always part of the link: with web.token off it is only needed for strong actions
        const link = `http://${o.host === "0.0.0.0" ? "127.0.0.1" : o.host}:${port}/#t=${token}`
        this.info = { url: link, port, token, pid: process.pid, directory: this.ctx.directory, startedAt: nowIso(), host: o.host }
        writeJsonAtomic(this.file, this.info)
        // the token: readable by this user only (the smith CLI reads it)
        chmodPrivate(this.file)
        this.ctx.log.info(`web view on http://${o.host}:${port}`)
        this.ctx.audit?.append({ actor: "system", category: "security", action: "web-start", result: "ok", message: `Weboberfläche auf ${o.host}:${port}${o.token ? "" : " – ohne Token"}${o.readOnly ? " · nur lesend" : ""}` })
        return this.info
      } catch (err) {
        lastErr = err
      }
    }
    throw new Error(`no free port in ${base}–${base + o.portFallback}: ${errorMessage(lastErr)}`)
  }

  stop(): void {
    if (!this.server) return
    try {
      this.server.stop(true)
    } catch {
      // ignore
    }
    this.server = undefined
    this.live.stop()
    const cur = readJson<WebInfo | null>(this.file, null)
    if (cur?.pid === process.pid) {
      try {
        // keep the token for tokenRotate: false (bookmarks keep working)
        writeJsonAtomic(this.file, this.ctx.options.web.tokenRotate ? {} : { token: cur.token })
        chmodPrivate(this.file)
      } catch {
        // ignore
      }
    }
    this.ctx.audit?.append({ actor: "system", category: "security", action: "web-stop", result: "ok", message: "Weboberfläche gestoppt" })
    this.info = undefined
  }

  private headers(type: string, extra: Record<string, string> = {}): Record<string, string> {
    return {
      "content-type": type,
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "cross-origin-resource-policy": "same-origin",
      "cross-origin-opener-policy": "same-origin",
      ...extra,
    }
  }

  private json(status: number, body: Json): Response {
    return new Response(JSON.stringify(body), { status, headers: this.headers("application/json; charset=utf-8", { "cache-control": "no-store" }) })
  }

  private allowedOrigins(port: number): string[] {
    return this.ctx.options.web.allowedHosts.map((h) => `http://${h}:${port}`)
  }

  /** Request handler (public for tests). */
  async handle(req: Request, port: number, token: string): Promise<Response> {
    const o = this.ctx.options.web
    const url = new URL(req.url)
    const host = req.headers.get("host") ?? ""
    if (!o.allowedHosts.some((h) => host === `${h}:${port}`)) {
      this.ctx.audit?.security("host", `fremder Host: ${host.slice(0, 120)}`)
      return new Response("invalid host", { status: 421 })
    }
    const origin = req.headers.get("origin")
    const origins = this.allowedOrigins(port)
    if (origin && !origins.includes(origin)) {
      this.ctx.audit?.security("origin", `fremde Herkunft: ${origin.slice(0, 120)}`)
      return new Response("invalid origin", { status: 403 })
    }
    if (req.method === "OPTIONS") return new Response("preflight not allowed", { status: 405, headers: { allow: "GET, HEAD, POST" } })
    const isPost = req.method === "POST"
    const writePath = url.pathname === "/api/action" || url.pathname === "/api/upload" || url.pathname === "/api/import" || url.pathname === "/api/office/upload" || url.pathname === "/api/office/save" || url.pathname === "/api/skill/upload"
    if (req.method !== "GET" && req.method !== "HEAD" && !(isPost && writePath)) return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD, POST" } })
    if (!url.pathname.startsWith("/api/")) return this.staticFile(url.pathname)
    const given = req.headers.get("x-smith-token") ?? ""
    const hasToken = !!given && sameToken(given, token)
    if (given && !hasToken) {
      this.ctx.audit?.security("token", "falscher Token")
      return this.json(401, { error: "Token falsch – den Link aus /smith-web öffnen", code: "token" })
    }
    if (o.token && !hasToken) {
      if (url.pathname !== "/api/ping") this.ctx.audit?.security("token", "Anfrage ohne Token")
      return this.json(401, { error: "Token fehlt – den Link aus /smith-web öffnen", code: "token" })
    }
    if (isPost) {
      // CSRF: own origin required, browsers' fetch metadata must say same-origin
      if (o.checkOrigin && (!origin || !origins.includes(origin))) {
        this.ctx.audit?.security("origin", `POST ohne passende Herkunft (${origin ?? "keine"})`)
        return this.json(403, { error: "Herkunft fehlt oder ist fremd" })
      }
      const site = req.headers.get("sec-fetch-site")
      if (site && site !== "same-origin") {
        this.ctx.audit?.security("origin", `Sec-Fetch-Site ${site}`)
        return this.json(403, { error: "nur aus der Weboberfläche selbst" })
      }
      if (url.pathname.startsWith("/api/office/")) return this.officeUpload(req, url)
      if (url.pathname === "/api/skill/upload") return this.skillUpload(req, url)
      return url.pathname === "/api/action" ? this.action(req, hasToken) : url.pathname === "/api/import" ? this.importUpload(req, url) : this.upload(req, url)
    }
    try {
      if (url.pathname === "/api/events") {
        if (!o.liveUpdates) return this.json(404, { error: "Live-Aktualisierung ist aus (web.liveUpdates)" })
        return this.live.stream(Number(req.headers.get("last-event-id") ?? url.searchParams.get("since") ?? 0) || 0, this.headers("text/event-stream; charset=utf-8"))
      }
      if (url.pathname === "/api/attachment") return this.attachment(url.searchParams.get("path") ?? "")
      if (url.pathname === "/api/office/file") return await this.officeFile(url.searchParams)
      if (url.pathname === "/api/download") return this.download(url.searchParams.get("file") ?? "")
      return this.json(200, await this.api(url.pathname.slice(5), url.searchParams))
    } catch (err) {
      if (err instanceof NotFound) return this.json(404, { error: err.message })
      if (err instanceof ActionError) return this.json(err.status, { error: err.message, ...err.body })
      const msg = errorMessage(err)
      if (/invalid revision|invalid commit hash|not found|Datum als/i.test(msg)) return this.json(400, { error: msg })
      this.ctx.log.warn(`web api ${url.pathname} failed`, msg)
      return this.json(500, { error: msg })
    }
  }

  private async body(req: Request, max: number): Promise<Uint8Array> {
    const len = Number(req.headers.get("content-length") ?? 0)
    if (len > max) throw new ActionError(413, `Anfrage größer als ${Math.round(max / 1024)} KB`)
    const buf = new Uint8Array(await req.arrayBuffer())
    if (buf.length > max) throw new ActionError(413, `Anfrage größer als ${Math.round(max / 1024)} KB`)
    return buf
  }

  private async action(req: Request, hasToken: boolean): Promise<Response> {
    try {
      const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
      if (type !== "application/json") return this.json(415, { error: "nur application/json" })
      const raw = await this.body(req, this.ctx.options.web.maxBodyKB * 1024)
      let input: ActionRequest
      try {
        input = JSON.parse(new TextDecoder().decode(raw))
      } catch {
        return this.json(400, { error: "ungültiges JSON" })
      }
      if (!input || typeof input !== "object" || typeof input.action !== "string") return this.json(400, { error: "action fehlt" })
      if (!hasToken && needsStrongToken(this.ctx, input)) return this.json(401, { error: "Diese Aktion braucht den Token, auch wenn web.token aus ist – den Link aus /smith-web öffnen", code: "token-required" })
      const result = await executeAction({ ctx: this.ctx, actor: "web" }, input)
      return this.json(200, result)
    } catch (err) {
      const e = toActionError(err)
      if (e.status >= 500) this.ctx.log.warn(`web action failed`, e.message)
      return this.json(e.status, { error: e.message, ...e.body })
    }
  }

  /** Document import (5h): raw bytes of the file (PDF: the text per page as JSON from pdf.js). */
  private async importUpload(req: Request, url: URL): Promise<Response> {
    const ctx = this.ctx
    try {
      if (ctx.options.web.readOnly) return this.json(403, { error: "Die Weboberfläche ist nur lesend" })
      const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
      if (type !== "application/octet-stream") return this.json(415, { error: "nur application/octet-stream" })
      const data = await this.body(req, Math.round(ctx.options.import.maxMB * 1024 * 1024) + 1024)
      const result = await executeAction({ ctx, actor: "web" }, { action: "import.create", args: { name: (url.searchParams.get("name") ?? "").slice(0, 200), ai: url.searchParams.get("ai") || undefined } }, data)
      return this.json(200, result)
    } catch (err) {
      const e = toActionError(err)
      return this.json(e.status, { error: e.message })
    }
  }

  /** Office documents: upload a new file or save the editor's file as a new version (raw bytes). */
  private async officeUpload(req: Request, url: URL): Promise<Response> {
    const ctx = this.ctx
    try {
      if (ctx.options.web.readOnly) return this.json(403, { error: "Die Weboberfläche ist nur lesend" })
      const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
      if (type !== "application/octet-stream") return this.json(415, { error: "nur application/octet-stream" })
      const data = await this.body(req, Math.round(ctx.options.office.maxMB * 1024 * 1024))
      const q = url.searchParams
      const input =
        url.pathname === "/api/office/save"
          ? { action: "office.save", args: { target: q.get("target") ?? "", reason: q.get("reason") || undefined }, base: q.get("base") || undefined }
          : { action: "office.upload", args: { fileName: (q.get("name") ?? "").slice(0, 200), title: q.get("title") || undefined, ai: q.get("ai") || undefined } }
      const result = await executeAction({ ctx, actor: "web" }, input as ActionRequest, data)
      return this.json(200, result)
    } catch (err) {
      const e = toActionError(err)
      return this.json(e.status, { error: e.message, ...e.body })
    }
  }

  /** Skill package upload: .zip/.skill, SKILL.md or a folder as JSON (raw bytes, one commit). */
  private async skillUpload(req: Request, url: URL): Promise<Response> {
    const ctx = this.ctx
    try {
      if (ctx.options.web.readOnly) return this.json(403, { error: "Die Weboberfläche ist nur lesend" })
      const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
      if (type !== "application/octet-stream") return this.json(415, { error: "nur application/octet-stream" })
      const data = await this.body(req, 16 * 1024 * 1024)
      const q = url.searchParams
      const result = await executeAction({ ctx, actor: "web" }, { action: "skill.upload", args: { fileName: (q.get("name") ?? "").slice(0, 200), force: q.get("force") === "1" || undefined } } as ActionRequest, data)
      return this.json(200, result)
    } catch (err) {
      const e = toActionError(err)
      return this.json(e.status, { error: e.message, ...e.body })
    }
  }

  /** The file of an office document: current, a version (commit) or the AI draft. */
  private async officeFile(q: URLSearchParams): Promise<Response> {
    const office = this.ctx.office
    if (!office) return this.json(404, { error: "Office-Dokumente nicht verfügbar" })
    const id = q.get("id") ?? ""
    const name = id.startsWith("office:") ? id.slice(7) : id
    const e = this.ctx.store.getOwned("office", name)
    if (!e) return this.json(404, { error: "Office-Dokument nicht gefunden" })
    const format = office.formatOf(e)
    const commit = q.get("commit")
    const bytes = q.get("draft") === "1" ? office.draftBytes(name) : commit ? await office.bytesAt(e, commit) : office.bytes(e)
    if (!bytes) return this.json(404, { error: "kein Entwurf" })
    return new Response(bytes, {
      headers: this.headers(OFFICE_MIME[format], { "cache-control": "no-store", "content-disposition": `attachment; filename="${str(e.fields.file) || `${name}.${format}`}"`, "content-security-policy": "default-src 'none'; sandbox" }),
    })
  }

  /** Attachment upload: raw bytes, stored below knowledge/_anhaenge/<YYYY-MM>/ (one commit). */
  private async upload(req: Request, url: URL): Promise<Response> {
    const ctx = this.ctx
    try {
      if (ctx.options.web.readOnly) return this.json(403, { error: "Die Weboberfläche ist nur lesend" })
      const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
      if (type !== "application/octet-stream") return this.json(415, { error: "nur application/octet-stream" })
      const nameRaw = url.searchParams.get("name") ?? ""
      const ext = extname(nameRaw).toLowerCase()
      if (!ATTACHMENT_TYPES[ext]) return this.json(415, { error: `Dateityp ${ext || "?"} nicht erlaubt (${Object.keys(ATTACHMENT_TYPES).join(" ")})` })
      const data = await this.body(req, Math.round(ctx.options.docs.attachmentMaxMB * 1024 * 1024))
      if (!data.length) return this.json(400, { error: "leere Datei" })
      if (TEXT_ATTACHMENT.test(ext)) {
        const secrets = ctx.redactor.scan(new TextDecoder().decode(data))
        if (secrets.length) return this.json(422, { error: `Die Datei enthält vertrauliche Daten (${secrets.join(", ")})` })
      }
      const month = new Date().toISOString().slice(0, 7)
      const file = `${slugify(basename(nameRaw, extname(nameRaw)), 50) || "anhang"}-${shortId(4)}${ext}`
      const rel = `knowledge/${ATTACHMENT_DIR}/${month}/${file}`
      const target = url.searchParams.get("target") ?? ""
      const result = await executeAction({ ctx, actor: "web" }, { action: "attachment.add", args: { path: rel, target: target || undefined, name: nameRaw.slice(0, 200) } }, data)
      return this.json(200, result)
    } catch (err) {
      const e = toActionError(err)
      return this.json(e.status, { error: e.message })
    }
  }

  private attachment(path: string): Response {
    const rel = path.replace(/^\/+/, "")
    if (!/^[A-Za-z0-9._/-]+$/.test(rel) || rel.split("/").includes("..")) return this.json(400, { error: "ungültiger Pfad" })
    const base = join(this.ctx.store.root, "knowledge", ATTACHMENT_DIR)
    const full = normalize(join(base, rel))
    if (!full.startsWith(base + sep) || !existsSync(full)) return this.json(404, { error: "Anhang nicht gefunden" })
    const type = ATTACHMENT_TYPES[extname(full).toLowerCase()] ?? "application/octet-stream"
    return new Response(readFileSync(full), {
      headers: this.headers(type, { "cache-control": "private, max-age=3600", "content-disposition": `${/^image\/(?!svg)/.test(type) ? "inline" : "attachment"}; filename="${basename(full)}"`, "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" }),
    })
  }

  private download(file: string): Response {
    const base = resolve(this.ctx.store.stateDir, "exports")
    const full = resolve(base, file)
    if (!full.startsWith(base + sep) || !existsSync(full) || !statSync(full).isFile()) return this.json(404, { error: "Datei nicht gefunden" })
    const ext = extname(full).toLowerCase()
    return new Response(readFileSync(full), { headers: this.headers(ext === ".html" ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8", { "content-disposition": `attachment; filename="${basename(full)}"`, "cache-control": "no-store" }) })
  }

  private staticFile(path: string): Response {
    let rel: string
    try {
      rel = decodeURIComponent(path === "/" || path === "" ? "index.html" : path.replace(/^\/+/, ""))
    } catch {
      return new Response("not found", { status: 404 })
    }
    const full = normalize(join(STATIC_DIR, rel))
    if (!full.startsWith(STATIC_DIR + sep) || !existsSync(full) || !statSync(full).isFile()) return new Response("not found", { status: 404, headers: this.headers("text/plain; charset=utf-8") })
    const type = STATIC_TYPES[extname(full)]
    if (!type) return new Response("not found", { status: 404 })
    return new Response(readFileSync(full), { headers: this.headers(type, { "cache-control": rel.startsWith("vendor/") ? "max-age=86400" : "no-cache" }) })
  }
}

function chmodPrivate(file: string): void {
  try {
    chmodSync(file, 0o600)
  } catch {
    // best effort (filesystems without modes)
  }
}
