/**
 * Write flows through the real UI (demo server): editor with [[ completion and Ctrl+S,
 * board drag & drop and keyboard, checklist, attachment upload, quick note, conflict,
 * AI proposal, agent acceptance, palette. Checks the result through the API.
 *
 *   PLAYWRIGHT_CORE=… DEMO_URL='http://127.0.0.1:47555/#t=…' bun test/web/ui-flows.ts [shots]
 */
import { mkdirSync } from "node:fs"
import { join } from "node:path"

const url = process.env.DEMO_URL
if (!url) throw new Error("DEMO_URL fehlt")
const shots = process.argv[2] || "screenshots"
mkdirSync(shots, { recursive: true })
const base = url.replace(/#.*$/, "")
const token = /#t=([0-9a-f]+)/.exec(url)![1]
const { chromium } = (await import(process.env.PLAYWRIGHT_CORE || "playwright-core")) as any
const api = async (path: string) => (await fetch(`${base}api/${path}`, { headers: { "x-smith-token": token } })).json() as Promise<any>

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium" })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors: string[] = []
page.on("pageerror", (e: Error) => errors.push(`pageerror: ${e.message}`))
page.on("console", (m: any) => m.type() === "error" && errors.push(`console: ${m.text()}`))
const results: Array<[string, boolean, string?]> = []
const check = (name: string, ok: boolean, detail?: string) => {
  results.push([name, ok, detail])
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` – ${detail}` : ""}`)
}
const go = async (hash: string, wait = 900) => {
  await page.goto(`${base}${hash}`)
  await page.waitForTimeout(wait)
}
const clickText = async (text: string, scope = "body") => {
  // a dialog of the previous step may still be closing (slow machine): wait for it first
  if (scope === "body") await page.waitForSelector(".overlay", { state: "detached", timeout: 15_000 }).catch(() => undefined)
  return page.locator(scope).getByRole("button", { name: text, exact: true }).first().click()
}

await page.goto(url)
await page.waitForTimeout(800)

// 1. editor: [[ completion, Ctrl+S, version + commit
{
  await go("#/editor/knowledge%3Atoken-store", 1800)
  const before = await api("entry?id=knowledge%3Atoken-store")
  await page.click(".cm-content")
  await page.keyboard.press("Control+End")
  await page.keyboard.type("\n\nVerwandt: [[Testsys")
  await page.waitForTimeout(900)
  const option = await page.locator(".cm-tooltip-autocomplete li").first().textContent().catch(() => "")
  check("Editor: [[ schlägt Ziele vor", /Testsystem T2/.test(option || ""), option || "keine Vorschläge")
  await page.keyboard.press("Enter")
  await page.waitForTimeout(300)
  await page.keyboard.press("Control+s")
  await page.waitForTimeout(1500)
  const after = await api("entry?id=knowledge%3Atoken-store")
  check("Editor: Strg+S speichert mit [[Link]]", after.body.includes("[[t2-testsystem]]") && after.version !== before.version, after.body.slice(-60))
  const audit = await api("audit?target=knowledge%3Atoken-store&limit=5")
  check("Editor: Audit-Ereignis und Commit", audit.events.some((e: any) => e.actor === "user-web" && e.commit))
  await page.screenshot({ path: join(shots, "f01-editor-gespeichert.png") })
}

// 2. board: drag & drop between columns and keyboard move
{
  await go("#/board?projekt=kundenportal", 1200)
  const card = page.locator('.tcard[data-name="t-3"]')
  const target = page.locator('.col[data-col="in_umsetzung"] .col-body')
  await card.dragTo(target)
  await page.waitForTimeout(1500)
  let t = (await api("task?id=t-3")).task
  check("Board: Drag & Drop wechselt die Spalte", t.status === "in_umsetzung", t.status)
  await page.locator('.tcard[data-name="t-4"]').focus()
  await page.keyboard.press(" ")
  await page.keyboard.press("ArrowRight")
  await page.keyboard.press(" ")
  await page.waitForTimeout(1500)
  // WIP limit 3 reached → confirmation dialog
  const dialog = await page.locator(".overlay .dialog").count()
  if (dialog) {
    await page.screenshot({ path: join(shots, "f02-wip-bestaetigung.png") })
    await clickText("Trotzdem ausführen", ".overlay")
    await page.waitForTimeout(1500)
  }
  t = (await api("task?id=t-4")).task
  check("Board: Tastatur verschiebt (mit WIP-Bestätigung)", t.status === "in_umsetzung", `${t.status}${dialog ? ", WIP-Dialog" : ""}`)
}

// 3. task: checklist toggle, attachment upload (file input), subtask
{
  await go("#/aufgabe/t-1", 1500)
  const box = page.locator(".md li.task input[type=checkbox]").first()
  await box.check()
  await page.waitForTimeout(1500)
  const tk = await api("task?id=t-1")
  check("Aufgabe: Checkbox abhaken schreibt zurück", /- \[x\] Token ist nach Logout gesperrt/.test(tk.body))
  await page.setInputFiles('input[type=file]', { name: "log.txt", mimeType: "text/plain", buffer: Buffer.from("ERROR timeout at gateway\n") })
  await page.waitForTimeout(1800)
  const tk2 = await api("task?id=t-1")
  check("Aufgabe: Anhang hochgeladen", tk2.task.attachments.some((a: string) => /log-/.test(a)), tk2.task.attachments.join(", "))
  await page.fill('input[placeholder="+ Unteraufgabe (Enter)"]', "Doku nachziehen")
  await page.keyboard.press("Enter")
  await page.waitForTimeout(1500)
  const tk3 = await api("task?id=t-1")
  check("Aufgabe: Unteraufgabe angelegt", tk3.children.some((c: any) => c.title === "Doku nachziehen"))
}

// 4. quick note (n) → document "Eingang"
{
  await go("#/", 800)
  await page.keyboard.press("n")
  await page.waitForTimeout(300)
  await page.fill(".overlay textarea", "Gateway-Timeout im Auge behalten")
  await page.keyboard.press("Control+Enter")
  await page.waitForTimeout(1500)
  const e = await api("entry?id=knowledge%3Aeingang")
  check("Schnellnotiz landet im Dokument Eingang", e.body.includes("Gateway-Timeout im Auge behalten"))
}

// 5. conflict decided per click
{
  await go("#/konflikte", 1000)
  await clickText("Beide gelten")
  await page.waitForTimeout(1500)
  const c = await api("conflicts")
  check("Konflikt per Klick entschieden", c.length > 0 && c.every((x: any) => x.status === "resolved"))
}

// 6. AI proposal: open diff from the inbox and accept
{
  await go("#/eingang", 1200)
  await page.getByRole("button", { name: "Diff ansehen" }).first().click()
  await page.waitForTimeout(1200)
  await page.screenshot({ path: join(shots, "f06-vorschlag-diff.png") })
  await clickText("Übernehmen", ".overlay")
  await page.waitForTimeout(1500)
  const d = await api("entry?id=knowledge%3Adeployment-testsystem-t2")
  check("KI-Vorschlag per Diff übernommen", d.body.includes("Migration vor dem Deployment ausführen") && !d.proposals.length)
}

// 7. agent: accept and merge the worktree branch
{
  const jobs = await api("jobs")
  const job = jobs.find((j: any) => j.phase === "in_test")
  if (job) {
    await go(`#/agenten/${job.id}`, 1500)
    await clickText("Abnehmen")
    await page.waitForTimeout(400)
    await page.locator(".overlay .btn.primary").first().click()
    await page.waitForTimeout(2500)
    const j = (await api(`job?id=${job.id}`)).job
    const t = (await api("task?id=t-1")).task
    check("Agenten-Auftrag abgenommen und gemergt", j.phase === "accepted" && t.status === "erledigt", `${j.phase} / ${t.status}`)
  } else check("Agenten-Auftrag abgenommen und gemergt", false, "kein Auftrag in test")
}

// 8. palette: jump to an entry
{
  await go("#/", 600)
  await page.keyboard.press("Control+k")
  await page.keyboard.type("Auth-Gateway")
  // the entry search is debounced and asynchronous: wait until the entry is listed first
  await page.waitForFunction(() => document.querySelector(".palette .item.on")?.textContent?.includes("Auth-Gateway") && document.querySelector(".palette .item.on .grp")?.textContent === "Eintrag", null, { timeout: 15_000 }).catch(() => undefined)
  await page.keyboard.press("Enter")
  await page.waitForTimeout(1000)
  check("Befehlspalette springt zum Eintrag", page.url().includes("eintrag/knowledge%3Aauth-gateway"), page.url())
}

// 9. new document with template, then rename with preview
{
  await go("#/neu/dokument", 1200)
  await page.fill('input[placeholder="Titel"]', "Runbook Gateway-Neustart")
  await page.selectOption("select >> nth=0", { label: "Runbook" }).catch(() => undefined)
  await clickText("Anlegen und bearbeiten")
  await page.waitForTimeout(1800)
  check("Neues Dokument öffnet den Editor", /editor\/knowledge(%3A|:)runbook-gateway-neustart/.test(page.url()), page.url())
}

// 10. read-only lock blocks writes
{
  await go("#/einstellungen", 1000)
  await page.getByRole("button", { name: /Schreiben für diese Sitzung sperren/ }).click()
  await page.waitForTimeout(800)
  const r = await fetch(`${base}api/action`, { method: "POST", headers: { "x-smith-token": token, "content-type": "application/json", origin: base.replace(/\/$/, "") }, body: JSON.stringify({ action: "note.quick", args: { text: "x" } }) })
  check("Sperre: Schreibaktionen abgelehnt (403)", r.status === 403, String(r.status))
  await page.getByRole("button", { name: /Schreiben wieder erlauben/ }).click()
  await page.waitForTimeout(800)
}

// 11. graph: d3-force physics keeps running (AC1) and drag pulls neighbours (AC2)
{
  await go("#/graph", 1500)
  const hasHook = await page.evaluate(() => typeof (window as any).__smithGraph?.nodes === "function")
  if (!hasHook) {
    check("Graph: Dauerlauf bewegt Knoten", false, "window.__smithGraph fehlt")
    check("Graph: Drag zieht Nachbarn", false, "window.__smithGraph fehlt")
  } else {
    const pos = () => page.evaluate(() => (window as any).__smithGraph.nodes().map((d: any) => [d.id, d.x, d.y] as [string, number, number]))
    const t0 = await pos()
    await page.waitForTimeout(800)
    const t1 = await pos()
    const byId = new Map(t1.map(([id, x, y]) => [id, [x, y]]))
    const moved = t0.filter(([id, x, y]) => {
      const p = byId.get(id)
      return p && Math.hypot(p[0] - x, p[1] - y) > 0.5
    }).length
    check("Graph: Dauerlauf bewegt Knoten", moved >= 2, `${moved} Knoten bewegt in 800 ms`)

    const prep = await page.evaluate(() => {
      const g = (window as any).__smithGraph
      const links = g.links()
      const real = links.find((l: any) => !l.weak && l.source && l.target && typeof l.source === "object" && typeof l.target === "object")
      if (!real) return { ok: false, why: "keine echte Kante" }
      const a = real.source
      const b = real.target
      ;(window as any).__gtest = { aId: a.id, bId: b.id, bx: b.x, by: b.y }
      a.fx = a.x + 40
      a.fy = a.y + 40
      g.simulation().alphaTarget(0.3).restart()
      return { ok: true, a: a.id, b: b.id }
    })
    if (!prep.ok) {
      check("Graph: Drag zieht Nachbarn", false, prep.why)
    } else {
      await page.waitForTimeout(800)
      const bMoved = await page.evaluate(() => {
        const g = (window as any).__smithGraph
        const t = (window as any).__gtest
        if (!g || !t) return null
        const b = g.nodes().find((d: any) => d.id === t.bId)
        return b ? Math.hypot(b.x - t.bx, b.y - t.by) : null
      })
      check("Graph: Drag zieht Nachbarn", bMoved !== null && bMoved > 0.5, bMoved === null ? "Nachbar nicht gefunden" : `Nachbar ${prep.b} ${bMoved.toFixed(1)} px bewegt`)
      await page.evaluate(() => {
        const g = (window as any).__smithGraph
        const a = g?.nodes().find((d: any) => d.id === (window as any).__gtest?.aId)
        if (a) {
          a.fx = null
          a.fy = null
        }
        g?.simulation().alphaTarget(0.05)
      })
    }
  }
}

await browser.close()
const bad = results.filter((r) => !r[1])
if (errors.length) console.error(errors.join("\n"))
console.log(`${results.length - bad.length}/${results.length} Abläufe ok`)
process.exit(bad.length || errors.length ? 1 : 0)
