// Building blocks of entry pages: markdown body with resolved links, relations, links and
// backlinks, facts, evidence, conflicts, versions, audit, usage and relevance.
import { get } from "./api.js"
import { barChart, legendOf, lineChart, sparkline } from "./charts.js"
import { ACTOR_LABEL, KIND_PLURAL, RELATION_TYPES, SOURCE_LABEL, aiChip, debounce, entryHref, fmtDate, fmtNum, fmtRel, h, icon, kindChip, statusChip, strengthBar, swap, tagChips } from "./dom.js"
import { enhance, linkTargets, render } from "./markdown.js"
import { act, app, card, confirmDialog, errorText, modal, moreButton, section } from "./ui.js"

// ---------------------------------------------------------------------------
// markdown with resolved links
// ---------------------------------------------------------------------------
const resolved = new Map()
export async function resolveTargets(targets) {
  const missing = targets.filter((t) => !resolved.has(t))
  for (let i = 0; i < missing.length; i += 150) {
    const chunk = missing.slice(i, i + 150)
    try {
      const r = await get("links/resolve", { targets: chunk.join("\u001f") })
      for (const t of chunk) resolved.set(t, r[t] ?? null)
    } catch (_) {
      // unknown stays unknown
    }
  }
}
export const forgetResolved = () => resolved.clear()

export function mdOptions(extra = {}) {
  return {
    resolve: (t) => (resolved.has(t) ? resolved.get(t) : undefined),
    taskPrefix: app.info?.taskPrefix || "T",
    ticketPattern: app.info?.config?.memorysmith?.ticketPattern,
    strict: true,
    ...extra,
  }
}

/** Render markdown into `el` (resolving [[links]] first). */
export async function renderMarkdown(el, src, opts = {}) {
  await resolveTargets(linkTargets(src))
  el.classList.add("md")
  el.innerHTML = render(src, mdOptions(opts)) || '<p class="faint">(kein Inhalt)</p>'
  enhance(el, opts)
  return el
}

export function mdBlock(src, opts = {}) {
  const el = h("div", { class: `md ${opts.class || ""}` })
  renderMarkdown(el, src, opts)
  return el
}

// ---------------------------------------------------------------------------
// header, facts, evidence, history
// ---------------------------------------------------------------------------
export function entryHead(data) {
  const n = data.node
  return [
    h(
      "div",
      { class: "entry-head" },
      kindChip(n),
      statusChip(n.status),
      n.tier && n.tier !== "active" ? h("span", { class: "chip", text: n.tierLabel || n.tier }) : null,
      data.own ? h("span", { class: "chip accent", text: "von mir" }) : data.own === false ? h("span", { class: "chip", text: "von der KI" }) : null,
      aiChip(data.ai),
      data.pinned ? h("span", { class: "chip", title: "angepinnt" }, icon("pin", 11), "angepinnt") : null,
      data.folder ? h("a", { class: "chip outline", href: `#/dokumente?ordner=${encodeURIComponent(data.folder)}` }, icon("folder", 11), data.folder) : null,
      n.date ? h("span", { class: "faint", text: fmtDate(n.date) }) : null,
    ),
    h("h1", { text: data.title || n.title }),
    data.description && data.description !== n.title ? h("p", { class: "entry-sub", text: data.description }) : null,
  ]
}

export function factsBlock(data) {
  const rows = data.fields.map(([k, v]) => h("tr", null, h("td", { text: k }), h("td", { text: v })))
  if (data.tags?.length) rows.push(h("tr", null, h("td", { text: "Tags" }), h("td", null, tagChips(data.tags, 30))))
  rows.push(h("tr", null, h("td", { text: "Id" }), h("td", { class: "mono", text: data.node.id })))
  if (data.file) rows.push(h("tr", null, h("td", { text: "Datei" }), h("td", { class: "mono", text: data.file })))
  return card("Eigenschaften", h("table", { class: "facts" }, h("tbody", null, rows)))
}

export function evidenceBlock(data) {
  if (!data.evidence?.length) return null
  return card(
    "Belege",
    data.evidence.map((e) => h("div", { class: "evidence" }, h("div", { text: `„${e.text}“` }), h("div", { class: "faint" }, `${fmtDate(e.at)} · ${e.source}`, e.session ? [" · ", h("a", { href: `#/session/${encodeURIComponent(e.session)}`, text: "Session" })] : null))),
  )
}

export function historyBlock(data) {
  if (!data.history?.length) return null
  return card(
    "Verlauf",
    h(
      "div",
      { class: "stack", style: { gap: "4px", fontSize: "13px" } },
      data.history.map((x) => h("div", null, h("strong", { text: fmtDate(x.at) }), ` · ${x.action}${x.actor ? ` (${ACTOR_LABEL[x.actor] || x.actor})` : ""}${x.reason ? ` – ${x.reason}` : ""}`)),
    ),
  )
}

// ---------------------------------------------------------------------------
// relations
// ---------------------------------------------------------------------------
export function relationItem(r, { onOpen, onChange } = {}) {
  const o = r.other
  const href = o.exists ? entryHref(o.id) : null
  const actions =
    onChange && !app.readOnly
      ? h(
          "div",
          { class: "rel-actions" },
          r.derived
            ? [
                h("button", { class: "btn sm", type: "button", text: "Bestätigen", title: "Abgeleitete Verknüpfung speichern", onclick: (e) => run(e, "relation.confirmDerived", { from: r.from, to: r.to }) }),
                h("button", { class: "btn sm", type: "button", text: "Ausblenden", title: "Als „kein Bezug“ speichern", onclick: (e) => run(e, "relation.notRelated", { from: r.from, to: r.to }) }),
              ]
            : [
                h("button", { class: "btn sm", type: "button", text: "Ändern", onclick: (e) => edit(e) }),
                r.type !== "not_related" ? h("button", { class: "btn sm", type: "button", text: "Umkehren", onclick: (e) => run(e, "relation.reverse", { from: r.from, to: r.to }) }) : null,
                h("button", { class: "btn sm danger", type: "button", text: "Löschen", onclick: (e) => run(e, "relation.delete", { from: r.from, to: r.to }) }),
              ],
        )
      : null
  async function run(e, action, args) {
    e.preventDefault()
    e.stopPropagation()
    if (await act(action, args)) onChange()
  }
  async function edit(e) {
    e.preventDefault()
    e.stopPropagation()
    if (await relationDialog(r.from, { to: r.to, type: r.type, strength: r.strength, description: r.description })) onChange()
  }
  const el = h(
    href ? "a" : "div",
    { class: "rel", href },
    h(
      "div",
      { class: "rel-top" },
      h("span", { class: "dir", text: r.direction === "out" ? "→" : "←", title: r.direction === "out" ? "ausgehend" : "eingehend" }),
      h("span", { class: "rel-type", text: r.direction === "out" ? r.label : `${r.label} (eingehend)` }),
      strengthBar(r.strength),
      h("span", { text: Number(r.strength).toFixed(1) }),
      r.derived ? h("span", { class: "chip", text: "abgeleitet" }) : null,
    ),
    h("div", { class: "rel-title" }, kindChip(o), o.title || o.id, o.exists ? null : h("span", { class: "faint", text: "(nicht mehr vorhanden)" })),
    r.description ? h("div", { class: "rel-desc", text: r.description }) : null,
    h("div", { class: "rel-foot", text: [SOURCE_LABEL[r.source] || r.source, r.at ? fmtDate(r.at) : "", o.id].filter(Boolean).join(" · ") }),
    actions,
  )
  if (onOpen && o.exists) {
    el.addEventListener("click", (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.target.closest("button")) return
      e.preventDefault()
      onOpen(o.id)
    })
  }
  return el
}

export function relationsBlock(data, opts = {}) {
  const real = data.relations.filter((r) => r.type !== "not_related")
  const none = data.relations.filter((r) => r.type === "not_related")
  const out = real.filter((r) => r.direction === "out")
  const inc = real.filter((r) => r.direction === "in")
  const add = opts.onChange && !app.readOnly ? h("button", { class: "btn sm", type: "button", onclick: async () => (await relationDialog(data.node.id)) && opts.onChange() }, icon("plus", 13), "Verknüpfen") : null
  return section(
    `Verknüpfungen (${real.length})`,
    add,
    !real.length ? h("div", { class: "faint", text: "Noch keine Verknüpfungen." }) : null,
    out.length ? h("div", { class: "list" }, out.map((r) => relationItem(r, opts))) : null,
    inc.length ? [h("h3", { text: "Eingehend" }), h("div", { class: "list" }, inc.map((r) => relationItem(r, opts)))] : null,
    none.length ? h("details", null, h("summary", { class: "faint", text: `Geprüft – kein Bezug (${none.length})` }), h("div", { class: "list" }, none.map((r) => relationItem(r, opts)))) : null,
  )
}

/** Target picker: search entries by title (links/complete). */
export function targetPicker(onPick, { placeholder = "Eintrag suchen …", value = "" } = {}) {
  const input = h("input", { class: "input wide", placeholder, value, autocomplete: "off" })
  const list = h("div", { class: "list", style: { maxHeight: "220px", overflowY: "auto", marginTop: "6px" } })
  let chosen = null
  const search = debounce(async () => {
    const q = input.value.trim()
    try {
      const r = await get("links/complete", { q, limit: 12 })
      swap(
        list,
        r.length
          ? r.map((x) =>
              h(
                "div",
                {
                  class: "row clickable",
                  onclick: () => {
                    chosen = x
                    input.value = x.title
                    swap(list, h("div", { class: "row" }, kindChip(x), h("div", { class: "main" }, h("div", { class: "title", text: x.title }), h("div", { class: "desc mono", text: x.id }))))
                    onPick(x)
                  },
                },
                kindChip(x),
                h("div", { class: "main" }, h("div", { class: "title", text: x.title }), h("div", { class: "desc mono", text: x.id })),
              ),
            )
          : h("div", { class: "empty", text: "Nichts gefunden." }),
      )
    } catch (_) {
      // ignore
    }
  }, 150)
  input.addEventListener("input", () => {
    chosen = null
    search()
  })
  input.addEventListener("focus", search)
  return { el: h("div", null, input, list), get value() {
    return chosen
  } }
}

/** Create or change a stored relation (type, strength 1–5, description). */
export async function relationDialog(from, preset = {}) {
  const res = await modal((close) => {
    let to = preset.to ? { id: preset.to, title: preset.to } : null
    const picker = preset.to ? null : targetPicker((x) => (to = x))
    const type = h(
      "select",
      { class: "input" },
      Object.entries(RELATION_TYPES).map(([k, l]) => h("option", { value: k, text: l, selected: (preset.type || "related") === k })),
    )
    const strength = h("input", { type: "range", min: "1", max: "5", step: "1", value: String(Math.max(1, Math.round((preset.strength ?? 0.6) * 5))) })
    const sv = h("span", { text: strength.value })
    strength.addEventListener("input", () => (sv.textContent = strength.value))
    const desc = h("input", { class: "input wide", placeholder: "Ein Satz, der den Zusammenhang erklärt", value: preset.description || "" })
    return {
      title: preset.to ? "Verknüpfung ändern" : "Verknüpfen",
      body: [
        h("p", { class: "muted mono", text: preset.to ? `${from} → ${preset.to}` : `von ${from}` }),
        picker ? h("div", { class: "field" }, h("label", { text: "Ziel" }), picker.el) : null,
        h("div", { class: "fields" }, h("div", { class: "field" }, h("label", { text: "Art" }), type), h("div", { class: "field" }, h("label", null, "Stärke ", sv), strength)),
        h("div", { class: "field" }, h("label", { text: "Beschreibung" }), desc),
      ],
      foot: [
        h("button", { class: "btn", type: "button", text: "Abbrechen", onclick: () => close(undefined) }),
        h("button", {
          class: "btn primary",
          type: "button",
          text: "Speichern",
          onclick: () => {
            if (!to) return
            close({ to: to.id, type: type.value, strength: Number(strength.value), description: desc.value.trim() })
          },
        }),
      ],
    }
  })
  if (!res) return null
  return act("relation.create", { from, to: res.to, type: res.type, strength: res.strength, description: res.description || undefined })
}

// ---------------------------------------------------------------------------
// links, backlinks, mentions
// ---------------------------------------------------------------------------
export function linksBlock(data, { onChange } = {}) {
  const parts = []
  if (data.backlinks?.length) parts.push(h("h3", { text: `Verlinkt von (${data.backlinks.length})` }), h("div", { class: "list" }, data.backlinks.map((b) => h("a", { class: "row", href: entryHref(b.from), "data-id": b.from }, kindChip({ id: b.from }), h("div", { class: "main" }, h("div", { class: "title", text: b.title }), h("div", { class: "desc mono", text: b.raw }))))))
  if (data.mentions?.length)
    parts.push(
      h("h3", { text: `Erwähnt ohne Link (${data.mentions.length})` }),
      h(
        "div",
        { class: "list" },
        data.mentions.map((m) =>
          h(
            "div",
            { class: "row" },
            kindChip({ id: m.from }),
            h("div", { class: "main" }, h("a", { class: "title", href: entryHref(m.from), text: m.title }), h("div", { class: "desc", text: m.excerpt })),
            onChange && !app.readOnly ? h("button", { class: "btn sm", type: "button", text: "verlinken", title: `„${m.phrase}“ in ${m.from} zum Link machen`, onclick: async () => (await act("mention.link", { target: m.from, to: data.node.id, phrase: m.phrase })) && onChange() }) : null,
          ),
        ),
      ),
    )
  if (data.links?.length) {
    parts.push(
      h("h3", { text: `Links in diesem Eintrag (${data.links.length})` }),
      h(
        "div",
        { class: "list" },
        data.links.map((l) =>
          l.id
            ? h("a", { class: "row", href: entryHref(l.id), "data-id": l.id }, kindChip({ id: l.id }), h("div", { class: "main" }, h("div", { class: "title", text: l.title || l.id }), h("div", { class: "desc mono", text: l.raw })))
            : h("div", { class: "row" }, h("span", { class: "chip danger", text: "defekt" }), h("div", { class: "main" }, h("div", { class: "title mono", text: l.raw }), h("div", { class: "desc", text: "Ziel nicht gefunden" }))),
        ),
      ),
    )
  }
  if (!parts.length) return card("Rückverweise", h("div", { class: "faint", text: "Keine Links und Rückverweise." }))
  return card("Links und Rückverweise", parts)
}

// ---------------------------------------------------------------------------
// conflicts
// ---------------------------------------------------------------------------
export function conflictsBlock(data, { onChange } = {}) {
  if (!data.conflicts?.length) return null
  return h(
    "div",
    { class: "card warn" },
    h("h3", { text: "Offene Konflikte" }),
    data.conflicts.map((c) =>
      h(
        "div",
        { class: "rel" },
        h("div", { class: "rel-top" }, statusChip(c.status), h("span", { class: "mono", text: c.id })),
        h("div", { class: "rel-title" }, "mit ", h("a", { href: entryHref(c.other.id), text: c.other.title })),
        h("div", { class: "rel-desc", text: c.note || c.suspicion }),
        h("div", { class: "toolbar" }, h("a", { class: "btn sm", href: `#/konflikte?id=${encodeURIComponent(c.id)}`, text: "Entscheiden" }), onChange ? null : null),
      ),
    ),
  )
}

// ---------------------------------------------------------------------------
// tabs: versions, audit, usage
// ---------------------------------------------------------------------------
export async function versionsTab(id, { onRestored } = {}) {
  const { renderEntryDiff } = await import("./diff.js")
  const list = await get("versions", { id })
  const wrap = h("div", { class: "versions" })
  const left = h("div", { class: "list" })
  const right = h("div")
  let a = null
  let b = null
  const show = async (to, from, label) => {
    swap(right, h("div", { class: "loading" }, h("span", { class: "spinner" }), "Diff wird berechnet …"))
    try {
      const d = await get("diff", { id, to, from })
      const actions = []
      if (to !== "working" && list[0] && to !== list[0].hash && !app.readOnly)
        actions.push(
          h("button", {
            class: "btn",
            type: "button",
            onclick: async () => {
              const r = await act("entry.restoreVersion", { target: id, hash: to }, { label: "Diese Version wiederherstellen" })
              if (r && onRestored) onRestored()
            },
          }, icon("undo", 14), "Diese Version wiederherstellen"),
        )
      if (to !== "working") actions.push(h("button", { class: "btn", type: "button", text: "Mit heute vergleichen", onclick: () => show("working", to, "heute") }))
      swap(right, h("div", { class: "card" }, h("div", { class: "card-head" }, h("h3", { class: "grow", text: label || `${d.from.label} → ${d.to.label}` }), actions), renderEntryDiff(d)))
    } catch (err) {
      swap(right, h("div", { class: "notice error", text: errorText(err) }))
    }
  }
  const drawList = () =>
    swap(
      left,
      list.length
        ? list.map((v, i) => {
            const abBox = h(
              "span",
              { class: "ab", title: "Zwei Versionen vergleichen" },
              h("button", { type: "button", class: a === v.hash ? "on" : "", text: "A", onclick: (e) => pick(e, "a", v.hash) }),
              h("button", { type: "button", class: b === v.hash ? "on" : "", text: "B", onclick: (e) => pick(e, "b", v.hash) }),
            )
            return h(
              "div",
              {
                class: `version-item${i === 0 && !a && !b ? " on" : ""}`,
                onclick: (e) => {
                  for (const x of left.children) x.classList.remove("on")
                  e.currentTarget.classList.add("on")
                  show(v.hash, "parent", `${v.short} · ${v.subject}`)
                },
              },
              h("div", { class: "v-top" }, h("span", { text: fmtDate(v.date) }), v.actor ? h("span", { class: "chip", text: `${v.smith || ""}(${v.actor})` }) : null, v.manual ? h("span", { class: "chip warn", text: "von Hand" }) : null, v.markers.map((m) => h("span", { class: "chip accent", text: m })), h("span", { class: "grow" }), abBox),
              h("div", { class: "v-subject ellipsis", text: v.subject }),
              v.reasons?.length ? h("div", { class: "v-reason", text: v.reasons.join(" · ") }) : null,
              h("div", { class: "v-top" }, h("span", { class: "mono", text: v.short }), h("span", { class: "ok", text: `+${v.additions}` }), h("span", { text: `−${v.deletions}` }), v.runId ? h("span", { class: "faint mono", text: v.runId }) : null),
            )
          })
        : h("div", { class: "empty", text: "Keine Versionen in Git (Git aus oder noch nicht committet)." }),
    )
  const pick = (e, which, hash) => {
    e.stopPropagation()
    if (which === "a") a = a === hash ? null : hash
    else b = b === hash ? null : hash
    drawList()
    if (a && b) show(b, a, "Vergleich A → B")
  }
  drawList()
  wrap.append(left, right)
  if (list[0]) show(list[0].hash, "parent", `${list[0].short} · ${list[0].subject}`)
  else swap(right, h("div", { class: "faint", text: "Noch keine Version." }))
  return wrap
}

const RESULT_LABEL = { ok: "ok", rejected: "abgelehnt", staged: "vorgemerkt", error: "Fehler" }
export function auditTable(events, { showTarget = true } = {}) {
  if (!events.length) return h("div", { class: "empty", text: "Keine Ereignisse." })
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: "table" },
      h("thead", null, h("tr", null, h("th", { text: "Zeit" }), h("th", { text: "Wer" }), h("th", { text: "Aktion" }), showTarget ? h("th", { text: "Ziel" }) : null, h("th", { text: "Grund / Meldung" }), h("th", { text: "Ergebnis" }), h("th", { text: "Bezug" }))),
      h(
        "tbody",
        null,
        events.map((e) =>
          h(
            "tr",
            { class: "audit-row" },
            h("td", { class: "nowrap", title: e.at, text: fmtDate(e.at) }),
            h("td", null, h("div", { text: ACTOR_LABEL[e.actor] || e.actor }), e.smith ? h("div", { class: "faint", text: e.smith }) : null),
            h("td", null, h("span", { class: "chip", text: e.category }), " ", e.action),
            showTarget ? h("td", null, (e.targets || []).slice(0, 4).map((t) => h("div", null, /^[a-z]+:/.test(t) ? h("a", { href: entryHref(t), class: "mono", text: t }) : h("span", { class: "mono", text: t })))) : null,
            h("td", { text: e.reason || e.message || "" }),
            h("td", { class: `res-${e.result}`, text: RESULT_LABEL[e.result] || e.result }),
            h("td", null, e.commit ? h("a", { class: "mono", href: `#/commit/${e.commit}`, text: e.commit.slice(0, 8) }) : null, e.session ? h("div", null, h("a", { href: `#/session/${encodeURIComponent(e.session)}`, text: "Session" })) : null, e.run ? h("div", { class: "nowrap" }, h("a", { class: "faint mono", href: `#/audit?run=${encodeURIComponent(e.run)}`, text: e.run.slice(0, 10) })) : null),
          ),
        ),
      ),
    ),
  )
}

export async function auditTab(id) {
  const r = await get("audit", { target: id, limit: 300 })
  if (r.unavailable) return h("div", { class: "notice", text: "Audit-Log nicht verfügbar (SQLite fehlt)." })
  return auditTable(r.events, { showTarget: false })
}

const USE_LABEL = { "entry.load": "geladen", "entry.hint_followed": "Hinweis befolgt", "script.run": "ausgeführt", "entry.hint_helped": "Fehler-Hinweis half", "entry.hint_shown": "Hinweis gezeigt", "entry.view": "im Web geöffnet" }
export async function usageTab(id, days = 90) {
  const u = await get("usage", { id, days })
  if (!u.available) return h("div", { class: "notice", text: "Metriken nicht verfügbar – nur Gesamtzähler." }, u.usageFile ? h("pre", { class: "mono", text: JSON.stringify(u.usageFile, null, 2) }) : null)
  const wrap = h("div", { class: "stack" })
  const types = ["entry.load", "entry.hint_followed", "script.run", "entry.hint_helped"]
  const series = types.filter((t) => u.series?.series?.[t]?.some((v) => v)).map((t) => ({ name: USE_LABEL[t], values: u.series.series[t] }))
  const daysSel = h("div", { class: "seg" }, [30, 90, 365].map((d) => h("button", { type: "button", class: d === days ? "on" : "", text: `${d} Tage`, onclick: async () => swap(wrap.parentElement, await usageTab(id, d)) })))
  wrap.append(
    h(
      "div",
      { class: "grid" },
      u.success ? h("div", { class: "card" }, h("div", { class: "label", text: u.success.label }), h("div", { class: "num", text: u.success.value === null ? "–" : `${u.success.value} %` }), h("div", { class: "sub", text: u.success.detail })) : null,
      h("div", { class: "card" }, h("div", { class: "label", text: "Nutzungen gesamt" }), h("div", { class: "num", text: fmtNum(types.reduce((n, t) => n + (u.totals?.[t] || 0), 0)) }), h("div", { class: "sub", text: `${fmtNum(u.totals?.["entry.hint_shown"] || 0)} Hinweise gezeigt` })),
      u.curve?.length ? h("div", { class: "card" }, h("div", { class: "label", text: "Relevanz (12 Wochen)" }), sparkline(u.curve.map((c) => c.value), { w: 180, h: 44 }), h("div", { class: "sub", text: `aktuell ${fmtNum(u.curve[u.curve.length - 1].value, 2)}` })) : null,
    ),
  )
  wrap.append(
    h(
      "div",
      { class: "card chart-card" },
      h("div", { class: "card-head" }, h("h3", { class: "grow", text: "Nutzung" }), daysSel),
      series.length ? [barChart(u.series.buckets, series, { height: 180 }), legendOf(series)] : h("div", { class: "faint", text: "Im Zeitraum nicht genutzt." }),
    ),
  )
  if (u.users)
    wrap.append(
      h(
        "div",
        { class: "grid two" },
        card(`Agenten · ${u.users.sessions} Sessions`, u.users.agents?.length ? h("div", { class: "chips" }, u.users.agents.map((x) => h("span", { class: "chip", text: `${x.name || "?"} · ${x.n}` }))) : h("div", { class: "faint", text: "–" })),
        card("Projekte", u.users.projects?.length ? h("div", { class: "chips" }, u.users.projects.map((x) => h("span", { class: "chip", text: `${x.name || "?"} · ${x.n}` }))) : h("div", { class: "faint", text: "–" })),
      ),
    )
  wrap.append(
    card(
      "Letzte Nutzungen",
      u.recent?.length
        ? h(
            "table",
            { class: "table" },
            h("tbody", null, u.recent.map((r) => h("tr", null, h("td", { class: "nowrap", text: fmtDate(r.at) }), h("td", { text: USE_LABEL[r.type] || r.type }), h("td", null, r.session ? h("a", { href: `#/session/${encodeURIComponent(r.session)}`, class: "mono", text: r.session.slice(0, 14) }) : "–"), h("td", { text: r.project || "" }), h("td", { text: r.agent || r.origin || "" })))),
          )
        : h("div", { class: "faint", text: "Noch keine Nutzung." }),
    ),
  )
  if (u.curve?.length > 2) wrap.append(card("Relevanz über die Zeit", lineChart(u.curve.map((c) => new Date(c.at).toISOString().slice(0, 10)), [{ name: "Relevanz", values: u.curve.map((c) => c.value) }], { height: 180 })))
  return wrap
}

export function relevanceLine(rel) {
  if (!rel) return null
  const ring = rel.ring ? h("span", { class: `ring-${rel.ring}`, text: rel.ring === "good" ? "● gesund" : rel.ring === "warn" ? "● auffällig" : "● Konflikt" }) : null
  return h("div", { class: "faint", style: { fontSize: "12.5px" } }, `Relevanz ${fmtNum((rel.score || 0) * 100)} / 100 · `, rel.explain || "", ring ? [" · ", ring] : null, rel.ringReason ? h("span", { text: ` (${rel.ringReason})` }) : null)
}

export const kindTitle = (k) => KIND_PLURAL[k] || k
export { confirmDialog, fmtRel, moreButton }
