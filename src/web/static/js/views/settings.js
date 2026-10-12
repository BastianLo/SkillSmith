import { get, token } from "../api.js"
import { h, icon, put, segmented, storeGet, storeSet, swap } from "../dom.js"
import { act, app, askToken, card, confirmDialog, modal, toast, typeNameDialog } from "../ui.js"

export default async function settings(ctx) {
  ctx.title("Einstellungen")
  const info = await get("info")
  if (!ctx.alive()) return
  app.info = info
  const page = h("div", { class: "page narrow" })
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
  const curatorReport = h("div")
  put(
    page,
    h("h1", { text: "Einstellungen" }),
    h("p", { class: "page-sub", text: `skillsmith ${info.version} · Store ${info.store}` }),
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
        h("span", { class: "faint", text: info.notify?.browser ? "(notify.browser an)" : "(notify.browser aus)" }),
      ),
    ),
    card(
      "Sicherheit",
      h("table", { class: "facts" }, h("tbody", null, [
        ["Token-Pflicht (web.token)", info.token ? "an" : "aus – jeder Prozess auf diesem Rechner kann lesen und schreiben"],
        ["Token in diesem Browser", token() ? "vorhanden" : "fehlt"],
        ["Agenten starten / freigeben braucht Token", info.tasksRequireToken ? "ja" : "nein"],
        ["Pipeline-Befehle ändern braucht Token", info.pipelineRequireToken ? "ja" : "nein"],
        ["Nur lesend (web.readOnly)", info.readOnlyConfig ? "ja" : "nein"],
        ["Für diese Sitzung gesperrt", app.readOnly && !info.readOnlyConfig ? "ja" : "nein"],
      ].map(([k, v]) => h("tr", null, h("td", { text: k }), h("td", { text: v }))))),
      h("div", { class: "toolbar" }, lockBtn, h("button", { class: "btn", type: "button", onclick: async () => (await askToken()) && toast("Token übernommen.", { variant: "success" }) }, "Token eingeben")),
    ),
    card(
      "Hintergrund",
      h("p", { class: "muted", style: { fontSize: "13px" }, text: "Läufe, die sonst automatisch passieren, jetzt auslösen." }),
      h(
        "div",
        { class: "toolbar" },
        h("button", { class: "btn", type: "button", disabled: app.readOnly, onclick: async () => {
          const r = await act("curator.run", { dry: true }, { quiet: true })
          if (r?.data) swap(curatorReport, h("div", { class: "card flat" }, h("h3", { text: "Vorschau des Curators" }), h("pre", { class: "mono", style: { whiteSpace: "pre-wrap", fontSize: "12px" }, text: typeof r.data.report === "string" ? r.data.report : JSON.stringify(r.data.report, null, 2) }), h("button", { class: "btn primary sm", type: "button", text: "Curator ausführen", onclick: async () => (await confirmDialog("Curator jetzt ausführen? Die Läufe committen ihre Änderungen.")) && act("curator.run", { dry: false }) })))
        } }, "Curator (Vorschau)"),
        h("button", { class: "btn", type: "button", disabled: app.readOnly, onclick: () => act("doctor.run", {}) }, "Doktor"),
        h("button", { class: "btn", type: "button", disabled: app.readOnly, onclick: () => act("embeddings.sync", {}) }, "Embeddings abgleichen"),
        h("button", { class: "btn", type: "button", disabled: app.readOnly, onclick: () => act("agent.prepare", {}) }, "Agenten-Vorschläge vorbereiten"),
      ),
      curatorReport,
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
      "Wirksame Konfiguration",
      h("p", { class: "muted", style: { fontSize: "13px" }, text: "Nur zur Anzeige – geändert wird in opencode.json (Plugin-Optionen von skillsmith). Geheimnisse sind nicht enthalten." }),
      Object.entries(info.config || {})
        .filter(([, v]) => v && typeof v === "object" && !Array.isArray(v))
        .map(([k, v]) => h("details", null, h("summary", { class: "mono", text: k }), h("pre", { class: "mono", style: { whiteSpace: "pre-wrap", fontSize: "12px" }, text: JSON.stringify(v, null, 2) }))),
      h("details", null, h("summary", { class: "mono", text: "übrige Werte" }), h("pre", { class: "mono", style: { whiteSpace: "pre-wrap", fontSize: "12px" }, text: JSON.stringify(Object.fromEntries(Object.entries(info.config || {}).filter(([, v]) => !v || typeof v !== "object" || Array.isArray(v))), null, 2) })),
    ),
    card(
      "Tastenkürzel",
      h("table", { class: "facts" }, h("tbody", null, [
        ["Strg+K", "Befehlspalette: Ansichten, Einträge, Aktionen"],
        ["/", "Suche"],
        ["n", "Schnellnotiz"],
        ["g i / g b / g g / g s / g d / g t", "Eingang / Board / Graph / Statistik / Dokumente / Tagesnotiz"],
        ["Strg+S, Strg+L, [[", "Editor: speichern, Link einfügen, Link-Vorschläge"],
        ["Leertaste, Pfeile", "Board: Karte aufnehmen, verschieben, ablegen"],
      ].map(([k, v]) => h("tr", null, h("td", null, h("kbd", { text: k })), h("td", { text: v }))))),
    ),
  )
  ctx.el.replaceChildren(page)
}

export { modal }
