import { get } from "../api.js"
import { fmtDate, h, icon, put } from "../dom.js"

export default async function sessions(ctx) {
  ctx.title("Sessions")
  const list = await get("sessions", { limit: 300 })
  if (!ctx.alive()) return
  const filter = h("input", { class: "input", type: "search", placeholder: "Filtern …", style: { width: "260px" } })
  const listEl = h("div", { class: "list" })
  const draw = () => {
    const q = filter.value.trim().toLowerCase()
    const items = list.filter((s) => !q || `${s.title} ${s.project}`.toLowerCase().includes(q))
    listEl.replaceChildren(...(items.length ? items.map((s) => h("a", { class: "row", href: `#/session/${encodeURIComponent(s.id)}` }, icon("chat", 15), h("div", { class: "main" }, h("div", { class: "title", text: s.title }), h("div", { class: "desc", text: s.project })), h("div", { class: "meta" }, h("span", { text: fmtDate(s.at) }), s.problems ? h("span", { text: `${s.problems} Fehler` }) : null, s.links ? h("span", { text: `${s.links} Einträge` }) : null))) : [h("div", { class: "empty", text: "Keine Sessions im Verlauf." })]))
  }
  filter.addEventListener("input", draw)
  ctx.el.replaceChildren(put(h("div", { class: "page" }), h("h1", { text: "Sessions" }), h("p", { class: "page-sub", text: "Bewertete Sessions aus dem Session-Verlauf: was gefragt wurde, welche Fehler auftraten und was dabei gelernt oder genutzt wurde." }), h("div", { class: "toolbar" }, filter), listEl))
  draw()
}
