// Inbox "Zu prüfen": what changed and what waits for a decision – with the action next to it.
// Every message type can be switched right here: shown, bundled (one collapsed row) or off;
// changes of the AI also per smith. Single messages can be marked as done.
import { get } from "../api.js"
import { debounce, entryHref, fmtDate, fmtRel, h, icon, kindChip, put, swap } from "../dom.js"
import { act, app, confirmDialog, menu, modal } from "../ui.js"
import { proposalDialog } from "./entry.js"

const MODE_LABEL = { an: "anzeigen", gebuendelt: "bündeln", aus: "ausblenden" }
const NOTIFY_EVENTS = [
  ["proposal", "Plan eines Agenten fertig"],
  ["permission", "Rückfrage eines Agenten"],
  ["agent-done", "Auftrag umgesetzt"],
  ["agent-error", "Fehler eines Agenten"],
  ["halted", "Auftrag angehalten (Rücksprünge)"],
  ["pipeline", "Pipeline fertig"],
  ["job-failed", "Job fehlgeschlagen"],
]

export default async function inbox(ctx) {
  ctx.title("Eingang")
  const page = h("div", { class: "page" })
  const body = h("div")
  const filter = { group: ctx.query.get("gruppe") || "" }
  const expanded = new Set()
  ctx.el.replaceChildren(page)
  let data
  const load = async () => {
    data = await get("inbox", { since: ctx.query.get("seit") || undefined })
    if (!ctx.alive()) return
    draw()
  }

  const configure = async (type, mode) => {
    const r = await act("inbox.configure", { type, mode }, { quiet: false })
    if (r) load()
  }

  const dismissItems = async (items) => {
    if (!items.length) return
    const r = await act("inbox.dismiss", { ids: items.map((it) => it.id), sigs: items.map((it) => it.data?.sig || "") }, { quiet: items.length === 1 })
    if (r) {
      const ids = new Set(items.map((it) => it.id))
      data.items = data.items.filter((x) => !ids.has(x.id))
      data.hidden.dismissed += items.length
      draw()
    }
  }

  const groupMenu = (btn, g, list) => {
    const types = [...new Set(list.map((it) => it.type))]
    const typeLabel = (t) => data.types.find((x) => x.type === t)?.label || t
    const smiths = g === "Änderungen der KI" ? [...new Set(list.map((it) => it.smith).filter(Boolean))] : []
    menu(btn, [
      { label: `Alle ${list.length} als erledigt markieren`, icon: "check", run: async () => (await confirmDialog(`${list.length} Meldung(en) in „${g}“ als erledigt markieren? Sie erscheinen wieder, wenn sich etwas ändert.`)) && dismissItems(list) },
      "-",
      ...types.flatMap((t) => [
        { label: `${types.length > 1 ? `„${typeLabel(t)}“ ` : ""}bündeln`, icon: "layers", run: () => configure(t, "gebuendelt") },
        { label: `${types.length > 1 ? `„${typeLabel(t)}“ ` : ""}nicht mehr anzeigen`, icon: "belloff", run: () => configure(t, "aus") },
      ]),
      ...(data.bundled.includes(g) ? types.map((t) => ({ label: `${types.length > 1 ? `„${typeLabel(t)}“ ` : ""}einzeln anzeigen`, icon: "bell", run: () => configure(t, "an") })) : []),
      ...(smiths.length ? ["-", ...smiths.map((s) => ({ label: `Änderungen von ${s} ausblenden`, icon: "belloff", run: () => configure(`change.${s}`, "aus") }))] : []),
      "-",
      { label: "Alle Meldungsarten einstellen …", icon: "settings", run: () => settingsDialog() },
    ])
  }

  const draw = () => {
    const groups = new Map()
    for (const it of data.items) (groups.get(it.group) ?? groups.set(it.group, []).get(it.group)).push(it)
    const ordered = [...groups.keys()]
    const hiddenTotal = Object.values(data.hidden.byType).reduce((a, b) => a + b, 0)
    swap(
      page,
      h(
        "div",
        { class: "page-head" },
        h("div", { class: "grow" }, h("h1", { text: `Zu prüfen (${data.badge})` }), h("div", { class: "muted", text: `Was die Agenten seit ${data.since ? fmtDate(data.since) : "Ihrem letzten Besuch"} geändert haben und was eine Entscheidung braucht – mit der Aktion direkt daneben.` })),
        h(
          "div",
          { class: "toolbar" },
          h("button", { class: "btn", type: "button", text: "Als gesehen markieren", title: "Änderungen der KI ab jetzt neu zählen", onclick: async () => (await get("inbox", { mark: "1" }), ctx.setQuery({ seit: undefined }), load()) }),
          h("a", { class: "btn ghost", href: `#/eingang?seit=${encodeURIComponent(new Date(Date.now() - 7 * 86400000).toISOString())}`, text: "Letzte 7 Tage" }),
          h("button", { class: "btn", type: "button", onclick: () => settingsDialog() }, icon("bell", 14), "Meldungen einstellen"),
        ),
      ),
      h(
        "div",
        { class: "chips", style: { marginBottom: "12px" } },
        h("button", { class: `chip ${!filter.group ? "accent" : "outline"}`, type: "button", text: "alle", onclick: () => ((filter.group = ""), ctx.setQuery({ gruppe: undefined }), draw()) }),
        ordered.map((g) => h("button", { class: `chip ${filter.group === g ? "accent" : "outline"}`, type: "button", text: `${g} · ${data.counts[g] ?? groups.get(g).length}${data.bundled.includes(g) ? " (gebündelt)" : ""}`, onclick: () => ((filter.group = g), ctx.setQuery({ gruppe: g }), draw()) })),
      ),
      body,
      hiddenTotal || data.hidden.dismissed
        ? h(
            "div",
            { class: "hidden-note" },
            icon("belloff", 14),
            hiddenTotal ? `${hiddenTotal} Meldung(en) ausgeblendet (${Object.entries(data.hidden.byType).map(([t, n]) => `${data.types.find((x) => x.type === t)?.label ?? t} ${n}`).join(", ")})` : "",
            data.hidden.dismissed ? `${hiddenTotal ? " · " : ""}${data.hidden.dismissed} als erledigt markiert` : "",
            h("button", { class: "btn sm ghost", type: "button", text: "einstellen", onclick: () => settingsDialog() }),
          )
        : null,
    )
    swap(
      body,
      data.items.length
        ? ordered
            .filter((g) => !filter.group || g === filter.group)
            .map((g) => {
              const list = groups.get(g)
              const bundled = data.bundled.includes(g) && filter.group !== g
              const total = data.counts[g] ?? list.length
              const more = h("button", { class: "btn sm ghost icon", type: "button", title: "Diese Meldungen einstellen", "aria-label": "Diese Meldungen einstellen" }, icon("more", 14))
              more.addEventListener("click", () => groupMenu(more, g, list))
              const wrap = h(
                "div",
                { class: `inbox-group${bundled ? " bundled" : ""}${expanded.has(g) ? " expanded" : ""}` },
                h("h2", null, h("span", { class: "grow" }, g, " ", h("span", { class: "badge muted", text: String(total) })), more),
                bundled
                  ? h(
                      "button",
                      { class: "bundle-row", type: "button", onclick: () => (expanded.add(g), wrap.classList.add("expanded")) },
                      icon("layers", 14),
                      h("span", { class: "grow", style: { textAlign: "left" }, text: `${total} Meldung(en) gebündelt${g === "Änderungen der KI" ? ` – ${summarySmiths(list)}` : ""}` }),
                      h("span", { text: "anzeigen" }),
                    )
                  : null,
                h("div", { class: "list" }, list.map(itemRow)),
                total > list.length ? h("div", { class: "faint", style: { fontSize: "12.5px", marginTop: "6px" }, text: `${total - list.length} weitere – höchstens ${list.length} je Gruppe (inbox.maxPerGroup)` }) : null,
              )
              return wrap
            })
        : h("div", { class: "card empty-state" }, h("h2", { text: "Alles erledigt" }), h("p", { class: "muted", text: "Nichts zu prüfen – die Agenten haben seit Ihrem letzten Besuch nichts geändert und es wartet keine Entscheidung." })),
    )
  }

  const summarySmiths = (list) => {
    const by = {}
    for (const it of list) by[it.smith || "?"] = (by[it.smith || "?"] || 0) + 1
    return Object.entries(by)
      .sort((a, b) => b[1] - a[1])
      .map(([s, n]) => `${s} ${n}`)
      .join(", ")
  }

  const itemRow = (it) => {
    const open = it.data?.job && it.type !== "job-failed" ? `#/agenten/${encodeURIComponent(it.data.job)}` : it.type === "job-failed" ? `#/jobs?job=${encodeURIComponent(it.data.job)}` : it.type === "conflict" ? `#/konflikte?id=${encodeURIComponent(it.data.conflict)}` : it.target ? entryHref(it.target) : null
    const buttons = []
    if (it.type === "proposal" || it.type === "staged") buttons.push(h("button", { class: "btn sm", type: "button", text: "Diff ansehen", onclick: () => proposalDialog({ id: it.data.staged, smith: it.title.split(":")[0], reason: it.detail, target: it.target.split(":")[0], name: it.target.slice(it.target.indexOf(":") + 1), sessionID: it.data.session, args: {} }, load) }))
    if (it.type === "change" && it.data?.commit) buttons.push(h("a", { class: "btn sm", href: it.data.count > 1 ? entryHref(it.target, "versionen") : `#/commit/${it.data.commit}`, text: it.data.count > 1 ? "Versionen" : "Diff" }))
    if (it.type === "abbreviation") buttons.push(h("a", { class: "btn sm", href: `#/neu/glossar?titel=${encodeURIComponent(it.data.term)}`, text: "Bedeutung eintragen" }))
    if (it.type === "job-failed") buttons.push(h("a", { class: "btn sm", href: `#/logs?cid=${encodeURIComponent(it.data.run)}&stufe=debug`, text: "Log" }))
    if (!app.readOnly)
      for (const a of it.actions) {
        buttons.push(
          h("button", {
            class: `btn sm ${["Übernehmen", "Bestätigen", "Einplanen", "Freigeben"].includes(a.label) ? "primary" : ""}`,
            type: "button",
            text: a.label,
            onclick: async () => {
              if (a.confirm && !(await confirmDialog(`${a.label}: ${it.title}?`))) return
              const r = await act(a.action, a.args || {}, { target: a.target, quiet: a.action === "feedback", skipConfirm: !!a.confirm && a.action !== "run.undo" })
              if (r) {
                if (a.action === "feedback") {
                  data.items = data.items.filter((x) => x.id !== it.id)
                  draw()
                } else load()
              }
            },
          }),
        )
      }
    const more = h("button", { class: "btn sm ghost icon", type: "button", title: "Mehr", "aria-label": "Mehr" }, icon("more", 14))
    more.addEventListener("click", () =>
      menu(more, [
        { label: "Erledigt", icon: "check", run: () => dismissItems([it]) },
        "-",
        { label: `Diese Art nicht mehr anzeigen (${data.types.find((t) => t.type === it.type)?.label ?? it.type})`, icon: "belloff", run: () => configure(it.type, "aus") },
        it.type === "change" && it.smith ? { label: `Änderungen von ${it.smith} nicht mehr anzeigen`, icon: "belloff", run: () => configure(`change.${it.smith}`, "aus") } : null,
        { label: "Diese Art bündeln", icon: "layers", run: () => configure(it.type, "gebuendelt") },
      ]),
    )
    return h(
      "div",
      { class: "inbox-item" },
      h("span", { class: `sev ${it.severity}` }),
      it.target ? kindChip({ id: it.target }) : null,
      h(
        "div",
        { class: "grow" },
        open ? h("a", { href: open, "data-id": it.target && !it.data?.job ? it.target : undefined, style: { fontWeight: 600 }, text: it.title }) : h("div", { style: { fontWeight: 600 }, text: it.title }),
        it.detail ? h("div", { class: "muted", style: { fontSize: "13px" }, text: it.detail }) : null,
        it.at ? h("div", { class: "faint", style: { fontSize: "12px" }, text: fmtRel(it.at) }) : null,
      ),
      h("div", { class: "acts" }, buttons, app.readOnly ? null : h("button", { class: "btn sm ghost icon", type: "button", title: "Erledigt", "aria-label": "Erledigt", onclick: () => dismissItems([it]) }, icon("check", 14)), app.readOnly ? null : more),
    )
  }

  /** All message types with their mode and the notifications – saved together (one commit). */
  const settingsDialog = async () => {
    const info = await get("info")
    const types = Object.fromEntries([...data.types, ...data.subtypes].map((t) => [t.type, t.mode]))
    const cfg = info.config?.notify ?? {}
    const events = new Set(cfg.events ?? [])
    const channels = { toast: cfg.toast !== false, browser: cfg.browser !== false, macos: !!cfg.macos }
    const seg = (type) => {
      const wrap = h("div", { class: "seg" })
      const drawSeg = () =>
        swap(
          wrap,
          ["an", "gebuendelt", "aus"].map((m) => h("button", { type: "button", class: types[type] === m ? "on" : "", text: MODE_LABEL[m], onclick: () => ((types[type] = m), drawSeg(), type === "change" && drawSubs()) })),
        )
      drawSeg()
      return wrap
    }
    const typeRow = (t) => h("tr", null, h("td", null, h("div", { style: { fontWeight: 600 }, text: t.label }), h("div", { class: "faint", style: { fontSize: "12px" }, text: t.description })), h("td", { class: "count", text: String(t.count || "") }), h("td", null, seg(t.type)))
    const subRows = h("tbody")
    const drawSubs = () => swap(subRows, data.subtypes.map((s) => h("tr", { class: "sub" }, h("td", { text: s.label }), h("td", { class: "count", text: String(s.count || "") }), h("td", null, seg(s.type)))))
    drawSubs()
    const ok = await modal((close) => ({
      title: "Meldungen und Benachrichtigungen",
      wide: true,
      body: [
        h("p", { class: "muted", style: { fontSize: "13px" }, text: "Je Meldungsart: anzeigen, bündeln (eine aufklappbare Zeile je Gruppe) oder ausblenden. Ausgeblendetes zählt nicht im Eingang und nicht im Zähler." }),
        h(
          "table",
          { class: "mode-table" },
          // the per-smith switches follow the row "Änderungen der KI"
          h("tbody", null, data.types.slice(0, data.types.findIndex((t) => t.type === "change") + 1).map(typeRow)),
          subRows,
          h("tbody", null, data.types.slice(data.types.findIndex((t) => t.type === "change") + 1).map(typeRow)),
        ),
        h("h3", { text: "Benachrichtigungen" }),
        h("p", { class: "muted", style: { fontSize: "13px" }, text: "Mitteilungen außerhalb des Eingangs – als Toast in opencode, im Browser oder als macOS-Mitteilung." }),
        h(
          "div",
          { class: "chips" },
          [["toast", "Toast in opencode"], ["browser", "Browser"], ["macos", "macOS"]].map(([k, l]) => {
            const cb = h("input", { type: "checkbox", checked: channels[k] })
            cb.addEventListener("change", () => (channels[k] = cb.checked))
            return h("label", { class: "chip outline" }, cb, l)
          }),
        ),
        h(
          "div",
          { class: "chips", style: { marginTop: "8px" } },
          NOTIFY_EVENTS.map(([k, l]) => {
            const cb = h("input", { type: "checkbox", checked: events.has(k) })
            cb.addEventListener("change", () => (cb.checked ? events.add(k) : events.delete(k)))
            return h("label", { class: "chip outline" }, cb, l)
          }),
        ),
      ],
      foot: [h("button", { class: "btn", type: "button", text: "Abbrechen", onclick: () => close(false) }), h("button", { class: "btn primary", type: "button", text: "Übernehmen", onclick: () => close(true) })],
    }))
    if (!ok) return
    // stored: every type that is not shown normally; per-smith switches only where they differ
    const stored = Object.fromEntries(Object.entries(types).filter(([t, m]) => (t.startsWith("change.") ? m !== types.change : m !== "an")))
    const r = await act("settings.set", { values: { "inbox.types": stored, "notify.events": NOTIFY_EVENTS.map(([k]) => k).filter((k) => events.has(k)), "notify.toast": channels.toast, "notify.browser": channels.browser, "notify.macos": channels.macos }, reason: "Eingang und Benachrichtigungen" })
    if (r) load()
  }

  await load()
  if (ctx.query.get("einstellen") === "1") {
    ctx.setQuery({ einstellen: undefined })
    settingsDialog()
  }
  const later = debounce(() => ctx.alive() && load(), 1500)
  for (const t of ["run.finished", "inbox.changed", "agent.job", "task.changed", "job.changed"]) ctx.on(t, later)
}

export { put }
