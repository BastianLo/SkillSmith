import { h, icon, put, storeGet, storeSet } from "../dom.js"
import { mdBlock } from "../parts.js"
import { act, app, promptDialog } from "../ui.js"

export default async function chat(ctx) {
  ctx.title("Wissens-Chat")
  const history = storeGet("chatHistory", [])
  const page = h("div", { class: "page narrow" })
  const log = h("div", { class: "stack" })
  const input = h("textarea", { class: "input", rows: 3, placeholder: "Frage an Ihre Wissensbasis – z. B. „Wie setze ich die Kafka-Offsets im Testsystem zurück?“ (Strg+Enter)" })
  const btn = h("button", { class: "btn primary", type: "button" }, icon("chat", 14), "Fragen")
  const entry = (q, a, sources) =>
    h(
      "div",
      { class: "card" },
      h("div", { class: "chat-q", style: { marginTop: 0 }, text: q }),
      h("div", { class: "chat-a" }, mdBlock(a)),
      sources?.length ? h("div", { class: "faint", style: { fontSize: "12px", marginTop: "6px" }, text: `${sources.length} Quelle(n) verlinkt` }) : null,
      app.readOnly
        ? null
        : h(
            "div",
            { class: "toolbar", style: { marginBottom: 0 } },
            h("button", { class: "btn sm", type: "button", text: "Als Dokument speichern", onclick: async () => {
              const title = await promptDialog("Als Dokument speichern", { label: "Titel", value: q.slice(0, 120) })
              if (!title) return
              const r = await act("chat.save", { question: q, answer: a, as: "doc", title })
              if (r?.open) location.hash = r.open
            } }),
            h("button", { class: "btn sm", type: "button", text: "Als Ergebnis behalten", onclick: () => act("chat.save", { question: q, answer: a, as: "result" }) }),
          ),
    )
  const ask = async () => {
    const q = input.value.trim()
    if (!q) return
    btn.disabled = true
    const pending = h("div", { class: "card" }, h("div", { class: "chat-q", style: { marginTop: 0 }, text: q }), h("div", { class: "loading" }, h("span", { class: "spinner" }), "Sucht und liest in der Wissensbasis …"))
    log.prepend(pending)
    input.value = ""
    const r = await act("chat.ask", { question: q }, { quiet: true, allowReadOnly: true })
    btn.disabled = false
    if (!r?.data) {
      pending.remove()
      input.value = q
      return
    }
    pending.replaceWith(entry(q, r.data.answer, r.data.sources))
    history.unshift({ q, a: r.data.answer, sources: r.data.sources, at: Date.now() })
    storeSet("chatHistory", history.slice(0, 30))
  }
  btn.addEventListener("click", ask)
  input.addEventListener("keydown", (e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && ask())
  put(
    page,
    h("h1", { text: "Wissens-Chat" }),
    h("p", { class: "page-sub", text: "Eine nur lesende Session mit den Such- und Lesewerkzeugen des Plugins beantwortet Ihre Frage und belegt sie mit [[Links]] auf die Quellen. Private Dokumente bleiben außen vor." }),
    h("div", { class: "card" }, input, h("div", { class: "toolbar", style: { marginBottom: 0 } }, btn, history.length ? h("button", { class: "btn ghost sm", type: "button", text: "Verlauf leeren", onclick: () => (storeSet("chatHistory", []), log.replaceChildren()) }) : null)),
    log,
  )
  for (const x of history) log.append(entry(x.q, x.a, x.sources))
  ctx.el.replaceChildren(page)
  input.focus()
}
