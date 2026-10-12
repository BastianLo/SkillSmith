# graph-physics - Graph-Ansicht `#/graph` auf d3-force-Physik umgestellt

## Ergebnis

Die Graph-Route `#/graph` rendert nicht mehr mit Cytoscape/`cose`, sondern mit **d3-force** und einem eigenen **SVG**-Renderer. Sie läuft als dauerhafte Physik-Simulation (Abstoßung, Feder-Kanten, Kollision), ähnliche Themen sammeln sich, Ziehen bewegt die Nachbarn mit, Alt+Klick pinnt dauerhaft. Cytoscape ist aus Vendor, `index.html`, CSS und Tests vollständig entfernt; die Nutzer- und Entwicklerdoku sind nachgezogen.

## Umsetzung

- **Vendor:** `tools/vendor/d3.entry.js` (neu) und `tools/vendor/build.sh` bündeln `d3-force/d3-drag/d3-zoom/d3-selection` (ISC) zu `src/web/static/vendor/d3-force.min.js` (globales `window.d3`) plus `LICENSE-d3-force.txt`. `cytoscape.min.js` und `LICENSE-cytoscape.txt` sind gelöscht.
- **Einbindung:** `index.html` lädt `vendor/d3-force.min.js`; der Cytoscape-CSP-Workaround `<link id="__________cytoscape_stylesheet">` ist entfernt. `style.css`: `#cy` → `#graph-svg` und SVG-Regeln (`.gnode`, `.gedge`, `.hulls`, `.glabel`, `.faded`, `.path`, `.hidden`, `.linksrc`).
- **Renderer (`src/web/static/js/views/graph.js`, ~899 Z.):** Kräfte `forceManyBody().strength(d=>-(120+8*d.size)).distanceMax(600)`, `forceLink().distance(d=>d.weak?160:60+90*(1-(d.strength??0.5))).strength(d=>d.weak?(d.strength??0.05):0.2+0.6*(d.strength??0.5))`, `forceCollide`, `forceCenter`, Gruppen `forceX`/`forceY`, Zentrum `forceRadial`. Themenbasiertes Clustering über zusätzliche, nicht gerenderte „weakLinks" aus gemeinsamen `tags` (Top-3 Nachbarn, `strength=min(shared,3)*0.04`, distance 160).
- **Dauerlauf:** `alphaTarget(0.05)`; > 300 Knoten → `alphaTarget(0)` (läuft aus); 0 Kanten → kein `forceLink`. Drag pinnt (`fx`/`fy`), Nachbarn folgen, Loslassen gibt frei, Alt+Klick pinnt dauerhaft; Doppelklick bleibt „Umgebung öffnen". Zoom/Pan via `d3-zoom` (`scaleExtent [0.08,3]`). Volle Feature-Parität (Tooltip, Klick→Detailpanel, Kanten-Detail, Pfad-/Fokus-Modus, Einpassen, PNG-Export, Ansicht speichern, Verknüpfen-Modus, Gruppierung als Bounding-Box-Hülle, Zeitreise).
- **Tests:** `test/unit/web.test.ts` erwartet `d3-force.min.js`; `test/web/ui-flows.ts` Abschnitt „11. graph" prüft AC1 und AC2 über den Testhook `window.__smithGraph = {nodes, links, simulation}`.
- **Doku (dieser Lauf):** `AGENTS.md` (Vendor-Liste, Frontend-Beschreibung, §7 Testhinweis) und `README.md` (Graph-Bullet, Bibliotheksliste) auf d3-force/SVG umgestellt.

## Verifikation

| AC | Kriterium | Status | Evidenz |
|---|---|---|---|
| AC1 | Dauerlauf bewegt Knoten | PASS | 26/26 Knoten > 0.5 px in 800 ms |
| AC2 | Drag zieht Nachbarn | PASS | Nachbar 30.87 px bewegt |
| AC3 | Link-Modus | PASS | Drag öffnet `.overlay` („Verknüpfung ändern: …") |
| AC4 | 0 Kanten lesbar | PASS | `#/graph?types=duplicates`: 26 Knoten, 0 Kanten, `alpha=0.001`, keine Überlappung/Bewegung |
| AC5 | > 300 Knoten ohne Dauerlauf | **UNKLAR** | Demo-Store hat nur 26 Knoten; Code-Pfad `MANY → alphaTarget(0)` existiert, nicht ausgeübt |
| AC6 | Keine JS-/CSP-Fehler | PASS | `ui-smoke` Route `08-graph` hell/dunkel, keine `pageerror`/`console error`/HTTP ≥ 400 |
| AC7 | Vendor sauber/reproduzierbar | PASS (teilw.) | `d3-force.min.js` + `LICENSE-d3-force.txt` vorhanden; keine Cytoscape-Reste; Zweitlauf-Bit-Identität nicht ausgeführt |
| AC8 | center/group/isoliert stabil | PASS | `center` gleichmäßig umgeben (109–124 px); 9 Gruppen-Hüllen ohne Fehler |
| AC9 | `tsc` + Unit-Tests grün | PASS | `npx tsc --noEmit` Exit 0; `bun test test/unit` Exit 0 |
| AC10 | Feature-Parität | PASS | Tooltip, Klick→Detail, Pfad, Doppelklick, PNG-Export im Browser; Kanten-Klick nur per Code belegt |

Nicht getestet: AC5 (Demo-Store zu klein, Testlücke), Kanten-Klick nicht separat im Browser ausgelöst, Zweitlauf-Bit-Identität des Vendor-Builds.

## Review

Urteil **OK** (keine Blocker/Major). Offene Minors aus `review.md`:
1. `tools/vendor/build.sh` kopiert nur `node_modules/d3-force/LICENSE`; Lizenzen der Transitivpakete (d3-drag/zoom/selection/interpolate/transition/color/ease/dispatch/quadtree/timer) fehlen (AC7 nennt „ggf. weitere `LICENSE-d3-*.txt`").
2. Tote CSS-Klassen `.gnode.hover`/`.gnode.selected` (`style.css:588-589`) werden nie gesetzt (Hover/Selection als Inline-Style).

## Offene Punkte

- **AC5** nicht verifiziert (Demo-Store mit > 300 Knoten fehlt) – Testlücke, kein Code-Defekt.
- **Lizenzkopien der d3-Transitivpakete** in `build.sh` ergänzen (Minor 1).
- Tote CSS-Klassen `.gnode.hover`/`.gnode.selected` entfernen oder `restyle()` auf Klassen umstellen (Minor 2).

## Doku

- `AGENTS.md`: Vendor-Liste (d3-force statt cytoscape 3.34.3), Frontend-Beschreibung (d3-force/SVG-Renderer, `#graph-svg`, Dauerlauf/Clustering, Alt+Klick-Pin statt Cytoscape-CSP-Workaround), §7-Testkommentar zu `ui-flows`.
- `README.md`: Graph-Bullet (durchgehende Physik-Simulation, Ziehen bewegt Nachbarn, themenbasiertes Clustering, Alt+Klick-Pin), Bibliotheksliste (d3-force/ISC statt Cytoscape.js).
