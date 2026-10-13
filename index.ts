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
 * opencode 2 (opencode2): "plugins": ["./plugins/skillsmith"] – see server.ts.
 *
 * See README.md (usage) and AGENTS.md (architecture).
 */
import { createServer } from "./src/host/v1"
import { setup } from "./src/host/v2"

// opencode 1.x calls `server`, opencode 2 calls `setup` (it also finds server.ts in the plugin directory)
export default {
  id: "skillsmith",
  server: createServer,
  setup,
}
