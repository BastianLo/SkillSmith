/**
 * Static export (idea 13): knowledge and glossary as an HTML or Markdown package, e.g.
 * for the team wiki. Written below state/exports/<date-time>/; private documents only
 * when asked. HTML: one page per entry plus an index and a single-file "alles.html".
 */
import { join } from "node:path"
import type { Entry, Kind } from "../types"
import { ensureDir, writeFileAtomic } from "../util/fs"
import { escapeHtml, renderMarkdown } from "../util/markdown"
import type { Ctx } from "./context"
import { isPrivate, meaningsOf, spec } from "./kinds"

const CSS = `body{font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;color:#1f2328}a{color:#0b62c4}pre{background:#f5f6f8;padding:.8rem;overflow:auto;border-radius:6px}code{font-family:ui-monospace,Menlo,monospace;font-size:.9em}table{border-collapse:collapse}td,th{border:1px solid #d0d7de;padding:.3rem .5rem}h1{font-size:1.6rem}nav{font-size:.9rem;margin-bottom:1rem}.broken{color:#9a6700;text-decoration:underline dotted}.meta{color:#57606a;font-size:.85rem}`

export async function exportStatic(ctx: Ctx, opts: { format: "html" | "md"; kinds: string[]; includePrivate: boolean }): Promise<{ dir: string; count: number; files: string[]; single?: string }> {
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16)
  const dir = join(ctx.store.stateDir, "exports", `${stamp}-${opts.format}`)
  ensureDir(dir)
  const kinds = opts.kinds.filter((k): k is Kind => ["knowledge", "glossary", "skill", "error"].includes(k))
  const entries: Entry[] = kinds.flatMap((k) => ctx.store.list(k).filter((e) => e.tier !== "archive" && (opts.includePrivate || !isPrivate(e))))
  const ids = new Set(entries.map((e) => `${e.kind}:${e.name}`))
  const fileOf = (e: Pick<Entry, "kind" | "name">) => `${e.kind}-${e.name}.${opts.format === "html" ? "html" : "md"}`
  const files: string[] = []
  const link = (target: string) => {
    const t = ctx.links.resolve(target)
    if (!t || !ids.has(t.id)) return undefined
    return { href: fileOf(t), title: t.title }
  }
  const glossaryText = (e: Entry) =>
    meaningsOf(e.fields.meanings)
      .map((m) => `- **${m.expansion}**${m.context ? ` (${m.context})` : ""}: ${m.description}`)
      .join("\n")
  for (const e of entries) {
    const body = e.kind === "glossary" ? `${glossaryText(e)}\n\n${e.body}` : e.body
    const file = fileOf(e)
    if (opts.format === "md") {
      const md = body.replace(/\[\[([^\[\]|#\n]+)(?:#([^\[\]|\n]+))?(?:\|([^\[\]\n]+))?\]\]/g, (m, target: string, _s, label?: string) => {
        const r = link(target.trim())
        return r ? `[${label ?? target}](${r.href})` : (label ?? target)
      })
      writeFileAtomic(join(dir, file), `# ${e.title}\n\n${e.description ? `${e.description}\n\n` : ""}${md}\n`)
    } else {
      writeFileAtomic(
        join(dir, file),
        `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(e.title)}</title><style>${CSS}</style></head><body><nav><a href="index.html">← Übersicht</a></nav><h1>${escapeHtml(e.title)}</h1><p class="meta">${escapeHtml(spec(e.kind).label)}${e.tags.length ? ` · ${e.tags.map((t) => `#${escapeHtml(t)}`).join(" ")}` : ""}${e.meta?.updatedAt ? ` · Stand ${e.meta.updatedAt.slice(0, 10)}` : ""}</p>${e.description ? `<p><em>${escapeHtml(e.description)}</em></p>` : ""}${renderMarkdown(body, { link })}</body></html>\n`,
      )
    }
    files.push(file)
  }
  const sorted = [...entries].sort((a, b) => a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title))
  if (opts.format === "md") {
    writeFileAtomic(join(dir, "index.md"), `# Wissen (Export ${stamp})\n\n${sorted.map((e) => `- [${e.title}](${fileOf(e)}) – ${spec(e.kind).label}`).join("\n")}\n`)
    return { dir, count: files.length, files: ["index.md", ...files] }
  }
  writeFileAtomic(
    join(dir, "index.html"),
    `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Wissen</title><style>${CSS}</style></head><body><h1>Wissen</h1><p class="meta">Export vom ${stamp} · ${files.length} Seiten</p><ul>${sorted.map((e) => `<li><a href="${fileOf(e)}">${escapeHtml(e.title)}</a> <span class="meta">${escapeHtml(spec(e.kind).label)}</span></li>`).join("")}</ul></body></html>\n`,
  )
  // one self-contained file with every page (anchors instead of files)
  const anchor = (e: Pick<Entry, "kind" | "name">) => `${e.kind}-${e.name}`
  const singleLink = (target: string) => {
    const t = ctx.links.resolve(target)
    return t && ids.has(t.id) ? { href: `#${anchor(t)}`, title: t.title } : undefined
  }
  const single = join(dir, "alles.html")
  writeFileAtomic(
    single,
    `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Wissen</title><style>${CSS} section{border-top:1px solid #d0d7de;margin-top:2rem}</style></head><body><h1>Wissen</h1><ul>${sorted.map((e) => `<li><a href="#${anchor(e)}">${escapeHtml(e.title)}</a></li>`).join("")}</ul>${sorted
      .map((e) => `<section id="${anchor(e)}"><h2>${escapeHtml(e.title)}</h2>${renderMarkdown(e.kind === "glossary" ? `${glossaryText(e)}\n\n${e.body}` : e.body, { link: singleLink })}</section>`)
      .join("")}</body></html>\n`,
  )
  return { dir, count: files.length, files: ["index.html", "alles.html", ...files], single }
}
