# Verifikation – graph-physics (d3-force-Graph-Ansicht)

**Gesamturteil: FAIL** (Teil-Inkrement „Physik-Parameter")

> Der vorige Lauf (d3-force-Migration) endete mit FAIL wegen Blocker B1
> (`let h` überschattete den DOM-Helper `h`). **B1 ist behoben** (`vw`/`vh`,
> graph.js:355-356); die Route rendert wieder. Dieser Lauf prüft das neue Inkrement
> **konfigurierbare Physik-Parameter** und bestätigt zugleich, dass B1 weg ist.

## Abgrenzung

Für den Inkrement „Physik-Parameter" existiert **kein eigener Plan** (`plan.md` beschreibt
die d3-force-Migration). Die Checks sind aus dem Auftrag abgeleitet (ad-hoc-Verifikation).
Umgebung: Demo-Server `npx --yes bun test/web/demo.ts 47555`,
`DEMO_URL http://127.0.0.1:47555/#t=5a755ec98fc4fe326c7231dc52b2ba0a92615aa607926399`,
`browser-debug-mcp` (echter Browser). Demo-Store: **26 Knoten / 10 Kanten**.

## Check-Tabelle

| Check | AC | Ergebnis | Evidenz (Befehl, Beobachtung) |
|---|---|---|---|
| Statik – tsc | – | PASS | `npx tsc --noEmit` → kein Output, Exit 0 |
| Statik – node --check | – | PASS | `node --check src/web/static/js/views/graph.js` → kein Output, Exit 0 |
| Statik – Unit | – | PASS | `npx --yes bun test test/unit` → **167 pass / 0 fail**, 1043 expects, 47.11 s |
| B1-Regression | – | PASS | graph.js:355-356 `vw`/`vh`; `#graph-svg` vorhanden, `window.__smithGraph` gesetzt |
| Panel sichtbar/bedienbar | – | PASS | `details.phys` summary „Physik", **12 Range-Slider**, Button „Zurücksetzen" |
| Live-Anwendung ohne Reload | 2 | PASS | `collide 14→30`, `repBase 180→300`: `config()`=neue Werte, Hash `#/graph?repBase=300&collide=30`; `sameHook/sameSim/sameSvg=true`, `svgCount=1`, **26/26 Knoten-Objekte identisch**, Positionen 17–246 px bewegt, `alpha≈0.05`, `alphaTarget≈0.05` |
| „Zurücksetzen" (Defaults) | 2 | **FAIL** | Panel/`config()`/Hash → Defaults (`#/graph`), **aber** `simulation().alphaTarget()` bleibt stale: nach `alphaTarget=0.2` → Reset → `config()=0.05`, `sim.alphaTarget()=0.2`; nach `alphaTarget=0` → Reset → `config()=0.05`, `sim.alphaTarget()=0`. Siehe `review.md` M1 |
| Hash-Persistenz (F5) | 3 | PASS | `clusterStrength=0.15`, `distMax=0` → Hash geschrieben; nach Reload `config()`/Slider = 0.15 / 0. Defaults **nicht** im Hash (Reset → `#/graph`) |
| Hash-Robustheit | 3 | PASS | `#/graph?collide=abc&repBase=&distMax=0&velocityDecay=0` → `collide=14`, `repBase=180` (Fallback), `distMax=0`, `velocityDecay=0` (0 erhalten); `charge.distanceMax()=∞` |
| Überlappung Defaults vs. alt | 4 | PASS (mit Abweichung) | Demo zu dünn: 0 überlappende Paare bei **beiden** Konfigurationen. Kontrolliertes Gedränge (repBase 0, linkBase 1): minGap **11,9 px** (collide 6) vs. **27,9 px** (collide 14); Seed-Reset-Trial Fläche 2.217.587 (alt) vs. 3.244.100 (neu). Metrik validiert (collide 0 → 6 überlappende Paare) |
| Regression ui-smoke | 5 | PASS | `npx --yes bun test/web/ui-smoke.ts shots` → `ok – Screenshots in shots`, Exit 0; `08-graph.png` 130.676 B / `08-graph-dunkel.png` 131.040 B (vorher 54 KB bei B1-Crash) |
| Regression ui-flows | 5 | PASS (manuell nachgefahren) | Harness bricht **vor** dem Graph-Abschnitt ab (Exit 1) am vorbestehenden Flake „Befehlspalette springt zum Eintrag" (`ui-flows.ts:37:87`, `overlay` intercepts pointer events – graph-fremd). AC1/AC2 deshalb direkt im Browser über denselben Hook nachgefahren: **AC1 PASS** (26/26 Knoten > 0.5 px in 800 ms), **AC2 PASS** (Nachbar 36.6 px bewegt, Paar knowledge:auth-gateway ↔ memory:shop-entscheidung-token-speicherung) |
| Konsole/Fehler | 5 | PASS | keine App-`console`/`pageerror` auf `#/graph`; nur 2 selbst verursachte `__stress is not a function` nach Reload (eigene Helfer weg) |
| Feature-Parität | 6 | PASS | alle Side-Panel-Abschnitte (Ansicht, Größe, Gruppierung, Zeitreise, Arten, Beziehungen, Mindeststärke, Weitere) + Physik; Tools Pfad/Verknüpfen/Fokus/Speichern/PNG/Einpassen |

## Blocker / Major / Minor

- **MAJOR M1** – „Zurücksetzen" aktualisiert den Dauerlauf nicht (`graph.js:208-216`):
  `alphaTargetValue` und `sim.alphaTarget(...)` werden nicht neu gesetzt. Details + Fix in
  `review.md`. Belegt live (siehe Check „Zurücksetzen").
- **MINOR m1** – Überlappungs-AC im Demo-Store nicht belegbar (26 Knoten, 0 Überlappungen
  bei allen Konfigurationen); Effekt nur künstlich messbar.
- **MINOR m2** – `config().distMax` liefert bei „∞" den Rohwert `0` (Label zeigt `∞`).

## Zusätzliche Beobachtungen (was der Auftrag evtl. übersieht)

- **`params()` vs. `config()`:** `params()` gibt das lebende `p`-Objekt zurück (Testhook-Nutzer
  können es mutieren), `config()` eine Kopie – bewusst, aber für Aufrufer nicht dokumentiert.
- **`alphaTarget`-Sonderfall:** > 300 Knoten / 0 Kanten erzwingen `alphaTarget(0)`
  (`alphaTargetValue`), ein Slider-Wert > 0 wird dort bewusst ignoriert. Im Demo (26 Knoten)
  nicht ausgeübt.
- **ResizeObserver** ruft `applyForces(p)` mit dem lebenden `p` – konsistent mit den Slidern.
- **`distMax=0` → `distanceMax(Infinity)`** korrekt; `config()` zeigt 0, Label `∞`.
- Screenshots `shots/08-graph*.png` nun ~130 KB (gerendert), nicht mehr ~54 KB (Crash).

## Umgebungsprobleme (getrennt von Code-Fehlern)

1. `sh tools/vendor/build.sh` bleibt von der Bash-Allowlist blockiert (nicht Teil dieses
   Inkrements).
2. `bun` nur via `npx --yes bun`; `PLAYWRIGHT_CORE`/`CHROMIUM` aus Umgebung
   (`~/.npm/_npx/e058441c325e062a/node_modules/playwright-core`,
   `/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`).
3. ui-flows: Editor-Strg+S/Dialog-Flakes vorbestehend, graph-fremd; der Lauf brach dadurch
   (Exit 1) **vor** dem Graph-Abschnitt ab – AC1/AC2 wurden ersatzweise direkt im Browser
   über `window.__smithGraph` nachgefahren (beide PASS, siehe Tabelle).
