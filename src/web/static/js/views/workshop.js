import { get } from "../api.js"
import { barChart, legendOf } from "../charts.js"
import { entryHref, field, fmtDate, h, icon, put, swap } from "../dom.js"
import { act, app, card } from "../ui.js"
import { entryRow } from "./lists.js"

const CODE_TEMPLATE = `"""Kurzbeschreibung."""
from __future__ import annotations

import argparse


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args(argv)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`
const TEST_TEMPLATE = (mod) => `import unittest

import ${mod}


class Test${mod.replace(/(^|_)(\w)/g, (_m, _a, c) => c.toUpperCase())}(unittest.TestCase):
    def test_main(self) -> None:
        self.assertEqual(${mod}.main([]), 0)


if __name__ == "__main__":
    unittest.main()
`

export default async function workshop(ctx) {
  const name = ctx.params.name
  if (!name && ctx.query.get("neu") !== "1") return scriptList(ctx)
  ctx.title(name ? `Werkstatt: ${name}` : "Neues Skript")
  const data = name ? await get("workshop", { name }) : null
  if (!ctx.alive()) return
  const mod = (n) => (n || "skript").replace(/-/g, "_")
  const page = h("div", { class: "page" })
  const nameIn = h("input", { class: "input wide mono", value: data?.name || "", disabled: !!name, placeholder: "z. B. kafka-offset-reset" })
  const desc = h("input", { class: "input wide", value: data?.description || "" })
  const usage = h("input", { class: "input wide mono", value: data?.usage || "", placeholder: "python kafka_offset_reset.py --group G --topic T" })
  const caps = h("input", { class: "input wide", value: (data?.capabilities || []).join(", "), placeholder: "network, filesystem-write, subprocess …" })
  const reqs = h("input", { class: "input wide mono", value: (data?.requirements || []).join(", "), placeholder: "requests>=2" })
  const tags = h("input", { class: "input wide", value: (data?.tags || []).join(", ") })
  const code = h("textarea", { class: "input mono", rows: 22, spellcheck: "false", value: data?.code || CODE_TEMPLATE })
  const tests = h("textarea", { class: "input mono", rows: 16, spellcheck: "false", value: data?.tests || TEST_TEMPLATE(mod(nameIn.value)) })
  const docs = h("textarea", { class: "input", rows: 8, value: data?.docs || "## Zweck\n\n## Aufruf\n\n## Beispiele\n" })
  const report = h("div")
  const list = (v) => v.split(",").map((x) => x.trim()).filter(Boolean)
  const args = () => ({ name: nameIn.value.trim(), description: desc.value.trim(), usage: usage.value.trim(), code: code.value, tests: tests.value, docs: docs.value, capabilities: list(caps.value), requirements: list(reqs.value), tags: list(tags.value) })
  const showReport = (r) =>
    swap(
      report,
      h(
        "div",
        { class: `card ${r.ok ? "" : "danger"}` },
        h("h3", { text: r.ok ? "Prüfung bestanden" : "Prüfung fehlgeschlagen" }),
        r.risky?.length ? h("div", { class: "notice warn", text: `Riskante Fähigkeiten: ${r.risky.join(", ")} – Veröffentlichen braucht Ihre ausdrückliche Freigabe.` }) : null,
        h("pre", { class: "log", text: r.text || JSON.stringify(r, null, 2) }),
      ),
    )
  const tabs = (label, el) => h("div", { class: "field" }, h("label", { text: label }), el)
  put(
    page,
    h(
      "div",
      { class: "page-head" },
      h("div", { class: "grow" }, h("h1", { text: name ? `Skript-Werkstatt: ${name}` : "Neues Skript" }), h("div", { class: "muted", text: "Python 3.9+, mit Tests. Prüfen führt statische Prüfung, Tests (in der Sandbox, wenn verfügbar) und --help aus. Veröffentlichen nur bei grünen Tests." })),
      h(
        "div",
        { class: "toolbar" },
        h("button", { class: "btn", type: "button", onclick: async () => {
          const r = await act("script.check", args(), { quiet: true })
          if (r?.data) showReport(r.data)
        } }, icon("play", 14), "Prüfen"),
        app.readOnly ? null : h("button", { class: "btn primary", type: "button", onclick: async () => {
          const r = await act("script.publish", args())
          if (r?.target) location.hash = entryHref(r.target)
        } }, icon("check", 14), "Veröffentlichen"),
        name && !app.readOnly ? h("button", { class: "btn", type: "button", onclick: () => act("script.retest", { target: `script:${name}` }) }, icon("refresh", 14), "Veröffentlichte Fassung neu testen") : null,
        name ? h("a", { class: "btn", href: entryHref(`script:${name}`), text: "Eintrag" }) : null,
      ),
    ),
    h(
      "div",
      { class: "cols" },
      h("div", { class: "stack" }, h("div", { class: "card" }, tabs("Code", code), tabs("Tests", tests), tabs("Dokumentation (SCRIPT.md)", docs)), report),
      h(
        "div",
        { class: "stack" },
        h("div", { class: "card" }, field("Name", nameIn), field("Beschreibung", desc), field("Aufruf", usage), field("Fähigkeiten", caps), field("Abhängigkeiten", reqs), field("Tags", tags)),
        data?.test ? card("Letzter Test", h("div", { class: data.test.status === "passed" ? "st-ok" : "st-bad", text: `${data.test.status} · ${fmtDate(data.test.at)}` }), data.test.summary ? h("pre", { class: "mono", style: { whiteSpace: "pre-wrap", fontSize: "11.5px" }, text: data.test.summary }) : null) : null,
        data?.runs?.series ? card("Aufrufe (90 Tage)", (() => {
          const s = [{ name: "ausgeführt", values: data.runs.series.series["script.run"] || [] }]
          return s[0].values.some(Boolean) ? [barChart(data.runs.series.buckets, s, { height: 140 }), legendOf(s), data.runs.success ? h("div", { class: "faint", text: `${data.runs.success.label}: ${data.runs.success.value ?? "–"} % · ${data.runs.success.detail}` }) : null] : h("div", { class: "faint", text: "Noch nicht ausgeführt." })
        })()) : null,
      ),
    ),
  )
  nameIn.addEventListener("change", () => {
    if (!data && tests.value === TEST_TEMPLATE("skript")) tests.value = TEST_TEMPLATE(mod(nameIn.value))
  })
  ctx.el.replaceChildren(page)
}

async function scriptList(ctx) {
  ctx.title("Skripte")
  const items = await get("list", { kind: "script" })
  if (!ctx.alive()) return
  ctx.el.replaceChildren(
    put(
      h("div", { class: "page" }),
      h("div", { class: "page-head" }, h("div", { class: "grow" }, h("h1", { text: `Skripte (${items.length})` }), h("div", { class: "muted", text: "Getestete Python-Skripte von toolsmith und Ihnen. In der Werkstatt bearbeiten, prüfen und veröffentlichen." })), app.readOnly ? null : h("a", { class: "btn primary", href: "#/werkstatt?neu=1" }, icon("plus", 14), "Neues Skript")),
      items.length ? h("div", { class: "list" }, items.map((n) => entryRow(n, { extra: h("a", { class: "btn sm", href: `#/werkstatt/${encodeURIComponent(n.id.slice(7))}`, text: "Werkstatt", onclick: (e) => e.stopPropagation() }) }))) : h("div", { class: "card empty", text: "Noch keine Skripte." }),
    ),
  )
}
