/**
 * End-to-end test against a real opencode server (1.18.x) with a scripted mock LLM.
 *
 *   OPENCODE_BIN=/path/to/opencode bun test/e2e/run.ts
 *
 * Creates an isolated HOME/XDG tree, installs the plugin like a user would
 * (copy into ~/.config/opencode/plugins/skillsmith + one line in opencode.json)
 * and walks through the acceptance criteria of all four smiths. The global
 * default model deliberately does NOT exist (like the LiteLLM setup in the
 * bug report): background agents must use the session's model.
 * Phase 2 restarts the server with an unknown reviewerModel and checks that
 * reviews are postponed instead of dropped.
 * Exit code 0 = all checks passed.
 */
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { Database } from "bun:sqlite"
import { startMock, textOf, type MockReply, type MockRequest } from "./mock-llm"

const PLUGIN_SRC = resolve(import.meta.dir, "..", "..")
const OPENCODE = process.env.OPENCODE_BIN ?? "opencode"
const ROOT = resolve(process.env.E2E_DIR ?? join(PLUGIN_SRC, ".e2e"))
rmSync(ROOT, { recursive: true, force: true })
const HOME = join(ROOT, "home")
const PROJECT = join(ROOT, "project")
const CONFIG = join(HOME, ".config", "opencode")
const STORE = join(HOME, ".local", "share", "skillsmith")
const MODEL = { providerID: "mock", modelID: "mock-1" }

// ---------------------------------------------------------------------------------
let failures = 0
const results: string[] = []
function check(name: string, ok: boolean, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` – ${detail}` : ""}`)
  console.log(`${ok ? "✔" : "✘"} ${name}${detail ? ` – ${detail}` : ""}`)
  if (!ok) failures++
}
async function waitFor<T>(label: string, fn: () => T | Promise<T>, timeoutMs = 60_000, every = 500): Promise<T | undefined> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn()
      if (v) return v
    } catch {
      // retry
    }
    await Bun.sleep(every)
  }
  console.log(`  (timeout waiting for ${label})`)
  return undefined
}
const git = (...args: string[]) => execFileSync("git", ["-C", STORE, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
const subjects = () => {
  try {
    return git("log", "--format=%s").trim().split("\n")
  } catch {
    return []
  }
}
const sys = (r: MockRequest) => textOf(r.messages.find((m) => m.role === "system")?.content)
const allText = (r: MockRequest) => r.messages.map((m) => textOf(m.content)).join("\n")
const lastUser = (r: MockRequest) => textOf([...r.messages].reverse().find((m) => m.role === "user")?.content)
const toolResultsAfterLastUser = (r: MockRequest) => {
  let idx = -1
  r.messages.forEach((m, i) => {
    if (m.role === "user") idx = i
  })
  return r.messages.slice(idx + 1).filter((m) => m.role === "tool")
}
const lastToolResult = (r: MockRequest) => textOf([...r.messages].reverse().find((m) => m.role === "tool")?.content)
const toolNames = (r: MockRequest) => (r.tools ?? []).map((t) => t.function.name)
const smithOf = (r: MockRequest): string | undefined =>
  /You are smith-doctor\b/.test(sys(r)) ? "doctor" : /You are (skillsmith|docsmith|errorsmith|toolsmith|memorysmith)-(reviewer|curator)/.exec(sys(r))?.slice(1, 3).join("-")
const isBackground = (r: MockRequest) => !!smithOf(r)

// ---------------------------------------------------------------------------------
// seed a v1 store (meta/<name>.json) for migration + lifecycle + curator checks
function seedSkill(tier: string, name: string, description: string, body: string, ageDays: number) {
  const dir = join(STORE, "skills", tier, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`)
  const at = new Date(Date.now() - ageDays * 86_400_000).toISOString()
  mkdirSync(join(STORE, "meta"), { recursive: true })
  writeFileSync(join(STORE, "meta", `${name}.json`), JSON.stringify({ name, createdAt: at, createdBy: "reviewer", updatedAt: at, tierChangedAt: at, history: [] }, null, 2))
}
const SEED_BODY = (extra: string) =>
  `## When to use\nWhen releasing the payments service.\n\n## Steps\n1. Run \`./gradlew test\`\n2. Run \`./gradlew release\`\n${extra}\n\n## Pitfalls\n- Release needs a clean working tree because the plugin checks git status.\n\n## Verification\n- Tag exists on origin.`
seedSkill("active", "seed-release-a", "Release the payments service with gradle", SEED_BODY("3. Push the tag"), 1)
seedSkill("active", "seed-release-b", "Release payments service via gradle release task", SEED_BODY("3. Push tags to origin"), 1)
seedSkill("active", "old-unused-skill", "Something nobody used for a month", "## Steps\n1. Do the old thing.", 30)
// vectors in the file format of v2.1/v2.2 → migrated into SQLite on startup
{
  const legacy = join(STORE, "state", "embeddings", "legacy-space-4")
  mkdirSync(legacy, { recursive: true })
  writeFileSync(join(legacy, "entry-skill.json"), JSON.stringify({ dims: 4, count: 2, keys: ["seed-release-a", "seed-release-b"], hashes: ["ha", "hb"] }))
  writeFileSync(join(legacy, "entry-skill.f32"), new Uint8Array(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0]).buffer))
}

// ---------------------------------------------------------------------------------
const DEPLOY_BODY = `## When to use
Before deploying a service of this team.

## Steps
1. \`make test\`
2. \`make deploy ENV=<env>\`

## Pitfalls
- Never deploy without green tests; the pipeline does not re-run them.

## Verification
- \`make status ENV=<env>\` shows the new version.`

const FAIL_CMD = `sh -c "echo 'ERROR: PKIX path building failed: unable to find valid certification path' >&2; exit 1"`
const OK_CMD = `sh -c "echo BUILD SUCCESS"`

const ERROR_BODY = `## Symptom
\`\`\`
ERROR: PKIX path building failed: unable to find valid certification path
\`\`\`

## Ursache
Das Root-Zertifikat der Firma fehlt im Truststore.

## Lösung
1. \`keytool -importcert -cacerts -alias corp-root -file corp-root.pem\`
2. Build erneut starten.

## Prüfung
Der Build meldet BUILD SUCCESS.`

const SCRIPT_CODE = `"""Count values of a CSV column."""
from __future__ import annotations

import argparse
import csv
import sys
from collections import Counter


def count_values(lines: list[str], column: int, delimiter: str = ";") -> dict[str, int]:
    return dict(Counter(row[column] for row in csv.reader(lines, delimiter=delimiter) if len(row) > column))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Count values of a CSV column")
    parser.add_argument("file")
    parser.add_argument("--column", type=int, default=0)
    args = parser.parse_args(argv)
    with open(args.file, encoding="utf-8") as fh:
        for value, n in sorted(count_values(fh.read().splitlines(), args.column).items()):
            print(f"{value}\\t{n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
`
const SCRIPT_TESTS = `import unittest

import count_csv_values as m


class T(unittest.TestCase):
    def test_counts(self):
        self.assertEqual(m.count_values(["a;1", "b;2", "a;3"], 0), {"a": 2, "b": 1})

    def test_column(self):
        self.assertEqual(m.count_values(["a;1", "b;1"], 1), {"1": 2})

    def test_short_rows(self):
        self.assertEqual(m.count_values(["a", "b;2"], 1), {"2": 1})
`

function step(r: MockRequest): number {
  return r.messages.filter((m) => m.role === "tool").length
}

const backgroundScript = (who: string, r: MockRequest): MockReply => {
  const job = allText(r)
  const s = step(r)
  const smith = who.split("-")[0]
  const done = (summary: string, extra: Record<string, unknown> = {}): MockReply => ({ tools: [{ name: `${smith}_done`, args: { summary, ...extra } }] })
  if (s > 8) return { text: "finished" }
  if (who === "skillsmith-reviewer") {
    if (job.includes("SCENARIO_CREATE")) {
      if (s === 0) return { tools: [{ name: "skill_search", args: { query: "deployment checklist make deploy", include_archived: true } }] }
      if (s === 1)
        return {
          tools: [
            {
              name: "skillsmith_create",
              args: {
                name: "deploy-checklist",
                description: "Team deployment checklist: make test before make deploy, verify with make status",
                tags: ["deployment", "make"],
                body: DEPLOY_BODY,
                reason: "user asked to turn the deployment routine into a skill",
                user_quote: "mach daraus bitte einen Skill",
              },
            },
          ],
        }
      if (s === 2) return done("created deploy-checklist")
      return { text: "done" }
    }
    if (job.includes("BUILD_TASK")) {
      // near-duplicate of deploy-checklist → must be rejected by the semantic duplicate gate
      if (s === 0)
        return {
          tools: [
            {
              name: "skillsmith_create",
              args: {
                name: "deploy-routine",
                description: "Team deployment checklist: make test before make deploy, verify with make status",
                tags: ["deployment", "make"],
                body: DEPLOY_BODY,
                reason: "user asked to remember",
                user_quote: "merk dir das bitte",
              },
            },
          ],
        }
      if (s === 1) return done(`create result: ${lastToolResult(r).slice(0, 300)}`)
      return { text: "done" }
    }
    if (job.includes("SUBAGENT_TASK")) {
      if (s === 0) return { tools: [{ name: "skillsmith_note", args: { summary: "Subagent checks need echo before failing commands are retried", keywords: ["subagent", "echo", "retry"] } }] }
      if (s === 1) return done("noted candidate from subagent run")
      return { text: "done" }
    }
    return s === 0 ? done("nothing to learn") : { text: "done" }
  }
  if (who === "docsmith-reviewer") {
    if (job.includes("MEMORY_TASK")) {
      if (s === 0)
        return {
          tools: [
            {
              name: "docsmith_knowledge_create",
              args: {
                name: "login-token-cookie",
                title: "Login-Token im HttpOnly-Cookie",
                description: "Das Login-Token liegt im HttpOnly-Cookie statt im localStorage (XSS-Schutz)",
                tags: ["login", "token", "cookie"],
                body: "## Überblick\n- Das Login-Token kommt ins HttpOnly-Cookie statt in den localStorage, wegen XSS.",
                evidence: "das Login-Token kommt ins HttpOnly-Cookie statt in den localStorage",
                reason: "user explained the token storage",
              },
            },
          ],
        }
      if (s === 1) return done("knowledge entry login-token-cookie")
      return { text: "done" }
    }
    if (job.includes("SCENARIO_CREATE") && job.includes("## ABBREVIATIONS")) {
      if (s === 0)
        return {
          tools: [
            {
              name: "docsmith_glossary_upsert",
              args: { term: "ZKB", expansion: "Zentrales Kundenbuch", description: "Führendes System für Kundenstammdaten", context: "Kundendaten", reason: "defined by the user" },
            },
          ],
        }
      if (s === 1)
        return {
          tools: [
            {
              name: "docsmith_knowledge_create",
              args: {
                name: "kundendaten-quelle",
                title: "Quelle der Kundendaten",
                description: "Woher die Kundendaten für Deployments kommen (ZKB)",
                tags: ["kundendaten", "zkb"],
                body: "## Überblick\n- Das ZKB (Zentrales Kundenbuch) liefert die Kundendaten für das Deployment.",
                evidence: "Das ZKB (Zentrales Kundenbuch) liefert die Kundendaten",
                reason: "user explained the data source",
              },
            },
          ],
        }
      if (s === 2) return done("glossary ZKB + knowledge entry")
      return { text: "done" }
    }
    return s === 0 ? done("nothing to document") : { text: "done" }
  }
  if (who === "errorsmith-reviewer") {
    if (job.includes("PKIX path building failed") && job.includes("RESOLVED")) {
      if (s === 0) return { tools: [{ name: "error_lookup", args: { query: "PKIX path building failed" } }] }
      if (s === 1)
        return {
          tools: [
            {
              name: "errorsmith_create",
              args: {
                name: "pkix-root-ca-missing",
                title: "PKIX path building failed",
                description: "PKIX path building failed: Root-CA fehlt im Truststore – keytool importcert",
                status: "solved",
                body: ERROR_BODY,
                tags: ["ssl", "java", "build", "deployments"],
                context: ["build"],
                chain_id: "E1",
                reason: "error and fix seen in the session",
              },
            },
          ],
        }
      if (s === 2) return done("documented PKIX error")
      return { text: "done" }
    }
    return s === 0 ? done("nothing") : { text: "done" }
  }
  if (who === "toolsmith-reviewer") {
    if (job.includes("CSV_TASK")) {
      if (s === 0)
        return {
          tools: [
            {
              name: "toolsmith_draft",
              args: {
                name: "count-csv-values",
                description: "Zählt die Werte einer CSV-Spalte (Häufigkeiten)",
                usage: "python3 count_csv_values.py FILE [--column N]",
                code: SCRIPT_CODE,
                tests: SCRIPT_TESTS,
                docs: "## Zweck\nZählt Werte.\n\n## Aufruf\n`python3 count_csv_values.py daten.csv --column 1`\n\n## Ein- und Ausgabe\nCSV → TSV\n\n## Grenzen\nUTF-8",
                capabilities: [],
                tags: ["csv", "report"],
              },
            },
          ],
        }
      if (s === 1) {
        if (!lastToolResult(r).includes("CHECK PASSED")) return done(`draft failed: ${lastToolResult(r).slice(0, 300)}`)
        return { tools: [{ name: "toolsmith_publish", args: { name: "count-csv-values", reason: "weekly CSV report", user_quote: "kannst du daraus ein Skript machen" } }] }
      }
      if (s === 2) return done("published count-csv-values")
      return { text: "done" }
    }
    return s === 0 ? done("nothing to automate") : { text: "done" }
  }
  if (who === "memorysmith-reviewer") {
    if (job.includes("## THE USER ASKED TO REMEMBER") && job.includes("dienstags")) {
      if (s === 0)
        return {
          tools: [
            {
              name: "memorysmith_save",
              args: {
                type: "vorgabe",
                topic: "deploy-tage",
                title: "Deployments nur dienstags",
                summary: "Deployments nur dienstags, nie freitags",
                body: "Vorgabe des Nutzers: Deployments nur dienstags, nie freitags.",
                tags: ["deployment"],
                evidence: "Deployments nur dienstags, nie freitags",
                reason: "the user asked to remember it",
              },
            },
          ],
        }
      if (s === 1) return done("remembered the deployment rule")
      return { text: "done" }
    }
    if (job.includes("MEMORY_TASK")) {
      if (s === 0)
        return {
          tools: [
            {
              name: "memorysmith_save",
              args: {
                type: "entscheidung",
                topic: "login-token",
                title: "Login-Token im HttpOnly-Cookie statt localStorage",
                summary: "Das Login-Token liegt im HttpOnly-Cookie, localStorage ist wegen XSS verworfen",
                body: "## Entscheidung\nHttpOnly-Cookie.\n\n## Begründung\nXSS.\n\n## Alternativen\n- localStorage (verworfen: XSS)",
                tags: ["login", "token", "cookie"],
                evidence: "das Login-Token kommt ins HttpOnly-Cookie statt in den localStorage, wegen XSS",
                reason: "decision stated by the user",
              },
            },
          ],
        }
      if (s === 1)
        return {
          tools: [
            {
              name: "memorysmith_save",
              args: {
                type: "vorgabe",
                topic: "lombok",
                title: "Kein Lombok in diesem Projekt",
                summary: "In diesem Projekt kein Lombok verwenden",
                body: "Vorgabe des Nutzers: In diesem Projekt bitte kein Lombok verwenden.",
                tags: ["java", "lombok"],
                evidence: "In diesem Projekt bitte kein Lombok verwenden",
                reason: "convention set by the user",
              },
            },
          ],
        }
      if (s === 2)
        return {
          tools: [
            {
              name: "memorysmith_state",
              args: { goal: "Login auf Cookie-Token umbauen", done: ["Entscheidung getroffen"], open: ["Logout löscht das Cookie noch nicht"], next: ["Gateway anpassen"], files: ["src/auth.ts"] },
            },
          ],
        }
      if (s === 3) {
        const stateId = /state:[a-z0-9-]+/.exec(lastToolResult(r))?.[0] ?? "state:unknown"
        return {
          tools: [
            {
              name: "memorysmith_relate",
              args: { from: stateId, to: "memory:billing-entscheidung-login-token", type: "part_of", strength: 4, description: "Die Arbeit am Branch setzt die Token-Entscheidung um." },
            },
          ],
        }
      }
      if (s === 4) return done("decision, convention, work state, relation")
      return { text: "done" }
    }
    if (job.includes("SUBAGENT_RESULT")) {
      if (s === 0)
        return {
          tools: [
            {
              name: "memorysmith_result",
              args: {
                title: "Check false schlägt immer fehl",
                question: "run the three checks",
                answer: "Der Check false schlägt immer fehl und muss vor dem Retry übersprungen werden.",
                evidence: "Der Check false schlägt immer fehl",
                reason: "subagent result",
              },
            },
          ],
        }
      if (s === 1) return done("kept the subagent result")
      return { text: "done" }
    }
    return s === 0 ? done("nothing to remember") : { text: "done" }
  }
  if (who === "doctor") {
    if (s === 0) {
      const pairs = [...job.matchAll(/## PAIR (P\d+)/g)].map((m) => m[1])
      if (!pairs.length) return done("no pairs")
      return {
        tools: pairs.map((p) => ({
          name: "doctor_relate",
          args: { pair: p, type: "supplements", strength: 4, description: "Beide beschreiben dasselbe Thema; B ergänzt A." },
        })),
      }
    }
    if (s >= 1) return done("judged all pairs")
  }
  if (who === "skillsmith-curator") {
    if (s === 0)
      return {
        tools: [
          {
            name: "skillsmith_merge",
            args: {
              sources: ["seed-release-a", "seed-release-b"],
              target: "payments-release",
              description: "Release the payments service with gradle (tests, release task, push tags)",
              tags: ["release", "gradle"],
              body: SEED_BODY("3. Push the tag to origin (`git push origin --tags`)"),
              reason: "two near-identical release skills",
            },
          },
        ],
      }
    if (s === 1) return done("merged release skills")
    return { text: "done" }
  }
  return s === 0 ? done("nothing") : { text: "done" }
}

const mainScript = (r: MockRequest): MockReply => {
  // triggers come from the user's own text – hints may quote earlier requests (e.g. "BUILD_TASK …")
  const lu = lastUser(r).replace(/<smith_hints[\s\S]*?<\/smith_hints>/g, "").replace(/<smith_memory[\s\S]*?<\/smith_memory>/g, "")
  const results = toolResultsAfterLastUser(r)
  const after = results.length
  if (!r.tools || r.tools.length === 0) return { text: "E2E title" }
  if (lu.includes("[skillsmith] Output the following text exactly")) {
    const idx = lu.indexOf("\n\n")
    return { text: idx >= 0 ? lu.slice(idx + 2).split("<smith_hints")[0].trim() : lu }
  }
  const firstUser = textOf(r.messages.find((m) => m.role === "user")?.content)
  // phase 4: agent task (proposal with a subagent that tries to write, implementation, review)
  if (firstUser.startsWith("Du prüfst die Umsetzung")) return { text: "Passt zum Vorschlag.\n```json\n[]\n```" }
  if (firstUser.includes("AGENT_SUBTASK_WRITE")) {
    const path = /AGENT_SUBTASK_WRITE (\S+)/.exec(firstUser)?.[1] ?? join(PROJECT, "probe.txt")
    if (after === 0) return { tools: [{ name: "write", args: { filePath: path, content: "probe\n" } }] }
    return { text: `Subagent fertig: ${textOf(results[0]?.content).slice(0, 200)}` }
  }
  if (firstUser.includes("PHASE 1 – VORSCHLAG")) {
    const wd = /git-Worktree (\S+)/.exec(firstUser)?.[1]?.replace(/[.,]$/, "") ?? PROJECT
    if (lu.includes("PHASE 2")) {
      if (after === 0) return { tools: [{ name: "write", args: { filePath: join(wd, "impl.txt"), content: "umgesetzt\n" } }] }
      return { text: "Umgesetzt: impl.txt angelegt, geprüft mit test -f impl.txt." }
    }
    if (after === 0) return { tools: [{ name: "task", args: { description: "Schreibprobe", prompt: `AGENT_SUBTASK_WRITE ${join(wd, "probe.txt")}`, subagent_type: "general" } }] }
    return { text: 'Plan steht.\n```json\n{"approach": "impl.txt anlegen", "files": ["impl.txt"], "steps": ["Datei anlegen"], "risks": [], "questions": [], "tests": ["test -f impl.txt"]}\n```' }
  }
  if (firstUser.includes("SUBAGENT_TASK")) {
    const cmds = ["echo one", "false", "echo two"]
    if (after < cmds.length) return { tools: [{ name: "bash", args: { command: cmds[after], description: `step ${after}` } }] }
    return { text: "subagent finished: SUBAGENT_RESULT Der Check false schlägt immer fehl und muss vor dem Retry übersprungen werden." }
  }
  if (lu.includes("RUN_SUBAGENT")) {
    if (after === 0) return { tools: [{ name: "task", args: { description: "run checks", prompt: "SUBAGENT_TASK run the three checks", subagent_type: "general" } }] }
    return { text: "delegated" }
  }
  if (lu.includes("BUILD_TASK")) {
    if (after === 0) return { tools: [{ name: "bash", args: { command: FAIL_CMD, description: "build" } }] }
    if (after === 1) return { tools: [{ name: "bash", args: { command: OK_CMD, description: "build again" } }] }
    return { text: "gebaut" }
  }
  if (lu.includes("CSV_TASK")) {
    if (after === 0) return { tools: [{ name: "bash", args: { command: "printf 'a;1\\nb;2\\na;3\\n' | cut -d';' -f1 | sort | uniq -c | sort -rn", description: "count" } }] }
    return { text: "gezählt" }
  }
  if (lu.includes("BUILD_AGAIN")) {
    if (after === 0) return { tools: [{ name: "bash", args: { command: FAIL_CMD, description: "build" } }] }
    return { text: "known error seen" }
  }
  if (lu.includes("SEARCH_PARAPHRASE")) {
    if (after === 0) return { tools: [{ name: "skill_search", args: { query: "Anwendung in Produktion ausrollen" } }] }
    return { text: "found" }
  }
  if (lu.includes("DOCS_SEARCH")) {
    if (after === 0) return { tools: [{ name: "docs_search", args: { query: "Wie bringe ich die Anwendung in Produktion" } }] }
    return { text: "found docs" }
  }
  if (lu.includes("HISTORY_SEARCH")) {
    if (after === 0) return { tools: [{ name: "history_search", args: { query: "PKIX path building failed beim Build" } }] }
    return { text: "found history" }
  }
  if (lu.includes("MEMORY_READ")) {
    const calls = [
      { name: "memory_search", args: { query: "Login Token Cookie" } },
      { name: "memory_read", args: { id: "memory:billing-entscheidung-login-token" } },
      { name: "graph_neighbors", args: { id: "memory:billing-entscheidung-login-token" } },
    ]
    if (after < calls.length) return { tools: [calls[after]] }
    return { text: "read memories" }
  }
  if (lu.includes("READ_TOOLS")) {
    const calls = [
      { name: "glossary_lookup", args: { query: "ZKB" } },
      { name: "knowledge_search", args: { query: "Kundendaten Quelle" } },
      { name: "error_lookup", args: { query: "PKIX path building failed" } },
      { name: "script_read", args: { name: "count-csv-values" } },
      { name: "knowledge_list", args: {} },
      { name: "script_list", args: {} },
    ]
    if (after < calls.length) return { tools: [calls[after]] }
    return { text: "read everything" }
  }
  return { text: "ok" }
}

const mock = startMock({
  log: join(ROOT, "requests.jsonl"),
  async respond(r) {
    const who = smithOf(r)
    // web assistant (knowledge chat): answers with a link to its source
    if (/writing and research assistant of skillsmith/.test(sys(r))) return { text: "Gateway-Neustart nur nach Freigabe, siehe [[e2e-betriebsnotiz]]." }
    if (who) {
      await Bun.sleep(400) // makes parallel smith runs overlap measurably
      return backgroundScript(who, r)
    }
    return mainScript(r)
  },
})

// ---------------------------------------------------------------------------------
// install like a user would
mkdirSync(join(CONFIG, "plugins"), { recursive: true })
mkdirSync(PROJECT, { recursive: true })
cpSync(join(PLUGIN_SRC, "index.ts"), join(CONFIG, "plugins", "skillsmith", "index.ts"))
cpSync(join(PLUGIN_SRC, "src"), join(CONFIG, "plugins", "skillsmith", "src"), { recursive: true })
cpSync(join(PLUGIN_SRC, "package.json"), join(CONFIG, "plugins", "skillsmith", "package.json"))
function writeConfig(extra: Record<string, unknown> = {}) {
  writeFileSync(
    join(CONFIG, "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        // the global default model does NOT exist (like litellm/google/gemma-4-31b-it in the bug report)
        model: "mock/does-not-exist",
        small_model: "mock/mock-1",
        autoupdate: false,
        share: "disabled",
        permission: { "*": "allow" },
        // like a router combo ("Hermes" in 9router): a model name without provider – opencode reads it as
        // provider "mock-1" and fails with "Model not found: mock-1/." unless a model is passed explicitly
        agent: { hera: { mode: "primary", description: "Orchestrator mit Modell ohne Provider", model: "mock-1" } },
        provider: {
          mock: {
            npm: "@ai-sdk/openai-compatible",
            name: "Mock",
            options: { baseURL: mock.url, apiKey: "test" },
            models: { "mock-1": { name: "Mock 1", tool_call: true, limit: { context: 128000, output: 4096 } } },
          },
        },
        plugin: [
          [
            "./plugins/skillsmith/index.ts",
            {
              reviewThreshold: 3,
              idleReview: true,
              idleDelayMin: 0.03,
              idleMinNewMessages: 2,
              reviewSubagents: true,
              subagentMinToolCalls: 2,
              curatorIntervalDays: 365,
              toolsmith: { sandbox: "auto" },
              debug: true,
              ...extra,
            },
          ],
        ],
      },
      null,
      2,
    ),
  )
}
writeConfig()
writeFileSync(join(PROJECT, "README.md"), "# Projekt\n\nDie Kundendaten kommen aus dem ZKB.\n")
mkdirSync(join(PROJECT, "docs"), { recursive: true })
writeFileSync(
  join(PROJECT, "docs", "betrieb.md"),
  "# Betrieb\n\n## Auslieferung\nDer Billing-Dienst wird mit make deploy ENV=prod ausgerollt, nachdem make test grün war.\n\n## Monitoring\nDashboards liegen in Grafana unter billing-overview; Alarme gehen an das Team.\n",
)
execFileSync("git", ["init", "-q"], { cwd: PROJECT })
// a real project: remote, branch with a ticket, one commit (memorysmith scope)
execFileSync("git", ["checkout", "-q", "-b", "feature/T2-77-login"], { cwd: PROJECT })
execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/billing.git"], { cwd: PROJECT })
execFileSync("git", ["-c", "user.email=e2e@local", "-c", "user.name=e2e", "add", "-A"], { cwd: PROJECT })
execFileSync("git", ["-c", "user.email=e2e@local", "-c", "user.name=e2e", "commit", "-q", "-m", "init"], { cwd: PROJECT })

const env = {
  ...process.env,
  HOME,
  XDG_CONFIG_HOME: join(HOME, ".config"),
  XDG_DATA_HOME: join(HOME, ".local", "share"),
  XDG_CACHE_HOME: join(HOME, ".cache"),
  XDG_STATE_HOME: join(HOME, ".local", "state"),
  OPENCODE_DISABLE_AUTOUPDATE: "1",
}

let server: ReturnType<typeof Bun.spawn> | undefined
let port = 0
let client: ReturnType<typeof createOpencodeClient>
async function startServer(label: string): Promise<boolean> {
  port = 4400 + Math.floor(Math.random() * 1000)
  server = Bun.spawn([OPENCODE, "serve", "--port", String(port), "--hostname", "127.0.0.1", "--print-logs", "--log-level", "INFO"], {
    cwd: PROJECT,
    env,
    stdout: Bun.file(join(ROOT, `serve-${label}.out`)),
    stderr: Bun.file(join(ROOT, `serve-${label}.err`)),
  })
  client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}`, directory: PROJECT })
  return !!(await waitFor(
    "server",
    async () => (await fetch(`http://127.0.0.1:${port}/config?directory=${encodeURIComponent(PROJECT)}`, { signal: AbortSignal.timeout(90_000) })).ok,
    180_000,
    1000,
  ))
}
const data = <T = any>(res: any): T => {
  if (res?.error) throw new Error(JSON.stringify(res.error))
  return res.data as T
}
async function newSession(title: string): Promise<string> {
  return data<{ id: string }>(await client.session.create({ body: { title } })).id
}
async function say(id: string, text: string): Promise<string> {
  const res = data<any>(await client.session.prompt({ path: { id }, body: { model: MODEL, parts: [{ type: "text", text }] } }))
  return (res?.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("")
}
async function command(id: string, cmd: string, args = ""): Promise<string> {
  const res = data<any>(await client.session.command({ path: { id }, body: { command: cmd, arguments: args, model: "mock/mock-1" } as any }))
  return (res?.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("")
}
const journal = () =>
  existsSync(join(STORE, "state", "journal.jsonl"))
    ? readFileSync(join(STORE, "state", "journal.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : []
const readStore = (...p: string[]) => readFileSync(join(STORE, ...p), "utf8")
const logText = () => (existsSync(join(STORE, "state", "log", "skillsmith.log")) ? readStore("state", "log", "skillsmith.log") : "")

try {
  check("opencode server starts with the plugin", await startServer("1"))

  // 1 – registration ------------------------------------------------------------
  const agents = data<any[]>(await client.app.agents()).map((a) => a.name)
  const expectedAgents = [...["skillsmith", "docsmith", "errorsmith", "toolsmith", "memorysmith"].flatMap((s) => [`${s}-reviewer`, `${s}-curator`]), "smith-doctor"]
  check("reviewer + curator agents of all five smiths and the doctor registered", expectedAgents.every((a) => agents.includes(a)), agents.filter((a) => a.includes("smith")).join(","))
  const commands = data<any[]>(await client.command.list()).map((c) => c.name)
  const expectedCommands = ["smith-report", "smith-undo", "smith-curate", "knowledge", "glossary", "glossary-add", "glossary-open", "errors", "scripts", "scripts-test", "docs-search", "history", "memory", "remember", "forget", "resume", "smith-doctor", "smith-web"]
  check("slash commands registered", expectedCommands.every((c) => commands.includes(c)), `${commands.filter((c) => /smith|glossary|errors|scripts|knowledge|skills/.test(c)).length} commands`)
  const cfg = data<any>(await client.config.get())
  check("store active dir registered in skills.paths", (cfg.skills?.paths ?? []).some((p: string) => p.endsWith(join("skillsmith", "skills", "active"))))

  // 2 – migration + startup lifecycle --------------------------------------------
  const migrated = await waitFor("migration commit", () => subjects().find((s) => s === "skillsmith(command): migrate store to v2"), 40_000)
  check("v1 store migrated to v2 in one commit", !!migrated && existsSync(join(STORE, "meta", "skill", "seed-release-a.json")) && !existsSync(join(STORE, "meta", "seed-release-a.json")))
  const lifecycle = await waitFor("lifecycle commit", () => subjects().find((s) => s.startsWith("skillsmith(curator)") && s.includes("old-unused-skill")), 40_000)
  check("startup lifecycle moved unused skill to dormant", !!lifecycle && existsSync(join(STORE, "skills", "dormant", "old-unused-skill")), lifecycle)

  // 3 – session A: skillsmith + docsmith in parallel, session model --------------------
  const sA = await newSession("A")
  await say(sA, "Hallo SCENARIO_CREATE: wir deployen immer mit make deploy ENV=prod")
  await say(sA, "Vorher bitte immer make test laufen lassen. Das ZKB (Zentrales Kundenbuch) liefert die Kundendaten für das Deployment, das XKB kenne ich nicht.")
  await say(sA, "Super, mach daraus bitte einen Skill für unsere Deployment-Checkliste")
  const created = await waitFor("deploy-checklist", () => existsSync(join(STORE, "skills", "active", "deploy-checklist", "SKILL.md")), 60_000)
  check("skillsmith created skill deploy-checklist", !!created)
  const glossaryFile = await waitFor("glossary ZKB", () => existsSync(join(STORE, "glossary", "active", "zkb.md")), 60_000)
  check("docsmith wrote glossary entry ZKB (Abkürzung, Bedeutung, Beschreibung)", !!glossaryFile && readStore("glossary", "active", "zkb.md").includes("Zentrales Kundenbuch") && readStore("glossary", "active", "zkb.md").includes("Kundenstammdaten"))
  const knowledge = await waitFor("knowledge", () => existsSync(join(STORE, "knowledge", "active", "kundendaten-quelle.md")), 30_000)
  const kMeta = knowledge ? JSON.parse(readStore("meta", "knowledge", "kundendaten-quelle.json")) : {}
  check("docsmith wrote knowledge entry with evidence + tags", !!knowledge && kMeta.evidence?.[0]?.text?.includes("Zentrales Kundenbuch") && readStore("knowledge", "active", "kundendaten-quelle.md").includes("kundendaten"))
  const openAbbr = await waitFor("XKB candidate", () => existsSync(join(STORE, "candidates", "glossary", "abbr-xkb.json")), 30_000)
  check("unknown abbreviation XKB tracked as open glossary candidate (no guessing)", !!openAbbr && !existsSync(join(STORE, "glossary", "active", "xkb.md")))
  await waitFor("commits A", () => subjects().some((s) => s.startsWith("skillsmith(reviewer): create deploy-checklist")) && subjects().some((s) => s.startsWith("docsmith(reviewer):")), 30_000)
  const subjA = subjects()
  check(
    "one commit per smith run",
    subjA.filter((s) => s === "skillsmith(reviewer): create deploy-checklist").length === 1 && subjA.filter((s) => s.startsWith("docsmith(reviewer): create knowledge kundendaten-quelle")).length === 1 &&
      git("log", "-1", "--format=%B", "--grep", "create knowledge kundendaten-quelle").includes("- upsert glossary zkb"),
    subjA.filter((s) => s.includes("(reviewer)")).join(" | "),
  )
  const bgReqs = mock.requests.filter(isBackground)
  check("background agents use the session model, not the broken global default", bgReqs.length > 0 && bgReqs.every((r) => r.model === "mock-1"), [...new Set(bgReqs.map((r) => r.model))].join(","))
  const docReq = bgReqs.find((r) => smithOf(r) === "docsmith-reviewer" && allText(r).includes("SCENARIO_CREATE"))
  const docTools = docReq ? toolNames(docReq) : []
  check(
    "docsmith only has its own tools + read tools",
    docTools.includes("docsmith_glossary_upsert") && docTools.includes("knowledge_search") && !docTools.some((t) => /^(skillsmith|errorsmith|toolsmith|memorysmith|doctor)_|^bash$|^edit$|^write$/.test(t)),
    docTools.join(","),
  )
  check("docsmith job lists the abbreviations incl. definition", !!docReq && allText(docReq).includes('definition found (user): "Zentrales Kundenbuch"'))
  check("docsmith job contains the related project doc section (RAG)", !!docReq && allText(docReq).includes("docs/betrieb.md") && allText(docReq).includes("make deploy ENV=prod ausgerollt"))
  const lines = logText().split("\n")
  const startOf = (smith: string) => {
    const l = lines.find((x) => x.includes(`${smith} review`) && x.includes("started") && x.includes(sA))
    return l ? Date.parse(l.split(" ")[0]) : 0
  }
  const tSk = startOf("skillsmith")
  const tDoc = startOf("docsmith")
  check("smiths of one review run in parallel", !!tSk && !!tDoc && Math.abs(tSk - tDoc) < 1500, `${Math.abs(tSk - tDoc)} ms`)
  const mainReqs = mock.requests.filter((r) => !isBackground(r) && r.tools?.length)
  const lastMain = mainReqs[mainReqs.length - 1]
  const mainTools = toolNames(lastMain)
  check(
    "main agent sees all read tools but no write tools",
    ["skill_search", "skill_list", "knowledge_search", "knowledge_list", "glossary_lookup", "glossary_list", "error_lookup", "error_list", "script_search", "script_list", "docs_search", "history_search", "memory_search", "memory_list", "memory_read", "graph_neighbors"].every((t) => mainTools.includes(t)) &&
      !mainTools.some((t) => /^(skillsmith|docsmith|errorsmith|toolsmith|memorysmith|doctor)_/.test(t)),
  )

  // 4 – session C: errorsmith + toolsmith -----------------------------------------------
  const sC = await newSession("C")
  await say(sC, "BUILD_TASK bitte das Projekt bauen")
  await say(sC, "CSV_TASK Das mache ich jede Woche – kannst du daraus ein Skript machen? Zähl die Werte der ersten Spalte.")
  await say(sC, "danke, merk dir das bitte")
  const errFile = await waitFor("error entry", () => existsSync(join(STORE, "errors", "active", "pkix-root-ca-missing.md")), 90_000)
  const errText = errFile ? readStore("errors", "active", "pkix-root-ca-missing.md") : ""
  check("errorsmith documented the error with solution and signature", !!errFile && errText.includes("## Lösung") && errText.includes("sh: ERROR: PKIX path building failed"), errText.split("\n").find((l) => l.startsWith("signatures")))
  const errTags = errText.split("\n").find((l) => l.startsWith("tags")) ?? ""
  check("tag variant mapped onto the existing vocabulary (deployments → deployment)", errTags.includes('"deployment"') && !errTags.includes('"deployments"'), errTags)
  const scriptFile = await waitFor("script", () => existsSync(join(STORE, "scripts", "active", "count-csv-values", "count_csv_values.py")), 120_000)
  const sMeta = scriptFile ? JSON.parse(readStore("meta", "script", "count-csv-values.json")) : {}
  check("toolsmith built, tested and published a python script", !!scriptFile && sMeta.test?.status === "passed" && existsSync(join(STORE, "scripts", "active", "count-csv-values", "test_count_csv_values.py")), sMeta.test?.summary)
  const errReq = mock.requests.find((r) => smithOf(r) === "errorsmith-reviewer" && allText(r).includes("## ERROR CHAINS"))
  check("errorsmith job contains the resolved error chain", !!errReq && allText(errReq).includes("E1 (") && allText(errReq).includes("RESOLVED"))
  const dupReq = await waitFor(
    "duplicate attempt",
    () => mock.requests.find((r) => smithOf(r) === "skillsmith-reviewer" && allText(r).includes("BUILD_TASK") && step(r) === 1),
    60_000,
  )
  const dupOut = dupReq ? lastToolResult(dupReq) : ""
  check(
    "semantic duplicate gate rejects a near-copy of an existing skill",
    dupOut.includes("very similar") && dupOut.includes("deploy-checklist") && !existsSync(join(STORE, "skills", "active", "deploy-routine")),
    dupOut.slice(0, 160),
  )
  const toolReq = mock.requests.find((r) => smithOf(r) === "toolsmith-reviewer" && allText(r).includes("## AUTOMATION SIGNALS"))
  check("toolsmith job contains automation signals", !!toolReq && allText(toolReq).includes("user mentions automation"))

  const histC = await waitFor(
    "history record C",
    () => {
      const f = join(STORE, "state", "history.json")
      const rec = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).records?.[sC] : undefined
      return rec?.links?.some((l: any) => l.name === "pkix-root-ca-missing") && rec?.problems?.some((p: any) => p.resolved) ? rec : undefined
    },
    60_000,
  )
  check("session history: record with requests, solved error and linked entries", !!histC && histC.requests.some((q: string) => q.includes("BUILD_TASK")), histC ? JSON.stringify(histC.links) : "")

  // 5 – live known-error hint --------------------------------------------------------------
  const sD = await newSession("D")
  const beforeD = mock.requests.length
  await say(sD, "BUILD_AGAIN bitte nochmal bauen")
  const dReqs = mock.requests.slice(beforeD).filter((r) => !isBackground(r) && r.tools?.length)
  const afterTool = dReqs.find((r) => toolResultsAfterLastUser(r).length > 0)
  const toolOut = afterTool ? lastToolResult(afterTool) : ""
  check("failing command gets the documented solution appended (live hint)", toolOut.includes('<known_error source="errorsmith" name="pkix-root-ca-missing"') && toolOut.includes("keytool"), toolOut.slice(-160).replace(/\n/g, " "))
  const occ = await waitFor("occurrences", () => {
    const o = JSON.parse(readStore("state", "errors.json"))
    return Object.values<any>(o).find((x) => x.entry === "pkix-root-ca-missing")
  }, 10_000)
  check("error occurrence recorded with matched entry", !!occ && occ.sessions.length >= 2, occ ? `${occ.count}× in ${occ.sessions.length} sessions` : "")

  // 6 – combined hints + read tools ------------------------------------------------------------
  const sE = await newSession("E")
  const beforeE = mock.requests.length
  await say(sE, "Wie läuft die Deployment Checkliste mit make deploy, was ist das ZKB, und kann ich CSV Werte einer Spalte zählen?")
  const eReq = mock.requests.slice(beforeE).find((r) => !isBackground(r) && r.tools?.length)
  const hint = eReq ? lastUser(eReq) : ""
  check("combined hint: skill + glossary + script", hint.includes("<smith_hints") && hint.includes("deploy-checklist") && hint.includes("ZKB = Zentrales Kundenbuch") && hint.includes("count-csv-values"), hint.split("<smith_hints")[1]?.slice(0, 400).replace(/\n/g, " | "))
  const beforeR = mock.requests.length
  await say(sE, "READ_TOOLS bitte alles nachschlagen")
  const rReqs = mock.requests.slice(beforeR).filter((r) => !isBackground(r) && r.tools?.length)
  const finalR = rReqs[rReqs.length - 1]
  const outs = finalR ? toolResultsAfterLastUser(finalR).map((m) => textOf(m.content)) : []
  check("glossary_lookup returns meaning + description", outs[0]?.includes("Zentrales Kundenbuch") && outs[0]?.includes("Kundenstammdaten"), outs[0]?.slice(0, 120))
  check("knowledge_search finds the entry", !!outs[1]?.includes("kundendaten-quelle"))
  check("error_lookup returns the solution", !!outs[2]?.includes("keytool"))
  check("script_read shows how to run the script", !!outs[3]?.includes("count_csv_values.py --help") && !!outs[3]?.includes("tests: passed"))

  // 6b – semantic search: paraphrase without word overlap -----------------------------------------
  const embedStatus = await command(sA, "smith-embed", "sync")
  check("embeddings: model auto-detected and vectors built", embedStatus.includes("qwen3-embedding-8b") && /\d+ Vektoren/.test(embedStatus), embedStatus.split("\n").pop())
  const embedInfo = await command(sA, "smith-embed")
  const dbFile = join(STORE, "state", "embeddings", "vectors.sqlite")
  const rows = existsSync(dbFile)
    ? (() => {
        const db = new Database(dbFile, { readonly: true })
        try {
          return db.query("SELECT space, ns, count(*) AS n FROM vectors GROUP BY space, ns").all() as Array<{ space: string; ns: string; n: number }>
        } finally {
          db.close()
        }
      })()
    : []
  const leftovers = readdirSync(join(STORE, "state", "embeddings"), { recursive: true }).map(String).filter((f) => f.endsWith(".f32"))
  check(
    "vectors live in SQLite (incl. docs, sessions, tags), no namespace files",
    embedInfo.includes("Ablage: SQLite") && rows.some((r) => r.ns === "entry-skill" && r.space.startsWith("qwen3-embedding-8b")) && rows.some((r) => r.ns.startsWith("docs-")) && rows.some((r) => r.ns === "sessions") && leftovers.length === 0,
    rows.map((r) => `${r.ns}:${r.n}`).join(" "),
  )
  check("old vector files migrated into SQLite and removed", rows.some((r) => r.space === "legacy-space-4" && r.n === 2) && !existsSync(join(STORE, "state", "embeddings", "legacy-space-4")))
  const sP = await newSession("P")
  const beforeP = mock.requests.length
  await say(sP, "Wie bringe ich unseren Dienst in Produktion?")
  const pReq = mock.requests.slice(beforeP).find((r) => !isBackground(r) && r.tools?.length)
  const pHint = pReq ? lastUser(pReq) : ""
  check("semantic hint for a paraphrase (no shared words with the skill)", pHint.includes("<smith_hints") && pHint.includes("deploy-checklist"), pHint.split("<smith_hints")[1]?.slice(0, 200).replace(/\n/g, " | "))
  const beforeS = mock.requests.length
  await say(sP, "SEARCH_PARAPHRASE")
  const sReqs = mock.requests.slice(beforeS).filter((r) => !isBackground(r) && r.tools?.length)
  const searchOut = sReqs.length ? lastToolResult(sReqs[sReqs.length - 1]) : ""
  check("skill_search finds the skill by meaning", searchOut.includes("deploy-checklist"), searchOut.slice(0, 160).replace(/\n/g, " | "))
  check("queries carry the Qwen instruction, documents do not", mock.embeddings.some((b) => b.some((t) => t.startsWith("Instruct: "))) && mock.embeddings.some((b) => b.some((t) => t.startsWith("deploy checklist"))))
  const evalOut = await command(sA, "smith-embed", "eval")
  check("/smith-embed eval runs on real session data", evalOut.includes("Embedding-Auswertung") || evalOut.includes("Zu wenige Daten"), evalOut.split("\n")[0])

  // 6c – project docs RAG + similar earlier sessions ------------------------------------------------
  const beforeDS = mock.requests.length
  await say(sP, "DOCS_SEARCH")
  const dsReqs = mock.requests.slice(beforeDS).filter((r) => !isBackground(r) && r.tools?.length)
  const dsOut = dsReqs.length ? lastToolResult(dsReqs[dsReqs.length - 1]) : ""
  check("docs_search finds the project doc section by meaning", dsOut.includes("docs/betrieb.md:") && dsOut.includes("Auslieferung"), dsOut.slice(0, 160).replace(/\n/g, " | "))
  check("/docs-search", (await command(sA, "docs-search", "Grafana Dashboards")).includes("docs/betrieb.md"))
  const sF = await newSession("F")
  const beforeF = mock.requests.length
  await say(sF, "Der Build bricht wieder mit PKIX path building failed ab, was tun?")
  const fReq = mock.requests.slice(beforeF).find((r) => !isBackground(r) && r.tools?.length)
  const fHint = fReq ? lastUser(fReq) : ""
  check(
    "hint: similar earlier session with its solution and entries",
    fHint.includes("Ähnliche frühere Sessions") && fHint.includes("pkix-root-ca-missing") && fHint.includes("gelöst"),
    fHint.split("Ähnliche frühere Sessions")[1]?.slice(0, 220).replace(/\n/g, " | "),
  )
  const beforeHS = mock.requests.length
  await say(sF, "HISTORY_SEARCH")
  const hsReqs = mock.requests.slice(beforeHS).filter((r) => !isBackground(r) && r.tools?.length)
  const hsOut = hsReqs.length ? lastToolResult(hsReqs[hsReqs.length - 1]) : ""
  check("history_search returns the earlier session with its solution", hsOut.includes(sC) && hsOut.includes("Problem (gelöst)"), hsOut.slice(0, 200).replace(/\n/g, " | "))
  check("/history lists earlier sessions", (await command(sA, "history")).includes("Frühere Sessions"))

  // 7 – subagent review -----------------------------------------------------------------------
  const sS = await newSession("S")
  await say(sS, "RUN_SUBAGENT bitte delegieren")
  const subRun = await waitFor("subagent review", () => journal().find((j) => j.parent === sS && j.smith === "skillsmith"), 60_000)
  check("finished subagent session was reviewed", !!subRun, subRun ? `session ${subRun.session}` : "")
  check("subagent review noted a candidate", !!subRun && subRun.actions.some((a: any) => a.kind === "note") && readdirSync(join(STORE, "candidates", "skill")).length > 0)

  // 7b – memorysmith: decisions, conventions, work state, subagent results ---------------------
  const sqlite = <T,>(file: string, sql: string): T[] => {
    if (!existsSync(file)) return []
    const db = new Database(file, { readonly: true })
    try {
      return db.query(sql).all() as T[]
    } catch {
      return []
    } finally {
      db.close()
    }
  }
  const MEMDB = join(STORE, "state", "memory.sqlite")
  const sM = await newSession("M")
  await say(sM, "MEMORY_TASK Wir haben entschieden: das Login-Token kommt ins HttpOnly-Cookie statt in den localStorage, wegen XSS. In diesem Projekt bitte kein Lombok verwenden.")
  await say(sM, "Bitte merk dir das.")
  const decisionFile = join(STORE, "memories", "active", "billing-entscheidung-login-token.md")
  const decision = await waitFor("decision memory", () => existsSync(decisionFile) && existsSync(join(STORE, "memories", "active", "billing-vorgabe-lombok.md")), 90_000)
  const decText = decision ? readFileSync(decisionFile, "utf8") : ""
  check(
    "'merk dir' triggers memorysmith at once: decision with project, branch and ticket",
    !!decision && /status: "?gueltig/.test(decText) && /decided_by: "?user/.test(decText) && decText.includes("github.com/acme/billing") && decText.includes("feature/T2-77-login") && decText.includes("T2-77"),
    decText.split("\n").filter((l) => /^(status|project|branch|ticket):/.test(l)).join(" · "),
  )
  const states = await waitFor("work state", () => sqlite<any>(MEMDB, "SELECT * FROM states").find((x) => x.branch === "feature/T2-77-login"), 30_000)
  check("work state of the branch stored locally (memory.sqlite)", !!states && String(states.open).includes("Logout löscht das Cookie noch nicht") && states.project === "github.com/acme/billing")
  const rel = await waitFor("state relation", () => sqlite<any>(MEMDB, "SELECT * FROM relations").find((x) => x.type === "part_of" && x.to_id === "memory:billing-entscheidung-login-token"), 30_000)
  check("relation work state → decision stored with description", !!rel && String(rel.description).includes("Token-Entscheidung"))
  await waitFor("memorysmith commit", () => subjects().find((x) => x.startsWith("memorysmith(reviewer):")), 30_000)
  const memMsg = (() => {
    try {
      return git("log", "-1", "--format=%B", "--grep", "^memorysmith(reviewer)")
    } catch {
      return ""
    }
  })()
  check("memorysmith commit contains the memories, not the local work state", memMsg.includes("create memory billing-entscheidung-login-token") && memMsg.includes("create memory billing-vorgabe-lombok") && !memMsg.includes("state memory"), memMsg.split("\n")[0])

  // doctor: knowledge entry and decision describe the same → relation by the doctor
  const doctorLog = () => {
    try {
      return git("log", "--format=%B", "--grep", "^doctor(curator)")
    } catch {
      return ""
    }
  }
  const doctorCommit = await waitFor("doctor commit", () => doctorLog().includes("relate knowledge login-token-cookie") || doctorLog().includes("relate memory billing-entscheidung-login-token"), 180_000)
  const relOf = (kind: string, name: string) => (existsSync(join(STORE, "meta", kind, `${name}.json`)) ? JSON.parse(readStore("meta", kind, `${name}.json`)).relations ?? [] : [])
  const doctorRels = [...relOf("knowledge", "login-token-cookie"), ...relOf("memory", "billing-entscheidung-login-token")].filter((x: any) => x.source === "doctor")
  check("doctor judged the similar pair (knowledge ↔ decision) and committed the relation", !!doctorCommit && doctorRels.some((x: any) => x.type === "supplements" && x.description.includes("ergänzt")), subjects().find((x) => x.startsWith("doctor(curator):")))
  const conflictRows = sqlite<any>(MEMDB, "SELECT * FROM conflicts")
  check("doctor conflicts of the pair are resolved", conflictRows.some((c) => [c.a, c.b].includes("knowledge:login-token-cookie") && c.status === "resolved"), conflictRows.map((c) => `${c.id}:${c.status}`).join(" "))
  const docReqM = mock.requests.find((r) => smithOf(r) === "doctor")
  const docToolsM = docReqM ? toolNames(docReqM) : []
  check("doctor has only doctor tools + read tools", docToolsM.includes("doctor_relate") && docToolsM.includes("memory_read") && !docToolsM.some((t) => /^(skillsmith|docsmith|errorsmith|toolsmith|memorysmith)_|^bash$|^edit$/.test(t)), docToolsM.join(","))

  // subagent result captured in session S → memorysmith keeps it after /smith-review
  await command(sS, "smith-review")
  const result = await waitFor(
    "subagent result",
    () => sqlite<any>(MEMDB, "SELECT * FROM results").find((x) => String(x.answer).includes("Check false")) && sqlite<any>(MEMDB, "SELECT * FROM captures").some((c) => c.consumed === 1),
    90_000,
  )
  const caps = sqlite<any>(MEMDB, "SELECT * FROM captures")
  check("subagent answer captured and condensed into a result memory", !!result && caps.some((c) => c.session === sS && c.consumed === 1), `${caps.length} capture(s)`)

  // stand block in the first message of a new session + read tools
  const sN = await newSession("N")
  const beforeN = mock.requests.length
  await say(sN, "MEMORY_READ was steht an?")
  const nReqs = mock.requests.slice(beforeN).filter((r) => !isBackground(r) && r.tools?.length)
  const firstN = nReqs[0] ? textOf(nReqs[0].messages.filter((m) => m.role === "user").pop()?.content) : ""
  check(
    "stand block opens the session: work state, conventions, decisions",
    firstN.includes("<smith_memory") && firstN.includes("Logout löscht das Cookie noch nicht") && firstN.includes("Kein Lombok in diesem Projekt"),
    firstN.split("<smith_memory")[1]?.slice(0, 260).replace(/\n/g, " | "),
  )
  const nFinal = nReqs[nReqs.length - 1]
  const nOuts = nFinal ? toolResultsAfterLastUser(nFinal).map((m) => textOf(m.content)) : []
  check("memory_search finds decision and work state", !!nOuts[0]?.includes("memory:billing-entscheidung-login-token") && !!nOuts[0]?.includes("state:"), nOuts[0]?.slice(0, 200).replace(/\n/g, " | "))
  check("memory_read shows the full memory with its connections", !!nOuts[1]?.includes("## Begründung") && !!nOuts[1]?.includes("Verknüpfungen") && !!nOuts[1]?.includes("(eingehend)"), nOuts[1]?.split("Verknüpfungen")[1]?.slice(0, 200).replace(/\n/g, " | "))
  check("graph_neighbors lists related entries", !!nOuts[2]?.includes("knowledge:login-token-cookie") || !!nOuts[2]?.includes("state:"), nOuts[2]?.slice(0, 200).replace(/\n/g, " | "))
  const secondBefore = mock.requests.length
  await say(sN, "und sonst?")
  const n2 = mock.requests.slice(secondBefore).find((r) => !isBackground(r) && r.tools?.length)
  check("stand block only once per session", !!n2 && !lastUser(n2).includes("<smith_memory"))

  // compaction keeps the work state and reviews the session
  const beforeCompact = mock.requests.length
  try {
    await client.session.summarize({ path: { id: sM }, body: { providerID: "mock", modelID: "mock-1" } })
  } catch {
    // checked below
  }
  const compactReq = await waitFor("compaction request", () => mock.requests.slice(beforeCompact).find((r) => !isBackground(r) && allText(r).includes("<smith_memory")), 30_000)
  check("compaction prompt carries the remembered work state", !!compactReq)
  const compactJob = await waitFor("compaction review", () => logText().includes(`enqueued ${sM} (compaction`), 30_000)
  check("compaction queues a review of the session", !!compactJob)

  const remOut = await command(sM, "remember", "Deployments nur dienstags, nie freitags")
  const remFile = join(STORE, "memories", "active", "billing-vorgabe-deploy-tage.md")
  const rem = await waitFor("remember memory", () => existsSync(remFile), 90_000)
  check("/remember stores the user's words as a convention (no new messages needed)", remOut.includes("Wird gemerkt") && !!rem && readFileSync(remFile, "utf8").includes("dienstags"), remOut.split("\n")[0])

  // commands
  const memOut = await command(sA, "memory")
  check("/memory shows decisions, conventions and work states of the project", memOut.includes("Erinnerungen – billing") && memOut.includes("Kein Lombok") && memOut.includes("Logout löscht"), memOut.split("\n")[0])
  const resumeOut = await command(sA, "resume")
  check("/resume shows the work state of the branch", resumeOut.includes("Ziel: Login auf Cookie-Token umbauen") && resumeOut.includes("Gateway anpassen"))
  const docOut = await command(sA, "smith-doctor")
  check("/smith-doctor shows the status", docOut.includes("**Doktor**") && /gelöst: [1-9]/.test(docOut), docOut.split("\n")[1])
  const webOut = await command(sA, "smith-web")
  const link = /http:\/\/127\.0\.0\.1:(\d+)\/#t=([0-9a-f]+)/.exec(webOut)
  let webOk = false
  let webEntry: any
  if (link) {
    const h = { "x-smith-token": link[2] }
    const base = `http://127.0.0.1:${link[1]}`
    const stats = await fetch(`${base}/api/stats`, { headers: h })
    const denied = await fetch(`${base}/api/stats`)
    const page = await fetch(`${base}/`)
    webEntry = await (await fetch(`${base}/api/entry?id=${encodeURIComponent("memory:billing-entscheidung-login-token")}`, { headers: h })).json()
    webOk = stats.ok && denied.status === 401 && (page.headers.get("content-security-policy") ?? "").includes("script-src 'self'")
    writeFileSync(join(ROOT, "web.json"), JSON.stringify({ port: Number(link[1]), token: link[2] }))
  }
  check("/smith-web serves the web view (token, CSP)", webOk, link?.[0].replace(/#t=.*/, "#t=…"))
  const webRels = (webEntry?.relations ?? []) as any[]
  check(
    "web entry: full memory with every relation (type, direction, strength, description, source)",
    !!webEntry?.body?.includes("## Begründung") &&
      webRels.some((x) => x.direction === "in" && x.type === "part_of" && x.other.kind === "arbeitsstand" && x.description.includes("Token-Entscheidung")) &&
      webRels.some((x) => x.source === "doctor" && x.other.id === "knowledge:login-token-cookie"),
    webRels.map((x) => `${x.direction}:${x.type}:${x.other.id}`).join(" "),
  )

  // 7c – phase 4: web actions (one commit + audit), conflict 409, project, pipeline, agent task --------
  if (link) {
    const base = `http://127.0.0.1:${link[1]}`
    const tok = link[2]
    const act = async (action: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      const r = await fetch(`${base}/api/action`, { method: "POST", headers: { "x-smith-token": tok, "content-type": "application/json", origin: base }, body: JSON.stringify({ action, args, ...extra }) })
      return { status: r.status, body: (await r.json()) as any }
    }
    const get = async (path: string) => (await fetch(`${base}/api/${path}`, { headers: { "x-smith-token": tok } })).json() as Promise<any>
    const commitsBefore = subjects().length
    const doc = await act("doc.create", { title: "E2E Betriebsnotiz", body: "Gateway-Neustart nur nach Freigabe. Siehe [[skill:deploy-checklist]]." })
    const newSubjects = subjects().slice(0, subjects().length - commitsBefore)
    const docAudit = await get(`audit?target=${encodeURIComponent("knowledge:e2e-betriebsnotiz")}`)
    check("web action: exactly one commit with docsmith(web) and an audit event", doc.status === 200 && newSubjects.filter((x) => x.startsWith("docsmith(web): ")).length === 1 && docAudit.events.some((e: any) => e.actor === "user-web" && e.commit === doc.body.commit), `${doc.status} ${newSubjects.join(" | ")}`)
    const entry = await get(`entry?id=${encodeURIComponent("knowledge:e2e-betriebsnotiz")}`)
    await act("entry.save", { target: "knowledge:e2e-betriebsnotiz", body: "zweite Fassung" }, { base: entry.version })
    const stale = await act("entry.save", { target: "knowledge:e2e-betriebsnotiz", body: "veraltete Fassung" }, { base: entry.version })
    check("web action on a stale version → 409 with the diff since then", stale.status === 409 && stale.body.conflict === true && !!stale.body.diff, String(stale.status))
    const noOrigin = await fetch(`${base}/api/action`, { method: "POST", headers: { "x-smith-token": tok, "content-type": "application/json" }, body: JSON.stringify({ action: "note.quick", args: { text: "x" } }) })
    check("web action without own origin is refused (CSRF)", noOrigin.status === 403, String(noOrigin.status))

    // project with a pipeline and an agent task in its own worktree
    const app = join(ROOT, "app")
    mkdirSync(app, { recursive: true })
    writeFileSync(join(app, "README.md"), "# App\n")
    for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.email=e2e@local", "-c", "user.name=e2e", "commit", "-q", "-m", "init"]]) execFileSync("git", a, { cwd: app })
    const proj = await act("project.save", { name: "e2e-app", title: "E2E App", home_path: app, pipeline: { trigger: ["test"], stages: [{ name: "check", run: "test -f impl.txt && echo ok" }] } })
    const task = await act("task.create", { title: "impl.txt anlegen", project: "e2e-app", body: "Lege impl.txt an. Siehe [[e2e-betriebsnotiz]]." })
    const taskName = task.body.target?.replace(/^task:/, "")
    check("project with pipeline and task created via the web view", proj.status === 200 && task.status === 200 && !!taskName, `${proj.status} ${task.status} ${proj.body.error ?? ""}`)
    const assign = await act("agent.assign", { target: `task:${taskName}`, agent: "build", model: "mock/mock-1", workplace: "worktree" })
    const jobId = assign.body.data?.job
    check("agent task assigned (token, worktree, proposal phase without write tools)", assign.status === 200 && !!jobId, assign.body.error ?? assign.body.message)
    const awaiting = await waitFor("proposal", async () => ((await get(`job?id=${jobId}`)).job?.phase === "awaiting_approval" ? (await get(`job?id=${jobId}`)).job : undefined), 180_000, 1000)
    const workdir: string = awaiting?.workdir ?? ""
    const rejected = await get("audit?category=rejected&limit=50")
    check(
      "proposal phase: a subagent's write is blocked in the whole session tree and audited",
      !!awaiting && !existsSync(join(workdir, "probe.txt")) && rejected.events.some((e: any) => e.actor === "agent" && e.action === "write"),
      `${awaiting?.phase ?? "no proposal"} · sessions ${Object.keys(awaiting?.sessions ?? {}).length} · rejected ${rejected.events.length}`,
    )
    check("structured proposal parsed and stored at the job", awaiting?.proposals?.[0]?.approach === "impl.txt anlegen" && existsSync(join(workdir, ".git")), awaiting?.proposals?.[0]?.approach)
    await act("agent.approve", { job: jobId })
    const inTest = await waitFor("in_test", async () => {
      const j = (await get(`job?id=${jobId}`)).job
      return j?.phase === "in_test" || j?.phase === "error" ? j : undefined
    }, 240_000, 1000)
    const taskAfter = (await get(`task?id=${taskName}`)).task
    check("implementation in the worktree → pipeline green → review → card in test", inTest?.phase === "in_test" && existsSync(join(workdir, "impl.txt")) && inTest.pipelineFirstGreen === true && inTest.review?.status === "done" && taskAfter.status === "test", `${inTest?.phase} ${inTest?.error ?? ""} · ${taskAfter.status} · pipeline ${inTest?.pipelineFirstGreen}`)
    const diff = await get(`job/diff?id=${jobId}`)
    check("diff viewer data: the changed file of the worktree", diff.some((f: any) => f.path === "impl.txt"), diff.map((f: any) => f.path).join(","))
    const accept = await act("agent.accept", { job: jobId, mode: "merge" })
    const done = (await get(`task?id=${taskName}`)).task
    check("accept merges the branch into the project and sets the task to done (worktree removed)", accept.status === 200 && existsSync(join(app, "impl.txt")) && done.status === "erledigt" && !existsSync(workdir), `${accept.status} ${accept.body.message ?? accept.body.error}`)

    // agent with a model name without provider ("mock-1" like "Hermes"), no model chosen → repaired, the proposal arrives
    const agentsList = await get("agents")
    const hera = agentsList.find((a: any) => a.name === "hera")
    check("agent list flags a model without provider and names the fix", hera?.modelValid === false && hera?.modelFix === "mock/mock-1", JSON.stringify(hera))
    const task2 = await act("task.create", { title: "Zweite Planung", project: "e2e-app", body: "Nur planen." })
    const assign2 = await act("agent.assign", { target: task2.body.target, agent: "hera", workplace: "worktree" })
    const job2 = assign2.body.data?.job
    const planned = await waitFor("proposal hera", async () => {
      const j = (await get(`job?id=${job2}`)).job
      return j?.phase === "awaiting_approval" || j?.phase === "error" ? j : undefined
    }, 120_000, 1000)
    check("agent with model „mock-1“ (no provider) plans with mock/mock-1 instead of failing with „Model not found: mock-1/.“", planned?.phase === "awaiting_approval" && planned?.model === "mock/mock-1" && /mock-1/.test(planned?.modelNote ?? ""), `${assign2.status} ${planned?.phase} ${planned?.model} ${planned?.error ?? assign2.body.error ?? ""}`)
    if (job2) await act("agent.discard", { job: job2 }, { force: true }).then(() => undefined, () => undefined)
    const task3 = await act("task.create", { title: "Dritte Planung", project: "e2e-app" })
    const wrongModel = await act("agent.assign", { target: task3.body.target, agent: "build", model: "litellm/gibts-nicht", workplace: "home" })
    check("unknown chosen model is refused before a session starts (with the offered models)", wrongModel.status >= 400 && /gibt es in opencode nicht.*mock\/mock-1/.test(wrongModel.body.error ?? ""), `${wrongModel.status} ${String(wrongModel.body.error).slice(0, 160)}`)
    const chat = await act("chat.ask", { question: "Was gilt für Gateway-Neustarts?" })
    check("knowledge chat answers (assistant with an explicit, offered model)", chat.status === 200 && /e2e-betriebsnotiz/.test(chat.body.data?.answer ?? ""), `${chat.status} ${chat.body.error ?? chat.body.data?.answer}`)
  }

  // 8 – commands --------------------------------------------------------------------------------
  const report = await command(sA, "smith-report")
  check("/smith-report", report.includes("skillsmith Report") && report.includes("Glossar: 1 Begriffe") && report.includes("Skripte: 1 aktiv"), report.split("\n").slice(0, 3).join(" | "))
  const add = await command(sA, "glossary-add", "KWG | Kreditwesengesetz | Gesetz über das Kreditwesen | Recht")
  const kwgCommit = await waitFor("kwg commit", () => subjects()[0] === "docsmith(command): upsert glossary kwg", 10_000)
  check("/glossary-add writes and commits", add.includes("added glossary KWG") && !!kwgCommit, subjects()[0])
  check("/glossary ZKB", (await command(sA, "glossary", "ZKB")).includes("Zentrales Kundenbuch"))
  check("/glossary-open lists XKB", (await command(sA, "glossary-open")).includes("XKB"))
  check("/errors", (await command(sA, "errors")).includes("pkix-root-ca-missing"))
  check("/scripts", (await command(sA, "scripts", "csv")).includes("count-csv-values"))
  check("/knowledge", (await command(sA, "knowledge", "Kundendaten")).includes("kundendaten-quelle"))
  const pin = await command(sA, "smith-pin", "fehler pkix-root-ca-missing")
  const pinCommit = await waitFor("pin commit", () => subjects()[0] === "errorsmith(command): pin error pkix-root-ca-missing", 10_000)
  check("/smith-pin (kind + name) commits", !!pinCommit && pin.includes("pinned"), subjects()[0])
  const undo = await command(sA, "smith-undo")
  const emeta = JSON.parse(readStore("meta", "error", "pkix-root-ca-missing.json"))
  check("/smith-undo reverts the last run", undo.includes("Zurückgenommen") && !emeta.pinned && subjects()[0].startsWith("errorsmith(command): undo"), subjects()[0])

  // 9 – curator consolidation ------------------------------------------------------------------
  const cur = await command(sA, "smith-curate")
  check("/smith-curate starts the curator", cur.includes("Curator gestartet"))
  const merged = await waitFor("merge commit", () => subjects().find((s) => s.startsWith("skillsmith(curator): merge payments-release")), 60_000)
  check("curator merged similar skills (sources archived)", !!merged && existsSync(join(STORE, "skills", "active", "payments-release")) && existsSync(join(STORE, "skills", "archive", "seed-release-a")), merged)

  // 10 – clean state ------------------------------------------------------------------------------
  await waitFor("agent sessions cleaned", async () => data<any[]>(await client.session.list()).every((s) => !String(s.title).startsWith("skillsmith ·")), 30_000)
  const listed = data<any[]>(await client.session.list())
  check("no leftover background agent sessions", listed.every((s) => !String(s.title).startsWith("skillsmith ·")))
  // follow-up runs (the doctor re-checks pairs changed by the curator) may still be busy: wait for every run claim
  const runsDir = join(STORE, "state", "runs")
  await waitFor("background runs finished", () => (!existsSync(runsDir) || readdirSync(runsDir).length === 0) && git("status", "--porcelain").trim() === "" ? true : undefined, 90_000, 500)
  // local actions (work states, results, relations with a volatile end) have no commit
  const missing = journal().filter((j) => j.ok && j.actions.some((a: any) => a.applied && !a.local) && !j.commit)
  check("every run with applied changes has its own commit", missing.length === 0, missing.map((j) => j.run).join(","))
  // web actions refused on purpose above (unknown model) are user errors, not failed background runs
  const background = journal().filter((j) => j.actor !== "web")
  check("no background run failed", background.every((j) => j.ok), background.filter((j) => !j.ok).map((j) => `${j.smith}: ${j.error}`).join("; "))
  await Bun.sleep(1500)
  const status = git("status", "--porcelain").trim()
  check("store working tree clean (everything committed)", status === "", status)
  check("no 'dropping review job' in the log", !logText().includes("dropping review job"))

  // 11 – phase 2: unknown reviewerModel → reviews are postponed, never dropped ----------------
  server?.kill()
  await Bun.sleep(1500)
  writeConfig({ reviewerModel: "mock/nope-model", embedding: { baseURL: "http://127.0.0.1:9/v1", model: "qwen3-embedding-8b" } })
  check("server restarts with a broken reviewerModel", await startServer("2"))
  const sG = await newSession("G")
  const beforeG = mock.requests.length
  for (const t of ["eins SCENARIO_G", "zwei", "drei"]) await say(sG, t)
  const job = await waitFor(
    "postponed job",
    () => {
      const file = join(STORE, "state", "queue", `${sG}.json`)
      if (!existsSync(file)) return undefined
      const j = JSON.parse(readFileSync(file, "utf8"))
      return j.lastError ? j : undefined
    },
    60_000,
  )
  check("config error keeps the job with lastError and a retry time", !!job && /Model not found/.test(job.lastError) && Date.parse(job.notBefore) - Date.now() > 8 * 60_000, job?.lastError)
  check("no background LLM requests were attempted with the broken model", mock.requests.slice(beforeG).every((r) => !isBackground(r)))
  const gJournal = journal().filter((j) => j.session === sG)
  check("runs are journaled as failed (not silently lost)", gJournal.length > 0 && gJournal.every((j) => !j.ok))
  const stG = JSON.parse(readStore("state", "sessions", `${sG}.json`))
  check("session range stays unreviewed for the retry", !stG.lastReviewedMessageID && (stG.reviewFailures ?? 0) === 0)
  const embedAfter = await command(sG, "smith-embed")
  const skillVectors = Number(/entry-skill (\d+)/.exec(embedAfter)?.[1] ?? 0)
  check("after restart the vectors are loaded from SQLite (endpoint down, nothing re-embedded)", skillVectors > 0 && embedAfter.includes("Ablage: SQLite"), `entry-skill ${skillVectors}`)
  const sH = await newSession("H")
  const beforeH = mock.requests.length
  const t0 = Date.now()
  await say(sH, "Wie läuft die Deployment Checkliste mit make deploy?")
  const hReq = mock.requests.slice(beforeH).find((r) => !isBackground(r) && r.tools?.length)
  check("embedding endpoint down: hints fall back to BM25 without delay", !!hReq && lastUser(hReq).includes("deploy-checklist") && Date.now() - t0 < 15_000, `${Date.now() - t0} ms`)
} catch (err) {
  check("e2e run", false, String(err))
} finally {
  server?.kill()
  mock.server.stop(true)
  writeFileSync(join(ROOT, "results.txt"), results.join("\n") + "\n")
  console.log(`\n${results.length - failures}/${results.length} checks passed`)
  process.exit(failures ? 1 : 0)
}
