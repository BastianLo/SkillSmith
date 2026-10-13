// API client of the web view: token handling, reads, actions, uploads and the live stream.
// The token travels only in the x-smith-token header (never in a URL the server logs).

const TOKEN_KEY = `skillsmith-token-${location.port}`
let tokenMem = ""

export function takeToken() {
  const m = /(?:^#|[#&])t=([0-9a-f]{20,})/.exec(location.hash)
  if (!m) return false
  setToken(m[1])
  history.replaceState(null, "", `${location.pathname}#/`)
  return true
}

export function setToken(t) {
  tokenMem = t
  try {
    localStorage.setItem(TOKEN_KEY, t)
  } catch (_) {
    // private mode: memory only
  }
}

export function token() {
  if (tokenMem) return tokenMem
  try {
    return localStorage.getItem(TOKEN_KEY) || ""
  } catch (_) {
    return ""
  }
}

function headers(extra = {}) {
  const t = token()
  return { ...(t ? { "x-smith-token": t } : {}), ...extra }
}

export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error) || `HTTP ${status}`)
    this.status = status
    this.body = body || {}
  }
}

const qs = (params) => {
  if (!params) return ""
  const p = new URLSearchParams()
  // "" is kept (e.g. folder="" = main folder); undefined/null/false are left out
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== false) p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ""
}

async function parse(r) {
  let body = {}
  try {
    body = await r.json()
  } catch (_) {
    body = {}
  }
  if (!r.ok) throw new ApiError(r.status, body)
  return body
}

/** GET /api/<path> */
export async function get(path, params) {
  const r = await fetch(`/api/${path}${qs(params)}`, { headers: headers() })
  return parse(r)
}

/** POST /api/action – throws ApiError (409 conflict, 428 confirmation, 422 guard, 401 token, 403 read-only). */
export async function post(action, args = {}, opts = {}) {
  const body = { action, args }
  if (opts.target !== undefined) body.target = opts.target
  if (opts.base) body.base = opts.base
  if (opts.preview) body.preview = true
  if (opts.force) body.force = true
  const r = await fetch("/api/action", { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify(body) })
  return parse(r)
}

/** Attachment upload (raw bytes). */
export async function upload(file, target) {
  const r = await fetch(`/api/upload${qs({ name: file.name || "anhang.png", target })}`, {
    method: "POST",
    headers: headers({ "content-type": "application/octet-stream" }),
    body: file,
  })
  return parse(r)
}

/** Document import (5h): raw bytes (PDF: JSON with the text per page). */
export async function importFile(name, body, ai) {
  const r = await fetch(`/api/import${qs({ name, ai })}`, { method: "POST", headers: headers({ "content-type": "application/octet-stream" }), body })
  return parse(r)
}

const blobCache = new Map()
/** Attachment as object URL (images in the preview; <img src> cannot send the token header). */
export async function attachmentUrl(path) {
  if (blobCache.has(path)) return blobCache.get(path)
  const p = (async () => {
    const r = await fetch(`/api/attachment${qs({ path })}`, { headers: headers() })
    if (!r.ok) throw new ApiError(r.status, {})
    return URL.createObjectURL(await r.blob())
  })()
  blobCache.set(path, p)
  p.catch(() => blobCache.delete(path))
  return p
}

/** Download a file through fetch (token header) and hand it to the browser. */
export async function download(url, filename) {
  const r = await fetch(url, { headers: headers() })
  if (!r.ok) throw new ApiError(r.status, await r.json().catch(() => ({})))
  const blob = await r.blob()
  saveBlob(blob, filename)
}

export function saveBlob(blob, filename) {
  const a = document.createElement("a")
  a.href = URL.createObjectURL(blob)
  a.download = filename
  document.body.append(a)
  a.click()
  setTimeout(() => {
    URL.revokeObjectURL(a.href)
    a.remove()
  }, 1000)
}

// ---------------------------------------------------------------------------
// live stream: server-sent events read over fetch (the token stays in the header)
// ---------------------------------------------------------------------------
const listeners = new Map()
let lastId = 0
let state = "idle"
const stateListeners = new Set()

export function onLive(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set())
  listeners.get(type).add(fn)
  return () => listeners.get(type)?.delete(fn)
}

export function onLiveState(fn) {
  stateListeners.add(fn)
  fn(state)
  return () => stateListeners.delete(fn)
}

function setState(s) {
  state = s
  for (const fn of stateListeners) fn(s)
}

function dispatch(type, data) {
  for (const key of [type, "*"]) {
    for (const fn of listeners.get(key) ?? []) {
      try {
        fn(data, type)
      } catch (err) {
        console.error(err)
      }
    }
  }
}

export async function startLive() {
  let delay = 1500
  for (;;) {
    try {
      const r = await fetch(`/api/events`, { headers: headers({ accept: "text/event-stream", ...(lastId ? { "last-event-id": String(lastId) } : {}) }) })
      if (r.status === 404) {
        setState("disabled")
        return
      }
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`)
      setState("on")
      delay = 1500
      const reader = r.body.getReader()
      const dec = new TextDecoder()
      let buf = ""
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i)
          buf = buf.slice(i + 2)
          let type = "message"
          let data = ""
          let id = 0
          for (const line of chunk.split("\n")) {
            if (line.startsWith("event: ")) type = line.slice(7)
            else if (line.startsWith("data: ")) data += line.slice(6)
            else if (line.startsWith("id: ")) id = Number(line.slice(4)) || 0
          }
          if (id) lastId = id
          if (!data) continue
          try {
            dispatch(type, JSON.parse(data))
          } catch (_) {
            // ignore malformed event
          }
        }
      }
      throw new Error("closed")
    } catch (_) {
      setState("off")
      await new Promise((res) => setTimeout(res, delay))
      delay = Math.min(30_000, delay * 1.6)
    }
  }
}
