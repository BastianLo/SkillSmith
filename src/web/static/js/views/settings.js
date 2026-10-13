// Settings (5a): every option as a form field, generated from the option schema. Each value
// shows where it comes from (default, opencode.json, settings page, environment), whether it
// needs a restart and whether it is security relevant. Changes are saved together in one run
// (settings.json in the store, one commit, undo).
import { get, token } from "../api.js"
import { debounce, h, icon, put, segmented, storeGet, storeSet, swap } from "../dom.js"
import { act, app, askToken, card, tabBar, toast, typeNameDialog } from "../ui.js"

const SOURCE_LABEL = { standard: "Standard", opencode: "opencode.json", einstellungen: "Einstellungen", umgebung: "Umgebung" }

const fmt = (v) => (v === undefined ? "–" : typeof v === "string" ? (v === "" ? "„“" : v) : JSON.stringify(v))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

export default async function settings(ctx) {
  ctx.title("Einstellungen")
  const info = await get("info")
  if (!ctx.alive()) return
  app.info = info
  const tab = ctx.query.get("tab") || "werte"
  const page = h("div", { class: "page" })
  const body = h("div")
  put(
    page,
    h("div", { class: "page-head" }, h("div", { class: "grow" }, h("h1", { text: "Einstellungen" }), h("div", { class: "muted", text: `skillsmith ${info.version} · Store ${info.store}` }))),
    tabBar(
      [
        ["werte", "Konfiguration"],
        ["sitzung", "Darstellung und Sitzung"],
        ["tasten", "Tastenkürzel"],
      ],
      tab,
      (k) => (ctx.setQuery({ tab: k === "werte" ? undefined : k }), ctx.reload()),
    ),
    body,
  )
  ctx.el.replaceChildren(page)
  if (tab === "sitzung") return session(ctx, body, info)
  if (tab === "tasten") return swap(body, shortcuts())
  return values(ctx, body)
}

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------
async function values(ctx, body) {
  let data = await get("settings")
  if (!ctx.alive()) return
  if (data.unavailable) return swap(body, h("div", { class: "notice warn", text: "Einstellungen sind in diesem Prozess nicht verfügbar." }))
  const edits = new Map() // path → value
  const resets = new Set()
  const filter = { q: ctx.query.get("q") || "", only: ctx.query.get("nur") || "", group: ctx.query.get("gruppe") || "" }
  const focus = ctx.query.get("pfad")
  const list = h("div")
  const groupsNav = h("nav", { class: "settings-groups", "aria-label": "Gruppen" })
  const savebar = h("div", { class: "savebar hidden" })
  const search = h("input", { class: "input", type: "search", placeholder: "Einstellung suchen (Name, Schlüssel, Beschreibung) …", value: filter.q, style: { flex: "1 1 260px" } })
  search.addEventListener(
    "input",
    debounce(() => {
      filter.q = search.value.trim()
      ctx.setQuery({ q: filter.q || undefined })
      draw()
    }, 150),
  )
  const onlyChips = h("div", { class: "chips" })
  const drawOnly = () =>
    swap(
      onlyChips,
      [
        ["", "alle"],
        ["geaendert", "abweichend vom Standard"],
        ["neustart", "brauchen Neustart"],
        ["sicherheit", "sicherheitsrelevant"],
      ].map(([k, label]) => h("button", { class: `chip ${filter.only === k ? "accent" : "outline"}`, type: "button", text: label, onclick: () => ((filter.only = k), ctx.setQuery({ nur: k || undefined }), drawOnly(), draw()) })),
    )
  drawOnly()
  const restartNote = h("div")
  const drawRestart = () =>
    swap(restartNote, data.pendingRestart?.length ? h("div", { class: "notice warn" }, icon("refresh", 14), ` Wirkt erst nach einem Neustart von opencode: ${data.pendingRestart.join(", ")}`) : null, data.warnings?.length ? h("details", { class: "notice warn" }, h("summary", { text: `${data.warnings.length} Hinweis(e) zur Konfiguration` }), h("ul", null, data.warnings.map((w) => h("li", { class: "mono", text: w })))) : null)
  drawRestart()

  const matches = (v) => {
    if (filter.group && v.group !== filter.group) return false
    if (filter.only === "geaendert" && v.source === "standard") return false
    if (filter.only === "neustart" && !v.restart) return false
    if (filter.only === "sicherheit" && !v.security) return false
    if (!filter.q) return true
    const q = filter.q.toLowerCase()
    return `${v.label} ${v.path} ${v.help || ""}`.toLowerCase().includes(q)
  }

  const current = (v) => (resets.has(v.path) ? (v.opencode !== undefined ? v.opencode : v.standard) : edits.has(v.path) ? edits.get(v.path) : v.value)

  const change = (v, value) => {
    resets.delete(v.path)
    if (same(value, v.value)) edits.delete(v.path)
    else edits.set(v.path, value)
    drawSave()
    const row = list.querySelector(`[data-path="${CSS.escape(v.path)}"]`)
    if (row) row.classList.toggle("changed", edits.has(v.path) || resets.has(v.path))
  }

  const control = (v) => {
    const sp = v.spec
    const val = current(v)
    const dis = !!v.locked || app.readOnly
    if (v.path === "jobs") return h("a", { class: "btn sm", href: "#/jobs" }, icon("calendar", 14), "Jobs öffnen")
    if (v.path === "inbox.types") return h("a", { class: "btn sm", href: "#/eingang?einstellen=1" }, icon("inbox", 14), "Im Eingang einstellen")
    if (sp.t === "bool") {
      const cb = h("input", { type: "checkbox", checked: !!val, disabled: dis })
      cb.addEventListener("change", () => change(v, cb.checked))
      return h("label", { class: "row-flex" }, cb, h("span", { class: "muted", text: val ? "an" : "aus" }))
    }
    if (sp.t === "int" || sp.t === "num") {
      const inp = h("input", { class: "input", type: "number", value: val ?? "", min: sp.min, max: sp.max > 1e12 ? undefined : sp.max, step: sp.t === "int" ? 1 : "any", disabled: dis })
      inp.addEventListener("change", () => inp.value !== "" && change(v, Number(inp.value)))
      return h("div", null, inp, h("div", { class: "faint", style: { fontSize: "11.5px" }, text: `${sp.min} – ${sp.max > 1e12 ? "∞" : sp.max}` }))
    }
    if (sp.t === "enum") {
      const sel = h("select", { class: "input", disabled: dis }, [...(sp.optional ? [["", "(leer)"]] : []), ...sp.values.map((x) => [x, x])].map(([x, l]) => h("option", { value: x, text: l, selected: String(val ?? "") === x })))
      sel.addEventListener("change", () => change(v, sel.value === "" ? undefined : sel.value))
      return sel
    }
    if (sp.t === "list" && sp.values) {
      const set = new Set(val || [])
      return h(
        "div",
        { class: "chips" },
        sp.values.map((x) => {
          const cb = h("input", { type: "checkbox", checked: set.has(x), disabled: dis })
          cb.addEventListener("change", () => {
            if (cb.checked) set.add(x)
            else set.delete(x)
            change(v, sp.values.filter((y) => set.has(y)))
          })
          return h("label", { class: "chip outline" }, cb, x)
        }),
      )
    }
    if (sp.t === "list") {
      const ta = h("textarea", { class: "input", rows: Math.min(6, Math.max(2, (val || []).length + 1)), disabled: dis, placeholder: sp.format === "times" ? "08:30\n13:00" : "ein Wert je Zeile" })
      ta.value = (val || []).join("\n")
      ta.addEventListener("change", () =>
        change(
          v,
          ta.value
            .split(/\n|,(?=\s*\d{1,2}:\d{2})/)
            .map((x) => x.trim())
            .filter(Boolean),
        ),
      )
      return ta
    }
    if (sp.t === "record" || sp.t === "object") {
      const ta = h("textarea", { class: "input mono", rows: 3, disabled: dis, placeholder: "{ }" })
      ta.value = JSON.stringify(val ?? {}, null, 1)
      const err = h("div", { class: "faint", style: { fontSize: "11.5px" } })
      ta.addEventListener("change", () => {
        try {
          const parsed = JSON.parse(ta.value || "{}")
          err.textContent = ""
          change(v, parsed)
        } catch (e) {
          err.textContent = `kein gültiges JSON: ${e.message}`
        }
      })
      return h("div", null, ta, err)
    }
    const inp = h("input", { class: "input", type: "text", value: val ?? "", disabled: dis, placeholder: sp.format === "cron" ? "30 8 * * 1-5" : sp.optional ? "(leer)" : "" })
    inp.addEventListener("change", () => change(v, inp.value === "" && sp.optional ? undefined : inp.value))
    return inp
  }

  const row = (v) =>
    h(
      "div",
      { class: `setting${edits.has(v.path) || resets.has(v.path) ? " changed" : ""}${v.locked ? " locked" : ""}`, "data-path": v.path, id: `s-${v.path}` },
      h(
        "div",
        null,
        h(
          "div",
          { class: "s-label" },
          v.label,
          v.security ? h("span", { class: "chip danger", title: "Braucht den Token und eine Bestätigung; steht mit Vorher/Nachher im Audit-Log." }, icon("lock", 11), "Sicherheit") : null,
          v.restart ? h("span", { class: "chip warn", title: "Wird beim Start gelesen" }, "Neustart") : null,
        ),
        h("div", { class: "s-path", text: v.path }),
        v.help ? h("div", { class: "s-help", text: v.help }) : null,
        h(
          "div",
          { class: "s-src" },
          h("span", { class: `src-chip ${v.source}`, text: SOURCE_LABEL[v.source] || v.source }),
          v.source !== "standard" && v.path !== "storeDir" ? h("span", { text: `Standard: ${fmt(v.standard)}` }) : null,
          v.opencode !== undefined && v.source === "einstellungen" ? h("span", { text: `opencode.json: ${fmt(v.opencode)}` }) : null,
          v.locked ? h("span", { text: v.locked }) : null,
          v.source === "einstellungen" && !v.locked && !app.readOnly
            ? h("button", {
                class: "btn sm ghost",
                type: "button",
                text: "zurücksetzen",
                title: "Eintrag aus den Einstellungen entfernen – es gilt wieder opencode.json bzw. der Standard",
                onclick: () => {
                  edits.delete(v.path)
                  resets.add(v.path)
                  drawSave()
                  draw()
                },
              })
            : null,
        ),
      ),
      h("div", { class: "s-ctrl" }, control(v)),
    )

  const draw = () => {
    const visible = data.values.filter(matches)
    const byGroup = new Map()
    for (const v of visible) (byGroup.get(v.group) ?? byGroup.set(v.group, []).get(v.group)).push(v)
    swap(
      groupsNav,
      h("a", { href: "#", class: !filter.group ? "on" : "", onclick: (e) => (e.preventDefault(), (filter.group = ""), ctx.setQuery({ gruppe: undefined }), draw()) }, "Alle Gruppen"),
      data.groups.filter((g) => data.values.some((v) => v.group === g.id)).map((g) => {
        const n = data.values.filter((v) => v.group === g.id && v.source === "einstellungen").length
        return h("a", { href: "#", style: filter.group === g.id ? { color: "var(--accent)", fontWeight: 600 } : {}, onclick: (e) => (e.preventDefault(), (filter.group = g.id), ctx.setQuery({ gruppe: g.id }), draw()) }, h("span", { text: g.label }), n ? h("span", { class: "badge muted", title: "in den Einstellungen gesetzt", text: String(n) }) : null)
      }),
    )
    swap(
      list,
      visible.length
        ? data.groups
            .filter((g) => byGroup.has(g.id))
            .map((g) => h("div", { class: "card", style: { padding: 0 }, id: `g-${g.id}` }, h("div", { class: "card-head", style: { padding: "12px 14px 0" } }, h("h3", { class: "grow", text: g.label })), byGroup.get(g.id).map(row)))
        : h("div", { class: "card empty-state" }, h("p", { text: "Keine Einstellung passt zum Filter." })),
    )
  }

  // the bar is built once and only updated: a click on "Speichern" often blurs a field first
  // (change event → redraw), a replaced button would swallow that click
  const saveCount = h("strong")
  const saveChips = h("span", { class: "chips" })
  const saveBtn = h("button", {
    class: "btn primary",
    type: "button",
    text: "Speichern",
    onclick: async () => {
      saveBtn.disabled = true
      try {
        const r = await act("settings.set", { values: Object.fromEntries(edits), reset: [...resets] })
        if (!r) return
        edits.clear()
        resets.clear()
        data = await get("settings")
        drawSave()
        drawRestart()
        draw()
      } finally {
        saveBtn.disabled = false
      }
    },
  })
  put(savebar, saveCount, saveChips, h("span", { class: "grow" }), h("button", { class: "btn", type: "button", text: "Verwerfen", onclick: () => (edits.clear(), resets.clear(), drawSave(), draw()) }), saveBtn)
  const drawSave = () => {
    const n = edits.size + resets.size
    savebar.classList.toggle("hidden", !n)
    if (!n) return
    const security = data.values.filter((v) => v.security && (edits.has(v.path) || resets.has(v.path)))
    const restart = data.values.filter((v) => v.restart && (edits.has(v.path) || resets.has(v.path)))
    saveCount.textContent = `${n} Änderung(en)`
    swap(saveChips, security.length ? h("span", { class: "chip danger" }, icon("lock", 11), `${security.length} sicherheitsrelevant`) : null, restart.length ? h("span", { class: "chip warn", text: `${restart.length} erst nach Neustart` }) : null)
  }

  swap(
    body,
    restartNote,
    h(
      "div",
      { class: "settings-layout" },
      groupsNav,
      h(
        "div",
        null,
        h("div", { class: "toolbar", style: { marginTop: 0 } }, search, onlyChips),
        h("p", { class: "muted", style: { fontSize: "12.5px", marginTop: 0 } }, "Reihenfolge: Standard → opencode.json → diese Seite (settings.json im Store, versioniert mit Rückgängig) → Umgebungsvariablen. Geheimnisse wie API-Schlüssel stehen nie hier."),
        list,
        savebar,
      ),
    ),
  )
  draw()
  if (focus) {
    const el = document.getElementById(`s-${focus}`)
    if (el) {
      el.scrollIntoView({ block: "center" })
      el.classList.add("changed")
      setTimeout(() => el.classList.remove("changed"), 1600)
    }
  }
  ctx.on("settings.changed", async () => {
    if (edits.size || resets.size) return
    data = await get("settings")
    if (!ctx.alive()) return
    drawRestart()
    draw()
  })
}

// ---------------------------------------------------------------------------
// appearance and session
// ---------------------------------------------------------------------------
async function session(ctx, body, info) {
  const { applyTheme, setReadOnly } = await import("../main.js")
  const lockBtn = h("button", { class: "btn", type: "button" })
  const drawLock = () => {
    swap(lockBtn, icon("lock", 14), app.readOnly && !info.readOnlyConfig ? "Schreiben wieder erlauben" : "Schreiben für diese Sitzung sperren")
    lockBtn.disabled = info.readOnlyConfig
  }
  lockBtn.addEventListener("click", async () => {
    const locked = !app.readOnly
    const r = await act("system.lock", { locked }, { allowReadOnly: true })
    if (r) {
      setReadOnly(locked)
      drawLock()
    }
  })
  drawLock()
  swap(
    body,
    card(
      "Darstellung",
      h("div", { class: "row-flex" }, h("span", { text: "Farbschema" }), segmented([["auto", "System"], ["light", "Hell"], ["dark", "Dunkel"]], storeGet("theme", "auto"), (v) => (storeSet("theme", v), applyTheme(v)))),
      h(
        "div",
        { class: "row-flex", style: { marginTop: "10px" } },
        h("span", { text: "Browser-Benachrichtigungen" }),
        "Notification" in window
          ? Notification.permission === "granted"
            ? h("span", { class: "chip ok", text: "erlaubt" })
            : h("button", { class: "btn sm", type: "button", text: "Erlauben", onclick: async () => toast((await Notification.requestPermission()) === "granted" ? "Benachrichtigungen erlaubt." : "Nicht erlaubt.") })
          : h("span", { class: "faint", text: "vom Browser nicht unterstützt" }),
        h("a", { href: "#/eingang?einstellen=1", text: "Welche Ereignisse? → Eingang" }),
      ),
    ),
    card(
      "Sitzung und Sicherheit",
      h("table", { class: "facts" }, h("tbody", null, [
        ["Token-Pflicht (web.token)", info.token ? "an" : "aus – jeder Prozess auf diesem Rechner kann lesen und schreiben"],
        ["Token in diesem Browser", token() ? "vorhanden" : "fehlt"],
        ["Agenten starten / freigeben braucht Token", info.tasksRequireToken ? "ja" : "nein"],
        ["Pipeline-Befehle ändern braucht Token", info.pipelineRequireToken ? "ja" : "nein"],
        ["Nur lesend (web.readOnly)", info.readOnlyConfig ? "ja" : "nein"],
        ["Für diese Sitzung gesperrt", app.readOnly && !info.readOnlyConfig ? "ja" : "nein"],
      ].map(([k, v]) => h("tr", null, h("td", { text: k }), h("td", { text: v }))))),
      h("div", { class: "toolbar" }, lockBtn, h("button", { class: "btn", type: "button", onclick: async () => (await askToken()) && toast("Token übernommen.", { variant: "success" }) }, "Token eingeben"), h("a", { class: "btn ghost", href: "#/einstellungen?nur=sicherheit" }, "Sicherheitswerte ändern …")),
    ),
    card(
      "Metriken",
      h("p", { class: "muted", style: { fontSize: "13px" }, text: `Erfassung ${info.metrics?.enabled ? "an" : "aus"}${info.metrics?.available ? "" : " (SQLite nicht verfügbar)"}. Löschen entfernt alle Nutzungsdaten, Tokens und Tool-Aufrufe; Audit-Log und Store bleiben.` }),
      h("button", { class: "btn danger", type: "button", disabled: app.readOnly, onclick: async () => {
        const name = await typeNameDialog("Alle Metriken löschen?", "metriken löschen", "Metriken löschen")
        if (name) act("metrics.clear", { confirm: name })
      } }, icon("trash", 14), "Metriken löschen …"),
    ),
    card(
      "Wiederkehrende Läufe",
      h("p", { class: "muted", style: { fontSize: "13px" }, text: "Curator, Doktor, Retests, Embeddings, Vorschläge vorab und Aufräumen laufen als Jobs mit Zeitplan, Verlauf und Log." }),
      h("a", { class: "btn", href: "#/jobs" }, icon("calendar", 14), "Jobs öffnen"),
    ),
  )
}

function shortcuts() {
  return card(
    "Tastenkürzel",
    h("table", { class: "facts" }, h("tbody", null, [
      ["Strg+K", "Befehlspalette: Ansichten, Einträge, Aktionen"],
      ["/", "Suche"],
      ["n", "Schnellnotiz"],
      ["g i / g b / g g / g s / g d / g t", "Eingang / Board / Graph / Statistik / Dokumente / Tagesnotiz"],
      ["g e / g j / g l", "Einstellungen / Jobs / Log"],
      ["Strg+S, Strg+L, [[", "Editor: speichern, Link einfügen, Link-Vorschläge"],
      ["Leertaste, Pfeile", "Board: Karte aufnehmen, verschieben, ablegen"],
    ].map(([k, v]) => h("tr", null, h("td", null, h("kbd", { text: k })), h("td", { text: v }))))),
  )
}
