/**
 * opencode 2 entrypoint: opencode2 resolves `<plugin directory>/server` first.
 *
 *   "plugins": ["~/.config/opencode/plugins/skillsmith"]
 * or with options:
 *   "plugins": [{ "package": "~/.config/opencode/plugins/skillsmith", "options": { "writeMode": "shadow" } }]
 *
 * opencode 1.x loads index.ts (`server` hook); see src/host/v2.ts for the adapter.
 */
import { setup } from "./src/host/v2"

export default {
  id: "skillsmith",
  setup,
}
