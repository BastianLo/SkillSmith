/**
 * UI smoke test of the web view: opens every view of the demo server in Chromium, fails on
 * JavaScript errors and failed requests, and stores screenshots.
 *
 *   bun test/web/demo.ts 47555 &           # demo data + server
 *   PLAYWRIGHT_CORE=/pfad/zu/node_modules/playwright-core DEMO_URL='http://127.0.0.1:47555/#t=…' \
 *     bun test/web/ui-smoke.ts [screenshot-dir]
 */
import { mkdirSync } from "node:fs"
import { join } from "node:path"

const url = process.env.DEMO_URL
if (!url) throw new Error("DEMO_URL fehlt (Ausgabe von test/web/demo.ts)")
const outDir = process.argv[2] || "screenshots"
mkdirSync(outDir, { recursive: true })
const { chromium } = (await import(process.env.PLAYWRIGHT_CORE || "playwright-core")) as any
const base = url.replace(/#.*$/, "")
const routes: Array<[string, string, string?]> = [
  ["01-uebersicht", "#/"],
  ["02-eingang", "#/eingang"],
  ["03-dokumente", "#/dokumente"],
  ["04-dokument", "#/eintrag/knowledge%3Aauth-gateway"],
  ["05-versionen", "#/eintrag/knowledge%3Aauth-gateway?tab=versionen"],
  ["06-nutzung", "#/eintrag/knowledge%3Aauth-gateway?tab=nutzung"],
  ["07-editor", "#/editor/knowledge%3Aauth-gateway"],
  ["08-graph", "#/graph"],
  ["09-board", "#/board?projekt=kundenportal"],
  ["10-aufgabe", "#/aufgabe/t-1"],
  ["11-agenten", "#/agenten"],
  ["13-projekt", "#/projekt/kundenportal"],
  ["14-projekt-bearbeiten", "#/projekt/kundenportal/bearbeiten"],
  ["16-statistik", "#/statistik"],
  ["17-statistik-tools", "#/statistik?bereich=tools"],
  ["18-audit", "#/audit"],
  ["19-historie", "#/historie"],
  ["20-konflikte", "#/konflikte"],
  ["21-simulator", "#/simulator?text=Wie%20sperre%20ich%20das%20Refresh-Token%20beim%20Logout%3F"],
  ["22-landkarte", "#/landkarte"],
  ["23-glossar", "#/glossar"],
  ["24-tags", "#/tags"],
  ["25-tagesnotiz", "#/tagesnotiz"],
  ["26-freigaben", "#/freigaben"],
  ["27-suche", "#/suche?q=token"],
  ["28-liste-erinnerungen", "#/liste/memory"],
  ["29-werkstatt", "#/werkstatt"],
  ["30-export", "#/export"],
  ["31-einstellungen", "#/einstellungen"],
  ["32-ticket", "#/ticket/T2-123"],
  ["33-neues-dokument", "#/neu/dokument"],
  ["34-chat", "#/chat"],
  ["35-sessions", "#/sessions"],
  ["36-kandidaten", "#/kandidaten"],
  ["37-verlauf", "#/verlauf"],
  ["38-erinnerung", "#/eintrag/memory%3Ashop-entscheidung-token-speicherung"],
  ["39-arbeitsstaende", "#/liste/arbeitsstand"],
  ["41-einstellungen-sitzung", "#/einstellungen?tab=sitzung"],
  ["42-einstellungen-suche", "#/einstellungen?q=token"],
  ["43-log", "#/logs?stufe=debug"],
  ["44-log-gruppiert", "#/logs?gruppe=lauf&stufe=debug"],
  ["45-jobs", "#/jobs?job=prune"],
  ["46-eingang-einstellen", "#/eingang?einstellen=1"],
  ["47-aufgabe-kriterien-tests", "#/aufgabe/t-1?tab=tests"],
  ["48-agenten-liste", "#/liste/agent"],
  ["49-neuer-agent", "#/neu/agent"],
]

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium" })
const errors: string[] = []
for (const theme of ["light", "dark"]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: theme })
  page.on("pageerror", (e: Error) => errors.push(`[${theme}] pageerror ${page.url()}: ${e.message}`))
  page.on("console", (m: any) => m.type() === "error" && errors.push(`[${theme}] console ${page.url()}: ${m.text()}`))
  page.on("response", (r: any) => r.status() >= 400 && !/\/api\/entry\?id=knowledge%3Ajournal/.test(r.url()) && errors.push(`[${theme}] HTTP ${r.status()} ${r.url()}`))
  await page.goto(url)
  await page.waitForTimeout(800)
  const list = theme === "light" ? routes : routes.filter(([n]) => /uebersicht|board|graph|statistik$|editor|aufgabe/.test(n))
  for (const [name, hash] of list) {
    await page.goto(`${base}${hash}`)
    await page.waitForTimeout(/graph|landkarte|editor|statistik|04-|10-/.test(name) ? 2200 : 900)
    await page.screenshot({ path: join(outDir, `${name}${theme === "dark" ? "-dunkel" : ""}.png`), fullPage: false })
  }
  if (theme === "light") {
    // agent job page and pipeline run (links from the data)
    await page.goto(`${base}#/agenten`)
    await page.waitForTimeout(800)
    const job = await page.$eval("a.row[href^='#/agenten/']", (a: any) => a.getAttribute("href")).catch(() => null)
    if (job) {
      await page.goto(`${base}${job}`)
      await page.waitForTimeout(1800)
      await page.screenshot({ path: join(outDir, "12-agenten-auftrag.png"), fullPage: false })
      await page.screenshot({ path: join(outDir, "12b-agenten-auftrag-ganz.png"), fullPage: true })
    }
    await page.goto(`${base}#/projekt/kundenportal`)
    await page.waitForTimeout(800)
    const run = await page.$eval("a.row[href^='#/pipeline/']", (a: any) => a.getAttribute("href")).catch(() => null)
    if (run) {
      await page.goto(`${base}${run}`)
      await page.waitForTimeout(1200)
      await page.screenshot({ path: join(outDir, "15-pipeline-lauf.png"), fullPage: false })
    }
    // command palette and quick note dialog
    await page.goto(`${base}#/`)
    await page.waitForTimeout(600)
    await page.keyboard.press("Control+k")
    await page.keyboard.type("token")
    await page.waitForTimeout(700)
    await page.screenshot({ path: join(outDir, "40-befehlspalette.png") })
    await page.keyboard.press("Escape")
  }
  await page.close()
}
await browser.close()
if (errors.length) {
  console.error(errors.join("\n"))
  process.exit(1)
}
console.log(`ok – Screenshots in ${outDir}`)
