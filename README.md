# skillsmith – selbstpflegendes Wissen für opencode

skillsmith ist ein opencode-Plugin mit fünf „Smiths“ und einem „Doktor“, die im Hintergrund aus Ihren Sessions lernen und ihre Ergebnisse in einem gemeinsamen, Git-versionierten Store pflegen:

| Smith | pflegt | Werkzeuge für Ihren Agenten |
|---|---|---|
| **skillsmith** | **Skills** – Vorgehensweisen (wie macht man X richtig in Ihrer Umgebung) | `skill_search`, `skill_list`, `skill_read` |
| **docsmith** | **Wissensdatenbank** (Fakten zu Systemen, Projekten, Daten, Schnittstellen, Konventionen) und **Glossar** (Abkürzung · wörtliche Bedeutung · Kurzbeschreibung); durchsucht außerdem die `.md`-Doku Ihres Projekts | `knowledge_search`, `knowledge_list`, `knowledge_read`, `glossary_lookup`, `glossary_list`, `docs_search` |
| **errorsmith** | **Fehler mit Lösungsweg** – schlägt ein Befehl erneut mit einem bekannten Fehler fehl, hängt skillsmith die Lösung direkt an die Ausgabe | `error_lookup`, `error_list` |
| **toolsmith** | **Python-Skripte** – automatisierbare Lösungswege werden zu getesteten Skripten (Python 3.9, Standardbibliothek) | `script_search`, `script_list`, `script_read` |
| **memorysmith** | **Erinnerungen** an *Ihre* Projekte – Entscheidungen, Vorgaben, Erfahrungen, der Arbeitsstand jedes Branches und Ergebnisse von Subagenten; eine neue Session beginnt mit dem Stand | `memory_search`, `memory_list`, `memory_read` |
| **Doktor** | **Bezüge und Widersprüche** zwischen allen Einträgen – verknüpft Verwandtes (Art, Stärke, Beschreibung), führt Duplikate zusammen, korrigiert klar veraltetes Wissen, legt Ihnen echte Widersprüche vor | `graph_neighbors` |

Die vier ersten Smiths sammeln **allgemeines**, wiederverwendbares Wissen; memorysmith merkt sich das **Spezifische** („in *diesem* Projekt haben wir uns für X entschieden“, „auf Branch T2-77 ist noch offen …“). Alles ist über den Wissensgraphen verbunden.

Seit Version 3 ist die **Weboberfläche** (`/smith-web`) Ihr Arbeitsplatz für Entwicklerwissen:

- **Wissensbasis wie Obsidian** – eigene Dokumente in Ordnern, Markdown-Editor mit Live-Vorschau, `[[Links]]` und Rückverweisen, Vorlagen, Anhänge, Mermaid und Code-Hervorhebung. Je Dokument legen Sie fest, ob die KI es ändern, nur Vorschläge machen, nur lesen oder gar nicht sehen darf.
- **Aufgaben und Kanban-Board** je Projekt, mit Unteraufgaben, Checklisten, WIP-Limits und Drag & Drop.
- **Projekte mit Pipeline** – Prüfbefehle wie `mvn verify` laufen automatisch, wenn eine Karte nach „test“ kommt (grüner Haken / rotes Kreuz, JUnit-Auswertung, Live-Log).
- **Aufgaben an opencode-Agenten übergeben** – erst ein Vorschlag ohne Schreibrechte (auch für Subagenten), dann Ihre Freigabe, Umsetzung im eigenen git-Worktree, Pipeline, Review, Abnahme mit Merge.
- **Eingang „Zu prüfen“, Audit-Log, Versionen mit Diff, Statistik, Hinweis-Simulator, Befehlspalette** – jede Aktion ist ein Commit mit Audit-Eintrag und lässt sich rückgängig machen.

Alle Smiths arbeiten nach demselben Prinzip: Kandidaten (Wiederholungsnachweis), Metadaten (Herkunft, Historie, Nachweise, Tests), Tags/Schlagworte (ein gemeinsames Vokabular), Stufen (`active`/`dormant`/`archive`), Volltextsuche, Hinweise, Feedback, ein Git-Commit pro Lauf und `/smith-undo`. Dazu merkt sich skillsmith jede bewertete Session in Kurzform: Kommt ein Problem wieder, nennt der Hinweis die frühere Session samt Lösung und Einträgen (`history_search`, `/history`).

Steht in LiteLLM ein Embedding-Modell bereit (z. B. Qwen3-Embedding-8B), sucht skillsmith zusätzlich **nach Bedeutung** – automatisch, ohne Konfiguration (siehe [Semantische Suche](#semantische-suche-embeddings)). Ohne Embeddings funktioniert alles weiter mit Volltextsuche (BM25).

Getestet mit **opencode 1.18.19 und 1.18.35** (macOS/Linux). Version 4.0.0-beta.1 (Phase 5, Teil 1: Einstellungen, Log, Jobs, Eingang, Workflow je Spalte). opencode 2 (Vorschau `opencode2`) wird über einen eigenen Adapter unterstützt (siehe unten).

---

## Installation (2 Minuten)

1. ZIP entpacken und den Ordner `skillsmith` nach `~/.config/opencode/plugins/` kopieren:

   ```bash
   mkdir -p ~/.config/opencode/plugins
   unzip skillsmith.zip -d ~/.config/opencode/plugins/
   # Ergebnis: ~/.config/opencode/plugins/skillsmith/index.ts
   ```

2. In `~/.config/opencode/opencode.json` eintragen (Pfad relativ zur Config-Datei):

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": ["./plugins/skillsmith/index.ts"]
   }
   ```

3. opencode neu starten. `/smith-help` zeigt alle Befehle, `/smith-report` den Status.

Es muss nichts installiert werden (kein `npm install`). Für toolsmith wird `python3` gebraucht (macOS: Command Line Tools, Python 3.9 reicht).

### opencode 2 (Vorschau `opencode2`)

skillsmith läuft auch mit opencode 2 (getestet mit `opencode2` 0.0.0-beta-19271, Plugin-API 2.x). Derselbe Ordner, nur der Eintrag in `~/.config/opencode/opencode.json` sieht anders aus – opencode 2 lädt aus dem Ordner selbst `server.ts`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./plugins/skillsmith"]
}
```

mit Optionen:

```json
{ "plugins": [{ "package": "./plugins/skillsmith", "options": { "writeMode": "shadow" } }] }
```

Alles Wesentliche funktioniert wie unter opencode 1: Hintergrund-Reviews aller Smiths und der Doktor (eigene, versteckte Agenten mit nur ihren Werkzeugen), alle Befehle, Lese-Werkzeuge, Hinweise in der Nutzernachricht, Live-Fehlerhinweise an der Shell-Ausgabe, „merk dir“, Subagent-Antworten für memorysmith, Embeddings (Endpunkt aus den Providern der `opencode.json`), Weboberfläche. Unterschiede, weil opencode 2 Plugins das (noch) nicht anbietet:

- Hintergrund-Sessions werden nicht gelöscht (Plugins können Sessions nicht entfernen); sie tragen den Titel „skillsmith-agent · …“.
- Bei der Kompaktierung plant skillsmith den Review wie gewohnt, der Arbeitsstand-Block landet aber nicht in der Zusammenfassung.
- Befehlsausgaben gibt der Agent wieder (wie bei opencode 1), Toasts gibt es nicht.
- Agenten-Aufträge: Freigaben von Rückfragen („Permission“) bitte direkt in opencode beantworten; Session-Diffs und Zurücksetzen kommen aus git.
- Neue Skills sieht opencodes eigene Skill-Liste nach einem Neustart (über `skill_search`/`skill_read` sofort).
- Die eigenständige Anwendung (`skillsmith start`) startet weiterhin `opencode serve` (opencode 1); unter opencode 2 läuft skillsmith im Hintergrunddienst von `opencode2`.

### Update auf Version 3

Ordner ersetzen, opencode neu starten – der Store bleibt, wie er ist. Beim ersten Start übernimmt skillsmith das Lauf-Journal ins neue Audit-Log (`state/audit.sqlite`) und die bisherigen Nutzungszähler als Startwerte der Metriken (`state/metrics.sqlite`). Vorhandene Einträge gelten als „von der KI“ (KI-Recht `frei`); alles, was Sie ab jetzt per Befehl oder in der Weboberfläche anlegen, gehört Ihnen (Standard-KI-Recht `vorschlag`).

3.0.1: Agenten-Aufträge, Assistent und Hintergrund-Agenten kommen mit Modellnamen ohne Provider zurecht (z. B. Router-Kombinationen wie „Hermes“, siehe [Fehlersuche](#fehlersuche)); die Übergabe zeigt die Modelle von opencode zur Auswahl.

Neu in 3.0: die Weboberfläche kann schreiben (abschaltbar mit `"web": { "readOnly": true }`), Aufgaben, Projekte mit Pipeline, Agenten-Aufträge, Audit-Log, Metriken und Statistik, die Befehle `/task`, `/note` und `/doc`.

Von 2.x vor 2.4: Vektoren werden beim ersten Start automatisch in die SQLite-Ablage übernommen; memorysmith, Doktor und Weboberfläche sind sofort aktiv.

### Update von Version 1

- Ordner `~/.config/opencode/plugins/skillsmith` durch den neuen ersetzen, opencode neu starten.
- Der Store wird beim ersten Start automatisch auf das neue Layout migriert (eigener Commit `skillsmith(command): migrate store to v2`). Ihre Skills, Kandidaten und die Historie bleiben erhalten.
- Die Befehle heißen jetzt `/smith-…` (z. B. `/smith-report`, `/smith-undo`, `/smith-curate`). Erhalten bleiben `/skills-search` und `/skills-adopt`.

### Empfohlen für LiteLLM / Firmen-Proxy

Die Hintergrund-Agenten verwenden **automatisch das Modell der bewerteten Session** (das Modell, mit dem Sie gerade arbeiten). Wollen Sie ein festes Modell, setzen Sie es explizit:

```json
{
  "plugin": [
    ["./plugins/skillsmith/index.ts", { "reviewerModel": "litellm/DeepSeek-V41-Flash" }]
  ]
}
```

> **Behoben in Version 2:** In Version 1 fiel der Hintergrund-Agent auf das globale `model` aus `opencode.json` zurück (bei Ihnen `litellm/google/gemma-4-31b-it`, das LiteLLM nicht anbietet) → `ProviderModelNotFound`, 15 Minuten Wartezeit, danach wurde der Review verworfen. Jetzt wird das Modell immer explizit übergeben, ein Fehler beendet das Warten sofort, und Konfigurationsfehler (unbekanntes Modell, Provider, Anmeldung) werden **nicht** verworfen: der Review wird aufgehoben und alle 10 Minuten erneut versucht; ein Toast nennt die Ursache.

### Mit Optionen

```json
{
  "plugin": [
    ["./plugins/skillsmith/index.ts", {
      "reviewThreshold": 5,
      "reviewerModel": "litellm/DeepSeek-V41-Flash",
      "docsmith": { "ignoreAbbreviations": ["PR", "UAT"] },
      "toolsmith": { "allowPipInstall": false }
    }]
  ]
}
```

---

## Wie es funktioniert

```
Ihre Session ──(N Nachrichten / Leerlauf / Subagent fertig / /smith-review)──► Review-Warteschlange
                                                                                │  (persistent, parallel, nie verworfen)
                                                                                ▼
        Transkript (redigiert) + deterministische Signale: Fehlerketten, Abkürzungen,
        Code-Änderungen, Projekt-Doku-Stellen, Automatisierungs-Signale, Feedback
                                                                                ▼
          Router ──► skillsmith ║ docsmith ║ errorsmith ║ toolsmith ║ memorysmith  (-reviewer)
                     (parallel, je ein versteckter Agent mit nur seinen eigenen Werkzeugen)
                                                                                ▼
          geprüfte Operationen (Limits, Nachweise, Duplikate, Geheimnisse, Tests, Freigaben)
                                                                                ▼
          ~/.local/share/skillsmith ──► ein Git-Commit pro Smith-Lauf + Toast
                                                                                ▼
          Doktor: neue/geänderte Einträge mit ähnlichen vergleichen ──► Bezüge, Zusammenführungen,
          Korrekturen (eigener Commit) oder Konflikt für Sie (/smith-doctor, Weboberfläche)
```

### Trigger

| Trigger | Wann | Option |
|---|---|---|
| Schwelle | nach `reviewThreshold` Nutzernachrichten seit dem letzten Review | `reviewThreshold` (5) |
| Leerlauf | Session ruht `idleDelayMin` Minuten und hat ≥ `idleMinNewMessages` neue Nachrichten | `idleReview`, `idleDelayMin`, `idleMinNewMessages` |
| Subagent | ein Subagent (Task-Tool) ist fertig (≥ `subagentMinToolCalls` Tool-Aufrufe oder ein Fehler) | `reviewSubagents` (aus) |
| Manuell | `/smith-review` | – |
| „Merk dir …“ | eine Nachricht enthält „merk dir“, „nicht vergessen“, „remember“ … oder Sie nutzen `/remember` → Review direkt nach der Antwort | – |
| Kompaktierung | opencode fasst die Session zusammen → Review der Session; der Arbeitsstand wird in die Zusammenfassung übernommen | – |
| Nachholen | beim Start für Sessions mit unbewerteten Nachrichten | `catchUpOnStart` |

Es gibt keinen Mindestabstand und kein Tageslimit. Jeder Trigger wird ein Job in einer persistenten Warteschlange; bis zu `reviewConcurrency` Sessions und `agentConcurrency` Hintergrund-Agenten laufen parallel. Ein technischer Fehlschlag wird mit Backoff wiederholt; ein Konfigurationsfehler alle 10 Minuten. Smiths, die einen Bereich schon erfolgreich bewertet haben, laufen beim Wiederholen nicht erneut.

### Router: welcher Smith wann läuft

| Smith | läuft, wenn … |
|---|---|
| skillsmith | Nutzernachrichten oder Tool-Aufrufe vorhanden sind |
| docsmith | Nutzernachrichten vorhanden sind oder Code geändert wurde |
| errorsmith | Fehlerketten (fehlgeschlagener Aufruf …) oder eingefügte Fehlermeldungen vorkommen |
| toolsmith | Automatisierungs-Signale ≥ `toolsmith.minSignalScore` (Inline-Python, lange Pipelines, wiederholte Befehle, Ad-hoc-Skripte), Sie Automatisierung erwähnen („jedes Mal“, „Skript“, „automatisieren“) oder ein vorhandenes Skript benutzt wurde |
| memorysmith | Nutzernachrichten vorhanden sind, ein Subagent ein Ergebnis geliefert hat oder Sie `/remember` benutzt haben (nicht für Subagent-Sessions selbst) |

---

## skillsmith – Skills

Ein Skill ist eine `SKILL.md` (opencode-/agentskills-Format) mit Beschreibung, Tags und den Abschnitten *When to use / Steps / Pitfalls / Verification*. Aktive Skills listet opencode selbst im System-Prompt.

Entscheidungsreihenfolge des Reviewers: bestehenden Skill **patchen** → ruhenden **reaktivieren** → überlappende **zusammenführen** → Muster als **Kandidat** vormerken → **neu anlegen** (nur wenn der Kandidat schon in ≥ `recurrenceMinSessions` Sessions auftrat **oder** Sie es ausdrücklich verlangt haben – Ihr Zitat wird wörtlich geprüft) → nichts tun.

**Skill-Pakete mit Referenzdateien:** Ein Skill darf neben der `SKILL.md` weitere Dateien haben – z. B. `references/styleguide.md`, `references/design-patterns.md`, Beispiele, Vorlagen (bis 3 Ordnerebenen). **Bibliothek → Skills → „Skill hochladen“**: einen Ordner wählen oder hineinziehen, eine `.zip`/`.skill` oder eine einzelne `SKILL.md`. Name und Beschreibung kommen aus dem Frontmatter (`name`, `description`, `tags`); ein bestehender Skill gleichen Namens wird nach Rückfrage **ersetzt** (Dateien, die im neuen Paket fehlen, werden entfernt) – ein Commit, „Rückgängig“ wie immer. Auf der Skill-Seite stehen die Dateien zum Ansehen, „Neue Version hochladen“ ersetzt das Paket. Agenten lesen eine Referenzdatei mit `skill_read(name, file="references/styleguide.md")`; opencodes eigenes `skill`-Tool zeigt den Ordner ohnehin. Angenommen werden Text- (`.md`, `.txt`, `.json`, `.yaml`, `.csv`, Code …) und Bild-/Office-/PDF-Dateien, max. 60 Dateien, 2 MB je Datei, 12 MB gesamt; Geheimnisse werden abgelehnt, versteckte Dateien übersprungen. Weitere Frontmatter-Felder (z. B. `license`, `allowed-tools`) werden nicht übernommen.

**Feedback:** Lädt der Agent einen Skill und danach schlägt ein Befehl fehl oder Sie korrigieren ihn („nein, stattdessen …“), landet das beim nächsten Review direkt beim Skill.

## docsmith – Wissensdatenbank und Glossar

**Wissensdatenbank:** Markdown-Einträge (`knowledge/<stufe>/<name>.md`) mit Titel, Beschreibung, Tags und Text. docsmith schreibt **direkt** (keine Vorschläge) – dafür gilt ein harter Nachweis: Jede inhaltliche Änderung braucht eine Passage, die wörtlich im Transkript (Ihre Nachricht, Tool-Ausgabe) oder in der Projekt-Doku steht. Erfundenes wird abgelehnt.

- Wurde in der Session Code geändert, sucht docsmith die Wissenseinträge zu den geänderten Bezeichnern und aktualisiert veraltete Stellen. Die `.md`-Dateien Ihres Projekts werden dafür **nur gelesen** (als Nachweis); wirken sie veraltet, meldet docsmith das per Toast und in `/smith-report` („Projekt-Doku prüfen“).
- Einträge, die länger als `docsmith.reviewAfterDays` (180) nicht bestätigt wurden, markiert `/knowledge` mit „⚠ zu prüfen“. Wissen wird nie automatisch archiviert.

**Projekt-Doku (RAG):** Die `.md`-Dateien des Projekts (README, `docs/`, ADRs …; ohne `node_modules`, `.git`, Build-Ordner) werden in Abschnitte nach Überschriften zerlegt und indiziert – mit Embeddings nach Bedeutung, sonst per BM25. docsmith bekommt bei jedem Review die Abschnitte, die zu den Code-Änderungen bzw. zum Thema der Session passen, und darf sie als Nachweis zitieren. Ihr Agent und die Hintergrund-Agenten durchsuchen die Doku mit `docs_search` (Ergebnis: `datei:zeile`, Überschrift, Passage), Sie selbst mit `/docs-search`. Geänderte Dateien werden beim nächsten Zugriff neu eingelesen; geschrieben wird dort nie.

**Widerspruchs-Check:** Nach jedem Anlegen oder Ändern eines Wissenseintrags bekommt docsmith die inhaltlich verwandten Einträge gezeigt und prüft sie auf Widersprüche. Ist klar, welche Aussage stimmt, wird mit Nachweis korrigiert; wenn nicht, markiert docsmith den Eintrag (`docsmith_knowledge_flag`) statt zu raten. Markierte Einträge zeigen den Hinweis beim Lesen und in `/knowledge` („⚠ Widerspruch?“); der Curator legt sie zusammen mit verwandten, noch nicht geprüften Eintragspaaren regelmäßig zur Klärung vor. Eine belegte inhaltliche Änderung hebt die Markierung auf.

**Glossar:** ein Eintrag je Abkürzung (`glossary/<stufe>/<abk>.md`) mit einer oder mehreren Bedeutungen: **Abkürzung · wörtliche Bedeutung · Kurzbeschreibung** (+ optional Kontext, Aliase, Tags).

- Abkürzungen werden in Ihren Nachrichten und den Antworten des Agenten erkannt (nicht in Code oder Tool-Ausgaben). Definitionen wie „ZKB (Zentrales Kundenbuch)“, „Zentrales Kundenbuch (ZKB)“, „ZKB steht für …“ werden übernommen.
- **Es wird nie geraten:** Ist die Bedeutung nirgends genannt, wird die Abkürzung als offener Kandidat geführt (`/glossary-open`, mit Anzahl der Sessions) – Sie tragen sie mit `/glossary-add` ein oder blenden sie mit `/glossary-ignore` aus.
- Gängige technische Kürzel (HTTP, JSON, API, SQL …) werden ignoriert, eigene über `docsmith.ignoreAbbreviations`.
- `glossary_lookup` ist eine Volltextsuche über Abkürzung, Bedeutung und Beschreibung; verwendet ein Agent eine bekannte Abkürzung, erklärt der Hinweis sie einmal pro Session.
- Import/Export: `/glossary-import datei.csv|datei.md` (Spalten Abkürzung; Bedeutung; Beschreibung[; Kontext], Trennzeichen `;` `,` oder Tab, oder Markdown-Tabelle), `/glossary-export [ziel.md]`.

## errorsmith – Fehler mit Lösungsweg

skillsmith extrahiert Fehlerketten deterministisch: fehlgeschlagener Aufruf → weitere Versuche → späterer erfolgreicher Aufruf desselben Befehls (gelöst) bzw. Ihre Korrektur. Jeder Fehler bekommt eine **Signatur** (Befehl + normalisierte Fehlermeldung ohne Pfade, Zahlen, Zeitstempel, IDs). Alle Fehler werden mit Häufigkeit und Sessions gezählt (`/errors-top`).

- **Gelöste** Fehler werden mit *Symptom / Ursache / Lösung / Prüfung* dokumentiert, **ungelöste** erst, wenn sie in ≥ `errorsmith.openMinSessions` (2) Sessions auftraten (Status „offen“).
- **Live-Hinweis:** Schlägt ein Shell-Befehl mit einem dokumentierten Fehler fehl (gleiche Signatur oder starker Volltexttreffer), hängt skillsmith Ursache und Lösung als `<known_error>`-Block direkt an die Tool-Ausgabe – der Agent sieht die Lösung sofort. Ob der nächste Versuch klappt, wird gezählt; Einträge, deren Hinweis nicht hilft, legt der Curator zur Überarbeitung vor.
- Triviale Fehler (Tippfehler, Suchen ohne Treffer, `grep` ohne Treffer) werden ignoriert.

## toolsmith – getestete Python-Skripte

Findet toolsmith einen Lösungsweg, der sich lohnend automatisieren lässt (Konvertierung, Auswertung, Prüfung, wiederkehrende Abläufe), baut er ein Skript in einer Werkstatt und veröffentlicht es nur, wenn alle Prüfungen bestehen:

1. Syntax für **Python 3.9** (`toolsmith.pythonTarget`; z. B. kein `match`, kein `X | Y` ohne `from __future__ import annotations`, kein `tomllib`),
2. Importe: Standardbibliothek bevorzugt; fehlende Pakete werden nur mit `toolsmith.allowPipInstall: true` per `pip install --user` nachinstalliert (nicht jedes Paket ist in Ihrer Paketverwaltung verfügbar – daher standardmäßig aus),
3. **Fähigkeiten** (`network`, `subprocess`, `delete`, `filesystem-write`, `env`) werden im Code erkannt und müssen deklariert sein,
4. mindestens `toolsmith.minTests` (3) Unit-Tests (`unittest`), ausgeführt in einem temporären Verzeichnis mit Zeitlimit – auf macOS in einer **Sandbox** (`sandbox-exec`: kein Netzwerk, Schreiben nur im Temp-Verzeichnis), sofern verfügbar,
5. `python3 <skript>.py --help` funktioniert.

Neue Skripte brauchen wie Skills einen Wiederholungsnachweis (Kandidat aus ≥ 2 Sessions) oder Ihren ausdrücklichen Wunsch. Skripte mit `network`, `subprocess` oder `delete` (`toolsmith.requireApprovalFor`) werden **immer zur Freigabe vorgemerkt** (`/smith-pending`, `/smith-approve <id>`); ohne Sandbox werden sie vorher nicht ausgeführt. Bei der Freigabe wird erneut geprüft.

Ablage: `scripts/<stufe>/<name>/` mit `SCRIPT.md` (Zweck, Aufruf, Ein-/Ausgabe, Grenzen), `<modul>.py`, `test_<modul>.py`. `script_read` zeigt dem Agenten den genauen Aufruf. Wöchentlich (und mit `/scripts-test`) werden alle Skripte neu getestet; fehlschlagende repariert der toolsmith-Curator.

---

## memorysmith – Erinnerungen

memorysmith merkt sich, was in **Ihrem Kontext** gilt – projekt-, branch- oder ticketbezogen. Jede Erinnerung gehört zu einem Projekt (erkannt am Git-Remote, z. B. `github.com/acme/billing`, sonst am Verzeichnis), Branch und Ticket (aus dem Branchnamen, Muster `memorysmith.ticketPattern`).

| Art | Beispiel | Lebensdauer | Ablage |
|---|---|---|---|
| **Entscheidung** | „Token im HttpOnly-Cookie statt localStorage – wegen XSS“ (mit Begründung und verworfenen Alternativen) | bis sie abgelöst wird; nach `decisionReviewDays` als „prüfen?“ markiert | Store (Git) |
| **Vorgabe** | „In diesem Projekt kein Lombok“, „Commit-Messages auf Deutsch“ (global nur, wenn Sie es so sagen) | bis Sie sie ändern | Store (Git) |
| **Erfahrung** | „Testsystem T2 verlangt seit Release 4.1 den Header X-T2-Auth“ | Archiv nach `experienceArchiveDays` (180) ohne Nutzung | Store (Git) |
| **Arbeitsstand** | pro Branch: Ziel, erledigt, offen, nächste Schritte, Dateien (frühere Stände bleiben im Verlauf) | verfällt nach `stateDays` (14) ohne Aktivität oder wenn der Branch gelöscht ist | lokal (`state/memory.sqlite`) |
| **Ergebnis** | verdichtete Antwort eines Subagenten oder einer Recherche | gelöscht nach `resultDays` (14), außer es wurde genutzt oder verknüpft | lokal (`state/memory.sqlite`) |

Regeln (fest im Code, nicht nur im Prompt):
- Jede Erinnerung braucht einen **wörtlichen Beleg** aus Ihrer Nachricht, einer Tool-Ausgabe oder einem Subagent-Ergebnis.
- **Vorgaben** nur mit Ihren eigenen Worten. **Entscheidungen**, die Sie nicht selbst getroffen oder bestätigt haben, werden als `vorgeschlagen` gespeichert und so angezeigt.
- Gleiches Thema im selben Projekt = **dieselbe** Erinnerung (wird aktualisiert, nicht dupliziert). Eine neue Entscheidung kann eine alte **ablösen** (Status `abgeloest`, archiviert, Verknüpfung bleibt).
- Ergebnisse fertiger Subagenten (Task-Tool) werden aufgefangen und beim nächsten Review der Session verdichtet.

**Stand zu Sessionbeginn:** Die erste Nachricht einer neuen Session bekommt (einmalig) einen `<smith_memory>`-Block: Arbeitsstand des aktuellen Branches, Vorgaben und gültige Entscheidungen des Projekts (höchstens `standMaxChars`). Passende Erinnerungen erscheinen später wie die anderen Hinweise („Erinnerungen“), zusammen mit stark verknüpften Einträgen („Siehe auch“). Wird die Session kompaktiert, wandert der Stand in die Zusammenfassung.

Für Sie: `/memory [suche]`, `/resume [branch]`, `/remember [text]`, `/forget <id>`. Für den Agenten: `memory_search`, `memory_read` (vollständig mit Verknüpfungen), `graph_neighbors`.

## Doktor – Bezüge und Widersprüche

Nach jeder Änderung (aller Smiths und Befehle) vergleicht der Doktor den Eintrag mit ähnlichen – nach Bedeutung (Embeddings ≥ `embedding.relatedSimilarity`) oder, ohne Embeddings, per Volltext. Jedes neue Paar wird ein **offener Konflikt** mit Verdacht („Duplikat-Verdacht“, „Erinnerung und Wissen zum selben Thema“ …). Der Hintergrund-Agent `smith-doctor` entscheidet pro Paar genau eines:

| Urteil | Wirkung |
|---|---|
| **Bezug** | Verknüpfung mit Art, Stärke (1–5) und einem erklärenden Satz |
| **kein Bezug** | nur ähnliche Wörter – wird gemerkt und nicht erneut vorgelegt |
| **zusammenführen** | Duplikate gleicher Art werden ein Eintrag mit allen noch gültigen Fakten |
| **korrigieren** | ein Eintrag ist klar veraltet → die Stelle wird mit wörtlichem Beleg aus dem anderen ersetzt (`doctor.autoResolve`; nie bei Entscheidungen und Vorgaben) |
| **Konflikt** | unsicher oder es geht um Ihre Entscheidungen/Vorgaben → `/smith-doctor` und die Weboberfläche zeigen ihn Ihnen |

Beziehungsarten: verwandt, ergänzt, Duplikat von, widerspricht, löst ab, setzt voraus, gehört zu, löst (Skript/Erfahrung → Fehler), verursacht durch, abgeleitet aus, nutzt, Beispiel für – und „kein Bezug“. Pro Paar gibt es genau eine Beziehung; ein neues Urteil ersetzt das alte. Ein Paar wird erst wieder geprüft, wenn sich einer der beiden Einträge ändert.

Zusätzlich leitet skillsmith Bezüge aus dem Inhalt ab (ohne LLM, gestrichelt im Graphen): Ein Fehler, dessen Lösung ein Skript aufruft („löst“), ein Eintrag, der einen anderen beim Namen nennt, Zusammenführungen, abgelöste Entscheidungen, Ergebnisse eines Branches, Einträge aus einer Session.

Konflikt selbst entscheiden: `/smith-doctor resolve <id> a|b|beide|kein-bezug` (a = A gilt, B ist veraltet).

## Weboberfläche

`/smith-web` startet die Weboberfläche und gibt einen Link aus (nur `127.0.0.1`, mit Zugangsschlüssel im Link). Sie läuft, solange opencode läuft (`/smith-web stop` beendet sie vorher, `"web": { "autostart": true }` startet sie mit opencode); mehrere opencode-Fenster teilen sich eine Instanz. Alle Bibliotheken (d3-force, CodeMirror 6, uPlot, Mermaid, highlight.js – MIT, BSD bzw. ISC) liegen dem Plugin bei; es wird nichts aus dem Internet geladen.

Links ist die Navigation nach **Bereichen** (Start, Aufgaben, Wissen, Bibliothek, Qualität, Einblick, System) – jeder Bereich lässt sich einklappen, oben auf der Seite stehen die Tabs des Bereichs. **Strg+K** öffnet die Befehlspalette (jede Ansicht, jeder Eintrag, jede Aktion), **n** eine Schnellnotiz, **/** die Suche, **g i / g b / g g / g s** springen zu Eingang, Board, Graph, Statistik.

### Wissensbasis (Dokumente)

- **Ihre Dokumente und das Wissen der KI liegen in derselben Ablage** (`knowledge/<stufe>/<ordner…>/<name>.md`), werden gleich gesucht, verknüpft, versioniert und dem Agenten als Hinweis angeboten – Ihre leicht bevorzugt (`docs.ownBoost`).
- **Ordner** (beliebig tief), **Vorlagen** (How-to, Runbook, Troubleshooting, ADR, Besprechung, Onboarding, Tagesnotiz; eigene Vorlagen im Ordner `_vorlagen`), **Anhänge** (Bilder, PDFs, Logs ≤ `docs.attachmentMaxMB` unter `knowledge/_anhaenge/`, per Knopf, Einfügen oder Ziehen).
- **Editor** (CodeMirror 6): Markdown-Hervorhebung, geteilte Ansicht mit Live-Vorschau (Mermaid-Diagramme, Code-Hervorhebung, Tabellen, Checklisten, Bilder), Gliederung, Suchen/Ersetzen, Strg+S speichern, Strg+L Link. Ungespeicherte Entwürfe hält der Browser. Speichern prüft die Version: Hat inzwischen ein Agent geändert, sehen Sie den Diff und entscheiden (übertragen oder überschreiben).
- **Links:** `[[name]]` oder `[[Titel]]`, `[[name|Text]]`, `[[name#Abschnitt]]`, `[[skill:…]]`, `[[task:T-12]]`; Kurz-IDs wie `T-12` und Ticketnummern wie `T2-123` werden automatisch verlinkt, `#tag` im Text ist ein Tag. Beim Tippen von `[[` schlägt der Editor Ziele vor – auch „als neues Dokument anlegen“. Jeder Link ist eine Kante „verweist auf“ im Graph; die Gegenseite zeigt „Verlinkt von“ und „Erwähnt ohne Link“ (mit Knopf „verlinken“). Umbenennen zieht alle Links im Store nach.
- **KI-Recht je Eintrag** (auch je Ordner als Standard): `frei` – die KI darf ändern; `vorschlag` (Standard für Ihre Dokumente) – Änderungen der KI kommen als Diff in Ihren Eingang, Sie übernehmen, passen an oder lehnen ab (abgelehnte wiederholt sie nicht); `lesen` – die KI darf nichts ändern, nur einen Hinweis „möglicherweise veraltet“ hinterlassen; `privat` – das Dokument existiert für die KI nicht (keine Suche, keine Hinweise, keine Embeddings). Durchgesetzt im Code, nicht im Prompt.
- **Tagesnotiz** (`journal/JJJJ-MM-TT`, vorbefüllt mit Sessions, Arbeitsständen, gelösten Fehlern, Entscheidungen und Commits) mit **Standup-Entwurf** zum Kopieren; **Schnellnotiz** (`/note` oder Knopf) ins Dokument „Eingang“; **aus Session dokumentieren** (`/doc` oder Knopf auf der Session-Seite): docsmith schreibt einen Entwurf, der Ihr Dokument wird.
- **Wissens-Chat:** eine Frage stellen, eine nur lesende Session antwortet mit `[[Links]]` auf ihre Quellen; gute Antworten als Dokument oder Ergebnis speichern.

### Aufgaben, Projekte, Pipeline

- **Aufgaben** sind Einträge im Store (`tasks/`, Kurz-IDs `T-1, T-2, …` über alle Projekte), mit Versionen, Suche, Links, Audit-Log. Das **Board** zeigt sie in Spalten (`tasks.columns`), je Projekt oder alle zusammen: Karten ziehen oder mit der Tastatur verschieben (Karte fokussieren, Leertaste, Pfeiltasten, Leertaste); der Spaltenwechsel ist ein Commit, die Reihenfolge in der Spalte bleibt lokal. WIP-Limits und „erledigt“ trotz offener Unteraufgaben oder roter Pipeline brauchen eine Bestätigung.
- **Unteraufgaben** (zwei Ebenen, `tasks.maxDepth`), **Checklisten** im Text (ein Punkt wird per Klick zur Unteraufgabe), **Anhänge** an Aufgaben (Knopf oder auf die Beschreibung ziehen – sie werden im Text verlinkt), Felder für Priorität, Fälligkeit, Labels, Branch, Ticket.
- **Lose Punkte:** Checkboxen `- [ ]` aus Ihren Dokumenten und offene Punkte der Arbeitsstände erscheinen unter dem Board und werden per Klick zur Aufgabe oder abgehakt.
- **memorysmith schlägt Aufgaben vor**, wenn Sie im Gespräch etwas vertagen („das machen wir später“) – gestrichelt in der ersten Spalte, einplanen können nur Sie (`memorysmith.proposeTasks`).
- **Projekte** bündeln ein Board, ein Verzeichnis (`home_path`) und eine **Pipeline** aus Prüfbefehlen, zum Beispiel:

  ```json
  { "trigger": ["test"], "source": "arbeitsverzeichnis",
    "stages": [ { "name": "build",  "run": "mvn -B -q -DskipTests package" },
                { "name": "verify", "run": "mvn -B verify", "timeout": "20m", "reports": "target/surefire-reports/*.xml" },
                { "name": "lint",   "run": "mvn -B checkstyle:check", "allowFailure": true } ] }
  ```

  Kommt eine Karte nach „test“, laufen die Stufen der Reihe nach in Ihrer Login-Shell (mit `JAVA_HOME`, `~/.m2` …), nach der ersten roten wird abgebrochen. Die Karte zeigt Haken, Kreuz oder „läuft“ und die Stufen; JUnit-Berichte (Surefire, Failsafe, Gradle, Jest) werden ausgewertet; das Log ist live mitlesbar und geschwärzt. Höchstens ein Lauf je Projekt und `pipeline.maxParallel` insgesamt. Pipeline-Befehle ändern braucht immer den Zugangsschlüssel und zeigt vorher die Änderung (`pipeline.requireToken`). `source: "branch"` prüft einen sauberen Checkout des Branches in einem eigenen Worktree; `pipeline.sandbox: true` nutzt auf macOS `sandbox-exec`.

### Aufgaben an Agenten übergeben – Workflow je Spalte

Das Board hat in Version 4 die Spalten **neu · planung · umsetzung · test · verifikation · erledigt** (alte Boards werden beim Start umgestellt: eingeplant → planung, in_umsetzung → umsetzung, review → verifikation). Jede Spalte kann einen **Schritt mit eigenem Agenten** haben; die Karte wandert von selbst weiter:

| Spalte | Schritt | Agent darf | geht weiter, wenn … | bei Fehler |
|---|---|---|---|---|
| planung | Plan, Akzeptanzkriterien, Testfälle | nur lesen (auch Subagenten) | Sie den Plan freigeben (**Tor 1**) | – |
| umsetzung | Code ändern | schreiben (nur diese Session) | die Pipeline grün ist (rot → bis `tasks.autoFixRounds` selbst nachbessern) | zurück in die Umsetzung |
| test | Testfälle ausführen: *Befehl* (Pipeline-Lauf), *Test-Agent* (frische Session ohne Schreibrechte), *von Hand* (Sie tragen das Ergebnis ein) | Befehle, kein Schreiben | alle Testfälle bestanden | zurück in die Umsetzung |
| verifikation | jedes Kriterium mit Beleg aus Diff und Testprotokoll prüfen, Review | nur lesen | alle Kriterien erfüllt – dann wartet die Karte auf **Ihre Abnahme (Tor 2)** | zurück in die Umsetzung |

- **Kriterien und Testfälle** sind Felder der Aufgabe (Tab „Kriterien & Tests“, versioniert): der Planer schlägt sie vor, Sie bearbeiten und bestätigen sie bei der Freigabe oder jederzeit in der Aufgabe. Dort tragen Sie Ergebnisse von Hand ein oder starten die Befehls-Tests.
- Nach **`tasks.maxLoops`** Rücksprüngen (Standard 3) **hält der Auftrag an** (Eingang, Benachrichtigung): eine weitere Runde mit Ihrem Hinweis, nachbessern, trotzdem abnehmen oder verwerfen.
- **Agent je Spalte** und die Regeln stellen Sie in den Einstellungen (`tasks.flow`) oder je Projekt („Projekt bearbeiten → Workflow“) ein: Schritt, Agent, Prüfungen (Pipeline, Testfälle, Kriterien, Review), Tor, Folgespalte, Rücksprungspalte. Planung und Umsetzung desselben Agenten laufen in einer Session (Kontext bleibt), Test und Verifikation schauen mit frischen Augen.
- **Karte ziehen startet den Schritt** der Zielspalte (`tasks.autoStart`, braucht den Zugangsschlüssel); „erledigt“ setzen und mergen nur Sie.
- **Agenten verwalten** (Aufgaben → Agenten): Agenten sind Einträge im Store mit Versionen und Diff. „Aus opencode übernehmen“ legt Ihre bestehenden Agenten als erste Version an; skillsmith trägt sie beim Start in opencode ein (wirkt nach einem Neustart). Der Job **„Agenten verbessern“** wertet Rücksprünge, Überarbeitungen, Befunde und Ihre Korrekturen aus und schlägt Prompt-Änderungen als Diff mit Begründung vor – übernommen wird nur, was Sie freigeben. Die Auswertung zeigt je Agent **und Version**: Plan beim ersten Mal frei, Rücksprünge, angehalten, Pipeline beim ersten Mal grün, Kosten.

Die Live-Ansicht des Auftrags zeigt die Spalten mit Position und Rücksprüngen, den Verlauf der Schritte, den Baum aus Agent und Subagenten mit Status, Tokens und Kosten, jede Session mit Nachrichten und Werkzeugaufrufen, die Testdurchführung und den Verifikationsbericht. Rückfragen von opencode beantworten Sie in der Weboberfläche oder im Terminal. Agenten-Aufträge laufen nur, solange opencode läuft.

### Einstellungen, Log und Jobs

- **Einstellungen** (System → Einstellungen): jede Option als Formular, gruppiert, mit Beschreibung, Standardwert und **Quelle** (Standard, opencode.json, Einstellungen, Umgebung). Was Sie hier speichern, liegt versioniert in `settings.json` im Store und gewinnt über opencode.json (Umgebungsvariablen gewinnen über alles). Sicherheitsrelevante Werte (Token, Lese-Sperre, Pipeline …) brauchen eine Bestätigung und den Zugangsschlüssel; Werte, die einen Neustart brauchen, sind markiert.
- **Log** (Einblick → Log): strukturiert (`state/log/JJJJ-MM-TT.jsonl`), filterbar nach Stufe, Bereich, Lauf, Job, Session; live mitlesen, nach Lauf gruppieren. Stufe je Bereich einstellbar (`log.level`, `log.areas`), Aufbewahrung `log.days`/`log.maxMB`.
- **Jobs** (System → Jobs): alles, was im Hintergrund regelmäßig läuft (Lebenszyklus, Konsolidierung, Skript-Retests, Doktor, Embeddings, Vorab-Pläne, Agenten verbessern, Aufräumen) mit Zeitplan (Uhrzeit, Wochentage, Intervall, bei Leerlauf, Cron, nach Reviews), Verlauf mit Log-Link, von Hand starten, pausieren, abbrechen. Verpasste Läufe werden einmal nachgeholt (`catchUp`).

### Code-Anker, Herkunft und Qualität

- **Code-Anker:** `[[code:src/main/java/…/TokenStore.java]]`, `[[code:TokenStore]]`, `[[code:TokenStore#revoke]]` oder `[[code:Datei.ts#L40-L58]]` im Text binden Wissen an Code. Beim Speichern löst skillsmith den Anker im `home_path` der Projekte (bzw. im aktuellen Projekt) auf und merkt sich Pfad, Signatur, einen Hash des Codes und den Commit. Der Job „Code-Anker prüfen“ schaut nach neuen Commits nach: unverändert, geändert, verschoben (git-Umbenennung) oder gelöscht. Betroffene Einträge stehen im Eingang unter **Code geändert** mit dem Code-Diff – „Passt noch“ übernimmt den neuen Stand, „Vom Agenten beheben lassen“ macht einen Vorschlag mit Diff (das KI-Recht des Dokuments gilt). **Qualität → Wissen zum Code** zeigt alles Wissen zu einer Datei; im Graph sind Code-Dateien eigene Knoten. Auflösung per Muster für Java, Kotlin und TypeScript/JavaScript; genauer über das IntelliJ-Plugin.
- **Herkunft je Absatz:** Jeder Absatz trägt seine Quellen (Session mit Zitat, Commit, Ticket, Code-Anker, Datei, Review-Kommentar, Ihre Eingabe …) in den Metadaten; der Text bleibt sauberes Markdown. Der Tab **Herkunft** markiert jeden Absatz am Rand (belegt, unbelegt, Quelle veraltet), zeigt das Zitat beim Überfahren und filtert unbelegte Absätze; eine Quelle lässt sich von Hand angeben. Die Smiths liefern Belege je Absatz (`provenance.perParagraph`: aus, warnen, pflicht); ältere Belege zählen nur dort, wo ihr Zitat im Absatz steht.
- **Qualitätswert 0–100** je Eintrag mit Begründung: belegte Absätze, Alter der Belege, Trefferquote der Hinweise, offene Zweifel und Konflikte, intakte Code-Anker, Gym-Urteil (Gewichte unter `quality.weights`). Sichtbar in Listen und im Eintrag; Hinweise bevorzugen gute Einträge, schwache kommen in den Eingang („Qualität prüfen“).
- **Kreuzprüfung:** Mit einem Prüfmodell (`crosscheck.model`, ein anderes als das der Smiths) prüft ein zweites Modell jeden von der KI geänderten Absatz gegen seine Quelle: gestützt → geschrieben, nicht gestützt → Vorschlag mit Begründung, widersprochen → abgelehnt (Audit). Ohne Prüfmodell ist die Kreuzprüfung aus.
- **Gym** (Qualität → Gym): Hilft ein Eintrag wirklich? Dieselbe Aufgabe ohne und mit Eintrag, mehrere Läufe je Arm (gleiches Modell, `build`-Agent, MCP/Web/Subagenten aus), nur deterministisch prüfbar (Antwort enthält, Reihenfolge, Befehl ausgeführt, Exit 0, Ausgabe gleich). Aufgaben legen Sie an oder lassen sie aus früheren Sessions vorschlagen; die Aufgabe darf die Lösung nicht verraten. Urteil hilft / neutral / schadet / ungenutzt fließt in den Qualitätswert; Folgen anfangs nur als Bericht (`gym.consequence`).

### Review-Wissen aus GitHub

Unter **Qualität → Review-Wissen** und als Job: Review-Kommentare neuer PRs der Repositories in `reviews.repos` (über `gh`, sonst Ihr GitHub-MCP in einer nur lesenden Session) werden gebündelt; ab 3 ähnlichen Kommentaren von 2 Personen entsteht ein Kandidat. Bestätigt wird er zur **Vorgabe** (Projekt oder Team) oder zum Skill – die Kommentare hängen als Herkunft daran; abgelehnte kommen nicht wieder. Die **Vor-PR-Prüfung** vergleicht den Diff Ihres Branches mit den Vorgaben (Befunde an Datei und Zeile): als `/smith-pr-check`, `smith pr-check` und als Prüfschritt `pr-check` einer Board-Spalte. Namen erscheinen nur als Quelle, es gibt keine Auswertung je Person.

### Dokument-Import

**Wissen → Import:** PDF, Word (DOCX, ältere DOC auf macOS), PowerPoint, Markdown und Text per Klick oder Drag & Drop. Der Text wird lokal gelesen (PDF mit dem mitgelieferten pdf.js im Browser), links erscheinen die Seiten, rechts die Funde live: Wissen (Ordner `import/<Datei>`), Glossar- und Runbook-Kandidaten, Vorgaben, Entscheidungen (vorgeschlagen), Aufgaben-Vorschläge. Jeder Fund trägt Datei, Seite/Folie und das wörtliche Zitat – ein Zitat, das nicht in der Datei steht, verwirft skillsmith. Funde übernehmen, bearbeiten, mit einem Eintrag zusammenführen („ergänzt Eintrag X“) oder verwerfen; **Übernehmen** schreibt alles in einem Commit, das Original liegt als Anhang daneben (bis `import.storeMaxMB`). KI-Recht je Import (Standard „vorschlag“). Gescannte PDFs ohne Textebene werden gemeldet (keine Texterkennung).

### Office-Dokumente (PowerPoint, Word)

**Wissen → Office:** `.pptx` und `.docx` hochladen (Klick oder Drag & Drop), neu anlegen oder von der KI erstellen lassen. Der Text der Datei wird gelesen und steht im Eintrag (`office:<name>`): **Suche, Embeddings, [[Links]], Verknüpfungen und Graph** funktionieren wie bei jedem Dokument. Die Datei selbst liegt im Git-Store; jede Änderung ist eine **Version**: ansehen, herunterladen, wiederherstellen.

- **Vorschau und selbst bearbeiten** im Browser (PowerPoint mit Menüband, Folien, Notizen; Word mit Formatvorlagen, Listen, Tabellen) – „Als neue Version speichern“ schreibt die Datei in einem Commit. Der Word-Editor ist noch jung: Inhalte, die er nicht kennt, können beim Speichern aus dem Editor verloren gehen – im Zweifel herunterladen und in Word bearbeiten, dann wieder hochladen.
- **Mit der KI bearbeiten:** ein Prompt wie „Erstelle bitte ein Deckblatt“. Die KI plant die Änderungen (neue Folien mit Layout, Texte, Aufzählungen, Tabellen, Notizen, Absätze mit Formatvorlagen, Seitenumbrüche, Ersetzen …), skillsmith führt sie **Schritt für Schritt** an einem Entwurf aus – die Vorschau aktualisiert sich live. Weitere Prompts ändern denselben Entwurf; **Übernehmen** macht daraus eine neue Version (ein Commit), **Verwerfen** lässt die Datei unverändert. Inhalt darf die KI mit den Lesewerkzeugen aus der Wissensbasis holen. KI-Recht „lesen“ oder „privat“ schließt die KI-Bearbeitung aus.
- **Neu anlegen:** „Neue Präsentation“ / „Neues Word-Dokument“ – leer oder **aus einer Vorlage**, optional gleich mit einem Prompt, der den Inhalt erstellt.
- **Vorlagen:** eine `.potx` (PowerPoint) bzw. `.dotx` (Word) hochladen – Folienmaster, Layouts und Design bzw. Formatvorlagen werden für neue Dokumente übernommen; neue Folien der KI füllen die Platzhalter der Layouts, damit das Design stimmt. „Als Vorlage“ macht aus einem vorhandenen Dokument eine Vorlage.
- **Skills der Office-Agenten:** Unten auf der Office-Seite wählen Sie je Agent (PowerPoint, Word) die Skills aus, z. B. Ihren Präsentations-Skill mit Styleguide und Design-Patterns. Diese Skills werden bei **jeder** KI-Bearbeitung **vollständig und verbindlich** in den Auftrag geladen – `SKILL.md` und alle Text-Referenzdateien, nicht nur die Beschreibung; der Agent muss sie nicht erst selbst anfordern. Bei Widerspruch gilt Ihr Prompt. Das KI-Panel zeigt die hinterlegten Skills, jeder Schritt im Verlauf, mit welchen Skills er geplant wurde. Optionen `office.skills.pptx` / `office.skills.docx` (Namen), `office.skillMaxChars` (Obergrenze des geladenen Texts, 150 000 Zeichen – darüber wird gekürzt und gewarnt). Private Skills (KI-Recht „privat“) werden nie geladen.
- Optionen: `office.maxMB` (größte Datei, 50), `office.aiEdit` (KI-Bearbeitung an/aus), `office.defaultAi` (KI-Recht neuer Office-Dokumente, „frei“). Makro-Dateien (`.pptm`, `.docm`) und alte Binärformate (`.ppt`, `.doc`) werden nicht angenommen.

### Bibliothek: Skripte, Snippets, Prompts

- **Skripte** gibt es jetzt auch in **TypeScript** (node ≥ 22.18, sonst das Bun in opencode) – gleiche Prüfung, Sandbox und Freigabe wie Python. Neue Skripte haben einen einheitlichen Aufruf **`call_script(name, params)`**: Parameter und Ergebnis als JSON-Schema in `SCRIPT.md`, JSON auf stdin, Hülle `{ok, data, error}` auf stdout. Agenten nutzen das Werkzeug `call_script`, in der Weboberfläche „Ausführen“ (Formular aus dem Schema), im Terminal `smith run`.
- **Snippets** (Bibliothek → Snippets): Code mit Platzhaltern `${name}` / `${name:standard}`, ausfüllen und kopieren, `smith snippet <name>`, Export als IntelliJ-Live-Templates; erscheinen in den Hinweisen. Derselbe Code in mehreren Sessions wird als Snippet vorgeschlagen.
- **Prompts** (Bibliothek → Prompts): Text mit `{{ticket}}`, `{{branch}}`, `{{auswahl}}` …; in opencode **`/prompt <name> [var=wert …] [text]`** (ein Befehl, neue Prompts ohne Neustart), Variablen aus dem Kontext. Nutzung und Bewertung je Fassung; der Job „Prompts verbessern“ schlägt Diffs vor. `{{prompt:name}}` bindet einen Prompt in Agenten-Prompts ein.

### Eingang: Meldungen abstellen

Jede Meldungsart im Eingang lässt sich **direkt im Eingang** einstellen (Menü an der Gruppe oder „Einstellen“): **anzeigen**, **bündeln** (eine Zeile je Gruppe, Standard für KI-Änderungen) oder **ausblenden**; KI-Änderungen auch je Smith. Einzelne Meldungen lassen sich wegklicken – sie kommen erst wieder, wenn sich der Inhalt ändert. Im selben Dialog stellen Sie die Benachrichtigungen (Toast, Browser, macOS) je Ereignis ein. Der Zähler in der Navigation zählt gebündelte Gruppen einmal.

### Einblick

- **Eingang „Zu prüfen“** – was die KI seit Ihrem letzten Besuch geändert hat (mit Diff, 👍/👎, Rückgängig), Vorschläge für Ihre Dokumente, Konflikte, unbestätigte Entscheidungen, fällige Prüfungen, Agenten, rote Pipelines, Aufgaben-Vorschläge, Regeln aus Korrekturen, defekte Links, Aufräum-Kandidaten – jeweils mit der Aktion daneben.
- **Eintrag** mit Tabs **Inhalt**, **Verknüpfungen** (anlegen, ändern, umkehren, löschen, abgeleitete bestätigen), **Versionen** (jeder Commit mit Diff – Felder, Inhalt mit Wortmarkierung untereinander oder nebeneinander, Metadaten in Worten; zwei Versionen vergleichen; eine alte wiederherstellen), **Audit** und **Nutzung** (Balken je Tag, Erfolgskennzahl, letzte Nutzungen, Relevanz-Kurve). Dazu Umbenennen, Verschieben, Umwandeln (Wissen ↔ Erfahrung), Zusammenführen, Anpinnen, Archivieren, endgültig löschen (nur archiviert, mit eingetipptem Namen).
- **Graph** – Knotengröße nach **Relevanz** (Nutzung 50 % mit Halbwertszeit, Vernetzung per PageRank 35 %, Bedeutung 15 %, je Art eingeordnet), Ring für den Zustand (grün: Hinweise wirken, orange: fehleranfällig, rot: Konflikt), doppelter Rand für Ihre Dokumente. Die Ansicht ist eine **durchgehend laufende Physik-Simulation** (d3-force, eigenes SVG): Knoten stoßen sich ab, Kanten ziehen an, ähnliche Themen sammeln sich. **Ziehen** eines Knotens bewegt die verbundenen Nachbarn mit, Loslassen gibt ihn wieder frei, **Alt+Klick** pinnt ihn dauerhaft. Pfad zwischen zwei Knoten, Fokus, Gruppierung nach Tag/Projekt/Art, **Zeitreise** (Graph zu einem Datum aus Git), gespeicherte Ansichten, PNG-Export, Verknüpfen per Ziehen eines Knotens auf einen anderen.
- **Semantische Landkarte** – 2D-Projektion aller Einträge (Embeddings, sonst Begriffe): Themeninseln, mögliche Duplikate, Lücken.
- **Statistik** – Überblick (Kennzahlen mit Vorzeitraum, Aktivitätskalender), Wissen (meistgenutzt, Aufsteiger/Absteiger, ungenutzt, Wachstum), Hinweise (Trefferquote je Art, BM25/semantisch, Wartezeit), Fehler, Smiths und Kosten, Tools und MCPs (Aufrufe, Fehlerquote, Median und langsamste 5 % – auch Ihre eigenen MCPs), Tageszeiten-Heatmap, Aufgaben (Durchlaufzeit, Durchsatz, Flussdiagramm), Pipeline (Grün-Quote, Dauer je Stufe, instabile Tests), Agenten (Freigabequote, Nachbesserungen, Pipeline beim ersten Mal grün, Kosten). Zeitraum 7–365 Tage, Klick auf einen Tag zeigt die Ereignisse, jedes Diagramm als CSV.
- **Audit-Log** – jedes Ereignis, das etwas geändert hat oder ändern wollte (Sie, Agenten, Curator, Doktor, System), mit Grund, Ergebnis, Commit, Lauf und Session; Filter, Gruppierung nach Lauf, Export als CSV/JSONL, Hash-Kette („Kette intakt“) und abgelehnte Agent-Aktionen nach Grund.
- **Versionen** (Store-Historie, Commit-Seite mit „Lauf rückgängig“), **Konflikte** (A gilt, B gilt, beide, kein Bezug, Korrektur, Zusammenführen), **Freigaben** (vorgemerkte Änderungen), **Hinweis-Simulator** (genau der Hinweis-Block zu einer Nachricht, Werte je Kandidat, warum (nicht) gezeigt, Schwellen probeweise verschieben), **Ticket-, Session- und Projektseiten**, **Glossar-Tabelle** (inline bearbeiten, CSV/Markdown importieren und exportieren), **Tags** (umbenennen, zusammenführen), **Skript-Werkstatt** (Code und Tests bearbeiten, prüfen, veröffentlichen), **Kandidaten**, **statischer Export** (HTML inkl. einer Datei `alles.html`, oder Markdown).

### Sicherheit beim Schreiben

Jede Aktion läuft durch dieselben Prüfungen wie bei den Agenten (Validierung, Geheimnis-Scan, Versionsprüfung), ist **ein Lauf mit höchstens einem Commit** (`<smith>(web): …`) und steht im Audit-Log; „Rückgängig“ nimmt den Lauf per `git revert` zurück. Lokale Daten (Arbeitsstände, Läufe, Reihenfolge) bekommen keinen Commit, aber ein Vorher/Nachher im Audit-Log. Der Server nimmt nur `127.0.0.1` und `localhost` als Host an (DNS-Rebinding), verlangt den Schlüssel im Header, bei Schreibzugriffen die eigene Herkunft (CSRF) und JSON, lädt nichts von außen (strenge Content-Security-Policy). Jeder Wert ist eine Option; die Schlüsselpflicht lässt sich mit `"web": { "token": false }` abschalten – dann kann jeder Prozess auf diesem Rechner lesen und schreiben, die Oberfläche zeigt „ohne Token“; Agenten starten/freigeben und Pipeline-Befehle ändern verlangen den Schlüssel trotzdem (`tasks.requireToken`, `pipeline.requireToken`). „Schreiben sperren“ in den Einstellungen sperrt bis zum Neustart, `web.readOnly` dauerhaft.

## smith – skillsmith im Terminal

`smith` erreicht skillsmith aus jedem Terminal, ohne opencode zu öffnen, und ohne zusätzliche Installation:

```bash
alias smith='BUN_BE_BUN=1 opencode ~/.config/opencode/plugins/skillsmith/bin/smith.ts'
# oder mit node ≥ 22.18:
alias smith='node ~/.config/opencode/plugins/skillsmith/bin/smith'
```

| Befehl | Wirkung |
|---|---|
| `smith ask "…"` | Frage an den Wissens-Chat, Antwort mit Quellen |
| `smith note "…"` | Schnellnotiz mit Verzeichnis, Projekt und Branch |
| `smith task neu "…"` / `smith task T-12 [spalte]` | Aufgabe anlegen / anzeigen bzw. verschieben |
| `smith find "…"` | Suche über alle Arten |
| `smith run <skript> --param k=v` | Skript über `call_script` |
| `smith snippet <name> k=v` | Snippet ausgefüllt in die Zwischenablage |
| `smith prompt <name> k=v [text]` | Prompt ausführen (`--copy`: nur ausfüllen) |
| `smith import <datei>` | Datei an die Import-Seite übergeben |
| `smith pr-check [basis]` | Vor-PR-Prüfung des aktuellen Branches |
| `smith status` | wartende Freigaben, laufende Agenten, rote Pipelines, Jobs |

Die CLI spricht die laufende Instanz über die Web-API an (Token aus `state/web.json`, nur für Ihren Benutzer lesbar). Läuft keine Instanz, öffnet sie den Store direkt für Notizen, Aufgaben und Suche (mit dem Bun aus opencode); `ask`, `prompt` und `pr-check` brauchen ein laufendes opencode. `--json` liefert maschinenlesbare Ausgabe, z. B. für einen macOS-Kurzbefehl mit Tastenkürzel („Shell-Skript ausführen“ → `smith note "$(pbpaste)"`).

## IntelliJ-Plugin

Quellen unter `integrations/intellij` (Bauen und Installieren: dortige README): Randsymbole an Klassen und Methoden mit verankertem Wissen, Werkzeugfenster mit Aufgaben des Branches, Aufträgen und Freigaben, Kontextmenü „Als Wissen speichern“, „Code-Anker kopieren“, „Snippet einfügen“, Fehler aus der Run-Konsole an errorsmith.

## Eigenständige Anwendung (CLI)

skillsmith ist weiterhin ein opencode-Plugin, lässt sich aber auch als **eigenständige Anwendung** starten – ohne dass ein opencode-Fenster offen bleiben muss. Die CLI startet im Hintergrund `opencode serve` (headless, ohne TUI); darin läuft der skillsmith-Server-Hook, also Weboberfläche, Hintergrund-Reviewer, Curator, Doktor und Pipeline. Der Arbeitsplatz unter `/smith-web` bleibt zusätzlich innerhalb einer normalen opencode-TUI verfügbar und unverändert.

> **Hinweis zum Laden:** `opencode serve` lädt Plugins **lazy** – der Server-Hook feuert erst, wenn ein API-Request eintrifft. Die CLI liest deshalb die Server-Adresse aus der Ausgabe von `opencode serve` und sendet dann einen Request (`GET /agent`), um das Plugin zu laden; erst danach startet die Weboberfläche.

### Voraussetzungen

- Node **≥ 22.6** (native TypeScript-Typentfernung) – es werden keine npm-Abhängigkeiten installiert.
- `opencode` im `PATH` (oder `--opencode <bin>` / `SKILLSMITH_OPENCODE_BIN`).

### Installation

Die CLI ist eine ausführbare Datei `bin/skillsmith`. Am einfachsten als Symlink in ein `PATH`-Verzeichnis legen:

```bash
ln -sf <repo>/bin/skillsmith ~/Tools/skillsmith
# oder:
npm link
```

Danach genügt `skillsmith <befehl>`.

### Befehle

| Befehl | Zweck |
|---|---|
| `skillsmith run` | im Vordergrund starten (Strg-C beendet) |
| `skillsmith start` | im Hintergrund starten |
| `skillsmith stop` | Hintergrund-Instanz beenden |
| `skillsmith restart` | `stop`, dann `start` |
| `skillsmith status` | Status und Adresse der Weboberfläche (Exit-Code 0 = läuft, 3 = gestoppt) |
| `skillsmith url` | Link zur Weboberfläche (mit Zugangsschlüssel/Token) |
| `skillsmith logs` | skillsmith-Log verfolgen (`tail -f`) |
| `skillsmith enable` | als launchd-Dienst registrieren (macOS; überlebt Neustart/Login) |
| `skillsmith disable` | launchd-Dienst entfernen |
| `skillsmith --help` | Hilfe |

### Optionen

| Option | Bedeutung |
|---|---|
| `--store <dir>` | Store-Verzeichnis (Standard: siehe Store-Auflösung) |
| `--port <n>` | Port der Weboberfläche (Standard 4747) |
| `--host <h>` | Adresse der Weboberfläche (Standard `127.0.0.1`) |
| `--opencode <bin>` | opencode-Binary/Wrapper (Standard: `opencode` aus `PATH`) |
| `--verbose`, `-v` | opencode-Logs zusätzlich ausgeben |
| `--help`, `-h` | Hilfe |

### Umgebungsvariablen

| Variable | Bedeutung |
|---|---|
| `SKILLSMITH_STORE_DIR` bzw. `SKILLSMITH_HOME` | Store-Verzeichnis |
| `SKILLSMITH_WEB_PORT` | Port der Weboberfläche |
| `SKILLSMITH_WEB_HOST` | Adresse der Weboberfläche |
| `SKILLSMITH_WEB_AUTOSTART` | Weboberfläche mit dem Prozess starten |
| `SKILLSMITH_OPENCODE_BIN` | opencode-Binary/Wrapper |

Diese Werte überschreiben die Konfigurationsdatei, damit CLI und Plugin denselben Store und dieselbe Adresse verwenden.

### Store-Auflösung

Die CLI stimmt mit dem Plugin überein. Reihenfolge:

1. `--store <dir>`
2. `SKILLSMITH_STORE_DIR`
3. `SKILLSMITH_HOME`
4. `storeDir` aus der skillsmith-Plugin-Option in opencodes Config (`opencode.jsonc`/`opencode.json`)
5. Standard `~/.local/share/skillsmith`

Das opencode-Binary wird in dieser Reihenfolge gesucht: `--opencode` → `SKILLSMITH_OPENCODE_BIN` → `opencode` aus dem `PATH`.

Die gefundene Datei muss kein ausführbares Programm sein: Ist sie eine Pointer-/Wrapper-Datei ohne Shebang (einzeiliger Text, der auf eine andere Datei zeigt), folgt die CLI dem Ziel bzw. startet sie über die Shell – ein `spawn ENOEXEC` beim Start bedeutet also nur, dass die `opencode`-Datei im `PATH` kein Programm ist, und die CLI kommt damit zurecht. Alternativ `--opencode`/`SKILLSMITH_OPENCODE_BIN` direkt auf das echte Binary oder das Skript setzen.

### launchd: `enable` / `disable`

`skillsmith enable` registriert unter macOS einen LaunchAgent `com.skillsmith.agent` in `~/Library/LaunchAgents/`. launchd startet **die CLI** (`skillsmith run`, also Node + `bin/skillsmith.ts`), nicht opencode direkt – nur so läuft der Lazy-Load-Trigger. `RunAtLoad` und `KeepAlive` starten nach Login bzw. Absturz neu. Store, Port und opencode-Binary werden als `EnvironmentVariables` in der Plist festgehalten; das Log liegt unter `<store>/state/log/opencode.out`. `skillsmith disable` entfernt den Dienst wieder.

Im Hintergrundbetrieb schreibt `start` eine PID-Datei `<store>/state/cli.json`; `stop` beendet die Prozessgruppe (SIGTERM, dann SIGKILL).

### Beispiel

```bash
skillsmith start                 # im Hintergrund starten
skillsmith status                # Status und Adresse
skillsmith url                   # Link öffnen
skillsmith enable                # überlebt Neustart/Login (macOS)
skillsmith disable               # Dienst wieder entfernen
```

---

## Suche, Tags und Hinweise

- **Volltextsuche (BM25F)** über alle Arten, ohne Datenbank: Deutsch/Englisch, Umlaute (`ü` = `ue`), Wortanfänge/Komposita. Gewichtet werden Name/Titel, Beschreibung, **Tags**, Überschriften und Text (Glossar: Abkürzung und Aliase am stärksten).
- Jeder Eintrag trägt **2–8 Tags** (Technologie, System, Komponente, Aufgabentyp). Alle Such-Werkzeuge akzeptieren einen `tags`-Filter; `/smith-tags` zeigt alle Schlagworte.
- **Ein Vokabular:** Tags der Hintergrund-Agenten werden auf vorhandene Tags abgebildet – Schreibvarianten (`deployments` → `deployment`, `db-2` → `db2`, `queries` → `query`) immer, mit Embeddings auch Synonyme (≥ `embedding.tagSimilarity`). Fehlen Tags (oder ist es nur einer), werden die Tags der ähnlichsten Einträge vorgeschlagen, sonst aus dem Namen abgeleitet. Der Agent sieht jede Abbildung in der Antwort. Ihre eigenen Tags (Befehle) bleiben unverändert. Bereits vorhandene Varianten vereinheitlicht der Curator (`unifyTags`, ein Commit pro Smith; Vorschau in `/smith-curate dry`).
- **Hinweis pro Nachricht:** Jede Nutzernachricht wird durchsucht; starke Treffer werden als ein `<smith_hints>`-Block an *diese* Nachricht angehängt (Skills, Glossar, Wissen, bekannte Fehler bei eingefügten Fehlermeldungen, Skripte, Erinnerungen, stark verknüpfte Einträge, **ähnliche frühere Sessions**). Die erste Nachricht einer Session bekommt zusätzlich den Stand des Projekts (`<smith_memory>`). Der System-Prompt bleibt unverändert, der Prompt-Cache stabil.

## Frühere Sessions

Nach jedem Review legt skillsmith eine kurze, geschwärzte Zusammenfassung der Session ab (`state/history.json`, nicht versioniert, projektübergreifend): Ihre Anfragen, aufgetretene Fehler (gelöst/ungelöst, mit dem Schritt, der geholfen hat), die Einträge, die dabei angelegt, geändert oder benutzt wurden, und das Ende der letzten Antwort.

Ähnelt eine neue Nachricht einer früheren Session, die etwas Wiederverwendbares hinterlassen hat, steht im Hinweis zum Beispiel:

```
Ähnliche frühere Sessions (Details: history_search):
- 03.10.: „Maven Build bricht mit PKIX ab“ – gelöst: keytool -importcert … – siehe Fehler pkix-root-ca-missing (neu)
```

Mit Embeddings zählt die Bedeutung (≥ `embedding.sessionHintSimilarity`), sonst müssen die meisten Suchbegriffe (≥ 3) übereinstimmen. Die aktuelle Session wird nie angezeigt. `history_search` (Agent) und `/history [suche]` (Sie) zeigen die Details; Aufbewahrung `history.days` (180) bzw. höchstens `history.maxRecords` (2000) Sessions.

## Semantische Suche (Embeddings)

Ist in Ihrem LiteLLM ein Embedding-Modell verfügbar, wird es automatisch genutzt: skillsmith nimmt Adresse und Schlüssel des Providers aus `opencode.json` (Provider mit „litellm“ im Namen) und erkennt das Modell über `GET /models` (bevorzugt Qwen3-Embedding-8B). Fehlt etwas, bleibt alles wie bisher (nur BM25).

| Wo | Was sich ändert |
|---|---|
| **Such-Werkzeuge** (`skill_search`, `knowledge_search`, `glossary_lookup`, `error_lookup`, `script_search`) und `/skills-search`, `/knowledge`, `/errors`, `/scripts` | BM25 und Vektorsuche werden per Reciprocal Rank Fusion kombiniert: „Wie bringe ich den Dienst in Produktion?“ findet die Deployment-Checkliste, auch ohne gemeinsames Wort |
| **Listen-Werkzeuge** (`skill_list`, `knowledge_list`, `glossary_list`, `error_list`, `script_list`, `memory_list`) | listen alle Einträge einer Art gruppiert nach Stufe (aktiv, ruhend; archiviert nur mit `include_archived: true`) mit optionalem `tags`-Filter; die Slash-Befehle `/smith-list` etc. bleiben daneben bestehen |
| **Hinweise pro Nachricht** | zusätzlich Treffer mit Ähnlichkeit ≥ `hintMinSimilarity`; der Hinweis wird parallel berechnet und wartet höchstens `hintWaitMs` (sonst BM25) |
| **Kandidaten** | dasselbe Muster in anderen Worten zählt als derselbe Kandidat (≥ `candidateSimilarity`) – der Wiederholungsnachweis greift zuverlässiger |
| **Duplikat-Sperre** | ein Hintergrund-Agent darf keinen Eintrag anlegen, der einem bestehenden fast gleicht (≥ `duplicateSimilarity`); er bekommt den Namen des vorhandenen Eintrags zum Aktualisieren |
| **Bekannte Fehler** | der Live-Hinweis greift auch bei anders formulierten Fehlermeldungen (≥ `errorSimilarity`) |
| **Reviewer-Kontext** | passende Einträge und Kandidaten für die Hintergrund-Agenten werden nach Bedeutung ausgewählt |
| **Curator-Cluster** | Einträge, die dasselbe in anderen Worten beschreiben (≥ `clusterSimilarity`), werden zum Zusammenführen vorgelegt – zusätzlich zu den Wort-Clustern |
| **Projekt-Doku** (`docs_search`, docsmith-Kontext) | Doku-Abschnitte werden auch ohne gemeinsames Wort gefunden |
| **Widerspruchs-Check** | verwandte Wissenseinträge (≥ `relatedSimilarity`) werden nach Änderungen und vom Curator geprüft |
| **Tags** | Synonyme werden auf das vorhandene Tag abgebildet (≥ `tagSimilarity`) |
| **Frühere Sessions** | ähnliche Sessions auch bei anderer Formulierung (≥ `sessionHintSimilarity`) |

Alles davon hat einen BM25-Weg ohne Embeddings: Wort-Cluster, Volltextsuche über Doku-Abschnitte und Sessions, verwandte Einträge per Volltext, Tag-Varianten per Schreibweise.

Technik:
- Ein Vektor pro Eintrag, Doku-Abschnitt, Session und Tag, Kürzung auf `dimensions` (1024) und neu normalisiert (Qwen3-Embedding unterstützt das). Suchanfragen bekommen die von Qwen vorgesehene Anweisung (`Instruct: …\nQuery: …`), Einträge nicht.
- Ablage in **SQLite** (`state/embeddings/vectors.sqlite`, über das in opencode eingebaute `bun:sqlite` – keine Erweiterung, nichts zu installieren): ein Vektor pro Zeile mit Inhalts-Hash, nur Geändertes wird neu eingebettet und **nur Geändertes geschrieben**. Mehrere opencode-Fenster teilen sich die Datei und sehen die Änderungen der anderen sofort. Gesucht wird weiterhin im Arbeitsspeicher (alle Vektoren eines Bereichs vergleichen: 2000 ≈ 3 ms, 20 000 ≈ 20–40 ms).
- Gemessen (50 000 Vektoren à 1024 Dimensionen): eine neue Erinnerung speichern ≈ 1 ms statt ≈ 600 ms mit dem alten Dateiformat, das bei jeder Änderung die ganze Datei neu schrieb. Die Dateien aus 2.1/2.2 werden beim ersten Start übernommen und gelöscht; Vektorräume eines alten Modells werden nach 60 Tagen ohne Nutzung entfernt. Ist die Datenbank beschädigt, wird sie beiseitegelegt und neu aufgebaut (die Vektoren sind abgeleitete Daten). Ohne SQLite – oder mit `embedding.storage: "file"` – gilt das alte Dateiformat.
- Schlägt der Endpunkt dreimal fehl, pausieren Embeddings 5 Minuten (nur BM25), ohne dass Hinweise oder Werkzeuge warten.
- An den Embedding-Endpunkt gehen geschwärzte Texte, also dieselben Daten, die auch das Chat-Modell sieht.

`/smith-embed` zeigt Status, Modell, Vektoren, Ablage (Größe, letzter Schreibvorgang) und Latenz; `/smith-embed sync` baut fehlende Vektoren auf; **`/smith-embed eval`** wertet Ihre bisherigen Sessions aus (Nachricht → danach geladener Eintrag) und vergleicht BM25 mit der hybriden Suche (Treffer@1, Treffer@3, MRR) – inklusive eines Vorschlags für `hintMinSimilarity`.

## Metadaten

Zu jedem Eintrag gibt es `meta/<art>/<name>.json` (versioniert): Erstellung (wer, wann, welche Session/welcher Agent/welches Projekt), Projekte, in denen er bestätigt wurde, Historie aller Änderungen mit Lauf-ID und Grund, Nachweise (Wissen/Glossar/Fehler), Zeitpunkt der letzten Bestätigung, Pin, Zusammenführungen, Testergebnis (Skripte). Nutzungszahlen (geladen, Hinweise gezeigt/genutzt, Fehlerquote, Live-Hinweis geholfen) liegen in `state/usage.json`.

## Curator

| Art | Lebenszyklus (ohne LLM) | Konsolidierung (LLM, alle `curatorIntervalDays`) |
|---|---|---|
| Skills | `staleDays` (14) → ruhend, `archiveDays` (60) → Archiv; Budget `activeBudget` für den System-Prompt | ähnliche zusammenführen, fehleranfällige schärfen |
| Wissen | nie automatisch; „zu prüfen“ nach `docsmith.reviewAfterDays` | ähnliche Einträge zusammenführen; markierte Widersprüche klären (verwandte Paare prüft der Doktor; ist er aus, der Curator: max. 5 Paare pro Lauf) |
| Glossar | doppelte Abkürzungen werden automatisch zusammengeführt | – |
| Fehler | `errorsmith.staleDays` (90) → ruhend, `archiveDays` (365) → Archiv; erneutes Auftreten reaktiviert | Duplikate zusammenführen, nicht hilfreiche Lösungen schärfen |
| Skripte | `toolsmith.staleDays` (60) → ruhend, `archiveDays` (180) → Archiv; wöchentlicher Re-Test | fehlschlagende Skripte reparieren |
| Erinnerungen | abgelöste → Archiv; Erfahrungen nach `memorysmith.experienceArchiveDays` (180) ohne Nutzung → Archiv; Entscheidungen und Vorgaben nie; Arbeitsstände verfallen nach `stateDays` bzw. wenn der Branch gelöscht ist; ungenutzte Ergebnisse werden nach `resultDays` gelöscht | gleiche Erinnerungen eines Projekts zusammenführen, abgelöste Entscheidungen markieren |
| Tags (alle Arten) | Varianten werden auf das häufigere Tag vereinheitlicht (`unifyTags`) | – |

Wird ein Eintrag wieder benutzt, wird er automatisch reaktiviert. Angepinnte Einträge (`/smith-pin`) werden nie archiviert. `/smith-curate` startet alles sofort, `/smith-curate dry` zeigt eine Vorschau.

## Git-Historie

Der Store (`~/.local/share/skillsmith`) ist ein Git-Repository. Genau **ein Commit pro Lauf** eines Smiths, nur mit dessen Dateien; der Text enthält Lauf-ID, Trigger, Session, Agent, Projekt und je Aktion den Grund:

```
skillsmith(reviewer): create deploy-checklist
docsmith(reviewer): create knowledge kundendaten-quelle (+2 more)
errorsmith(reviewer): create error pkix-root-ca-missing
toolsmith(reviewer): create script count-csv-values
memorysmith(reviewer): create memory billing-entscheidung-login-token (+1 more)
doctor(curator): relate knowledge login-token-cookie
errorsmith(curator): dormant error old-proxy-timeout
docsmith(command): upsert glossary kwg
manual: external changes
```

`/smith-undo` nimmt den letzten Lauf (beliebiger Smith) zurück, `/smith-undo <lauf-id|commit>` einen bestimmten – wieder als eigener Commit. Manuelle Änderungen werden separat committet. `state/` wird nicht versioniert – also auch nicht die lokalen Arbeitsstände und Ergebnisse (`state/memory.sqlite`); im Lauf-Journal stehen sie trotzdem.

## Schreibmodi

| `writeMode` | Verhalten |
|---|---|
| `auto` (Standard) | Änderungen werden direkt geschrieben und committet. |
| `stage` | Änderungen werden vorgemerkt: `/smith-pending`, `/smith-approve <id\|all>`, `/smith-reject <id\|all>`. |
| `shadow` | Nichts wird geschrieben; Vorschläge landen in `state/shadow.jsonl`. |

Pro Smith überschreibbar, z. B. `"toolsmith": { "writeMode": "stage" }`. docsmith schreibt standardmäßig direkt.

---

## Befehle

| Befehl | Zweck |
|---|---|
| `/smith-help` | Übersicht |
| `/smith-report` | Status aller Smiths, Modell, Warteschlange (inkl. letztem Fehler), Python/Sandbox, Nutzung, letzte Commits |
| `/smith-review` | aktuelle Session sofort von allen zuständigen Smiths bewerten |
| `/smith-curate [dry]` | Curator jetzt ausführen (`dry` = Vorschau) |
| `/smith-undo [lauf-id\|commit]` | Lauf per Git zurücknehmen |
| `/smith-pending`, `/smith-approve <id\|all>`, `/smith-reject <id\|all>` | vorgemerkte Änderungen |
| `/smith-list <skills\|wissen\|glossar\|fehler\|skripte> [stufe]` | Einträge auflisten |
| `/smith-tags [art]` | Tags/Schlagworte mit Anzahl |
| `/smith-embed [status\|sync\|eval [sessions]]` | semantische Suche: Status, Vektoren neu aufbauen, Auswertung mit Ihren Sessions |
| `/smith-pin [art] <name>`, `/smith-unpin …` | vor Archivierung/Zusammenführung schützen |
| `/smith-restore [art] <name>`, `/smith-archive [art] <name>` | Stufe ändern |
| `/skills-search <begriffe>` | Skills durchsuchen |
| `/skills-adopt <name>` | fremden Skill (z. B. aus `~/.config/opencode/skills`) übernehmen |
| `/knowledge [suche]` | Wissensdatenbank durchsuchen/auflisten |
| `/glossary [abk\|suche]` | Glossar nachschlagen/auflisten |
| `/glossary-add ABK \| Bedeutung \| Beschreibung [\| Kontext]` | Abkürzung eintragen (weitere Bedeutung: gleicher Befehl) |
| `/glossary-open` | offene Abkürzungen (Bedeutung unbekannt) |
| `/glossary-ignore ABK …` | Abkürzungen künftig ignorieren |
| `/glossary-import <datei>`, `/glossary-export [ziel.md]` | Import (CSV/Markdown), Export (Markdown-Tabelle) |
| `/errors [suche]`, `/errors-top` | dokumentierte Fehler; häufigste Fehler (auch undokumentierte) |
| `/scripts [suche]`, `/scripts-test [name]` | Skripte; neu testen |
| `/docs-search [suche]` | Doku dieses Projekts (`.md`) durchsuchen; ohne Suche: Umfang des Index |
| `/history [suche]` | frühere Sessions dieses Projekts auflisten bzw. alle durchsuchen |
| `/memory [suche]` | Erinnerungen dieses Projekts: Arbeitsstand, Vorgaben, Entscheidungen, Erfahrungen, Ergebnisse – bzw. suchen |
| `/resume [branch]` | Arbeitsstand eines Branches (Standard: aktueller) mit offenen Punkten, Entscheidungen und Ergebnissen – gut zum Weitermachen |
| `/remember [text]` | etwas ausdrücklich merken lassen; ohne Text: diese Session sofort auf Erinnerungen prüfen |
| `/forget <id>` | Erinnerung archivieren (`memory:…`) bzw. Arbeitsstand/Ergebnis verwerfen (`state:…`, `result:…`) |
| `/smith-doctor [run\|resolve <id> a\|b\|beide\|kein-bezug]` | Doktor: Status und Konflikte, Lauf starten, Konflikt entscheiden |
| `/smith-web [stop]` | Weboberfläche öffnen (Link) bzw. beenden |
| `/task [neu <titel> \| T-12 \| T-12 <spalte>]` | Aufgaben: offene auflisten, anlegen, anzeigen, verschieben |
| `/note <text>` | Schnellnotiz ins Dokument „Eingang“ (mit Session-Link) |
| `/doc <thema> [\| vorlage]` | docsmith schreibt aus dieser Session einen Entwurf als Ihr Dokument |

Bei `[art]` gehen auch: `skill(s)`, `wissen`, `doku`, `glossar`, `abk`, `fehler`, `error(s)`, `skript(e)`, `script(s)`, `erinnerung(en)`, `memory`. Ist der Name eindeutig, kann die Art entfallen.

Die Listen-Befehle (`/smith-list`, `/knowledge`, `/glossary`, `/errors`, `/scripts`, `/memory`) bleiben unverändert. Zusätzlich gibt es für Agenten die entsprechenden Listen-Werkzeuge (`skill_list`, `knowledge_list`, `glossary_list`, `error_list`, `script_list`, `memory_list`) – sie liefern dieselben Einträge als Tool-Ausgabe, ohne die Befehle zu ersetzen.

---

## Optionen

Allgemein:

| Option | Standard | Bedeutung |
|---|---|---|
| `enabled` | `true` | Hauptschalter (auch `SKILLSMITH_DISABLED=1`) |
| `storeDir` | `~/.local/share/skillsmith` | Ablage (auch `SKILLSMITH_HOME`) |
| `writeMode` | `"auto"` | `auto` \| `stage` \| `shadow` |
| `reviewThreshold` | `5` | Review nach so vielen Nutzernachrichten |
| `idleReview` / `idleDelayMin` / `idleMinNewMessages` | `true` / `3` / `2` | Review bei Leerlauf |
| `reviewSubagents` / `subagentMinToolCalls` | `false` / `6` | Subagent-Sessions bewerten |
| `reviewConcurrency` | `4` | parallele Review-Jobs (Sessions) |
| `agentConcurrency` | `8` | parallele Hintergrund-Agenten (alle Smiths) |
| `reviewTimeoutMin` | `15` | Abbruch eines Hintergrund-Agenten |
| `catchUpOnStart` | `true` | offene Reviews beim Start nachholen |
| `reviewerModel` | Modell der Session | festes Modell `"provider/modell"` für alle Hintergrund-Agenten |
| `curatorModel` | = `reviewerModel` | Modell für die Curator-Agenten |
| `agentSteps` | `40` | max. Schritte pro Hintergrund-Agent |
| `skillLanguage` | `"auto"` | Sprache der Inhalte (`auto` = Sprache der Unterhaltung) |
| `transcriptMaxChars` | `24000` | max. Transkriptlänge |
| `maxDescriptionChars` | `300` | max. Länge einer Beschreibung |
| `curatorIntervalDays` / `curatorMaxChanges` / `consolidate` | `7` / `5` / `true` | LLM-Konsolidierung |
| `similarityThreshold` | `0.45` | Ähnlichkeit für Cluster |
| `needsReviewMinLoads` / `needsReviewRate` | `3` / `0.5` | ab wann ein Eintrag als fehleranfällig gilt |
| `hints` | `{ "enabled": true, "max": 3, "minScore": 0.35, "includeSubagents": true, "glossary": true, "knowledge": true, "errors": true, "scripts": true, "maxGlossary": 5, "sessions": true }` | Hinweise pro Nachricht (`sessions` = ähnliche frühere Sessions) |
| `history` | `{ "enabled": true, "days": 180, "maxRecords": 2000 }` | Session-Verlauf für Hinweise, `history_search`, `/history` |
| `unifyTags` | `true` | Curator vereinheitlicht Tag-Varianten |
| `git` | `{ "enabled": true }` | Git-Tracking; `binary` für einen eigenen Pfad |
| `indexForeignSkills` | `true` | Skills aus anderen Orten schreibgeschützt mit durchsuchen |
| `redact` | `{ "extraPatterns": [], "emails": true }` | zusätzliche Muster, die vor dem Modell geschwärzt werden |
| `keepAgentSessions` / `debug` | `false` / `false` | Debugging |

skillsmith (Skills):

| Option | Standard | Bedeutung |
|---|---|---|
| `skillsmith` | `{ "enabled": true }` | `enabled`, `writeMode`, `model` |
| `maxNewSkillsPerReview` / `maxChangesPerReview` | `1` / `3` | Limits pro Review |
| `recurrenceMinSessions` | `2` | Sessions, bevor ein neuer Skill entsteht (`1` = sofort) |
| `maxBodyChars` | `8000` | max. Skill-Länge |
| `activeBudget` | `{ "maxSkills": 20, "maxChars": 6000 }` | Budget aktiver Skills im System-Prompt |
| `staleDays` / `archiveDays` | `14` / `60` | Lebenszyklus |

docsmith, errorsmith, toolsmith (jeweils zusätzlich `enabled`, `writeMode`, `model`):

| Option | Standard | Bedeutung |
|---|---|---|
| `docsmith.maxChangesPerReview` / `maxBodyChars` | `6` / `6000` | Limits |
| `docsmith.reviewAfterDays` | `180` | Wissen danach „zu prüfen“ |
| `docsmith.repoDocs` / `repoDocsMaxChars` / `changesMaxChars` | `true` / `4000` / `6000` | Projekt-`.md` lesen; Budget für Doku-Stellen und Code-Änderungen |
| `docsmith.projectIndex` / `projectIndexMaxFiles` / `projectIndexMaxChunks` | `true` / `1000` / `5000` | Projekt-Doku in Abschnitten indizieren (`docs_search`, docsmith-Kontext); Dateien > 300 KB werden übersprungen |
| `docsmith.detectAbbreviations` / `ignoreAbbreviations` | `true` / `[]` | Abkürzungserkennung |
| `errorsmith.maxChangesPerReview` / `maxBodyChars` | `4` / `5000` | Limits |
| `errorsmith.liveHints` / `hintMinScore` | `true` / `0.5` | Lösung an fehlgeschlagene Befehle anhängen |
| `errorsmith.openMinSessions` | `2` | Sessions, bevor ein ungelöster Fehler dokumentiert wird |
| `errorsmith.staleDays` / `archiveDays` | `90` / `365` | Lebenszyklus |
| `toolsmith.python` / `pythonTarget` | `"python3"` / `"3.9"` | Interpreter und Zielversion |
| `toolsmith.allowPipInstall` | `false` | fehlende Pakete per `pip install --user` nachinstallieren |
| `toolsmith.sandbox` | `"auto"` | `auto` (Sandbox, wenn verfügbar), `required` (nie ohne), `off` |
| `toolsmith.testTimeoutSec` / `minTests` / `maxIterations` | `60` / `3` / `5` | Tests |
| `toolsmith.recurrenceMinSessions` / `minSignalScore` | `2` / `3` | wann ein Skript entstehen darf / toolsmith läuft |
| `toolsmith.requireApprovalFor` | `["network", "subprocess", "delete"]` | Fähigkeiten mit Pflicht-Freigabe |
| `toolsmith.staleDays` / `archiveDays` | `60` / `180` | Lebenszyklus |

memorysmith, Doktor, Weboberfläche:

| Option | Standard | Bedeutung |
|---|---|---|
| `memorysmith` | `{ "enabled": true }` | zusätzlich `writeMode`, `model` |
| `memorysmith.maxChangesPerReview` / `maxBodyChars` | `8` / `4000` | Limits pro Review |
| `memorysmith.stateDays` / `resultDays` | `14` / `14` | Lebensdauer von Arbeitsständen und Ergebnissen |
| `memorysmith.experienceArchiveDays` / `decisionReviewDays` | `180` / `180` | Erfahrungen archivieren; Entscheidungen zur Prüfung markieren |
| `memorysmith.standBlock` / `standMaxChars` | `true` / `1500` | Stand-Block in der ersten Nachricht einer Session |
| `memorysmith.ticketPattern` | `"[A-Z][A-Z0-9]+-\\d+"` | Ticketnummer im Branchnamen |
| `memorysmith.captureSubagents` | `true` | Ergebnisse von Subagenten auffangen |
| `memorysmith.crossProject` | `false` | Erinnerungen anderer Projekte in Hinweisen und Suche zeigen |
| `doctor` | `{ "enabled": true }` | zusätzlich `writeMode`, `model` (Standard: `curatorModel`) |
| `doctor.maxPairsPerRun` / `candidates` | `10` / `8` | Paare pro Lauf; ähnliche Einträge pro Änderung |
| `doctor.autoResolve` | `true` | klar veraltetes Wissen / Erfahrungen mit Beleg korrigieren (sonst: Konflikt für Sie) |
| `doctor.backfillPerRun` | `40` | Einträge des Bestands pro Lauf beim ersten Start |
| `memorysmith.stateHistory` / `proposeTasks` | `50` / `true` | gespeicherte Stände je Arbeitsstand; Aufgaben-Vorschläge bei „machen wir später“ |

Weboberfläche und Sicherheit (`web`):

| Option | Standard | Bedeutung |
|---|---|---|
| `web.host` | `"127.0.0.1"` | Adresse; eine andere als `127.0.0.1` nur mit Token |
| `web.port` / `portFallback` | `4747` / `10` | Port und Ausweichports |
| `web.token` / `tokenRotate` | `true` / `true` | Schlüsselpflicht (abschaltbar); neuer Schlüssel bei jedem Start (`false`: bleibt, Lesezeichen funktionieren) |
| `web.allowedHosts` / `checkOrigin` | `["127.0.0.1", "localhost"]` / `true` | zulässige Hostnamen; Herkunftsprüfung bei Schreibzugriffen |
| `web.readOnly` | `false` | alle Schreibaktionen sperren |
| `web.maxBodyKB` | `1024` | maximale Größe einer Anfrage |
| `web.confirm` | Löschen `name`, sonst `preview` | Bestätigung je Aktion (`delete`, `undo`, `restore`, `merge`, `rename`): `name`, `preview` oder `none` |
| `web.securityLogPerMinute` | `1` | Drosselung der Sicherheitsereignisse im Audit-Log |
| `web.autostart` / `liveUpdates` / `diffMaxLines` | `false` / `true` / `2000` | mit opencode starten; Live-Aktualisierung; Diff-Länge |

Wissensbasis, Links, Graph:

| Option | Standard | Bedeutung |
|---|---|---|
| `docs.defaultAiAccess` / `folderAiAccess` | `"vorschlag"` / `{}` | KI-Recht für Ihre neuen Dokumente; Startwerte je Ordner (z. B. `{ "privat": "privat" }`) |
| `docs.maxBodyChars` / `attachmentMaxMB` | `50000` / `5` | Länge Ihrer Dokumente; Größe je Anhang |
| `docs.ownBoost` | `0.1` | Vorrang Ihrer Dokumente in Hinweisen |
| `docs.privateEmbeddings` | `false` | private Dokumente lokal einbetten (nur für Ihre Suche) |
| `docs.journalFolder` / `inboxDoc` | `"journal"` / `"eingang"` | Ordner der Tagesnotizen; Dokument der Schnellnotizen |
| `docsmith.folder` | Hauptordner | Ordner für neue Wissenseinträge der KI |
| `links.ticketUrl` | `""` | z. B. `"https://jira.firma.de/browse/{ticket}"`; leer = nur die Ticket-Seite |
| `graph.relevance` | `{ "weights": { "usage": 0.5, "network": 0.35, "importance": 0.15 }, "halfLifeDays": 30, "newDays": 14 }` | Knotengröße im Graph |
| `hints.relevanceBoost` | `0` | Relevanz als schwacher Gleichstandsbrecher in Hinweisen |

Aufgaben, Agenten, Pipeline, Benachrichtigungen:

| Option | Standard | Bedeutung |
|---|---|---|
| `tasks.columns` / `wipLimits` / `maxDepth` / `idPrefix` | 5 Spalten / `{}` / `2` / `"T"` | Board (je Projekt überschreibbar) |
| `tasks.agents` | `true` | Agenten-Aufträge anbieten |
| `tasks.requireToken` | `true` | Agenten starten und freigeben nur mit Schlüssel, auch ohne `web.token` |
| `tasks.planAllowBash` / `writeTools` | `false` / `["edit", "write", "patch", "multiedit"]` | bash im Vorschlag; Werkzeuge, die als schreibend gelten |
| `tasks.worktree` / `maxParallel` | `true` / `3` | eigener Worktree je Auftrag; parallele Aufträge |
| `tasks.autoFixRounds` | `1` | Nachbesserungen bei roter Pipeline vor „test“ |
| `tasks.review` / `reviewAgent` / `largeDeletion` | `true` / `""` / `200` | Review vor der Abnahme (Agent, z. B. `"verifier"`); Schwelle für große Löschungen |
| `tasks.similar` | `3` | ähnliche erledigte Aufgaben im Auftrag |
| `tasks.prepare` / `prepareAt` | `true` / `[]` | Vorschläge vorab erstellen (beim Start bzw. zu Uhrzeiten wie `["08:30", "13:00"]`) |
| `pipeline.maxParallel` / `keepRuns` / `timeoutMin` | `2` / `20` / `15` | Last, aufbewahrte Läufe je Projekt, Zeitlimit je Stufe |
| `pipeline.requireGreen` | `"warn"` | „erledigt“ bei roter Pipeline: `warn` (Bestätigung), `block`, `off` |
| `pipeline.requireToken` / `sandbox` / `logMaxKB` | `true` / `false` / `2048` | Schlüssel für Pipeline-Änderungen; macOS-Sandbox; Log-Länge |
| `notify.toast` / `browser` / `macos` / `events` | `true` / `true` / `false` / alle | Benachrichtigungen (Ereignisse: `proposal`, `permission`, `pipeline`, `agent-done`, `agent-error`) |

Audit-Log und Metriken:

| Option | Standard | Bedeutung |
|---|---|---|
| `audit.days` / `hashChain` / `logRejected` | `0` (unbegrenzt) / `true` / `true` | Aufbewahrung, Hash-Kette, abgelehnte Agent-Aktionen |
| `metrics.enabled` / `rawDays` | `true` / `365` | Erfassung; Rohdaten (Tagessummen bleiben) |
| `metrics.toolCalls` / `tokens` / `webViews` | `true` | einzeln abschaltbar |
| `metrics.flushMs` | `2000` | Schreibpuffer |

Semantische Suche (`embedding`):

| Option | Standard | Bedeutung |
|---|---|---|
| `embedding.enabled` | `true` | aus mit `false` oder `SKILLSMITH_EMBEDDINGS=0`; ohne erreichbares Modell automatisch aus |
| `embedding.provider` | Provider mit „litellm“ im Namen | opencode-Provider, dessen `baseURL`/`apiKey` genutzt werden |
| `embedding.model` | automatisch (`GET /models`) | Modell-ID im Endpunkt, z. B. `"qwen3-embedding-8b"` |
| `embedding.baseURL` / `apiKey` / `apiKeyEnv` | aus dem Provider / `"LITELLM_API_KEY"` | eigener Endpunkt bzw. Schlüssel (Fallback auch `opencode auth login`) |
| `embedding.dimensions` | `1024` | Kürzung der Vektoren (0 = volle Länge, bei Qwen3-Embedding-8B 4096) |
| `embedding.instructionFormat` | `"auto"` | `qwen` (Anweisung für Anfragen), `none`; `auto` = qwen bei Qwen-Modellen |
| `embedding.timeoutMs` / `batchSize` / `hintWaitMs` | `4000` / `16` / `2500` | Zeitlimits und Batchgröße |
| `embedding.storage` | `"sqlite"` | Ablage der Vektoren: `sqlite` (schreibt nur Änderungen) oder `file` (eine Datei pro Bereich, Fallback) |
| `embedding.searchMinSimilarity` / `hintMinSimilarity` | `0.4` / `0.55` | Mindestähnlichkeit für rein semantische Treffer in Suche / Hinweisen |
| `embedding.candidateSimilarity` / `duplicateSimilarity` / `errorSimilarity` | `0.85` / `0.92` / `0.6` | Kandidaten-Zuordnung, Duplikat-Sperre, Fehler-Hinweise |
| `embedding.clusterSimilarity` / `relatedSimilarity` | `0.82` / `0.7` | Curator-Cluster; verwandte Wissenseinträge (Widerspruchs-Check, zwischen beiden Werten als Paar) |
| `embedding.tagSimilarity` / `sessionHintSimilarity` | `0.92` / `0.7` | Tag-Synonyme; Hinweis auf frühere Sessions |

Die Schwellen sind Startwerte; `/smith-embed eval` zeigt anhand Ihrer Daten, wo sie liegen sollten.

Ungültige Werte werden ignoriert (Standardwert) und im Log gemeldet.

---

## Ablage

```
~/.local/share/skillsmith/                 (Git-Repository)
├── skills/<stufe>/<name>/SKILL.md          ← aktive lädt opencode selbst
├── knowledge/<stufe>/<ordner…>/<name>.md   ← Wissen und Ihre Dokumente (`.ordner.json`: KI-Recht je Ordner)
├── knowledge/_anhaenge/<JJJJ-MM>/           ← Anhänge (Bilder, PDFs …)
├── office/<stufe>/<name>/OFFICE.md + Datei  ← PowerPoint/Word (.pptx/.docx/.potx/.dotx) mit erkanntem Text
├── glossary/<stufe>/<abk>.md               ← Glossar
├── errors/<stufe>/<name>.md                ← Fehler mit Lösung
├── scripts/<stufe>/<name>/                 ← SCRIPT.md, <modul>.py, test_<modul>.py
├── memories/<stufe>/<projekt>-<art>-<thema>.md ← Entscheidungen, Vorgaben, Erfahrungen
├── tasks/<stufe>/t-<n>.md  tasks/.counter.json ← Aufgaben (Ihre; memorysmith schlägt nur vor)
├── projects/<stufe>/<name>.md              ← Projekte mit home_path, Board und Pipeline
├── meta/<art>/<name>.json                  ← Metadaten (Herkunft, Historie, Nachweise, Tests, Verknüpfungen)
├── candidates/<art>/<id>.json              ← Kandidaten (Wiederholungsnachweis, offene Abkürzungen)
├── glossary-ignore.json  store.json
└── state/                                  ← nicht versioniert
    ├── queue/ sessions/ runs/ locks/ staged/ drafts/ exports/
    ├── office/<name>/                      ← KI-Entwürfe von Office-Dokumenten (bis „Übernehmen“)
    ├── embeddings/vectors.sqlite           ← Vektoren (Einträge, Kandidaten, Projekt-Doku, Sessions, Tags)
    ├── memory.sqlite                       ← Arbeitsstände, Ergebnisse, Subagent-Ergebnisse, lokale Verknüpfungen, Doktor
    ├── audit.sqlite  metrics.sqlite        ← Audit-Log (Hash-Kette) und Metriken (Ereignisse + Tagessummen)
    ├── pipeline/<projekt>/  agent-jobs/  worktrees/  ← Pipeline-Läufe mit Log, Agenten-Aufträge, Worktrees
    ├── board.json  rule-candidates.json  web-visit.json  exports/
    ├── web.json                            ← laufende Weboberfläche (Port, Schlüssel)
    ├── cli.json                            ← vom CLI gestartete Hintergrund-Instanz (PID, Store, opencode)
    ├── history.json                        ← Kurzfassung bewerteter Sessions (geschwärzt)
    ├── usage.json errors.json model.json python.json curator.json
    ├── journal.jsonl shadow.jsonl outdated-docs.jsonl
    └── log/skillsmith.log  log/opencode.out
```

Alle Dateien sind Markdown mit Frontmatter und können von Hand bearbeitet werden.

---

## Datenschutz und Sicherheit

- Vor dem Senden an ein Modell werden Passwörter, Tokens, API-Keys, private Schlüssel, Verbindungs-URLs mit Zugangsdaten, IBANs, Kartennummern und E-Mail-Adressen geschwärzt (eigene Muster: `redact.extraPatterns`). Ein Scanner blockiert das Schreiben solcher Daten in jeden Eintrag und jedes Skript.
- Hintergrund-Agenten haben **keine** Shell-, Edit- oder Web-Werkzeuge – jeder Smith nur seine eigenen Werkzeuge und die Lese-Werkzeuge. Ihre normalen Agenten sehen die Schreib-Werkzeuge gar nicht.
- Projektdateien werden nie verändert; docsmith liest nur `.md`-Dateien (auch deren Inhalt wird vor dem Modell geschwärzt).
- Der Session-Verlauf (`state/history.json`) enthält nur geschwärzte Kurzfassungen und bleibt lokal (nicht im Git). Dasselbe gilt für Arbeitsstände, Ergebnisse und aufgefangene Subagent-Antworten (`state/memory.sqlite`).
- Die Weboberfläche lauscht nur auf `127.0.0.1`, verlangt den zufälligen Schlüssel aus dem Link bei jedem Abruf (abschaltbar), prüft Host und Herkunft der Anfrage, lädt nichts von außen (strenge Content-Security-Policy). Schreiben geht nur über die Aktionen mit denselben Prüfungen wie bei den Agenten (siehe „Sicherheit beim Schreiben“).
- Private Dokumente (`ai: privat`) gehen nie an ein Modell und nicht in Embeddings. Metriken enthalten nur Ids, Zahlen und Zeiten – keine Nachrichten, Tool-Argumente oder Suchanfragen; Audit-Log und Metriken bleiben lokal (`state/`).
- Agenten-Aufträge: erst Vorschlag ohne Schreibrechte (für den ganzen Session-Baum im Plugin erzwungen), Umsetzung im eigenen Worktree, opencode-Berechtigungen bleiben aktiv, mergen nur auf Ihren Klick. Die Pipeline führt nur Befehle aus, die Sie im Projekt hinterlegt haben; ihre Logs werden geschwärzt.
- toolsmith führt Tests nur mit minimaler Umgebung im Temp-Verzeichnis aus (macOS: Sandbox ohne Netzwerk); riskante Skripte nur nach Ihrer Freigabe.

## Grenzen

- **Neue Skills erscheinen erst nach einem Neustart in opencodes eigener Skill-Liste**; über `skill_search`/`skill_read` und die Hinweise sind sie sofort nutzbar.
- opencode 2 wird als Vorschau unterstützt (`server.ts`, Adapter `src/host/v2.ts`); Einschränkungen siehe „opencode 2“ unter Installation.
- Die Qualität hängt vom Modell ab. Mit kleinen Modellen ggf. `writeMode: "stage"` (oder pro Smith) nutzen.
- Hintergrund-Reviews verbrauchen Tokens: pro Review laufen bis zu fünf Agenten parallel, danach ggf. der Doktor.
- Arbeitsstände und Ergebnisse sind lokal (pro Rechner), Entscheidungen, Vorgaben und Erfahrungen liegen im Git-Store.
- Pipeline und Agenten-Aufträge laufen nur, solange opencode läuft; ein unterbrochener Pipeline-Lauf wird beim nächsten Start als unterbrochen markiert. Die Pipeline ersetzt nicht die echte CI (gleiche Befehle, Ihre lokale Umgebung).
- Ein Agent arbeitet mit Ihren Rechten auf Ihrem Rechner – darum Vorschlag zuerst, Worktree und Ihre Abnahme.
- Linux hat keine vollwertige Test-Sandbox (nur Netzwerk-Isolation via `unshare`, falls erlaubt).
- Code-Anker werden per Muster aufgelöst (Java, Kotlin, TypeScript/JavaScript); Umbenennungen erkennt skillsmith über git und den Symbolnamen, nicht über eine echte Symbolauflösung.
- Gym-Läufe im Modus „arbeiten“ laufen in einem git-Worktree des Projekts; die Shell des Agenten läuft dort nicht in `sandbox-exec` (das kann opencode nicht), nur Prüfbefehle von skillsmith.
- Office-Dokumente: Vorschau und Editor sind Nachbauten von PowerPoint/Word im Browser (ooxml); sehr komplexe Folien (SmartArt, eingebettete Objekte, Animationen) sehen dort teils anders aus als in Office. Die KI ändert Struktur und Text (Folien, Platzhalter, Textfelder, Tabellen, Absätze, Formatvorlagen), keine freien Grafiken.
- Die Menüleisten-App ist noch nicht umgesetzt; das IntelliJ-Plugin liegt als Quellcode vor und muss gebaut werden.

## Fehlersuche

- Log: `~/.local/share/skillsmith/state/log/skillsmith.log` (ausführlich mit `"debug": true` oder `SKILLSMITH_DEBUG=1`).
- Lauf-Journal: `state/journal.jsonl` (ein Eintrag pro Smith-Lauf mit Aktionen, Fehler und Commit).
- `/smith-report` zeigt das verwendete Modell, die Warteschlange und den letzten Fehler (z. B. „Model not found: …“). Abhilfe bei Modellfehlern: `reviewerModel` setzen.
- **„Model not found: Hermes/.“** – opencode liest Modelle als `provider/modell`; ein Name ohne Provider (z. B. eine Router-Kombination wie „Hermes“ aus 9router) wird als Provider gelesen. Der Chat im Terminal fällt dann still auf ein anderes Modell zurück, Sessions über die Schnittstelle nicht. skillsmith gibt jeder Session, die es startet (Hintergrund-Agenten, Assistent, Agenten-Aufträge), ein geprüftes Modell mit: ein eindeutiger Name wird ergänzt („Hermes“ → `9router/Hermes`, am Auftrag vermerkt), sonst gilt das zuletzt genutzte Modell bzw. opencodes Standard. Dauerhaft beheben: `model: 9router/Hermes` (Ihr Provider-Name aus `opencode.json`) im Agenten und in `opencode.json`.
- toolsmith: `/smith-report` zeigt Python-Version und Sandbox; `toolsmith.python` auf einen anderen Interpreter setzen, z. B. `/usr/bin/python3`.
- Plugin vorübergehend aus: `SKILLSMITH_DISABLED=1 opencode`.
