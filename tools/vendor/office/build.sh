#!/bin/sh
# Rebuilds the ooxml bundles (dev only, results are committed):
#   src/web/static/vendor/office/   browser: PowerPoint viewer/editor (pptx/), Word editor (docx.js)
#   src/vendor/office-core.js       server (Bun): read and change .pptx/.docx for the AI edits
# ooxml by ChristopherVR (Apache-2.0); exact versions, install scripts off.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
root="$here/../../.."
web="$root/src/web/static/vendor/office"
core="$root/src/vendor"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"
npm init -y >/dev/null
npm install --no-audit --no-fund --ignore-scripts --save-exact \
  pptx-vanilla-viewer@3.33.2 pptx-viewer-core@4.13.5 docx-vanilla-viewer@0.5.0 docx-core@0.1.13 jszip@3.10.1 >/dev/null
cp "$here/pptx.entry.js" pptx.js && cp "$here/docx.entry.js" docx.js && cp "$here/core.entry.ts" .
rm -rf "$web" && mkdir -p "$web" "$core"
bun "$here/build.ts" "$work" "$web" "$core"
cp node_modules/pptx-vanilla-viewer/dist/styles.css "$web/pptx.css"
node -e '
const fs = require("fs"), path = require("path")
const lines = ["Third-party packages bundled in the office vendor files (name@version: license):", ""]
const seen = new Set()
const walk = (dir) => { for (const d of fs.readdirSync(dir)) { if (d.startsWith(".")) continue; const p = path.join(dir, d); if (d.startsWith("@")) { walk(p); continue } const f = path.join(p, "package.json"); if (!fs.existsSync(f)) continue; const j = JSON.parse(fs.readFileSync(f)); const k = j.name + "@" + j.version; if (!seen.has(k)) { seen.add(k); lines.push(k + ": " + (typeof j.license === "string" ? j.license : JSON.stringify(j.license ?? "see package"))) } } }
walk("node_modules")
fs.writeFileSync(process.argv[1], lines.join("\n") + "\n")
' "$web/THIRD-PARTY.txt"
cp node_modules/pptx-viewer-core/LICENSE "$web/LICENSE-ooxml.txt" 2>/dev/null || cp node_modules/pptx-vanilla-viewer/LICENSE "$web/LICENSE-ooxml.txt"
cp "$web/LICENSE-ooxml.txt" "$web/THIRD-PARTY.txt" "$core/"
echo "office bundles written to $web and $core"
