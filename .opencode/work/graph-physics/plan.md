# graph-physics - Graph-Ansicht `#/graph`: d3-force-Physik-Simulation mit eigenem SVG-Renderer

## Ziel & Abgrenzung

**In scope**
- Ersatz der Cytoscape-Graph-Ansicht (`src/web/static/js/views/graph.js`, heute 439 Z., Cytoscape + `cose`) durch eine **d3-force**-basierte, dauerhaft laufende Physik-Simulation mit eigenem **SVG**-Renderer.
- Obsidian-artiges Verhalten: Feder-Anziehung entlang der Kanten, Abstoßung aller Knoten, Kollision; Drag pinnt den gezogenen Knoten (`fx`/`fy`), verbundene Nachbarn folgen; nach dem Loslassen schwimmt der Knoten weiter (Fixierung lösen); Doppelklick pinnt dauerhaft.
- Vollständige Feature-Parität der bestehenden Ansicht (Tooltip, Klick→Detail, Doppelklick→Umgebung, Pfad-Modus, Fokus, Kanten-Detail, Einpassen, PNG-Export, Ansicht speichern, Verknüpfen-Modus, Gruppierung, Zeitreise).
- Vendor-Umbau: `d3-force` (+ Transitiv-Abhängigkeiten) reproduzierbar über `tools/vendor/build.sh` bundeln; **Cytoscape vollständig entfernen** (Script, Vendor-Dateien, Lizenz, CSS, Test-Erwartung, Doku).
- Tests anpassen (`ui-flows`, `ui-smoke`, `web.test.ts`) und Doku nachziehen.

**Out of scope**
- Die getrennte „Landkarte" `views/map.js` (eigenes SVG) bleibt unberührt.
- Kein Backend-/API-Umbau: Datenquelle bleibt `get("graph", …)` (`src/web/api.ts:502-584`) und `graph/path` / `graph/at`. Keine neuen Endpunkte, keine Feldänderungen.
- Keine Laufzeit-npm-Abhängigkeit des Plugins, kein CDN (CSP `script-src 'self'`), Frontend bleibt build-frei (ES-Module; d3 als klassisches `<script>` mit Global).

**Voraussetzung / Ist-Zustand**
- Der Arbeitsordner war leer; `findings-graph-view.md` und `findings-highcharts-vs-force.md` **existieren nicht** (siehe Offene Fragen). Grundlage sind der gelesene Code und die Projekt-Erinnerungen.
- Die frühere cola-Umsetzung ist im Arbeitsbaum **bereits zurückgebaut**: kein `cytoscape-cola.min.js`, kein `tools/vendor/cola.entry.js`, `graph.js` nutzt wieder `cose`. Der „cola-Rückbau" ist damit überwiegend Verifikation/keine Artefakte (S8).

## Akzeptanzkriterien

| ID | Kriterium (prüfbar) | Herkunft |
|---|---|---|
| AC1 | Dauerlauf: Nach dem Einpassen ändern sich ohne Nutzeraktion über ~800 ms mindestens zwei Knotenpositionen messbar (> 0.5 px). | Auftrag |
| AC2 | Drag zieht verbundene Nachbarn mit: Wird ein Knoten gezogen/`fx`/`fy` gesetzt, bewegt sich ein direkt verbundener Nachbar > 0.5 px. | Auftrag |
| AC3 | Verknüpfen-Modus unverändert: Im Link-Modus öffnet ein Knoten-Drop auf einen anderen den `relationDialog` (`src/web/static/js/parts.js:224`). | Auftrag |
| AC4 | 0 Kanten lesbar: Bei `data.edges.length === 0` sind alle Knoten sichtbar/lesbar angeordnet (kein Überlappen der Labels, kein „Fliegen"). | Auftrag |
| AC5 | > 300 Knoten ohne Dauerlauf: oberhalb der Schwelle läuft die Simulation nach dem Einlaufen aus (kein permanentes Ticken). | Auftrag |
| AC6 | Keine JS-/CSP-Fehler: `ui-smoke` Route `08-graph` (hell/dunkel) ohne `pageerror`/`console error`/HTTP ≥ 400. | Auftrag |
| AC7 | Vendor reproduzierbar + sauber entfernt: `sh tools/vendor/build.sh` erzeugt das d3-Bundle deterministisch (2. Lauf bit-identisch) und legt Lizenzen ab; im Repo existieren **keine** Cytoscape-/cola-Reste (grep leer außer Historie). | Auftrag |
| AC8 | center/group/isoliert stabil: Umgebungsgraph (`center`) bleibt um das Zentrum gruppiert; Gruppen-Hüllen umschließen ihre Mitglieder; isolierte Knoten driften nicht ins Unendliche. | Auftrag |
| AC9 | `npx tsc --noEmit` grün und `npx --yes bun test test/unit` grün (167+ Tests). | AGENTS §7 |
| AC10 | Feature-Parität: alle unter „Paritätstabelle" gelisteten Funktionen bleiben bzw. entfallen nur mit dokumentierter Begründung. | Auftrag |

### Paritätstabelle (AC10)

| Feature | Entscheidung | Begründung |
|---|---|---|
| Hover-Tooltip (`n.explain`/`ringReason`/Relevanz) | bleibt | DOM-Tooltip `graph-tip`, identisch aus `byId` gespeist. |
| Klick Knoten → Detailpanel (`openInPanel`) | bleibt | wiederverwendet, Ziel über SVG-Element-Id. |
| Doppelklick Knoten → Umgebung (`#/graph?center=…`) | bleibt | plus optionale d3-Pin-Funktion (Auftrag). |
| Klick Kante → Detailpanel | bleibt | Treffer über `<line>`/`<path>`. |
| Pfad-Modus (`graph/path`, `.path`/`.faded`) | bleibt | CSS-Klassen auf SVG-Elementen. |
| Fokus-Modus (Nachbarschaft hervorheben) | bleibt | CSS-Klassen `.faded`/`.hidden`. |
| Einpassen (`fit`) | bleibt | eigene `fit()`-Funktion über `d3-zoom`. |
| PNG-Export | bleibt | SVG → Canvas → `toBlob` (CSP erlaubt `img-src data: blob:`). |
| Ansicht speichern (`storeGet/Set graphViews`) | bleibt | unverändert (Hash). |
| Gruppierung Tag/Projekt/Art | bleibt | gezeichnete Hülle + schwache Gruppen-Kraft (siehe Lösungsansatz). |
| Zeitreise (`graph/at`, read-only) | bleibt | Datenpfad unverändert; Link-Modus wird bei `past` nicht angeboten (wie heute). |
| Zoomen/Pan (`minZoom`/`maxZoom`) | bleibt | `d3-zoom` mit `scaleExtent([0.08, 3])`. |
| Knoten-Auswahl (`.linksrc`, „selected") | bleibt | CSS-Klasse auf SVG-Element. |
| Cytoscape-Kontextmenü/`autoungrabify` | entfällt bewusst | Cytoscape-spezifisch, ohne Entsprechung im d3-Modell. |

## Lösungsansatz

**Bibliothek:** `d3-force` als Physik-Engine; Rendering, Zoom/Pan, Drag, Tooltip und Export selbst gebaut (SVG). `d3-drag`, `d3-zoom`, `d3-selection` werden genutzt (kein `d3-transition` nötig, wird aber als Zoom-Abhängigkeit mitgebundelt).

**SVG statt Canvas (Empfehlung, umgesetzt):** Bei ≤ 300 Knoten ist SVG performant genug (d3 schreibt nur `transform`/`x`/`y`/`d`-Attribute). Vorteile: Labels/Text ohne Bitmap-Aufwand, CSS-Styling (Dark/Light über Variablen, `.faded`/`.path`/`.hidden`), native Event-Ziele pro Knoten/Kante (Klick/Hover ohne Hit-Test-Code), und **der PNG-Export** lässt sich direkt aus dem DOM serialisieren. Canvas würde eine eigene Text-/Event-/Auswahlschicht und einen Canvas-Renderer erfordern (~+300 Z.) ohne Mehrwert bei dieser Größe. Bei > 300 Knoten wird ohnehin statisch gerendert.

**Dauerlauf-Mechanik:** `simulation.alphaTarget(0.05)` (Default `alphaMin = 0.001`) → die Simulation kühlt nie unter `alphaMin` ab und tickt dauerhaft (kein `setInterval`-Trick nötig). `alphaDecay` bleibt nah am Default, damit der Dauerlauf ruhig ist. > 300 Knoten: `alphaTarget(0)` → sie läuft aus und stoppt.

**Drag-Semantik (Obsidian):** `d3-drag` auf Knoten. `start`: `d.fx = d.x; d.fy = d.y; sim.alphaTarget(0.3).restart()`. `drag`: `d.fx = event.x; d.fy = event.y` (Nachbarn folgen über die Feder-Kraft). `end`: `sim.alphaTarget(0.05)` und **`d.fx = d.fy = null`** → der Knoten schwimmt weiter. Doppelklick togglet eine dauerhafte Fixierung (`d.fx`/`d.fy` setzen bzw. `null`).

**Gruppen (compound):** Es gibt keine Cytoscape-`parent`-Beziehung mehr. Vorschlag (umgesetzt): pro Gruppe eine **gezeichnete Hülle** (abgerundetes Rechteck = Bounding-Box der Mitglieder + Padding, in einem `<g class="hulls">` unter den Kanten, jede Tick aktualisiert) **und** eine schwache Anziehung der Mitglieder zum Gruppen-Zentroide (`forceX`/`forceY` mit `strength ~ 0.05` je gruppiertem Knoten). Das hält Gruppen zusammen, ohne die Physik zu dominieren; die Hülle ist rein visuell (kein Hit-Target für Klick/Pfad).

**Zentrum (`data.center`, früher `concentric`):** statt eines Layouts wird das Zentrum mit `d.fx/d.fy` im Mittelpunkt fixiert und `forceRadial(radius=∅, strength)` bzw. stärkeres `forceCenter` + `forceManyBody` auf die Umgebung gelegt; zusätzlich Betonung (Ring/Bold) wie heute.

**0 Kanten:** alle Knoten isoliert → `forceManyBody` mit hoher Stärke + `forceCollide` und **ohne** `forceLink`; Ergebnis ist eine stabile, überlappungsfreie Wolke (Ersatz für das alte Grid, AC4). Kein Dauerlauf-Zwang: hier `alphaTarget(0)` (läuft aus), damit nichts fliegt.

**Link-Modus (Konflikt Physik-Drag):** Im Link-Modus wird die Simulation **eingefroren** (`sim.alphaTarget(0)`), das normale Knoten-Drag wird deaktiviert und ein separater Drag-Handler gesetzt, der nur `fx/fy` des gezogenen Knotens verfolgt. Bei `end` wird der Zielknoten per `simulation.find(x, y, radius)` bzw. Distanz-Test ermittelt, `fx/fy` wieder gelöst und `relationDialog(src, { to: hit })` geöffnet (bisheriges `grab`/`free`-Verhalten, `src/web/static/js/views/graph.js:320-341`).

**Startphase/kein Springen:** Initialpositionen deterministisch seeden (Kreis-/Spiral-Layout um das Zentrum, keine Zufalls-Sprünge), Simulation einige Ticks „warm" laufen lassen, dann einmalig `fit()`.

**Testhook:** `window.__smithGraph = { nodes: () => simNodes, links: () => simLinks, simulation: () => sim }` (statt `= cy`), gesetzt nach Aufbau, in `ctx.cleanup` gelöscht.

**Verworfene Alternativen**
- Canvas-Renderer: mehr Code, kein Mehrwert bei ≤ 300 Knoten (siehe oben).
- `d3-transition`-basierte Zoom-Animationen: nicht nötig, spart Komplexität.
- Gruppen ausschließlich per Kraft ohne Hülle: Gruppenzugehörigkeit wäre visuell nicht erkennbar.

## Schritte

### Phase A – Vendor (d3 ein, Cytoscape raus)

- [x] **S1 – d3-Transitivabhängigkeiten ermitteln und Entry anlegen** | Dateien: `tools/vendor/d3.entry.js` (neu) | fertig wenn: `d3.entry.js` die benötigten Namen exportiert (`forceSimulation, forceLink, forceManyBody, forceCollide, forceCenter, forceX, forceY, forceRadial`, `drag, zoom, zoomIdentity, select`). Erwartete Transitiv-Pakete (im Temp-Build mit `npm ls` verifizieren): `d3-force` → `d3-dispatch`, `d3-quadtree`, `d3-timer`; `d3-drag` → `d3-dispatch`, `d3-selection`; `d3-zoom` → `d3-dispatch`, `d3-drag`, `d3-interpolate`, `d3-selection`, `d3-transition`; `d3-transition` → `d3-color`, `d3-dispatch`, `d3-ease`, `d3-interpolate`, `d3-timer` (alle ISC).
- [x] **S2 – `build.sh` erweitern** | Dateien: `tools/vendor/build.sh:11-23` | fertig wenn: `npm install … d3-force@3 d3-drag@3 d3-zoom@3 d3-selection@3` (gepinnt) ergänzt; `cp "$here/d3.entry.js" .`; `bun build ./d3.entry.js --format iife --name d3 --minify --outfile "$out/d3-force.min.js"` (globales `window.d3`); Lizenzkopien `node_modules/d3-force/LICENSE` → `LICENSE-d3-force.txt` (ggf. weitere `LICENSE-d3-*.txt`); Cytoscape-Zeilen (Install/Build/cp `cytoscape.min.js`, `LICENSE-cytoscape.txt`) entfernt; Skript läuft zweimal bit-identisch.
- [x] **S3 – Cytoscape-Vendor-Artefakte löschen** | Dateien: `src/web/static/vendor/cytoscape.min.js`, `src/web/static/vendor/LICENSE-cytoscape.txt` | fertig wenn: beide Dateien entfernt; `rg -i cytoscape src/ tools/ test/` liefert keine Treffer mehr (außer ggf. `.opencode/work/`-Historie).

### Phase B – Einbindung & CSS

- [x] **S4 – `index.html` umstellen** | Dateien: `src/web/static/index.html:9-10,32` | fertig wenn: `<script src="vendor/cytoscape.min.js">` (:32) durch `<script src="vendor/d3-force.min.js">` ersetzt; der Cytoscape-CSP-Workaround `<link id="__________cytoscape_stylesheet">` (:9-10) zu einem normalen `<link rel="stylesheet" href="style.css">` umbenannt/entschärft (Kommentar entfernen).
- [x] **S5 – CSS ersetzen** | Dateien: `src/web/static/style.css:565-578` | fertig wenn: `#cy` (:572) durch `#graph-svg { position:absolute; inset:0; width:100%; height:100%; }` ersetzt; neue Regeln für `.hulls rect` (Hülle), `.gnode` (Kreis), `.gnode.own` (Doppelrahmen via `stroke-dasharray`/zweiter Kreis), `.gnode.center`, `.gnode.faded`, `.gnode.archived`, `.gedge`, `.gedge.derived`, `.path`, `.hidden`, `.linksrc`, `.glabel` ergänzt; Farben weiter über CSS-Variablen (`--bg`, `--text`, `--accent`, `--ring-good/warn/critical`, `--faint`, `--border-strong`) → Dark/Light automatisch.

### Phase C – Renderer

- [x] **S6 – d3-Renderer in `graph.js` implementieren** | Dateien: `src/web/static/js/views/graph.js:203-293` (Cytoscape-Block), `:228` (cleanup), `:247-251` (fit) | fertig wenn:
  - Datenaufbau aus `data.nodes`/`data.edges` in `simNodes`/`simLinks` (Felder wie `src/web/static/js/views/graph.js:184-202`: `color,size,ring,ringW,own,faded,center,archived,label` bzw. `source,target,color,width,derived,arrow,label,strength`).
  - SVG-Gerüst `#graph-svg` mit `<g class="viewport">` (Zoom-Transform), darin `.hulls`, `.gedges`, `.gnodes`; je Kante `<line>`/`<path>` + `<marker>`-Pfeil (außer `SYMMETRIC`, `src/web/static/js/dom.js:173`), je Knoten `<g class="gnode">` mit Kreis (+ Innenkreis für `own`) und `<text class="glabel">`.
  - Kräfte: `forceLink().id(d=>d.id).distance(d=>60+90*(1-(d.strength??0.5))).strength(d=>0.2+0.6*(d.strength??0.5))`, `forceManyBody().strength(-160).distanceMax(600)`, `forceCollide(d=>d.size/2+6)`, `forceCenter(w/2,h/2)`; Gruppen `forceX/forceY` schwach (s. Lösungsansatz).
  - Tick-Handler schreibt `transform`/`x1,y1,x2,y2`/`cx,cy`/Label-Positionen.
  - `d3-zoom` (`scaleExtent([0.08,3])`) auf `#graph-svg` → `transform` auf `.viewport`; `fit()`-Funktion berechnet BBox aus `simNodes` und setzt den Transform; Aufruf nach Warmup.
  - Startseed + einmaliges `fit()` nach kurzer Verzögerung (kein Springen).
  - `ctx.cleanup(() => { sim.stop(); ro.disconnect(); tip.remove(); delete window.__smithGraph })` (ersetzt `cy.destroy()`, `:228`).
  - Testhook `window.__smithGraph = { nodes: () => simNodes, links: () => simLinks, simulation: () => sim }`.
- [x] **S7 – Interaktionen portieren** | Dateien: `src/web/static/js/views/graph.js:253-438` | fertig wenn:
  - Tooltip (`:253-273`) an SVG-`mouseenter`/`mousemove`/`mouseleave` der Knoten; Inhalt unverändert.
  - `openInPanel` (`:343-378`) unverändert, Ziel über Knoten-Id statt `cy.getElementById`.
  - `setMode`/`highlight` (`:275-293`) setzen CSS-Klassen auf SVG-Elementen; `drawTools` (`:294-318`) unverändert (Pfad/Fokus/Speichern/PNG/Einpassen/Link).
  - Pfad-Modus (`:380-413`), Doppelklick (`:414-417` + Pin-Toggle), Kanten-Klick (`:418-431`), Hintergrund-Klick (`:432-437`), `openInPanel(center)` (`:438`).
  - **Link-Modus** (`:320-341`): Simulation einfrieren, separater Drag → `relationDialog(src,{to:hit})` (s. Lösungsansatz).
  - **PNG-Export:** `XMLSerializer` → SVG-Blob → `Image` → `<canvas>` → `toBlob` → `saveBlob` (`src/web/static/js/api.js:115`).
  - **Performance-Schwelle:** `MANY = simNodes.length > 300` → `alphaTarget(0)`, kein Dauerlauf; ≤ 300 → Dauerlauf (`alphaTarget(0.05)`). `data.edges.length === 0` → kein `forceLink`, statische Wolke.
  - **ResizeObserver** auf `.graph-main` aktualisiert `w/h` und `forceCenter`.
  - **Kein Dauerlauf bei 0 Kanten / > 300** konsistent zu AC4/AC5.

### Phase D – Tests & Doku

- [x] **S8 – Unit-Test der statischen Auslieferung anpassen** | Dateien: `test/unit/web.test.ts:55-56` | fertig wenn: Erwartung `"cytoscape.min.js"` → `"d3-force.min.js"` und `/vendor/cytoscape.min.js` → `/vendor/d3-force.min.js` (200). AC7/AC9.
- [x] **S9 – `ui-flows.ts` Graph-Abschnitt ergänzen** | Dateien: `test/web/ui-flows.ts` (neuer Abschnitt „11. graph" vor `:190`) | fertig wenn: AC1 (`window.__smithGraph.nodes()`-Positionen zu t0 vs. t0+800 ms, ≥ 2 Knoten > 0.5 px) und AC2 (`__smithGraph.links()`-Paar wählen, `simulation().nodes()`-Nachbar `fx/fy` setzen/ziehen, Nachbarbewegung > 0.5 px) über den neuen Hook geprüft werden; fehlt der Hook → FAIL.
- [x] **S10 – `ui-smoke.ts` prüfen/ggf. anpassen** | Dateien: `test/web/ui-smoke.ts:26,70` | fertig wenn: Route `08-graph` bleibt (Screenshot hell/dunkel), Wartezeit ausreichend; keine weiteren Änderungen nötig.
- [ ] **S11 – Doku nachziehen** | Dateien: `AGENTS.md:163` (Vendor-Liste), `AGENTS.md:271` (Frontend-Beschreibung, Cytoscape-Workaround), `AGENTS.md:§7` (Tests), `README.md:287` (Graph-Bullet), `README.md:241` (Bibliotheksliste) | fertig wenn: Cytoscape/cola durch „d3-force" ersetzt, SVG-Renderer und Dauerlauf-Parameter beschrieben, Lizenz (ISC) genannt. (Umsetzung durch Writer.)

### Phase E – Verifikation

- [ ] **S12 – Verifikationslauf** | Dateien: keine | fertig wenn: alle Checks der Verifikationstabelle ausgeführt und dokumentiert sind.

## Verifikation

| Check | AC | Art | Befehl / Ablauf | Erwartet |
|---|---|---|---|---|
| V1 | AC9 | statisch | `npx tsc --noEmit` (Repo-Root) | Exit 0, keine Fehler |
| V2 | AC9 | statisch/Unit | `npx --yes bun test test/unit` | alle Tests grün (inkl. angepasstem `web.test.ts`) |
| V3 | AC7 | manuell/Vendor | `sh tools/vendor/build.sh` zweimal; `ls -l src/web/static/vendor/` | Artefakt `d3-force.min.js` + `LICENSE-d3-*.txt` vorhanden, 2. Lauf bit-identisch (`shasum`), keine Cytoscape-Dateien |
| V4 | AC7 | statisch | `rg -i "cytoscape|cola" src/ tools/ test/ AGENTS.md README.md` | keine Treffer außer Historie/Erinnerungen (`.opencode/`) |
| V5 | AC1, AC2, AC3, AC6 | UI/E2E | `npx --yes bun test/web/demo.ts 47555` → `DEMO_URL=… PLAYWRIGHT_CORE=… CHROMIUM=… npx --yes bun test/web/ui-flows.ts shots` | AC1 „Positionen ändern sich" grün; AC2 „Drag zieht Nachbarn" grün; AC3 (Link-Dialog) grün; keine `pageerror`/`console error` |
| V6 | AC6 | UI/Smoke | `DEMO_URL=… PLAYWRIGHT_CORE=… CHROMIUM=… npx --yes bun test/web/ui-smoke.ts shots` | alle Routen inkl. `08-graph`/`08-graph-dunkel` ohne JS-/CSP-Fehler/HTTP ≥ 400 |
| V7 | AC4 | UI/manuell | Demo-Store, `#/graph?kinds=skill&types=related` (Graph ohne Kanten) öffnen | Knoten überlappungsfrei/lesbar; Simulation läuft aus (kein Fliegen) |
| V8 | AC5 | UI/manuell | Demo-Store mit > 300 Knoten (`#/graph?top=400`) | nach dem Einlaufen keine Positionsänderung mehr (Dauerlauf gestoppt) |
| V9 | AC8 | UI/manuell | `#/graph?center=knowledge%3Aauth-gateway&depth=2`, `#/graph?group=kind`, isolierter Knoten | Zentrum umgeben, Gruppen-Hüllen korrekt, isolierte Knoten bleiben im Bild |
| V10 | AC10 | UI/manuell | Paritätstabelle durchklicken (Tooltip, Klick→Detail, Doppelklick→Umgebung, Pfad, Fokus, Kanten-Detail, Einpassen, PNG, Speichern) | alle „bleibt"-Punkte funktionieren |
| V11 | AC10 | UI/visuell | `visionary`-Subagent auf `shots/08-graph.png` und `08-graph-dunkel.png` | Knoten/Kanten/Labels/Hüllen sichtbar, Dark/Light korrekt, keine Überlagerung |

## Risiken & Rollback

- **Performance bei 300–600 Knoten:** SVG-DOM bei jedem Tick aktualisieren kann ruckeln. Mitigation: Schwelle 300 → statisch; Tick-Handler schreibt nur Attribute (kein DOM-Neuaufbau). Falls nötig, `forceCollide`-Iterationen senken.
- **Dauerlauf-Kosten:** `alphaTarget(0.05)` tickt permanent. Bei vielen Knoten CPU-Last; die 300er-Schwelle begrenzt das. Ggf. `alphaTarget` auf 0.02 senken.
- **Zoom/Drag-Konflikt:** `d3-drag` vs. `d3-zoom` auf derselben Fläche; Drag auf Knoten muss `event.stopPropagation()`/eigenen `filter` nutzen, damit Pan nicht auslöst.
- **Link-Modus:** Einfrieren der Simulation ändert das Live-Verhalten; der Dialogpfad (`relationDialog`) muss unverändert bleiben (AC3).
- **PNG-Export:** SVG→Canvas kann an fehlenden Inline-Styles scheitern (externe CSS-Klassen werden beim Serialisieren nicht aufgelöst). Mitigation: beim Export die benötigten Styles inline setzen oder einfarbige Fassung; im schlimmsten Fall bewusst streichen (dann AC10-Eintrag anpassen).
- **Rollback:** Alle Änderungen sind auf `#/graph`, Vendor und Tests begrenzt und liegen in wenigen Dateien; `git revert` des Lauf-Commits stellt den Cytoscape-Stand wieder her (Vendor-Dateien wiederherstellen).

## Offene Fragen

1. **Fehlende Pflichtdateien:** `.opencode/work/graph-physics/findings-graph-view.md` und `findings-highcharts-vs-force.md` existieren nicht. Der Plan stützt sich auf Code + Projekt-Erinnerungen (`memory:skillsmith-entscheidung-graph-physik`, `result:20261012-68137f`). Sollen die Findings neu erzeugt werden, oder ist der Plan ohne sie freigegeben?
2. **Dauerlauf-Parameter:** Ist `alphaTarget(0.05)` (ruhiges Dauerschwingen) gewünscht, oder ein lebhafteres Bild (z. B. 0.1)? Auswirkung auf AC1-Schwelle und CPU.
3. **PNG-Export:** Beibehalten (mit Inline-Style-Aufwand) oder bewusst streichen? Empfehlung: beibehalten, da AC10 Parität fordert.
4. **Doppelklick-Pin:** Heute Doppelklick = „Umgebung öffnen". Der Auftrag nennt optional „Doppelklick dauerhaft pinnen". Konflikt: Vorschlag — Doppelklick bleibt „Umgebung"; Pin per Modifikatorklick (z. B. `Alt`/Rechtsklick). Bestätigung nötig.
5. **Group-Hülle:** Bounding-Box (einfach, kann sich überlappen) vs. konvexe Hülle (schöner, mehr Code). Vorschlag: Bounding-Box mit Padding; Einverstanden?
