# AGENTS.md – Entwicklerdokumentation für skillsmith

Dieses Dokument richtet sich an Agenten/Entwickler, die skillsmith weiterentwickeln. Nutzerdoku: `README.md`.

## 1. Zweck und Designprinzipien

skillsmith ist ein opencode-Plugin (Plugin-API v1, getestet mit opencode **1.18.19** und **1.18.35**, Version 3.0) mit fünf „Smiths“ und dem Doktor, die im Hintergrund Sessions bewerten und einen gemeinsamen Store pflegen. Seit 3.0 ist die Weboberfläche ein schreibender Arbeitsplatz (Wissensbasis, Aufgaben/Board, Projekte mit Pipeline, Agenten-Aufträge, Audit-Log, Metriken):

| Smith | Arten (`Kind`) | Hintergrund-Agenten | Schreib-Tools |
|---|---|---|---|
| skillsmith | `skill` | `skillsmith-reviewer`, `skillsmith-curator` | `skillsmith_*` |
| docsmith | `knowledge`, `glossary` | `docsmith-reviewer`, `docsmith-curator` | `docsmith_*` |
| errorsmith | `error` | `errorsmith-reviewer`, `errorsmith-curator` | `errorsmith_*` |
| toolsmith | `script` | `toolsmith-reviewer`, `toolsmith-curator` | `toolsmith_*` |
| memorysmith | `memory` (Entscheidung, Vorgabe, Erfahrung) + lokal: Arbeitsstand, Ergebnis | `memorysmith-reviewer`, `memorysmith-curator` | `memorysmith_*` |
| doctor | Beziehungen zwischen allen Knoten, Konflikte | `smith-doctor` | `doctor_*` |
| (Nutzer) | `task`, `project` (`userOwned`), eigene Dokumente in `knowledge` | `smith-assistant` (nur lesend: Entwürfe, Doku-Prüfung, Wissens-Chat) | Web-Aktionen (`src/core/actions`) |

Prinzipien:

1. **Dateien sind die Wahrheit.** Markdown + Frontmatter, `meta/<kind>/*.json`, `candidates/<kind>/*.json` im Store. Suche, Statistiken, Queue, Vorkommen sind abgeleitet bzw. Laufzeitdaten (`state/`, nicht versioniert). Datenbanken (beide lokal, `bun:sqlite`): die Vektor-Ablage `state/embeddings/vectors.sqlite` – reine Ableitung, jederzeit neu erzeugbar – und `state/memory.sqlite` für **flüchtige** Erinnerungen (Arbeitsstände, Ergebnisse, aufgefangene Subagent-Antworten), Beziehungen mit flüchtigem Ende und die Buchführung des Doktors. Dauerhafte Erinnerungen und Beziehungen zwischen Store-Einträgen liegen als Dateien im Git-Store. Kein MCP.
2. **Ein generisches Gerüst, Unterschiede nur im Kind-Register.** Store, Ops, Suche, Kandidaten, Meta, Tiers, Git, Curator-Lebenszyklus sind für alle Arten gleich; `src/core/kinds.ts` beschreibt Layout, Frontmatter-Felder, Suchfelder und Labels je Art.
3. **Guards im Code, nicht im Prompt.** Alles, was schreibt, geht durch `src/core/ops.ts` (Limits, Wiederholungs-/Nachweis-Gates, Duplikate, Geheimnis-Scan, Pins, Fremd-Skills, Schreibmodi, Freigabepflicht, Parallelität). Prompts sind nur Hilfe.
4. **Ein Lauf = ein Commit.** Jeder Smith-Lauf (Reviewer, Curator, Doktor, Befehl) erzeugt höchstens einen Git-Commit mit genau den Pfaden, die er berührt hat; deterministische Commit-Nachricht `<smith>(<actor>): …`. Lokale Aktionen (`RunAction.local`: Arbeitsstand, Ergebnis, Beziehung mit flüchtigem Ende, Konflikt) stehen im Journal, aber nicht im Commit.
5. **Kein Review geht verloren.** Persistente Queue, Koaleszierung pro Session mit Folge-Review, parallele Ausführung, kein Tages- oder Abstandslimit (Nutzerwunsch – Tokenkosten unkritisch). Konfigurationsfehler (unbekanntes Modell …) → Job bleibt, Retry alle 10 min. Teilerfolg: erledigte Smiths werden im Session-State (`reviewProgress`) gemerkt und beim Retry übersprungen.
6. **Deterministische Signale vor dem LLM.** Fehlerketten, Signaturen, Abkürzungen, Code-Änderungen, Projekt-Doku-Stellen und Automatisierungs-Signale werden ohne Modell extrahiert (`signals.ts`) und den Agenten als Daten gegeben; Gates prüfen gegen genau diese Daten.
7. **Prompt-Cache schonen.** System-Prompt nie dynamisch; Hinweise hängen an der jeweiligen Nutzernachricht, pro Nachricht stabil. Live-Fehlerhinweise hängen an der Tool-Ausgabe.
8. **Host-Unabhängigkeit.** `src/core/**` kennt opencode nur über den SDK-Client und die Message-Struktur; Hooks liegen in `src/host/v1.ts`.
9. **Der Nutzer ist ein Akteur wie die Smiths.** Jede Web-Aktion ist ein Lauf (`actor: "web"`, Smith nach Art) durch `Ops` mit denselben Gates, höchstens einem Commit `<smith>(web): …` und einem Audit-Ereignis; Rückgängig = `git revert` des Laufs. Die KI respektiert das KI-Recht (`ai`) eines Eintrags im Code (`Ops`, Suche, Hinweise, Embeddings).

## 2. Laden durch opencode (nicht kaputtmachen!)

- Der Nutzer trägt `"./plugins/skillsmith/index.ts"` oder `["./plugins/skillsmith/index.ts", {optionen}]` in `plugin` ein. Optionen kommen als 2. Argument von `server(input, options)`.
- **Pfad-Plugins müssen `export default { id, server }` exportieren** (`index.ts`).
- **`package.json` ohne `main`/`exports`**, **keine Laufzeit-Abhängigkeiten** (nur Node-Builtins). `@opencode-ai/plugin` wird optional dynamisch importiert (zod-Schemas, `src/host/schema.ts`); sonst JSON-Schema-Args. `SKILLSMITH_FORCE_JSON_SCHEMA=1` erzwingt den Fallback (E2E grün in beiden Modi).
- `src/py/checker.py` wird über `new URL("../py/checker.py", import.meta.url)` gefunden – beim Packen mitliefern.
- Mehrfachinstanzen pro Verzeichnis: Guard `globalThis[Symbol.for("skillsmith.instance:<dir>")]`.
- Env-Overrides in `resolveOptions` (`src/config.ts`) überschreiben die Config-Datei, damit CLI und Plugin übereinstimmen: `SKILLSMITH_STORE_DIR` (→ `storeDir`), `SKILLSMITH_WEB_AUTOSTART` (→ `web.autostart`), `SKILLSMITH_WEB_HOST` (→ `web.host`), `SKILLSMITH_WEB_PORT` (→ `web.port`, nur gültige Ports 1–65535). Dazu die bestehenden `SKILLSMITH_DISABLED=1`, `SKILLSMITH_DEBUG=1`, `SKILLSMITH_EMBEDDINGS=0`. `SKILLSMITH_OPENCODE_BIN` wird nur von der CLI gelesen (opencode-Binary), nicht vom Plugin.

## 3. Architektur

```
index.ts                     export default { id: "skillsmith", server: createServer }
bin/skillsmith               ausführbarer Launcher (Node-Shebang); löst seinen realen Pfad auf und
                             importiert bin/skillsmith.ts (der Befehl bleibt ohne Dateiendung)
bin/skillsmith.ts            CLI der eigenständigen Anwendung: run/start/stop/restart/status/url/logs/
                             enable/disable; startet `opencode serve --port 0`, liest die Adresse aus
                             dessen Ausgabe, stößt per GET /agent das lazy Laden des Plugins an, wartet
                             auf state/web.json; Store-Auflösung wie das Plugin; `enable` schreibt einen
                             launchd-LaunchAgent com.skillsmith.agent (führt die CLI aus, RunAtLoad +
                             KeepAlive), `start` schreibt state/cli.json. Node >= 22.6, keine Abhängigkeiten.
                             `classifyLauncher` löst den opencode-Launcher auf: echtes Binary (ELF/Mach-O/PE)
                             oder Shebang → direkt starten; Pointer-Datei (kein Shebang, einzeiliger Text auf
                             eine existierende Datei) → rekursiv folgen; Verzeichnis → <dir>/package/bin/opencode;
                             sonst /bin/sh <datei> … (ENOEXEC-Fallback). Die Argumente (`serve --port 0 …`)
                             werden durchgereicht; der aufgelöste Pfad landet als SKILLSMITH_OPENCODE_BIN in
                             der launchd-Plist.
src/host/v1.ts               Hooks: config (11 Agenten, Permissions, 36 Befehle, skills.paths), tool,
                             event (idle/error/status → SessionSignals), chat.message (Zähler, Modell merken,
                             „merk dir“ → rememberRequested, Hinweise), experimental.chat.messages.transform
                             (Hinweise injizieren), tool.execute.after (skill-Nutzung, Task: Antwort auffangen +
                             Subagent-Job, Live-Fehlerhinweis), experimental.session.compacting (Stand-Block in den
                             Kontext, Review einplanen), tool.definition, command.execute.before, dispose;
                             Store-Migration, Doktor-Backfill, Web-Autostart beim Start
src/host/tools.ts            19 Lese-Tools (alle Agenten, inkl. skill_list, knowledge_list, glossary_list,
                             error_list, script_list, memory_list, docs_search, history_search, memory_search,
                             memory_read, graph_neighbors) + Schreib-Tools je Smith (nur in Läufen dieses Smiths);
                             Wissens-Schreibtools hängen verwandte Einträge an; memorysmith_*, doctor_*
src/host/commands.ts         30 Befehle (/smith-*, /skills-search|adopt, /knowledge, /glossary*, /errors*, /scripts*,
                             /docs-search, /history) + Dispatcher
src/host/memory-commands.ts  /memory, /remember, /forget, /resume, /smith-doctor, /smith-web; Report-Zeilen
src/host/schema.ts           Arg-Specs → zod oder JSON-Schema

src/core/kinds.ts            Kind-Register: Layout (dir|file), Haupt-Datei, Tiers, Frontmatter parse/serialize,
                             Suchfelder+Gewichte, Aliase für Befehle, Tags normalisieren, Glossar-Slug
src/core/frontmatter.ts      YAML-Frontmatter (Teilmenge) lesen; schreiben als YAML mit JSON-Flow-Werten
src/core/store.ts            generischer Store: list/get/fresh/create/update/patchBody/updateMeta/move/merge/
                             setPinned/adopt, Kandidaten pro Art, Glossar-Ignore, Run-Claims, Migration v1→v2
src/core/ops.ts              ALLE Schreiboperationen mit Guards; glossaryUpsert, publishScript, Staging (+Recheck)
src/core/search.ts           BM25F je Art (eigene df/avgLen), Tag-/Tier-/Projekt-Filter, Konfidenz, TF-IDF-Cluster
src/core/embeddings.ts       EmbeddingClient (OpenAI-/LiteLLM-/embeddings, Modell-Autoerkennung, MRL-Kürzung,
                             Qwen-Query-Anweisung, Batching, Timeout, Circuit-Breaker), SemanticIndex (Sync, score)
src/core/vector-store.ts     VectorStore-Interface; SqliteVectorStore (bun:sqlite, Standard): Zeile je Vektor,
                             inkrementeller Flush in einer Transaktion, Cache je Namespace + Abgleich mit anderen
                             Prozessen (data_version, seq, Tombstones), Migration der Dateien, Wartung;
                             FileVectorStore (Fallback/`storage: "file"`): Float32-Datei + JSON-Index je Namespace
src/core/retrieval.ts        Retriever: hybride Suche (BM25 + Vektor, RRF), SimilarityProvider für Ops
                             (Duplikat-Sperre, Kandidaten-Zuordnung, Tag-Plan), verwandte Einträge (related),
                             Tag-Vokabular (tagVariant, tagPlan, tagMerges), semantischer Fehlerabgleich
src/core/bm25.ts             MiniIndex (BM25F für Nicht-Store-Dokumente) + rrf() – Projekt-Doku, Session-Verlauf
src/core/project-docs.ts     ProjectDocs: .md des Projekts → Abschnitte (chunkMarkdown), mtime-Cache, BM25 + Namespace
                             docs-<hash(root)>; nur lesen. safeDocsRoot(): Worktree, sonst Verzeichnis – nie "/"
                             (opencode meldet worktree "/" außerhalb von Git) oder das Home-Verzeichnis
src/core/session-history.ts  SessionHistory: state/history.json (Lock + Merge), Datensatz pro Session, Suche,
                             Namespace sessions; fixOf() leitet den Lösungsschritt einer Fehlerkette ab
src/core/embed-eval.ts       Auswertung mit echten Sessions (Nachricht → geladener Eintrag; Treffer@k, MRR)
src/core/signals.ts          Fehler-Normalisierung/Signaturen/Ketten, Abkürzungen+Definitionen, Automatisierungs-
                             Score, Code-Änderungen aus edit/write/patch, Projekt-.md-Scan (nur lesen)
src/core/transcript.ts       Nachrichten → Transkript, strukturierte ToolCalls, Entry-Uses (Feedback), Haystack
src/core/reviewer.ts         Job: Nachrichten → prepare() → route() → runSmith() parallel → Feedback, Fortschritt
src/core/prompts.ts          System-Prompts (Reviewer/Curator je Smith) und Job-Prompt-Builder
src/core/agent-runner.ts     Hintergrund-Agent in eigener Session; explizites Modell; Fehlerklassifikation;
                             Semaphore (agentConcurrency)
src/core/hints.ts            kombinierte Hinweise pro Nutzernachricht; Live-Fehlerhinweise (tool.execute.after)
src/core/curator.ts          Lebenszyklus je Art, Glossar-Duplikate, Skript-Retests, LLM-Konsolidierung je Smith
src/core/pyworkshop.ts       Python-Umgebung/Sandbox-Erkennung, Check-Pipeline (checker.py, Tests, --help)
src/core/toolsmith.ts        Workshop: Drafts (state/drafts/<run>/<name>), revise, publish, Recheck bei Freigabe
src/py/checker.py            statische Prüfung (Py-3.9-Syntax via feature_version, Importe, Fähigkeiten, Testanzahl)
src/core/queue.ts            persistente Queue, Pool, Koaleszierung, Backoff, Config-Error-Retry, Session-Lock
src/core/state.ts            UsageStore (kind:name), OccurrenceStore (state/errors.json), SessionStore, Modell merken
src/core/git.ts              GitTracker; commitMessage (Smith-Präfix, actionLabel), findRunCommit (alle Smiths)
src/core/finalize.ts         Lauf-Ende: Commit, Journal, Run abmelden
src/core/runs.ts             RunRegistry (prozessweit) – Run hat smith, actor, limits, haystack, chains, drafts
src/core/scope.ts            Projekt (normalisierter Git-Remote, sonst path:<worktree>), Branch, Ticket; git synchron
                             gesucht (findGitSync, macOS: /usr/bin/git nur mit Command Line Tools), 30-s-Cache
src/core/memory-db.ts        MemoryDb (state/memory.sqlite): states, results, captures, relations (flüchtiges Ende),
                             conflicts, checked, doctor_queue, meta
src/core/graph.ts            Graph: Knoten (Store-Einträge, Arbeitsstände, Ergebnisse, Sessions), gespeicherte und
                             abgeleitete Kanten, neighbourhood(), canonicalEdge(), RELATION_LABEL
src/core/memory-format.ts    Textformen: Arbeitsstand, Erinnerungsliste, voller Eintrag mit Verknüpfungen, Stand-Block
src/core/doctor.ts           Doctor: Queue nach Läufen, scan() (Kandidaten → Konflikte), judge() (Agent smith-doctor),
                             decide(), Folge-Läufe, Backfill
src/core/actions/            Aktionskatalog (96 Aktionen, `ACTIONS`): entries (speichern mit Basisversion, umbenennen
                             inkl. Link-Nachzug, verschieben, umwandeln, zusammenführen, archivieren, löschen),
                             docs (Dokumente, Ordner, Vorlagen, Anhänge, Vorschläge der KI, Tagesnotiz, Schnellnotiz,
                             Assistent), tasks (Aufgaben, Board, Projekte, Pipeline), agents (Auftrag, Freigabe,
                             Nachbessern, Abnahme, Regeln), memory (Erinnerungen, Stände, Ergebnisse, Beziehungen,
                             Doktor, Glossar, Freigaben), system (Undo, Restore, Tags, Export, Einstellungen).
                             `runAction()`: Schema-Prüfung → Lauf → Ops → finalizeRun → Audit; 409 (Version),
                             428 (Bestätigung), 401 (starker Token), 403 (nur lesend)
src/core/audit.ts            AuditLog (state/audit.sqlite): jedes Ereignis mit Akteur, Grund, Ergebnis, Commit,
                             Vorher/Nachher (lokal), Hash-Kette; Übernahme des Lauf-Journals; abgelehnte Agent-Aktionen
src/core/metrics.ts          Metrics (state/metrics.sqlite): Ereignisse + Tagessummen, Puffer (flushMs), nur Ids/Zahlen
src/core/relevance.ts        Relevanz je Knoten (Nutzung mit Halbwertszeit, PageRank, Bedeutung; Rang je Art)
src/core/graph-extra.ts      Pfad, Graph zu einem Datum (git), semantische Landkarte (Embeddings oder TF-IDF + PCA)
src/core/links.ts            [[Links]], Kurz-IDs, Tickets, #tags: parsen, auflösen, Rückverweise, Erwähnungen, Umbenennen
src/core/versions.ts         Versionen je Eintrag aus git, Feld-/Wortdiff, Wiederherstellen
src/core/templates.ts        Dokumentvorlagen (eingebaut + `_vorlagen`)
src/core/tasks.ts            Tasks: Kurz-IDs (tasks/.counter.json), Spalten, WIP, Unteraufgaben, Checklisten,
                             lose Punkte, Board-Reihenfolge (state/board.json), Vorschläge von memorysmith
src/core/projects.ts         Projects: home_path, Board-Overrides, Pipeline-Definition, forDirectory()
src/core/pipeline.ts         Pipeline: Stufen in der Login-Shell, Warteschlange je Projekt, Zeitlimit, JUnit,
                             Log (geschwärzt, logMaxKB), branch-Checkout im Worktree, sandbox-exec
src/core/agent-tasks.ts      AgentTasks: Auftrag (Brief), Worktree, Phasen proposal → awaiting_approval →
                             implementing → checking/fixing → reviewing → in_test → accepted; Regeln aus Korrekturen
src/core/agent-hub.ts        prozessweiter Hub über alle Plugin-Instanzen: Session-Baum (Eltern), Guard je Wurzel
                             (`checkTool` in tool.execute.before), Ereignisse an den Besitzer des Auftrags
src/core/assistant.ts        smith-assistant: Entwürfe aus Session/Stand/Vorlage, Doku-Prüfung, Wissens-Chat
src/core/notify.ts           Benachrichtigungen (Toast in opencode, Browser über den Bus, macOS osascript)
src/core/bus.ts              Ereignis-Bus mit Ring (Live-Updates), `since(id)` für Reconnect
src/core/productivity.ts     Eingang, Tagesnotiz, Standup, Hinweis-Simulator, Session-/Ticket-Seiten
src/core/export.ts           statischer Export (HTML inkl. alles.html, Markdown)
src/host/metric-events.ts    Hook-Ereignisse → Metriken (Tool-Aufrufe inkl. MCP, Tokens, Hinweise)
src/web/server.ts            WebServer (Bun.serve, 127.0.0.1, Token abschaltbar, Host-/Origin-Prüfung, CSP, JSON,
                             maxBodyKB, Lese-Sperre, Uploads); `state/web.json` teilt eine Instanz
src/web/api.ts               GET-Endpunkte (Einträge, Graph, Versionen, Audit, Eingang, Board, Jobs, Stats …),
                             POST /api/action → runAction, POST /api/upload, GET /api/attachment
src/web/live.ts              SSE /api/live (Token im Header, Reconnect mit Last-Event-ID)
src/web/stats.ts             Statistik-Endpunkte (Überblick, Wissen, Hinweise, Fehler, Smiths, Tools, Heatmap,
                             Aufgaben, Pipeline, Agenten, Ereignisse eines Tages)
src/web/static/              index.html, style.css, js/*.js (ES-Module ohne Build: api, dom, ui, markdown, diff,
                             charts, cm, palette, parts, main) und js/views/*.js (eine Datei je Route, lazy);
                             vendor/: d3-force/d3-drag/d3-zoom/d3-selection (ISC; gebündelt als
                             `d3-force.min.js`), CodeMirror 6, uPlot 1.6.32, Mermaid 11.17.2,
                             highlight.js 11.11.1 (Lizenzen daneben) – gebaut mit tools/vendor/build.sh
src/core/redact.ts, skill.ts, context.ts, config.ts, log.ts, types.ts, util/{fs,text}.ts
```

### Datenfluss Review

1. `chat.message`: Zähler, `thresholdReached`, Modell der Nachricht in `state/model.json` und Session-State merken, `hints.onUserMessage`.
2. `session.idle` / Task-Tool → `queue.enqueue(...)` (wie v1).
3. `reviewSession`: unbewertete, abgeschlossene Nachrichten → `buildTranscript` (mit `scriptOf`, um Skript-Aufrufe als Nutzung zu erkennen) → `prepare()`:
   - Fehlerketten (`extractChains`, Sessions aus `OccurrenceStore`), eingefügte Fehler als `P<n>`-Ketten,
   - Live-Hinweis-Ergebnisse (`hinted` + nächster Aufruf),
   - Automatisierungs-Score, Abkürzungen (nur Nutzer-/Assistententext, ohne Code), Code-Änderungen, Projekt-`.md`-Stellen (Bezeichner-Scan + `ProjectDocs.search` mit Änderungstext bzw. Transkript, BM25-Abdeckung ≥ 0,5 oder Ähnlichkeit ≥ `hintMinSimilarity`, Budget `repoDocsMaxChars`),
   - `haystack` = redigiertes Transkript + Doku-Stellen + Änderungen (Nachweisprüfung).
4. `route()` wählt die Smiths; bereits erledigte (`reviewProgress`) werden übersprungen.
5. `runSmith()` je Smith parallel: Run (`smith`, Limits je Smith, `userText`, `haystack`, `chains`), docsmith notiert vorher deterministisch offene Abkürzungen (`candidates/glossary/abbr-<slug>`), Prompt bauen, Agent `<smith>-reviewer` mit **explizitem Modell** (`resolveModel`: `<smith>.model` → `reviewerModel` → Modell der Session → zuletzt gesehenes Modell), `finalizeRun` (ein Commit).
6. `recordHistory()` (nur Hauptsessions): Anfragen, Fehlerketten (gelöst + `fixOf`), Links (angewendete Aktionen der Läufe = neu/geändert, `transcript.uses`, `error_lookup` per Name, hilfreiche Live-Hinweise = genutzt), Ende der letzten Antwort → `SessionHistory.record` (Merge pro Session, idempotent bei Wiederholung).
7. Alle erfolgreich → Feedback-Statistik je Use (`usage.recordFeedback(kind, name, …)`), Bereich als bewertet markieren. Sonst: `reviewProgress` speichern; Config-Fehler → `config-error` (Queue: +10 min, nie verwerfen, Toast höchstens alle 30 min); andere Fehler → Backoff; nach 5 Fehlschlägen wird der Bereich übersprungen (Schutz vor „giftigen“ Transkripten).

### agent-runner (Bugfix Modellwahl)

- `promptAsync` bekommt immer `body.model`, wenn ein Modell bestimmbar ist. Ohne Modell würde opencode `agent.model ?? cfg.model` nehmen (im Bug-Report ein von LiteLLM nicht angebotenes Modell → `ProviderModelNotFound`).
- `src/core/models.ts` (`chooseModel`): Kandidaten werden gegen `config.providers()` (30 s gecacht) geprüft; `matchModel` repariert eindeutige Namen ohne Provider bzw. mit falscher Schreibweise („Hermes“, „Hermes/“ → `9router/Hermes`; opencodes `parseModel("Hermes")` ergäbe `Hermes/` mit leerer Modell-Id – die TUI fällt still zurück, die API nicht). Explizites Modell (Option/Session) → muss existieren (sonst Config-Fehler, keine Session); ohne Modell: Agent-Modell → `model` aus opencode.json → opencodes Standard. Agenten-Aufträge (`AgentTasks.jobModel`): gewähltes Modell (streng) → Agent-Modell → zuletzt genutztes (`state/model.json`) → `cfg.model` → Standard; Ergebnis in `job.model`, Reparaturen in `job.modelNote`. `modelErrorHint()` ergänzt Fehlertexte. Interne Agenten bekommen `model` in der Config nur in der Form `provider/modell`.
- `session.error`-Events setzen `waiter.failed`; ist die Session dann idle, endet das Warten sofort (vorher: 15 min Timeout, weil nie eine Assistant-Nachricht entstand). `ContextOverflowError` wird ignoriert (opencode kompaktiert und macht weiter).
- Keine Assistant-Nachricht nach 90 s bei idle → Fehler „agent did not start“.
- `CONFIG_ERROR_RE` klassifiziert ModelNotFound/NoProviders/Auth/AgentNotFound.

### Interne Agenten und Rechte

Pro Smith zwei Agenten in `cfg.agent`, dazu `smith-doctor`: `mode: "primary"`, `hidden: true`, `permission: {"*": "deny", <19 Lese-Tools>: "allow", "<smith>_*": "allow"}` (Doktor: `doctor_*`). Global und in allen Nutzer-Agenten mit eigener `permission` werden `skillsmith_*`, `docsmith_*`, `errorsmith_*`, `toolsmith_*`, `memorysmith_*`, `doctor_*` als letzte Einträge auf `deny` gesetzt → normale Agenten sehen keine Schreib-Tools. Zusätzlich prüft `withRun` in `tools.ts`, dass die Session zu einem aktiven Lauf **desselben Smiths** gehört.

### Kinds, Store-Layout, Frontmatter

| Kind | Datei | Tiers | Frontmatter |
|---|---|---|---|
| skill | `skills/<tier>/<name>/SKILL.md` | active/dormant/archive | name, description, tags |
| knowledge | `knowledge/<tier>/<name>.md` | active/archive | name, title, description, tags |
| glossary | `glossary/<tier>/<slug>.md` | active/archive | name, term, aliases, meanings[{expansion, description, context?}], tags |
| error | `errors/<tier>/<name>.md` | active/dormant/archive | name, title, description, status (solved\|open), signatures, context, tags |
| script | `scripts/<tier>/<name>/SCRIPT.md` (+ `<modul>.py`, `test_<modul>.py`) | active/dormant/archive | name, description, usage, entry, capabilities, requirements, python, tags |
| memory | `memories/<tier>/<projekt-slug>-<typ>-<thema>.md` | active/archive | name, title, description, type (entscheidung\|vorgabe\|erfahrung), scope (projekt\|global), project, project_name, topic (`typ/thema`), status (gueltig\|vorgeschlagen\|abgeloest), decided_by, valid_from, review_after, superseded_by, branch, ticket, tags |

Frontmatter wird als YAML mit JSON-Flow-Werten geschrieben (`description: "…"`, `tags: ["a","b"]`) – gültiges YAML, robust lesbar. Der Leser versteht zusätzlich Block-Listen, Block-Skalare und einfache Quotes (Handbearbeitung).

Migration v1→v2 (`store.migrate`): `meta/*.json` → `meta/skill/`, `candidates/*.json` → `candidates/skill/`, `store.json {version: 2}`; beim Start als Befehlslauf mit eigenem Commit.

### Gates (ops.ts)

- **skill create:** `candidate_id` (≥ `recurrenceMinSessions` Sessions) oder `user_quote` (wörtlich in Nutzertext).
- **knowledge create/update/patch:** `evidence` (≥ 12 Zeichen, normalisiert wörtlich in `userText` oder `haystack`). Reine Tag-Änderungen ohne Nachweis.
- **glossary upsert:** Reviewer: Abkürzung als Wort im Transkript, jede *neue* Bedeutung wörtlich im Transkript/Doku. Bedeutungen werden deterministisch gemischt (gleiche Expansion → aktualisiert, neue → angehängt); archivierte Einträge werden reaktiviert; Kandidat `abbr-<slug>` → promoted.
- **error create:** `chain_id` aus `run.chains`; `solved` nur bei aufgelöster Kette oder `user_quote`; `open` nur bei ≥ `openMinSessions` Sessions; Signatur und Kontext werden automatisch ergänzt. Validierung: `## Symptom`, bei solved `## Lösung`.
- **script:** nur über `toolsmith_publish` (Workshop) – letzter Check muss bestanden sein; neu: Wiederholung (`toolsmith.recurrenceMinSessions`) oder `user_quote`; `needsApproval` (riskante Fähigkeiten, ungetestet ohne Sandbox) erzwingt Staging auch bei `writeMode: auto`; `applyStaged` führt den Check erneut aus (`setScriptRecheck`).
- Tags (`Ops.planTags` → `SimilarityProvider.tagPlan`, Provider ist immer gesetzt): bei create/merge/publish (und geänderten Tags bei update) von Hintergrund-Agenten werden Tags auf das Vokabular abgebildet – `tagVariant()` (nur bekannte Endungen: Plural, -ing, -ment, -ation, -js …; nie „java“/„javascript“), mit Embeddings zusätzlich Namespace `tags` (≥ `tagSimilarity`). Weniger als 2 Tags → Tags der ähnlichsten Einträge (Gewichtssumme ≥ 0,9). Befehle behalten explizite Tags. Danach `deriveTags()` als letzter Fallback. Abbildungen/Vorschläge gehen als Warnung an den Agenten.
- Widerspruch: `docsmith_knowledge_flag` → `Ops.flagKnowledge` (`meta.doubts`, max. 5, Aktion `flag`, zählt als Änderung). Belegte Inhaltsänderung (update mit Nachweis/Freigabe, patch) löscht `doubts`. Die Tools create/update/patch hängen `Retriever.related()` an (Embeddings ≥ `relatedSimilarity`, sonst BM25-Konfidenz ≥ 0,5).
- Budget: `WRITE_ACTIONS` zählen gegen `maxChanges`, `create` von skill/knowledge/error/script gegen `maxNew`. Glossar-Upserts zählen als Änderung, nicht als neu. Der Curator darf nichts Neues anlegen.

### toolsmith-Werkstatt

`Workshop.draft/revise` → `checkDraft()`:
1. Dateien in `state/drafts/<runId>/<name>/` schreiben;
2. `python -E -s -B checker.py --target 3.9 --module <m> <code> <test>` → JSON (Syntaxfehler mit `feature_version`, PEP-604-Annotationen ohne `__future__`, zu neue Module/Namen, Importe stdlib/third-party/missing, erkannte Fähigkeiten, Testanzahl, `__main__`-Guard, argparse);
3. Fähigkeiten: unbekannte/undeklarierte → Fehler; `risky = (deklariert ∪ erkannt) ∩ requireApprovalFor`;
4. Requirements: fehlende Module → Fehler, außer `allowPipInstall` (dann `pip install --user`, danach erneut prüfen);
5. Tests: Kopie in `mkdtemp`, `python -B [-E -s] -m unittest -v test_<m>` mit minimaler Umgebung (`HOME`/`TMPDIR` = Temp-Dir, ohne Requirements), Timeout; macOS mit `sandbox-exec`-Profil (kein Netzwerk, Schreiben nur im Temp-Dir), nur wenn der Selbsttest (`sandboxSelfTest`) bestanden ist; Linux optional `unshare -rn` (nur Netzwerk). Riskant ohne volle Sandbox oder `sandbox: required` ohne Sandbox → **nicht ausführen**, Status `untested`, `needsApproval`;
6. `--help` muss Exit 0 liefern.
Python-Umgebung wird in `state/python.json` 24 h gecacht (`/scripts-test` erneuert).

### Hinweise

- `HintEngine.select()`: Skills (BM25, Konfidenz-Regel wie v1), Glossar (Token der Nachricht gegen Term-/Alias-Map; Kleinbuchstaben-Tokens nur bei klein geschriebenen Termen; pro Session nur einmal erklärt → `explained`), Wissen/Skripte (max. 2, starke Treffer), Fehler (nur wenn die Nachricht wie eine Fehlermeldung aussieht), Erinnerungen (max. 2 des Projekts bzw. global, nicht abgelöst, + 1 Ergebnis mit Abdeckung ≥ 0,6), „Siehe auch“ (Nachbarn der Treffer mit Stärke ≥ 0,6, max. 3, nicht `contradicts`). Ausgabe: optional `<smith_memory>` (erste Nachricht) + ein `<smith_hints source="skillsmith">`-Block, gespeichert pro messageID.
- `onToolResult()` (Shell-Tools, Exit ≠ 0, nicht ignorierbar): Vorkommen erfassen; Eintrag per exakter Signatur oder BM25 (Konfidenz ≥ `hintMinScore`, ≥ 3 Terme); `<known_error …>` an `output.output` (pro Session+Eintrag höchstens alle 10 min); nächster Aufruf desselben Befehlskopfs → `helped`/`failed`. `transcript.ts` entfernt diese Blöcke wieder aus Fehlertexten (`stripPluginNotes`), damit Signaturen stabil bleiben.

### Curator

- `planLifecycle()` für skill/error/script mit eigenen Schwellen; letzte Aktivität = max(lastUsedAt, Vorkommen mit `entry`, created/updated, tierChangedAt wenn aktiv). Skill-Budget wie v1. Wissen/Glossar bewegen sich nie automatisch. `planMemory()`: abgelöste → Archiv, Erfahrungen nach `experienceArchiveDays` → Archiv, archivierte (nicht abgelöste) bei Nutzung → aktiv; Entscheidungen/Vorgaben nie wegen Alters.
- `cleanVolatile()` (lokal, ohne Commit, Teil von `lifecycle()`): Arbeitsstände nach `stateDays` oder bei gelöschtem Branch (nur aktuelles Projekt prüfbar) → `abgelaufen`; Ergebnisse nach `resultDays` ohne Nutzung und ohne Beziehung → gelöscht.
- `planGlossaryMerges()`: Union-Find über überlappende Terme/Aliase → `ops.merge` (deterministisch, ältester Eintrag ist Ziel).
- `lifecycle()`: ein Lauf + Commit **pro Smith** mit Änderungen.
- `retestScripts()`: wöchentlich; Commit nur bei Statuswechsel.
- `planTagMerges()` (`unifyTags`): `Retriever.tagMerges()` (häufigeres Tag ist kanonisch; Varianten lexikalisch bzw. Tag-Vektoren ≥ `tagSimilarity`) → `ops.update(tags, approved)` im Lebenszyklus-Lauf des zuständigen Smiths; vom Glossar-Merge absorbierte Einträge ausgenommen; Shadow-Modus → `shadow.jsonl`.
- `clustersFor()`: TF-IDF-Paare ∪ `semanticPairs()` (gespeicherte Vektoren, ≥ `clusterSimilarity`), Union-Find, max. 6 je Cluster.
- `consolidate()` (wartet bis 15 s auf aktuelle Vektoren): pro Smith mit Arbeit ein Curator-Agent (parallel, Semaphore): Erinnerungen (Cluster je Projekt; `memorysmith_merge` nur innerhalb eines Projekts), Skills (Cluster + fehleranfällig), Wissen (Cluster + markierte Widersprüche als `problems` + verwandte Paare `relatedSimilarity` ≤ s < `clusterSimilarity`, max. 5, nicht in `checkedPairs` der letzten 90 Tage bzw. seitdem geändert; Haystack = Text der beteiligten Einträge), Fehler (Cluster + Hinweise ohne Wirkung), Skripte (Retest fehlgeschlagen / Nutzung mit Fehlern). `checkedPairs` wird nach erfolgreichem Lauf gespeichert.

### memorysmith

- **Scope:** `ctx.scope()` → `ScopeResolver.resolve(directory, worktree)`; Projekt-Id stabil über Klone (`git@github.com:org/repo.git` = `https://…/org/repo` = `github.com/org/repo`). Läufe tragen `run.scope`; Tools schreiben immer mit dem Scope des Laufs.
- **Dauerhaft** (`Ops.memorySave`): Name = `<projekt-slug>-<typ>-<thema>` (global: `global-…`); gleicher Name in fremdem Projekt → Suffix aus Projekt-Hash. Gates: Nachweis immer (Reviewer); `vorgabe` nur mit Nutzerzitat; `entscheidung` ohne Nutzerzitat → `vorgeschlagen`/`decided_by: agent`, eine gültige Entscheidung wird dadurch nicht herabgestuft; gleiches Thema → update (archiviert → restore). `supersedes` → `memorySupersede` (Status `abgeloest`, `superseded_by`, Archiv; abgeleitete Kante „löst ab“). Duplikat-Sperre nur innerhalb desselben Projekts (`Retriever.similarity().duplicateOf`).
- **Flüchtig** (`memoryState`, `memoryResult`): `MemoryDb.upsertState` (ein Stand je Projekt+Branch, Id `state:<sha6(projekt)>-<branch-slug>`, alte Stände in `history`, max. 10), `addResult` (Id `result:<yyyymmdd>-<id>`); Aktionen `local: true`, im Shadow-Modus nur Vorschlag.
- **Captures:** `tool.execute.after` für `task` in Hauptsessions → `mem.capture(session, projekt, prompt, output)` (redigiert, gekürzt). `prepare()` nimmt die unverbrauchten Captures in den Job und in den Haystack (Nachweis), `runSmith` markiert sie nach erfolgreichem Lauf als verbraucht.
- **Routing:** nur Hauptsessions (Subagent-Sessions kommen über Captures); `/remember <text>` → `SessionState.rememberNotes` (zählen als Nutzerworte, eigener Abschnitt im Job) + Job `remember` (force, auch ohne neue Nachrichten); „merk dir …“ (`REMEMBER_RE`) → `rememberRequested` → bei idle sofort Job `remember`. Kompaktierung → Job `compaction`.
- **Stand-Block:** `HintEngine.standBlock()` → `standParts()`/`formatStand()`; nur in der ersten Nachricht einer Hauptsession (`standMessageID`), Teil des gespeicherten Hinweises (cache-stabil). Erinnerungen im Stand werden in derselben Nachricht nicht nochmals als Hinweis gezeigt.

### Wissensgraph und Doktor

- **Knoten:** `kind:name` für Store-Einträge, `state:…`, `result:…`, `session:<id>` (nur wenn eine Kante sie erreicht). `GraphNode.hash` = Version (Store) bzw. Inhalts-Hash (flüchtig) – damit erkennt der Doktor geänderte Paare.
- **Gespeicherte Kanten:** `Relation {to, type, strength 0–1, description, source, at, hashes, runId}`; Store↔Store in `meta.relations` des Quell-Eintrags (Git), sonst in `memory.sqlite`. Symmetrische Typen (`not_related`, `related`, `duplicates`, `contradicts`) liegen auf der kleineren Id (`canonicalEdge`). **Eine Beziehung pro Paar**: `Ops.relate` entfernt vorherige Urteile an beiden Enden. Stärke 1–5 im Tool → 0–1.
- **Abgeleitete Kanten** (`Graph.derivedEdges`, 30 s/Revision gecacht, nie gespeichert): Skript-Erwähnung → `uses` (aus Fehler: Skript `solves` Fehler), eindeutiger Name (≥ 3 Wortteile) im Text → `related` 0,5, `absorbedInto` → `duplicates`, `superseded_by` → `supersedes`, Ergebnis eines Branches → `part_of` Arbeitsstand, in Session entstanden → `derived_from` Session. Gespeicherte Kanten haben Vorrang.
- **Doktor:** `finalizeRun` → `Doctor.onRunFinished` (Inhaltsaktionen aller Smiths außer dem Doktor) → `doctor_queue`. `scan()`: `Retriever.similarTo` (Vektoren ≥ `relatedSimilarity`, sonst BM25 ≥ 0,5 mit ≥ 3 Termen) über knowledge/memory/error/skill/script; übersprungen werden Erinnerungen verschiedener Projekte, geprüfte Paare mit unveränderten Hashes (`checked`), Paare mit gespeichertem Urteil zu den aktuellen Hashes und abgeleitete Duplikat-/Ablösekanten. Rest → `openConflict` mit Verdacht. `run()`: Lock `doctor`, ≤ `maxPairsPerRun` offene Paare → Lauf `doctor(curator)` mit `run.doctorPairs` (P1…), Haystack = Text beider Einträge; Tools `doctor_relate|not_related|merge|correct|conflict|done` → `decide()` (markChecked mit Hashes nach dem Urteil, Konflikt gelöst bzw. `needs_user`). Unentschiedene Paare: `attempts`+1, nach 3 → `needs_user`. Folge-Lauf, solange Queue/offene Paare bleiben. Backfill einmalig (`meta doctor.backfill`). `doctor_correct`: nur `autoResolve`, nie Entscheidung/Vorgabe, Beleg wörtlich aus dem anderen Eintrag; `doctor_merge`: nur gleiche Art (nicht Glossar/Skript). Mit aktivem Doktor prüft der docsmith-Curator keine verwandten Paare mehr.
- **Nutzer:** `/smith-doctor resolve <id> a|b|beide|kein-bezug` – a/b: Erinnerung ↔ Erinnerung → `memorySupersede`, sonst Kante `supersedes` (Quelle `user`) + Archiv; flüchtiges Ende → löschen/verwerfen.

### Weboberfläche (schreibend seit 3.0)

- `/smith-web` → `WebServer.start()`: läuft schon eine Instanz eines anderen Prozesses auf demselben Store (`state/web.json`, pid lebt, `/api/ping` mit Token ok) → deren Link; sonst `Bun.serve` auf `web.host:web.port` (+`portFallback`), Token (24 Byte, bei `tokenRotate` je Start neu). Link immer `http://host:port/#t=<token>`. `dispose` stoppt.
- **Sicherheit:** Host aus `web.allowedHosts` (DNS-Rebinding), `/api/*` mit Header `x-smith-token` (konstante Vergleichszeit; `web.token: false` schaltet das ab – Flag „ohne Token“ in der UI), POST nur mit eigener `Origin` (CSRF, `checkOrigin`) und JSON bzw. Multipart beim Upload, `maxBodyKB`, `readOnly` (Konfig) bzw. Sitzungs-Sperre → 403. Starker Token (`tasks.requireToken`, `pipeline.requireToken`): `agent.assign/approve/accept` und Pipeline-Änderungen verlangen den Token auch bei `web.token: false` (401 `token-required`). CSP `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; worker-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` (Anhänge zusätzlich `sandbox`, nur Bilder inline), `nosniff`, `no-referrer`. Sicherheitsereignisse gedrosselt ins Audit-Log (`securityLogPerMinute`). Konfiguration an die UI nur über `publicConfig()` (Schlüssel/Passwörter maskiert).
- **Aktionen:** `POST /api/action {action, target, base, args, preview, force}`. `preview` liefert Diff/Folgen ohne Schreiben (Bestätigungsdialog nach `web.confirm`), `base` = gelesene Version → bei Abweichung 409 mit `{changedBy, changedAt, diff}`, `force` nach Bestätigung (428). Antwort `{ok, message, commit, run, undo, open, data}`; Live-Ereignis `run.finished`.
- **KI-Recht** (`fields.ai`): `frei` | `vorschlag` (KI-Änderungen → Staging/Vorschlag mit Diff, abgelehnte werden als Hash gemerkt) | `lesen` (nur `flag`) | `privat` (unsichtbar für Suche/Hinweise/Tools/Embeddings, außer `docs.privateEmbeddings` nur für die Nutzersuche). Durchgesetzt in `Ops` und im Retriever.
- **Live:** `GET /api/live` (SSE über fetch, Token im Header), Ereignisse aus `ctx.bus` (run.finished, commit, task.changed, pipeline.run/log, agent.job/event/tool, inbox.changed, notify); Replay nur bei Reconnect (`Last-Event-ID`).
- **Frontend:** ES-Module ohne Build, Router mit Hash-Routen (deutsch, Aliase für alte Routen), eine View-Datei je Route (dynamischer Import), `ctx.alive()`/`ctx.on()`/`ctx.cleanup()` gegen veraltete Antworten. DOM nur über `h()`/`textContent`; Markdown-Renderer escapt zuerst (Whitelist-Tags, Links nur `http(s)`/intern, Mermaid/hljs nachträglich). Anhänge über Blob-URLs (Token-Header). CodeMirror/highlight.js per dynamischem Import, Mermaid/uPlot lazy per `<script>`. Die Graph-Ansicht `#/graph` (`views/graph.js`) rendert mit **d3-force** und eigenem **SVG** (`#graph-svg`, Klassen `.gnode`/`.gedge`/`.hulls`/`.glabel`): dauerhaft laufende Physik-Simulation (`alphaTarget(0.05)`; > 300 Knoten oder 0 Kanten → `alphaTarget(0)` und Auslaufen), themenbasiertes Clustering über schwache, nicht gerenderte Zusatzkanten aus gemeinsamen Tags, Drag pinnt (`fx`/`fy`, Nachbarn folgen), Loslassen gibt frei, **Alt+Klick pinnt dauerhaft**, Zoom/Pan via `d3-zoom` (`scaleExtent [0.08,3]`).
- **Agenten-Aufträge:** Session mit `directory = Worktree` (eigene Plugin-Instanz!) – darum hält `agent-hub.ts` Guards, Session-Eltern und Listener prozessweit (`globalThis`), `checkTool` läuft in `tool.execute.before` jeder Instanz. Der Hauptsession werden **keine** `tools` beim Prompt übergeben: opencode 1.18 macht daraus Session-Permissions, die für alle späteren Prompts und Subagenten bleiben (ein späteres `allow` würde die Nutzer-Permissions überstimmen). Nur die Review-Session (schreibt nie) bekommt `tools: {write/edit/…: false, bash: false}`.

### Parallelität und Locks

Wie v1: mkdir-Locks (`store`, `git`, `review-<sid>`, `curator`, `lifecycle`, `usage`, `errors`), Run-Claims in `state/runs/` (pid, Pfade) → `ops.awaitClaims` lässt konkurrierende Läufe auf denselben Pfad warten; `git.commitExternal` schließt geclaimte Pfade aus. Mehrere Smith-Läufe einer Session laufen parallel und berühren disjunkte Pfade (andere Arten) – Ausnahme Kandidaten/Einträge derselben Art aus verschiedenen Sessions (Claims).

### Semantische Suche (Embeddings)

- **Optional und fehlertolerant:** Ohne Endpunkt/Modell, bei Timeout oder nach 3 Fehlern (dann 5 min Pause) liefert `Retriever.search` reine BM25-Ergebnisse. Kein Aufrufer darf auf Embeddings angewiesen sein.
- **Konfiguration:** `config`-Hook → `EmbeddingClient.configureFromOpencode(cfg)` (Provider mit „litellm“ im Namen oder einziger Provider mit `baseURL`; Key: Option → Provider-Option → `apiKeyEnv` → `auth.json`). Modell: Option oder `GET /models` (Filter `/embed/i`, Qwen-8B bevorzugt), negatives Ergebnis 5 min gecacht.
- **Ablage (`vector-store.ts`):** `openVectorStore()` öffnet `state/embeddings/vectors.sqlite` über `createRequire(import.meta.url)("bun:sqlite")` (kein Import zur Ladezeit, keine bun-Typen nötig; Apple-SQLite reicht, es wird keine Extension geladen). Tabellen `vectors(space, ns, key, hash, dims, vec BLOB, seq, updated_at)`, `tombstones`, `spaces(last_used)`, `meta(seq, tomb_floor, schema)`; WAL, `synchronous=NORMAL`, `busy_timeout=10s`. Lesen/Suchen aus einem Cache je Namespace (lazy, Snapshot-konsistent in einer Lesetransaktion). Andere Verbindungen werden über `PRAGMA data_version` erkannt und per `seq > cache.seq` (Zeilen + Tombstones) nachgezogen; ausstehende eigene Änderungen haben Vorrang. `flush()`: `BEGIN IMMEDIATE` → erst nachziehen, dann nur geänderte Zeilen schreiben (Upsert bzw. Löschen + Tombstone) mit neuer globaler `seq`. Wartung beim Öffnen: Spaces > 60 Tage ungenutzt löschen, Tombstones > 14 Tage (Caches älter als `tomb_floor` laden neu). Beschädigte Datei → beiseitelegen (`.corrupt-<ts>`), neu aufbauen. Alte Dateien (2.1/2.2) werden einmalig unter Lock `embeddings-migrate` importiert und gelöscht. Fehlt SQLite → `FileVectorStore`. `dispose` → `close()` (flush + schließen).
- **Vektorraum:** `<modell-slug>-<dimensions>`; Wechsel von Modell oder Dimension → neuer Raum, alles wird neu eingebettet. Namespaces: `entry-<kind>`, `cand-<kind>`, `foreign-<hash(directory)>` (Projekt-Skills unterscheiden sich je Projekt), `docs-<hash(docsRoot)>` (Projekt-Doku-Abschnitte), `sessions` (Session-Verlauf), `tags` (Tag-Vokabular). `SemanticIndex.syncCustom(ns, docs)` gleicht beliebige Namespaces per Hash ab (löscht Verwaistes), `scoreCustom()` vergleicht.
- **Texte:** `entryText()` je Art (Glossar: Term, Aliase, Bedeutungen; Fehler: Titel, Signaturen, Kontext, Body; …), Dokumente ohne Anweisung; Anfragen mit `PURPOSE_INSTRUCTIONS[search|hint|error|context]` im Qwen-Format, LRU-Cache (64) für Anfragevektoren.
- **Sync:** beim Start und nach jeder Store-Änderung im Hintergrund (`touch()` bei Suchen, `ensureCurrent()` bei Gates mit max. 5 s Wartezeit); Dokument-Timeout ≥ 60 s.
- **Fusion:** RRF (k = 60) aus BM25-Top-30 und Vektor-Top-50; rein semantische Treffer nur ab `searchMinSimilarity` bzw. `hintMinSimilarity`; `SearchHit.similarity` zusätzlich zur BM25-`confidence`, Anzeige = Maximum.
- **Hinweise:** `chat.message` startet die Berechnung (`hints.start`), `messages.transform` wartet darauf (BM25 sofort, Vektor höchstens `hintWaitMs`) – Ergebnis wird pro messageID gespeichert (Cache-stabil).
- **Gates:** `Ops.setSimilarity()`; Duplikat-Sperre nur für Hintergrund-Agenten (`create`, neues Skript), Befehle sind ausgenommen; Kandidaten-Zuordnung vor der Jaccard-Heuristik.
- **Projekt-Doku:** `ProjectDocs.scan()` höchstens alle 60 s (mtime/size-Cache je Datei, Inhalt redigiert), `syncVectors()` im Hintergrund (Start, nach Suche); `search()` = MiniIndex ∪ Vektoren per RRF. `docs_search` in einem Hintergrund-Lauf hängt die Treffer an `run.haystack` an (zählen als Nachweis).
- **Frühere Sessions:** `HintEngine.select()` nutzt denselben Anfragevektor; Treffer nur mit Links oder gelöstem Problem (`isUseful`), nie die aktuelle Session; semantisch ≥ `sessionHintSimilarity`, sonst BM25 mit ≥ 3 Termen und Abdeckung ≥ 0,75; max. 2.

## 4. Invarianten (Tests schützen die meisten davon)

1. Jede Schreiboperation geht durch `Ops`; neue Tools/Befehle **nie** direkt `store.*` aufrufen (Ausnahme: `markCandidatePromoted` bei `/glossary-ignore` innerhalb eines Befehlslaufs).
2. Gates aus Abschnitt 3 nicht aufweichen; nichts wird geraten (Glossar-Bedeutungen, Wissen).
3. Höchstens ein Commit pro Lauf, nur mit `run.touched`-Pfaden; Betreff `<smith>(<actor>): <aktion> [<art>] <name>; …` (Art entfällt bei Skills, max. 72 Zeichen, „(+N more)“), Body mit `Run:`, `Trigger:`, je Aktion `- …: <grund>`. `/smith-undo` findet Commits aller Smiths über `SMITH_SUBJECT_RE`.
4. `state/` wird nie versioniert.
5. System-Prompt bleibt unverändert; Hinweise nur an Nutzernachrichten/Tool-Ausgaben.
6. Fremde Skills sind read-only; Projektdateien werden nie geschrieben.
7. Nichts mit Geheimnissen wird geschrieben; Transkripte, Doku-Stellen und Änderungen werden vor dem Modell redigiert.
8. Hintergrund-Agenten haben nur Lese-Tools + eigene Smith-Tools (kein bash/edit/write/webfetch).
9. Interne Sessions zählen nie als Nutzeraktivität.
10. Reviews werden nie wegen Limits verworfen; keine Rate-Limits/Mindestabstände einbauen (Nutzerwunsch). Background-Agenten bekommen immer ein explizites Modell, wenn eines bestimmbar ist.
11. Lokale Aktionen (`local: true`) kommen nie in einen Commit; der E2E-Check „jeder Lauf mit Änderungen hat einen Commit“ ignoriert sie.
12. Jede Funktion hat einen Weg ohne Embeddings (Doktor-Kandidaten per BM25, Hinweise, Suche) und ohne SQLite (`ctx.mem` undefiniert → Arbeitsstände/Ergebnisse/Doktor aus, dauerhafte Erinnerungen funktionieren).
13. Erinnerungen verschiedener Projekte werden nie vermischt (Name, Duplikat-Sperre, Doktor-Kandidaten, Hinweise, Merge); `crossProject` öffnet nur Hinweise/Suche.
14. Die Weboberfläche schreibt nur über den Aktionskatalog → `Ops` (dieselben Gates wie Agenten, ein Lauf = höchstens ein Commit, Audit-Ereignis); sie ist lokal (Host-Prüfung, Origin, Token abschaltbar), lädt keine externen Ressourcen, und Agenten-Start/-Freigabe und Pipeline-Befehle brauchen den Token immer (sofern nicht ausdrücklich abgeschaltet).
15. `task` und `project` gehören dem Nutzer (`userOwned`): Agenten können sie nicht anlegen oder ändern; einzige Ausnahme sind Vorschläge von memorysmith (`fields.suggested`, Nutzerzitat als Beleg, max. 2 je Lauf, nur erste Spalte). Ein Agent setzt nie „erledigt“ und mergt nie selbst.
16. Ein KI-Recht `lesen`/`vorschlag`/`privat` wird im Code durchgesetzt, nie nur im Prompt; private Dokumente erreichen kein Modell und keine Embeddings.
17. Metriken enthalten keine Inhalte (keine Nachrichten, Tool-Argumente, Suchanfragen), nur Ids, Zahlen, Zeiten.

## 5. Verifizierte opencode-1.18-Fakten

- Hooks wie v1; `chat.message(input{sessionID, agent, model?{providerID, modelID}, messageID}, output{message, parts})`.
- `tool.execute.after(input{tool, sessionID, callID, args}, output{title, output, metadata})`: Mutation von `output.output` erreicht das Modell (`session/tools.ts`). Shell-Tool `bash`: `metadata.exit`.
- `session.promptAsync` antwortet 204 und forkt; Fehler werden als „prompt_async failed“ geloggt und als `session.error` (sessionID, `NamedError.Unknown` mit `Cause.pretty`) publiziert – es entsteht dann keine Assistant-Nachricht.
- Modellauflösung: `input.model ?? agent.model ?? Modell der letzten Nachricht ?? cfg.model`. Der Task-Tool-Subagent erbt das Modell der Elternnachricht.
- `Session.Event.Error` auch bei `ContextOverflowError` mit anschließender Kompaktierung (Session läuft weiter!).
- SDK v1: `config.providers()` → `{providers: [{id, models: {<id>: …}}], default}`; `session.command({body:{command, arguments, model?}})`.
- Permission: letzter passender Eintrag gewinnt; `"*": "deny"` blendet Tools komplett aus.
- `experimental.session.compacting(input{sessionID}, output{context: string[], prompt?})`: Strings in `context` landen im Kompaktierungs-Prompt (E2E prüft es).
- Task-Tool-Ausgabe: `<task id="<kind-session>" state="completed">\n<task_result>…</task_result>\n</task>`; `metadata.sessionId` = Kind-Session.
- Plugins laufen in Bun: `globalThis.Bun.serve` steht zur Verfügung (Weboberfläche).
- `session.prompt(Async)` mit `tools` (1.18.35): wird zu Session-Permissions `{permission, pattern:"*", action}` und **ersetzt** die bisherigen Session-Permissions dauerhaft; Task-Subagenten erben sie. Ohne `tools` bleibt alles wie es ist – es gibt keinen Weg, die Regeln wieder zu entfernen (PATCH `permission` hängt nur an).
- Eine Session mit `query.directory` = anderes Verzeichnis läuft in einer eigenen Plugin-Instanz (eigener `server()`-Aufruf) im selben Prozess.
- `opencode serve` lädt Plugins **lazy**: der `server`-Hook feuert erst, wenn ein API-Request eintrifft. Ohne Request passiert bei `serve` nichts – auch der Web-Autostart läuft nicht an. Die Standalone-CLI (`bin/skillsmith.ts`) liest die Server-Adresse aus der Ausgabe von `opencode serve` und sendet dann `GET /agent`, um das Plugin zu laden; danach startet die Weboberfläche. `opencode serve` wird mit `--port 0` gestartet (opencode wählt einen freien Port und meldet ihn).

## 6. Portierung auf opencode v2

Neuer Adapter `src/host/v2.ts`; zu prüfen: `cfg.skills` (Array), Agent-/Command-Registrierung, Event-Namen, Message-/Part-Struktur (`transcript.ts`), SDK-Aufrufe (`agent-runner.ts`, `reviewer.ts`). `src/core/**` sollte unverändert bleiben.

## 7. Tests

```bash
cd skillsmith
bun install                                   # nur Entwicklung (Typen, SDK für E2E)
bun test test/unit                            # 167 Unit-Tests (Embeddings mit Fake-Endpunkt, offline)
npx tsc --noEmit                              # strikte Typprüfung
SKILLSMITH_TEST_PYTHON=/pfad/python3.9 bun test test/unit/smiths-flow.test.ts -t toolsmith   # Werkstatt mit Python 3.9
OPENCODE_BIN=$(which opencode) bun test/e2e/run.ts   # E2E (103 Prüfungen, ~7 min)

# Weboberfläche im Browser (Playwright-Core + Chromium):
bun test/web/demo.ts 47555                    # Demo-Store mit Daten, druckt DEMO_URL
DEMO_URL=… PLAYWRIGHT_CORE=… bun test/web/ui-smoke.ts shots   # ~40 Routen hell/dunkel, keine JS-Fehler
DEMO_URL=… PLAYWRIGHT_CORE=… bun test/web/ui-flows.ts shots   # Schreib-Abläufe + Graph-Physik (Dauerlauf, Drag zieht Nachbarn) über die echte UI
tools/vendor/build.sh                         # Vendor-Bibliotheken neu bauen (nur bei Versionswechsel)
```

Phase 4 (Unit): `phase4-actions.test.ts` (Katalog, Speichern mit Basisversion/409, Bestätigungen/428, Undo, Umbenennen mit Link-Nachzug, KI-Recht in Ops/Suche/Hinweisen, Vorschläge, Anhänge, Ordner, Vorlagen, Token-Pflicht, Lese-Sperre, Audit mit Hash-Kette), `phase4-insight.test.ts` (Metriken, Relevanz, Versionen/Diff, Links/Rückverweise, Export), `phase4-work.test.ts` (Aufgaben, WIP, Unteraufgaben, Checklisten, memorysmith-Vorschläge, `/task` `/note`, Pipeline mit JUnit/Schwärzung/Zeitlimit/Warteschlange, kompletter Agenten-Ablauf mit Fake-Client inkl. Guard über Subagenten, Nachbessern, Review, Merge, Regeln; Eingang, Simulator, Landkarte, Graph-Pfad/-Zeitreise).

Unit-Tests: Store/Ops/Gates aller Arten, Frontmatter-Roundtrip, Migration, Suche, Git (Smith-Betreff, Undo), Signale (Fehler-Normalisierung, Ketten, Abkürzungen, Automatisierung, Code-Änderungen, Doku-Scan), Live-Fehlerhinweis, Werkstatt mit echtem Python (Check, Fehlerfälle, Freigabe riskanter Skripte), Agent-Runner (Modell, Config-Fehler, sofortiges Ende bei Fehler), Queue (Config-Fehler nie verworfen), Router, Curator je Art, Lese-Tools (inkl. Listen-Tools), Befehle (Glossar-Import/Export). `rag.test.ts`: MiniIndex/RRF, Markdown-Abschnitte, `docs_search` + docsmith-Kontext (BM25 und semantisch), Nachweis aus `docs_search`, verwandte Einträge/Flag/Doubts, semantische Curator-Cluster und Widerspruchs-Paare, Tag-Varianten/-Plan/-Synonyme/Curator-Vereinheitlichung mit Commit, Session-Verlauf (Merge, Hinweis BM25 und semantisch, `history_search`, `/history`, Aufbewahrung, Datensatz aus `reviewSession`). `vector-store.test.ts`: beide Ablagen (Persistenz, zwei Prozesse, Löschen), SQLite schreibt nur Änderungen, sieht fremde Änderungen ohne Neuöffnen, Migration der Dateien, beschädigte Datenbank, Fallback. `memory.test.ts`: Scope/Remote-Normalisierung, MemoryDb (Stände mit Verlauf, Ergebnisse, Captures, Konflikte, geprüfte Paare), Gates (Vorgabe nur mit Nutzerzitat, Entscheidung vorgeschlagen, kein Nachweis → abgelehnt), gleiches Thema = update, Ablösung, Projekttrennung, lokale Aktionen ohne Commit, Beziehungen (eine pro Paar, symmetrisch, flüchtiges Ende), abgeleitete Kanten, Doktor (Queue, Scan per BM25, Urteile über Tools, erneut geprüft nur bei Änderung, Konflikt → Nutzer → `/smith-doctor resolve`), Stand-Block (einmal, nur Hauptsession, Kürzung), Captures im Review, Lese-Tools, Befehle, Lebenszyklus. `web.test.ts`: Host/Origin/Token/nur GET/CSP/Pfade, Eintrag mit allen Beziehungen beider Richtungen, Graph-Filter, Suche, Start/Stopp mit echtem Server.

E2E (`test/e2e/run.ts`): isoliertes HOME, v1-Store als Ausgangslage, globales `model` absichtlich **nicht existent** (wie im Bug-Report), Sessions nutzen `mock/mock-1`. Prüft u. a.: 11 Agenten, 36 Befehle, Migration + Lebenszyklus mit Commits; Session A → skillsmith und docsmith parallel (Skill, Glossar ZKB, Wissen mit Nachweis, offene Abkürzung XKB, je ein Commit, Modell der Session); Session C → errorsmith (Fehler mit Signatur) und toolsmith (Skript mit echten Tests veröffentlicht); Live-Fehlerhinweis; kombinierte Hinweise; alle Lese-Tools; Subagent-Review; Befehle inkl. Pin/Undo/Curate; sauberer Store. Der Mock bedient auch `/v1/embeddings` (Synonymgruppen → gemeinsame Dimensionen) und listet `qwen3-embedding-8b` unter `/models`: geprüft werden Autoerkennung, Duplikat-Sperre, Hinweis und `skill_search` für eine Umschreibung ohne gemeinsames Wort, Qwen-Anweisung nur bei Anfragen, `/smith-embed eval`; Vektoren in SQLite (alle Namespaces, keine `.f32`-Dateien), Migration alter Vektordateien beim Start, nach dem Neustart in Phase 2 aus SQLite geladen; Projekt-Doku-Abschnitt im docsmith-Job, `docs_search` nach Bedeutung, `/docs-search`; Tag-Variante auf das Vokabular abgebildet; Session-Verlauf (Datensatz, Hinweis „Ähnliche frühere Sessions“ mit Lösung und Eintrag, `history_search`, `/history`). memorysmith/Doktor/Web (Projekt mit Remote `github.com/acme/billing`, Branch `feature/T2-77-login`): „merk dir“ löst sofort aus, Entscheidung und Vorgabe mit Projekt/Branch/Ticket, Arbeitsstand + Beziehung in `memory.sqlite`, Commit ohne lokale Aktionen; Doktor beurteilt das ähnliche Paar Wissen ↔ Entscheidung (eigener Commit, Konflikt gelöst, nur Doktor- und Lese-Tools); Subagent-Antwort aufgefangen und zum Ergebnis verdichtet; Stand-Block in der ersten Nachricht einer neuen Session (nur einmal); `memory_search`/`memory_read`/`graph_neighbors`; Kompaktierung trägt den Stand und plant einen Review; `/remember <text>` ohne neue Nachricht speichert eine Vorgabe; `/memory`, `/resume`, `/smith-doctor`, `/smith-web` (Token, CSP, Eintrag mit allen Beziehungen). Phase 2: Neustart mit unbekanntem `reviewerModel` (und totem Embedding-Endpunkt → Hinweise per BM25 ohne Verzögerung) → Job bleibt mit `lastError` und Retry-Zeit, keine LLM-Anfragen, Bereich bleibt unbewertet. Phase 4 (Abschnitt 7c, über die Web-API mit Token): `doc.create` → genau ein Commit `docsmith(web)` + Audit-Ereignis, veraltete Basisversion → 409 mit Diff, POST ohne Origin → 403; Projekt mit Pipeline und Aufgabe; Agenten-Auftrag (build, Worktree): Subagent versucht im Vorschlag zu schreiben → im ganzen Session-Baum geblockt und als `rejected` auditiert, Vorschlag geparst; Freigabe → Umsetzung im Worktree → Pipeline grün → Review → Karte in „test“; Diff-Daten; Abnahme merged den Branch, Aufgabe erledigt, Worktree entfernt; Agent „hera“ mit Modell ohne Provider (`model: "mock-1"`, wie eine Router-Kombination) plant mit `mock/mock-1` statt „Model not found: mock-1/.“, unbekanntes gewähltes Modell wird vor der Session abgelehnt, Wissens-Chat antwortet. Mock erkennt Hintergrund-Agenten am System-Prompt („You are <smith>-reviewer|curator“) und staffelt Antworten nach Anzahl der Tool-Nachrichten.

## 8. Bekannte Grenzen / Ideen

- Neue aktive Skills erscheinen in opencodes Skill-Liste erst nach Neustart.
- Embeddings optional; alle semantischen Funktionen (Suche, Hinweise, Kandidaten, Duplikate, Fehler, Curator-Cluster, Projekt-Doku, Widerspruchs-Check, Tags, frühere Sessions) haben einen BM25-/lexikalischen Weg.
- Gym (A/B-Prüfung, ob Einträge wirklich helfen): geplant, noch nicht umgesetzt.
- Pipeline und Agenten-Aufträge laufen im opencode-Prozess; ohne laufendes opencode passiert nichts (unterbrochene Läufe werden beim Start markiert). Die Standalone-CLI (`bin/skillsmith.ts`) hält dafür `opencode serve` headless am Laufen – Voraussetzung bleibt ein opencode-Prozess, nur ohne TUI.
- Board-Reihenfolge und Arbeitsstände sind lokal (kein Commit); Kurz-IDs der Aufgaben zählen je Store.
- Arbeitsstände/Ergebnisse sind pro Rechner (state/); Team-Sync wäre ein eigener Schritt.
- macOS-Sandbox nur via `sandbox-exec` (von Apple als veraltet markiert, funktioniert aber); Selbsttest schützt vor stillen Fehlern.
- Ideen: Team-Sync des Stores (pull/push), Projekt-spezifische Stores, v2-Adapter, Synonymlisten für Suche, Skript-Ausführungsstatistik über Exit-Codes.
