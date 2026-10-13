// Shared UI: toasts, dialogs, the action runner (confirmations, conflicts, undo), menus, popovers.
import { ApiError, get, post, setToken } from "./api.js"
import { entryHref, fmtDate, h, icon, kindChip, put, swap, truncate } from "./dom.js"

export const app = {
  info: null,
  catalog: new Map(),
  readOnly: false,
}

// ---------------------------------------------------------------------------
// toasts
// ---------------------------------------------------------------------------
export function toast(message, opts = {}) {
  const box = document.getElementById("toasts")
  const el = h(
    "div",
    { class: `toast ${opts.variant || ""}`, role: "status" },
    h(
      "div",
      { class: "t-body" },
      opts.title ? h("div", { class: "t-title", text: opts.title }) : null,
      h("div", { text: message }),
      opts.actions?.length
        ? h(
            "div",
            { class: "t-actions" },
            opts.actions.map((a) =>
              h("button", {
                class: "btn sm",
                type: "button",
                text: a.label,
                onclick: () => {
                  close()
                  a.run()
                },
              }),
            ),
          )
        : null,
    ),
    h("button", { class: "btn ghost icon sm", type: "button", "aria-label": "Schließen", onclick: () => close() }, icon("x", 14)),
  )
  const close = () => el.remove()
  box.append(el)
  const ms = opts.duration ?? (opts.variant === "error" ? 12000 : opts.actions?.length ? 9000 : 4500)
  if (ms > 0) setTimeout(close, ms)
  return close
}

export const toastError = (err) => toast(errorText(err), { variant: "error", title: err?.status === 403 ? "Nicht erlaubt" : err?.status === 422 ? "Abgelehnt" : "Fehler" })

export function errorText(err) {
  if (!err) return "Unbekannter Fehler"
  if (err.status === 401) return "Kein Zugriff – bitte den Link aus /smith-web in opencode öffnen (er enthält den Zugangsschlüssel)."
  return String(err.message || err)
}

export function announce(text) {
  const el = document.getElementById("announce")
  if (el) el.textContent = text
}

// ---------------------------------------------------------------------------
// dialogs
// ---------------------------------------------------------------------------
const openModals = new Set()

/** Close every open dialog (the router calls this when the page changes). */
export function closeModals() {
  for (const close of [...openModals]) close(undefined)
}

/** Generic modal. `build(close)` returns {title, body, foot, wide}. Resolves with the value given to close(). */
export function modal(build) {
  return new Promise((resolve) => {
    const prev = document.activeElement
    const overlay = h("div", { class: "overlay", role: "dialog", "aria-modal": "true" })
    let done = false
    const close = (v) => {
      if (done) return
      done = true
      openModals.delete(close)
      overlay.remove()
      document.removeEventListener("keydown", onKey, true)
      if (prev && prev.focus) prev.focus()
      resolve(v)
    }
    openModals.add(close)
    const spec = build(close)
    const dialog = h(
      "div",
      { class: `dialog ${spec.wide === true ? "wide" : spec.wide || ""} ${spec.class || ""}` },
      spec.title !== undefined ? h("div", { class: "dialog-head" }, h("h2", { class: "grow", text: spec.title }), h("button", { class: "btn ghost icon", type: "button", "aria-label": "Schließen", onclick: () => close(undefined) }, icon("x"))) : null,
      spec.raw ? spec.raw : h("div", { class: "dialog-body" }, spec.body),
      spec.foot ? h("div", { class: "dialog-foot" }, spec.foot) : null,
    )
    overlay.append(dialog)
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close(undefined)
    })
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        close(undefined)
      }
    }
    document.addEventListener("keydown", onKey, true)
    document.body.append(overlay)
    const focus = dialog.querySelector("[autofocus], input, textarea, select, .btn.primary")
    if (focus) setTimeout(() => focus.focus(), 0)
  })
}

export function confirmDialog(message, { title = "Bestätigen", ok = "OK", danger = false, detail } = {}) {
  return modal((close) => ({
    title,
    body: [h("p", { text: message }), detail || null],
    foot: [h("button", { class: "btn", type: "button", text: "Abbrechen", onclick: () => close(false) }), h("button", { class: `btn ${danger ? "danger solid" : "primary"}`, type: "button", text: ok, onclick: () => close(true) })],
  })).then((v) => !!v)
}

export function promptDialog(title, { label, value = "", placeholder = "", multiline = false, ok = "OK", hint, required = true } = {}) {
  return modal((close) => {
    const input = multiline ? h("textarea", { class: "input", rows: 6, placeholder, value }) : h("input", { class: "input wide", placeholder, value })
    const submit = () => {
      const v = input.value.trim()
      if (required && !v) return input.focus()
      close(v)
    }
    if (!multiline) input.addEventListener("keydown", (e) => e.key === "Enter" && submit())
    return {
      title,
      body: [label ? h("div", { class: "field" }, h("label", { text: label }), input, hint ? h("div", { class: "hint", text: hint }) : null) : input],
      foot: [h("button", { class: "btn", type: "button", text: "Abbrechen", onclick: () => close(undefined) }), h("button", { class: "btn primary", type: "button", text: ok, onclick: submit })],
    }
  })
}

/** "Type the name" confirmation (final delete, metrics). */
export function typeNameDialog(message, name, ok = "Endgültig löschen") {
  return modal((close) => {
    const input = h("input", { class: "input wide", placeholder: name, autocomplete: "off" })
    const btn = h("button", { class: "btn danger solid", type: "button", text: ok, disabled: true, onclick: () => close(input.value) })
    input.addEventListener("input", () => (btn.disabled = input.value !== name))
    input.addEventListener("keydown", (e) => e.key === "Enter" && input.value === name && close(input.value))
    return { title: "Bestätigen", body: [h("p", { text: message }), h("p", null, "Zum Bestätigen ", h("strong", { class: "mono", text: name }), " eintippen:"), input], foot: [h("button", { class: "btn", type: "button", text: "Abbrechen", onclick: () => close(undefined) }), btn] }
  })
}

// lazily loaded diff renderer (keeps the shell small)
async function diffModule() {
  return import("./diff.js")
}

/** Preview of an action (diff, affected entries) before running it. */
export async function previewDialog(label, preview) {
  const { renderEntryDiff, renderFileDiffs } = await diffModule()
  const body = []
  if (preview?.message) body.push(h("p", { text: preview.message }))
  const d = preview?.diff
  if (d && d.body) body.push(renderEntryDiff(d))
  else if (Array.isArray(d)) body.push(renderFileDiffs(d))
  if (preview?.affected?.length) {
    body.push(h("h3", { text: `Betroffen (${preview.affected.length})` }), h("div", { class: "list" }, preview.affected.map((a) => h("a", { class: "row", href: entryHref(a.id), target: "_blank" }, kindChip({ id: a.id }), h("div", { class: "main" }, h("div", { class: "title", text: a.title || a.id }), a.detail ? h("div", { class: "desc", text: a.detail }) : null)))))
  }
  if (!body.length) body.push(h("p", { class: "muted", text: "Keine Vorschau verfügbar." }))
  if (preview?.confirmName) {
    const name = await typeNameDialog(preview.message || label, preview.confirmName)
    return name ? { name } : false
  }
  return modal((close) => ({
    title: label,
    wide: true,
    body,
    foot: [h("button", { class: "btn", type: "button", text: "Abbrechen", onclick: () => close(false) }), h("button", { class: "btn primary", type: "button", text: "Ausführen", onclick: () => close(true) })],
  }))
}

/** Ask for the token (strong actions while web.token is off, or a missing token). */
export async function askToken() {
  const t = await promptDialog("Zugangsschlüssel", { label: "Token aus dem Link von /smith-web (der Teil nach #t=)", placeholder: "48 Zeichen", ok: "Übernehmen", hint: "Agenten starten und freigeben sowie Pipeline-Befehle ändern brauchen den Token immer." })
  if (!t) return false
  const m = /([0-9a-f]{20,})/.exec(t)
  if (!m) return false
  setToken(m[1])
  return true
}

const CONFIRM_ARG = { "script.publish": "approveRisky" }

/**
 * Run an action from the catalog with every safety step:
 * catalog confirmation (preview / type the name), 428 confirmation (WIP limit, red pipeline …),
 * 409 conflict (another run was faster), 401 token-required, success toast with undo.
 */
export async function act(action, args = {}, opts = {}) {
  const def = app.catalog.get(action)
  if (app.readOnly && def && !opts.allowReadOnly && action !== "system.lock" && !["chat.ask"].includes(action)) {
    toast("Schreiben ist gesperrt (nur lesend).", { variant: "warning" })
    return null
  }
  try {
    if (!opts.skipConfirm && def && def.confirm === "preview") {
      const p = await post(action, args, { ...opts, preview: true })
      const ok = await previewDialog(opts.label || def.label, p.preview)
      if (!ok) return null
      if (ok && ok.name) args = { ...args, confirm: ok.name }
    }
    if (!opts.skipConfirm && def && def.confirm === "name" && opts.confirmName && args.confirm === undefined) {
      const name = await typeNameDialog(opts.confirmText || `${def.label}: ${opts.confirmName}`, opts.confirmName)
      if (!name) return null
      args = { ...args, confirm: name }
    }
    const r = await post(action, args, opts)
    if (!opts.quiet) {
      const actions = []
      if (r.commit && r.run && !opts.noUndo && action !== "run.undo") actions.push({ label: "Rückgängig", run: () => act("run.undo", { run: r.run }) })
      if (r.open && opts.offerOpen) actions.push({ label: "Öffnen", run: () => (location.hash = r.open) })
      toast(opts.success || r.message || "Erledigt", { variant: "success", title: r.commit ? `Gespeichert · ${r.commit.slice(0, 8)}` : undefined, actions })
      for (const w of r.warnings ?? []) toast(w, { variant: "warning" })
    }
    return r
  } catch (err) {
    if (!(err instanceof ApiError)) {
      toastError(err)
      return null
    }
    if (err.status === 428) {
      const ok = await confirmDialog(err.message, { title: "Bitte bestätigen", ok: "Trotzdem ausführen", danger: true })
      if (!ok) return null
      const key = CONFIRM_ARG[action] || "force"
      return act(action, { ...args, [key]: true }, { ...opts, skipConfirm: true })
    }
    if (err.status === 401 && (err.body.code === "token-required" || err.body.code === "token")) {
      if (await askToken()) return act(action, args, { ...opts, skipConfirm: true })
      return null
    }
    if (err.status === 409 && err.body.conflict) {
      if (opts.onConflict) return opts.onConflict(err.body)
      const choice = await conflictDialog(err.body)
      if (choice === "overwrite") return act(action, args, { ...opts, force: true, skipConfirm: true })
      if (choice === "reload" && opts.onReload) opts.onReload(err.body)
      return null
    }
    if (opts.onError) return opts.onError(err)
    toastError(err)
    return null
  }
}

/** 409: someone else changed the entry since you opened it. */
export async function conflictDialog(body, { mine } = {}) {
  const { renderEntryDiff } = await diffModule()
  return modal((close) => ({
    title: "Inzwischen geändert",
    wide: true,
    body: [
      h("p", null, "Der Eintrag wurde geändert, nachdem Sie ihn geöffnet haben", body.changedBy ? h("span", null, " – ", h("strong", { text: body.changedBy })) : null, body.changedAt ? ` (${fmtDate(body.changedAt)})` : "", "."),
      body.diff ? [h("h3", { text: "Änderung seit Ihrer Version" }), renderEntryDiff(body.diff)] : h("p", { class: "muted", text: "Der Unterschied lässt sich nicht anzeigen." }),
      mine ? h("p", { class: "muted", text: "Ihre Änderung bleibt im Editor erhalten." }) : null,
    ],
    foot: [
      h("span", { class: "left", text: "Überschreiben ersetzt die fremde Änderung." }),
      h("button", { class: "btn", type: "button", text: "Abbrechen", onclick: () => close("cancel") }),
      h("button", { class: "btn", type: "button", text: "Neu laden und meine Änderung übertragen", onclick: () => close("reload") }),
      h("button", { class: "btn danger", type: "button", text: "Überschreiben", onclick: () => close("overwrite") }),
    ],
  }))
}

// ---------------------------------------------------------------------------
// menus and popovers
// ---------------------------------------------------------------------------
let openMenu = null
export function menu(anchor, items) {
  if (openMenu) openMenu()
  const r = anchor.getBoundingClientRect()
  const el = h(
    "div",
    { class: "menu", role: "menu" },
    items.filter(Boolean).map((it) =>
      it === "-"
        ? h("hr")
        : h("button", {
            type: "button",
            role: "menuitem",
            class: it.danger ? "danger" : "",
            disabled: it.disabled,
            onclick: () => {
              close()
              it.run()
            },
          }, it.icon ? icon(it.icon, 14) : null, it.label),
    ),
  )
  document.body.append(el)
  const w = el.offsetWidth
  el.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`
  el.style.top = `${Math.min(window.innerHeight - el.offsetHeight - 8, r.bottom + 4)}px`
  const onDoc = (e) => {
    if (!el.contains(e.target)) close()
  }
  const onKey = (e) => e.key === "Escape" && close()
  setTimeout(() => {
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onKey)
  }, 0)
  const close = () => {
    el.remove()
    document.removeEventListener("mousedown", onDoc)
    document.removeEventListener("keydown", onKey)
    openMenu = null
  }
  openMenu = close
  el.querySelector("button")?.focus()
  return close
}

export function moreButton(items, label = "Weitere Aktionen") {
  const btn = h("button", { class: "btn icon", type: "button", "aria-label": label, title: label }, icon("more"))
  btn.addEventListener("click", () => menu(btn, typeof items === "function" ? items() : items))
  return btn
}

// hover preview of [[links]] and entry links
let pop = null
let popTimer = null
const previewCache = new Map()
export function hoverPreview(root) {
  root.addEventListener("mouseover", (e) => {
    const a = e.target.closest && e.target.closest("a[data-id]")
    if (!a || !root.contains(a)) return
    clearTimeout(popTimer)
    popTimer = setTimeout(() => showPreview(a), 350)
  })
  root.addEventListener("mouseout", (e) => {
    const a = e.target.closest && e.target.closest("a[data-id]")
    if (!a) return
    clearTimeout(popTimer)
    hidePreview()
  })
}

async function showPreview(a) {
  const id = a.dataset.id
  if (!id) return
  let data = previewCache.get(id)
  if (!data) {
    try {
      const d = await get("entry", { id })
      data = { node: d.node, description: d.description, body: truncate(String(d.body || "").replace(/[#*`>\-\[\]]/g, "").replace(/\s+/g, " "), 260) }
      previewCache.set(id, data)
      setTimeout(() => previewCache.delete(id), 30_000)
    } catch (_) {
      return
    }
  }
  if (!document.body.contains(a)) return
  hidePreview()
  const r = a.getBoundingClientRect()
  pop = h("div", { class: "popover" }, h("div", { class: "row-flex" }, kindChip(data.node), data.node.status ? h("span", { class: "chip", text: data.node.status }) : null), h("div", { class: "p-title", text: data.node.title }), h("div", { class: "p-desc", text: data.description && data.description !== data.node.title ? data.description : data.body }))
  document.body.append(pop)
  const top = r.bottom + 6 + pop.offsetHeight > window.innerHeight ? r.top - pop.offsetHeight - 6 : r.bottom + 6
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.left))}px`
  pop.style.top = `${Math.max(8, top)}px`
}

export function hidePreview() {
  if (pop) pop.remove()
  pop = null
}

// ---------------------------------------------------------------------------
// tabs
// ---------------------------------------------------------------------------
/** Tabs bound to a query parameter (the URL keeps the open tab). */
export function tabBar(tabs, current, onSelect) {
  return h(
    "div",
    { class: "tabs", role: "tablist" },
    tabs.map(([key, label, badge]) =>
      h("button", { type: "button", role: "tab", class: key === current ? "on" : "", "aria-selected": key === current ? "true" : "false", onclick: () => onSelect(key) }, label, badge ? h("span", { class: "badge muted", style: { marginLeft: "6px" }, text: String(badge) }) : null),
    ),
  )
}

export function card(title, ...children) {
  return h("div", { class: "card" }, title ? h("h3", { text: title }) : null, children)
}

export function section(title, extra, ...children) {
  return h("div", { class: "card" }, h("div", { class: "card-head" }, h("h3", { class: "grow", text: title }), extra || null), children)
}

/** Set content of an element from an async loader, with loading and error states. */
export async function fill(el, loader) {
  swap(el, h("div", { class: "loading" }, h("span", { class: "spinner" }), "Lade …"))
  try {
    const content = await loader()
    swap(el, content)
  } catch (err) {
    swap(el, h("div", { class: "notice error", text: errorText(err) }))
  }
}

export { put, swap }
