// bun build of the ooxml bundles (called by build.sh inside a temporary npm project).
// Browser: one build for both viewers, so shared code (yjs, ooxml-core …) exists once.
const [work, web, core] = process.argv.slice(2)
const r1 = await Bun.build({ entrypoints: [`${work}/pptx.js`, `${work}/docx.js`], outdir: web, target: "browser", format: "esm", minify: true, splitting: true, naming: { entry: "[name].js", chunk: "chunks/[name]-[hash].js" } })
const r3 = await Bun.build({ entrypoints: [`${work}/core.entry.ts`], outdir: core, target: "bun", format: "esm", minify: true, external: ["@napi-rs/canvas"], naming: { entry: "office-core.js" } })
for (const r of [r1, r3]) if (!r.success) { console.error(r.logs.map(String).join("\n")); process.exit(1) }
