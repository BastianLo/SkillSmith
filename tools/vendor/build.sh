#!/bin/sh
# Rebuilds the vendored browser libraries of the web view (dev only – the plugin itself
# needs no npm install; the results are committed under src/web/static/vendor).
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../../src/web/static/vendor"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"
npm init -y >/dev/null
npm install --no-audit --no-fund uplot@1.6.32 mermaid@11.17.2 highlight.js@11.11.1 \
  @codemirror/state@6 @codemirror/view@6 @codemirror/commands@6 @codemirror/language@6 \
  @codemirror/lang-markdown@6 @codemirror/autocomplete@6 @codemirror/search@6 @lezer/highlight@1 \
  d3-force@3 d3-drag@3 d3-zoom@3 d3-selection@3 >/dev/null
cp "$here/codemirror.entry.js" "$here/highlight.entry.js" "$here/d3.entry.js" .
bun build ./codemirror.entry.js --format esm --minify --outfile "$out/codemirror.js"
bun build ./highlight.entry.js --format esm --minify --outfile "$out/highlight.js"
bun build ./d3.entry.js --format=iife --name=d3 --minify --outfile="$out/d3-force.min.js"
cp node_modules/uplot/dist/uPlot.iife.min.js "$out/uplot.min.js"
cp node_modules/uplot/dist/uPlot.min.css "$out/uplot.min.css"
cp node_modules/mermaid/dist/mermaid.min.js "$out/mermaid.min.js"
cp node_modules/uplot/LICENSE "$out/LICENSE-uplot.txt"
cp node_modules/mermaid/LICENSE "$out/LICENSE-mermaid.txt"
cp node_modules/highlight.js/LICENSE "$out/LICENSE-highlightjs.txt"
cp node_modules/@codemirror/view/LICENSE "$out/LICENSE-codemirror.txt"
cp node_modules/d3-force/LICENSE "$out/LICENSE-d3-force.txt"
echo "vendor libraries written to $out"
