# Code-Review – graph-physics: konfigurierbare Physik-Parameter

**Urteil: ÄNDERUNGEN NÖTIG**
Blocker: 0 · Major: 1 · Minor: 2 · Standardverstöße: 0

Geprüfter Umfang: Inkrement „Physik-Parameter" in `src/web/static/js/views/graph.js`
(`PHYS_DEFAULTS`/`PHYS_SPEC`/`params()`/`hashOf()`/`numOr`/Side-Panel/`applyForces`/`applyPhys`/
„Zurücksetzen"/Testhook). Basis: Arbeitsbaum (kein Commit), `git diff` gegen `HEAD`.

## Major

### M1 – „Zurücksetzen" aktualisiert den Dauerlauf nicht (`graph.js:208-216`)
Der Reset-Handler setzt `p[key]`, Slider-Wert und Label auf die Defaults, ruft `applyForces(p)`
und `history.replaceState(...)` – aber **weder** `alphaTargetValue` **noch** `sim.alphaTarget(...)`.
`applyPhys` (497-503) macht das für den `alphaTarget`-Regler korrekt; der Reset-Pfad nicht.

Nachweis (eigener Browser-Lauf, DEMO_URL `http://127.0.0.1:47555/#t=5a75…`):
- `alphaTarget`-Regler auf `0.2`, dann „Zurücksetzen" →
  `config().alphaTarget = 0.05`, Slider `0.05`, aber `simulation().alphaTarget() = 0.2`.
- `alphaTarget`-Regler auf `0`, dann „Zurücksetzen" →
  `config().alphaTarget = 0.05`, Slider `0.05`, aber `simulation().alphaTarget() = 0`
  (Dauerlauf bleibt faktisch aus, obwohl das Panel 0.05 zeigt).
- `alphaTargetValue` (von Drag-Ende 655 und `setMode` 736 genutzt) bleibt ebenfalls stale;
  ein nachfolgender Slider-Zug setzt `sim.alphaTarget(alphaTargetValue)` mit dem alten Wert.

**Fix:** im Reset-Handler analog zu `applyPhys`:
`alphaTargetValue = MANY || NO_EDGES ? 0 : p.alphaTarget` und
`sim.alphaTarget(alphaTargetValue).restart()` ergänzen.

## Minor

- **m1 – AC „weniger Überlappung" im Demo-Store nicht belegbar.** Der Demo-Graph hat nur
  **26 Knoten / 10 Kanten**; bei den Defaults *und* den alten Werten (collide 6, repBase 120,
  distMax 600) ist die Zahl überlappender Paare **0**. Der Effekt ist nur in einem
  künstlichen Gedränge messbar (siehe `verification.md`): bei `repBase 0/linkBase 1`
  minGap 11,9 px (alt) vs. 27,9 px (neu). Für einen echten AC-Beleg fehlt ein dichter Graph
  (> 300 oder stark vernetzt). Kein Code-Defekt, aber eine Verifikationslücke.
- **m2 – `distanceMax`-Anzeige „∞" nur im Label, nicht im Testhook.** `physFmt` zeigt `∞` bei
  `distMax=0` korrekt; `config()` liefert aber `0` (Rohwert). Konsistent mit dem Hash-Handling
  (`numOr` erhält 0) – bewusst, aber für Aufrufer erklärungsbedürftig. Kein Fix nötig,
  ggf. Kommentar.

## Geprüfte Aspekte ohne Befund

- **Live-Anwendung ohne Route-Reload:** `applyPhys` setzt `p[key]`, ruft `applyForces(p)`,
  bumpt `alpha` und `restart()`, danach `history.replaceState` – **kein** `location.hash=`.
  Belegt: `window.__smithGraph`-Objekt, `simulation()`-Objekt und `#graph-svg`-Knoten bleiben
  identisch (`sameHook/sameSim/sameSvg = true`, `svgCount = 1`); alle 26 Knoten-Objekte
  behalten Identität, Positionen bewegen sich (warm).
- **`applyForces(cfg)`** setzt alle Kräfte aus `cfg` (link/charge/collide/center/group/radial)
  und `velocityDecay(cfg.velocityDecay)` – Slider-Werte fließen vollständig ein.
  `distanceMax(cfg.distMax > 0 ? cfg.distMax : Infinity)` = 0→∞ korrekt.
- **Hash-Handling:** nur Abweichungen vom Default landen im Hash (`hashOf`, Zeile 87);
  Defaults werden nicht geschrieben (Reset → `#/graph`). `numOr` erhält `0` (distMax=0,
  velocityDecay=0) und fällt bei `""`/`NaN` auf den Default zurück (`collide=abc`, `repBase=`
  → 14 / 180). Reload mit `#/graph?clusterStrength=0.15&distMax=0` übernimmt beide Werte.
- **Testhook sauber:** `{ nodes, links, simulation, params, config, applyForces }`; `config()`
  gibt eine Kopie (`{...p}`), `params()` das lebende Objekt (dokumentiert). In `ctx.cleanup`
  gelöscht.
- **Feature-Parität:** alle Side-Panel-Abschnitte/-Filter vorhanden (Ansicht, Größe,
  Gruppierung, Zeitreise, Arten, Beziehungen, Mindeststärke, Weitere) + neuer „Physik"-Block;
  Tools Pfad/Verknüpfen/Fokus/Speichern/PNG/Einpassen unverändert.
- **CSP/Frontend (AGENTS §4/§14):** keine neuen externen Ressourcen, kein CDN,
  build-freie ES-Module; Inline-Styles nur am Slider-Element (`style.width`).

## Standards geprüft
Kein passendes Code-Standards-Skill für diesen Stack (Vanilla-JS-Frontend ohne Build, kein
Java/Spring); `code-standards-java` nicht anwendbar. Geprüft gegen `AGENTS.md` §3/§4
(Frontend ohne Build, CSP/kein CDN, keine Laufzeit-npm-Deps, Invarianten 12/14).
Nicht prüfbar: —.
