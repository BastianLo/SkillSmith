/**
 * skillsmith – self-maintaining knowledge for opencode:
 *   skillsmith (skills), docsmith (knowledge base + glossary),
 *   errorsmith (errors with fixes), toolsmith (tested Python scripts),
 *   memorysmith (decisions, conventions, experiences, work states, results),
 *   doctor (relations and conflicts between all entries), and the web workplace (/smith-web):
 *   documents, tasks and board, projects with pipeline, agent tasks, audit log, statistics.
 *
 * Add to opencode.json:
 *   "plugin": ["./plugins/skillsmith/index.ts"]
 * or with options:
 *   "plugin": [["./plugins/skillsmith/index.ts", { "writeMode": "shadow" }]]
 *
 * See README.md (usage) and AGENTS.md (architecture).
 */
import { createServer } from "./src/host/v1"

export default {
  id: "skillsmith",
  server: createServer,
}
