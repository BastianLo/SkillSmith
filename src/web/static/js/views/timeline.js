import { get } from "../api.js"
import { ACTOR_LABEL, debounce, entryHref, fmtDate, h, put } from "../dom.js"
import { act, app } from "../ui.js"

const ACTION_LABEL = {
  create: "neu",
  update: "geändert",
  patch: "korrigiert",
  rewrite: "neu gefasst",
  merge: "zusammengeführt",
  archive: "archiviert",
  restore: "wiederhergestellt",
  dormant: "ruhend",
  activate: "aktiviert",
  relate: "verknüpft",
  supersede: "abgelöst",
  state: "Arbeitsstand",
  result: "Ergebnis",
  upsert: "Glossar",
  publish: "veröffentlicht",
  flag: "markiert",
  migrate: "migriert",
  rename: "umbenannt",
  delete: "gelöscht",
  move: "verschoben",
}

export function timelineList(runs) {
  if (!runs.length) return h("div", { class: "list" }, h("div", { class: "empty", text: "Noch keine Läufe." }))
  return h(
    "div",
    { class: "list" },
    runs.map((r) =>
      h(
        "div",
        { class: "rel" },
        h(
          "div",
          { class: "rel-top" },
          h("span", { class: "chip", text: r.smith }),
          h("span", { text: ACTOR_LABEL[r.actor] || r.actor }),
          h("span", { class: "faint", text: fmtDate(r.at) }),
          r.trigger ? h("span", { class: "faint", text: r.trigger }) : null,
          r.ok === false ? h("span", { class: "chip danger", text: "fehlgeschlagen" }) : null,
          r.commit ? h("a", { class: "mono", href: `#/commit/${r.commit}`, text: r.commit.slice(0, 8) }) : null,
          r.session ? h("a", { href: `#/session/${encodeURIComponent(r.session)}`, text: "Session" }) : null,
          h("span", { class: "grow" }),
          r.commit && !app.readOnly ? h("button", { class: "btn sm ghost", type: "button", text: "Rückgängig", onclick: () => act("run.undo", { run: r.run }, { label: "Lauf rückgängig machen" }) }) : null,
        ),
        r.summary ? h("div", { class: "rel-desc", text: r.summary }) : null,
        r.actions.length
          ? h(
              "ul",
              { class: "meta-lines" },
              r.actions.map((a) => h("li", null, `${ACTION_LABEL[a.kind] || a.kind}: `, a.local && !/^(state|result):/.test(a.id) ? h("span", { class: "mono", text: a.name }) : h("a", { href: entryHref(a.id), "data-id": a.id, text: a.id }), a.reason ? h("span", { class: "faint", text: ` – ${a.reason}` }) : null)),
            )
          : null,
      ),
    ),
  )
}

export default async function timeline(ctx) {
  ctx.title("Läufe")
  const runs = await get("timeline", { limit: 200 })
  if (!ctx.alive()) return
  ctx.el.replaceChildren(put(h("div", { class: "page" }), h("h1", { text: "Läufe" }), h("p", { class: "page-sub", text: "Alle Läufe der Smiths, des Curators, des Doktors und Ihre Aktionen – neueste zuerst. Jeder Lauf mit Änderungen ist ein Commit." }), timelineList(runs)))
  ctx.on("run.finished", debounce(() => ctx.alive() && ctx.reload(), 1500))
}
