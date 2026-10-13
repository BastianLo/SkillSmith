# skillsmith für IntelliJ (5i)

Bringt skillsmith in die IDE. Spricht die lokale Web-API von skillsmith an (127.0.0.1, Token
aus `state/web.json` des Stores) – es muss also eine Instanz laufen (`skillsmith start` oder
`/smith-web` in opencode).

- **Wissen am Code:** Randsymbol an Klassen, Methoden und Funktionen mit Code-Anker
  (`[[code:…]]`); Warnsymbol, wenn sich der verankerte Code geändert hat. Klick listet die
  Einträge und öffnet einen in der Weboberfläche.
- **Werkzeugfenster „skillsmith“:** Aufgaben des aktuellen Branches, Agenten-Aufträge,
  wartende Freigaben (Doppelklick öffnet die Weboberfläche).
- **Kontextmenü im Editor:** „Als Wissen speichern“ (Auswahl als Dokument mit Code-Anker),
  „Code-Anker kopieren“ (genau über die PSI: Datei + Symbol bzw. Zeilenbereich),
  „Snippet einfügen …“ (Bibliothek, 5j).
- **Fehler aus der Run-Konsole** (Exit ≠ 0) gehen an errorsmith: bekannte Lösung als
  Mitteilung, das Vorkommen wird gezählt.

## Bauen

Java 17 (wird über die Toolchain geladen) und Gradle 8.14+ oder 9:

```bash
cd integrations/intellij
gradle buildPlugin          # → build/distributions/skillsmith-intellij-0.1.0.zip
```

Sperrt die Firma Maven Central oder die JetBrains-Repos, zu Hause bauen und die ZIP-Datei
mitnehmen – oder gegen eine installierte IDE bauen (braucht nur Maven Central für Kotlin):

```bash
gradle buildPlugin -PlocalIde="/Applications/IntelliJ IDEA.app"
```

## Installieren

Einstellungen → Plugins → Zahnrad → „Install Plugin from Disk…“ → ZIP auswählen.
Store-Verzeichnis unter Einstellungen → Tools → skillsmith (leer = wie das Plugin).
