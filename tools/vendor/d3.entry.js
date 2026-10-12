// Entry of the d3-force bundle for the web view (built by tools/vendor/build.sh).
// Exposes the used d3 APIs as a global `window.d3` so the build-free ES-module
// frontend can render the graph without importing anything (CSP: no CDN).
import { forceSimulation, forceLink, forceManyBody, forceCollide, forceCenter, forceX, forceY, forceRadial } from "d3-force"
import { drag } from "d3-drag"
import { zoom, zoomIdentity } from "d3-zoom"
import { select } from "d3-selection"

window.d3 = { forceSimulation, forceLink, forceManyBody, forceCollide, forceCenter, forceX, forceY, forceRadial, drag, zoom, zoomIdentity, select }
