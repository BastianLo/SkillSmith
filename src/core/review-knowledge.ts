/**
 * Review knowledge from GitHub (5f): recurring review comments of colleagues become
 * conventions, and before an own PR a read-only session checks the diff against them.
 *
 *  - extractor (job "review-extract", daily): review comments of new PRs of the configured
 *    repositories – through `gh api` (deterministic) or, without gh, through a read-only
 *    session that uses the user's GitHub MCP and answers with JSON;
 *  - bundling: similar comments are grouped (lexical similarity of the normalised text);
 *    from reviews.minComments comments of at least reviews.minPersons people a candidate for
 *    a convention arises, all comments attached as provenance;
 *  - confirm: a candidate becomes a convention (memory "vorgabe", project or global) or a
 *    skill; rejected candidates are remembered;
 *  - pre-PR check: a read-only session compares the diff of the branch with the confirmed
 *    conventions; findings at file and line with a link to the rule and the original comments.
 *
 * People appear only as the source of a comment; there is no evaluation per person.
 */
import { join } from "node:path"
import type { Run } from "../types"
import { readJson, withLock, writeJsonAtomic } from "../util/fs"
import { fold, nowIso, sha, stem, tokenize, truncate } from "../util/text"
import { runAgentSession } from "./agent-runner"
import type { Ctx } from "./context"
import { str } from "./frontmatter"
import { gitIn } from "./git"
import { GuardError } from "./ops"
import { execCapture } from "./pyworkshop"
import { ASSISTANT_AGENT } from "./prompts"
import { resolveModel } from "./reviewer"

export interface ReviewComment {
  id: string
  repo: string
  pr: number
  author: string
  body: string
  path?: string
  line?: number
  url?: string
  at: string
}

export interface ReviewCandidate {
  id: string
  /** representative comment (shortest of the most similar) */
  summary: string
  comments: string[]
  persons: number
  repos: string[]
  status: "offen" | "bestaetigt" | "abgelehnt"
  createdAt: string
  decidedAt?: string
  /** memory / skill created from it */
  entry?: string
}

interface State {
  comments: Record<string, ReviewComment>
  candidates: Record<string, ReviewCandidate>
  /** last fetch per repository */
  fetched: Record<string, string>
}

export interface PrFinding {
  file?: string
  line?: number
  rule: string
  text: string
  comments: string[]
}

const STOP = new Set(["bitte", "please", "the", "this", "that", "here", "hier", "und", "and", "oder", "auch", "mal", "doch", "noch", "eine", "einen", "einer", "nicht", "should", "could", "would", "kannst", "könnte"])

/** Terms of a comment for the similarity (code spans kept as words). */
export function terms(body: string): string[] {
  return tokenize(body.replace(/```[\s\S]*?```/g, " "))
    .map((t) => stem(t))
    .filter((t) => t.length > 2 && !STOP.has(t))
}

function cosine(a: string[], b: string[]): number {
  const ca = new Map<string, number>()
  const cb = new Map<string, number>()
  for (const t of a) ca.set(t, (ca.get(t) ?? 0) + 1)
  for (const t of b) cb.set(t, (cb.get(t) ?? 0) + 1)
  let dot = 0
  for (const [t, n] of ca) dot += n * (cb.get(t) ?? 0)
  const na = Math.sqrt([...ca.values()].reduce((s, n) => s + n * n, 0))
  const nb = Math.sqrt([...cb.values()].reduce((s, n) => s + n * n, 0))
  return na && nb ? dot / (na * nb) : 0
}

/** Groups of similar comments (union-find over pairs with cosine ≥ threshold). */
export function cluster(comments: ReviewComment[], threshold = 0.45): ReviewComment[][] {
  const t = comments.map((c) => terms(c.body))
  const parent = comments.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (let i = 0; i < comments.length; i++) for (let j = i + 1; j < comments.length; j++) if (cosine(t[i], t[j]) >= threshold) parent[find(i)] = find(j)
  const groups = new Map<number, ReviewComment[]>()
  comments.forEach((c, i) => (groups.get(find(i)) ?? groups.set(find(i), []).get(find(i))!).push(c))
  return [...groups.values()]
}

export class ReviewKnowledge {
  constructor(private ctx: Ctx) {}

  private get file(): string {
    return join(this.ctx.store.stateDir, "reviews.json")
  }

  state(): State {
    return readJson<State>(this.file, { comments: {}, candidates: {}, fetched: {} })
  }

  private async update<T>(fn: (s: State) => T): Promise<T> {
    return withLock(this.ctx.store.locksDir, "reviews", () => {
      const s = this.state()
      const r = fn(s)
      writeJsonAtomic(this.file, s)
      return r
    })
  }

  candidates(status?: ReviewCandidate["status"]): ReviewCandidate[] {
    return Object.values(this.state().candidates)
      .filter((c) => !status || c.status === status)
      .sort((a, b) => b.comments.length - a.comments.length)
  }

  comment(id: string): ReviewComment | undefined {
    return this.state().comments[id]
  }

  /** Add comments (deduplicated by id); redacted, short. */
  async add(list: ReviewComment[]): Promise<number> {
    return this.update((s) => {
      let n = 0
      for (const c of list) {
        if (!c.body?.trim() || s.comments[c.id]) continue
        s.comments[c.id] = { ...c, body: truncate(this.ctx.redactor.redact(c.body.trim()), 2000) }
        n++
      }
      return n
    })
  }

  /** Bundle all comments; new groups above the thresholds become candidates. */
  async bundle(): Promise<number> {
    const o = this.ctx.options.reviews
    return this.update((s) => {
      const taken = new Set(Object.values(s.candidates).flatMap((c) => c.comments))
      let n = 0
      for (const g of cluster(Object.values(s.comments), o.similarity)) {
        const persons = new Set(g.map((c) => c.author)).size
        if (g.length < o.minComments || persons < o.minPersons) continue
        const ids = g.map((c) => c.id).sort()
        // an existing candidate grows (also a rejected one stays rejected)
        const existing = Object.values(s.candidates).find((c) => c.comments.some((x) => ids.includes(x)))
        if (existing) {
          const added = ids.filter((x) => !existing.comments.includes(x))
          if (added.length) {
            existing.comments.push(...added)
            existing.persons = new Set(existing.comments.map((x) => s.comments[x]?.author)).size
          }
          continue
        }
        if (ids.every((x) => taken.has(x))) continue
        const summary = [...g].sort((a, b) => a.body.length - b.body.length)[Math.floor(g.length / 2)]?.body ?? g[0].body
        const id = `rk-${sha(ids.join(","), 8)}`
        s.candidates[id] = { id, summary: truncate(summary.replace(/\s+/g, " "), 300), comments: ids, persons, repos: [...new Set(g.map((c) => c.repo))], status: "offen", createdAt: nowIso() }
        n++
      }
      return n
    })
  }

  /** Review comments through the GitHub CLI (gh api). */
  async fetchGh(repo: string, since: string): Promise<ReviewComment[]> {
    const gh = this.ctx.options.reviews.gh || "gh"
    const pulls = await execCapture(gh, ["api", `repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${this.ctx.options.reviews.maxPrs}`], { timeoutMs: 60_000, maxBytes: 5_000_000 })
    if (pulls.code !== 0) throw new Error(`gh api ${repo}: ${truncate(pulls.stderr || pulls.stdout, 300)}`)
    const prs = (JSON.parse(pulls.stdout) as Array<{ number: number; updated_at: string }>).filter((p) => p.updated_at >= since)
    const out: ReviewComment[] = []
    for (const p of prs) {
      const r = await execCapture(gh, ["api", `repos/${repo}/pulls/${p.number}/comments?per_page=100`], { timeoutMs: 60_000, maxBytes: 5_000_000 })
      if (r.code !== 0) continue
      for (const c of JSON.parse(r.stdout) as Array<Record<string, any>>) {
        out.push({ id: `${repo}#${c.id}`, repo, pr: p.number, author: String(c.user?.login ?? "?"), body: String(c.body ?? ""), path: c.path, line: c.line ?? c.original_line ?? undefined, url: c.html_url, at: String(c.created_at ?? nowIso()) })
      }
    }
    return out
  }

  /** Review comments through the user's GitHub MCP in a read-only session (JSON answer). */
  async fetchMcp(repo: string, since: string): Promise<ReviewComment[]> {
    const o = this.ctx.options.reviews
    const res = await runAgentSession({
      client: this.ctx.client,
      agent: o.agent || "build",
      title: `skillsmith-review-wissen · ${repo}`,
      prompt: `Lies mit den GitHub-Werkzeugen (MCP) die Review-Kommentare (Kommentare an Code-Zeilen) aller Pull Requests von ${repo}, die seit ${since.slice(0, 10)} aktualisiert wurden (höchstens ${o.maxPrs} PRs). Ändere nichts, schreibe keine Kommentare. Antworte nur mit einem JSON-Block:\n\`\`\`json\n[{"id": "Kommentar-Id", "pr": 12, "author": "login", "body": "Text", "path": "src/A.java", "line": 40, "url": "https://…", "at": "2026-01-01T00:00:00Z"}]\n\`\`\``,
      timeoutMs: 15 * 60_000,
      keepSession: this.ctx.options.keepAgentSessions,
      log: this.ctx.log,
      model: resolveModel(this.ctx, "docsmith", "curator"),
      collectText: true,
      // read only: no shell, no file changes, no subagents
      tools: { bash: false, edit: false, write: false, patch: false, task: false, webfetch: false },
    })
    const m = /```(?:json)?\s*([\s\S]*?)```/.exec(res.text ?? "") ?? /(\[[\s\S]*\])/.exec(res.text ?? "")
    if (!m) throw new Error(`keine auswertbare Antwort (${res.error ?? "kein JSON"})`)
    const list = JSON.parse(m[1]) as Array<Record<string, any>>
    return list.filter((c) => c && c.body).map((c) => ({ id: `${repo}#${String(c.id ?? sha(String(c.body), 8))}`, repo, pr: Number(c.pr) || 0, author: String(c.author ?? "?"), body: String(c.body), path: c.path ? String(c.path) : undefined, line: Number(c.line) || undefined, url: c.url ? String(c.url) : undefined, at: String(c.at ?? nowIso()) }))
  }

  private async ghAvailable(): Promise<boolean> {
    const r = await execCapture(this.ctx.options.reviews.gh || "gh", ["auth", "status"], { timeoutMs: 15_000 }).catch(() => undefined)
    return r?.code === 0
  }

  /** The job: fetch, bundle, report. */
  async runJob(): Promise<{ summary: string; status?: "ok" | "skipped" | "warn" }> {
    const o = this.ctx.options.reviews
    if (!o.repos.length) return { summary: "keine Repositories eingestellt (reviews.repos)", status: "skipped" }
    const source = o.source === "auto" ? ((await this.ghAvailable()) ? "gh" : "mcp") : o.source
    const lines: string[] = []
    let added = 0
    for (const repo of o.repos) {
      const since = this.state().fetched[repo] ?? new Date(Date.now() - o.days * 86_400_000).toISOString()
      try {
        const list = source === "gh" ? await this.fetchGh(repo, since) : await this.fetchMcp(repo, since)
        const n = await this.add(list)
        added += n
        await this.update((s) => void (s.fetched[repo] = nowIso()))
        lines.push(`${repo}: ${n} neu`)
      } catch (err) {
        lines.push(`${repo}: ${String(err instanceof Error ? err.message : err)}`)
      }
    }
    const cands = await this.bundle()
    return { summary: `${source}: ${lines.join("; ")}; ${added} Kommentar(e), ${cands} neue(r) Kandidat(en)`, status: lines.some((l) => /: (?!\d+ neu)/.test(l)) ? "warn" : added || cands ? "ok" : "skipped" }
  }

  /** Confirm a candidate as convention (memory "vorgabe") or skill; the comments become its sources. */
  async confirm(run: Run, id: string, a: { as: "vorgabe" | "skill"; scope: "projekt" | "global"; title: string; text: string }): Promise<string> {
    const c = this.state().candidates[id]
    if (!c) throw new GuardError("Kandidat nicht gefunden")
    if (c.status === "bestaetigt") throw new GuardError("schon bestätigt")
    const comments = c.comments.map((x) => this.comment(x)).filter((x): x is ReviewComment => !!x)
    const origin = comments.slice(0, 8).map((x) => `- ${x.url ? `[${x.repo}#${x.pr}](${x.url})` : `${x.repo}#${x.pr}`}${x.path ? ` \`${x.path}${x.line ? `:${x.line}` : ""}\`` : ""}: „${truncate(x.body.replace(/\s+/g, " "), 160)}“`)
    const body = `${a.text.trim()}\n\n## Aus Reviews\n${origin.join("\n")}`
    let target: string
    if (a.as === "vorgabe") {
      const where = this.ctx.scope()
      const msg = await this.ctx.ops.memorySave(run, { type: "vorgabe", scope: a.scope, topic: a.title, title: a.title, summary: truncate(a.text.replace(/\s+/g, " "), 280), body, tags: ["review"], where, reason: `aus ${comments.length} Review-Kommentaren`, approved: true } as any)
      target = /memory id: (memory:[^\s]+)/.exec(msg)?.[1] ?? ""
    } else {
      const name = a.title.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || `review-${id}`
      await this.ctx.ops.create(run, "skill", { name, title: name, description: truncate(a.text.replace(/\s+/g, " "), 280), tags: ["review"], body: `## When to use\nBefore opening a pull request.\n\n## Steps\n1. ${a.text.trim()}\n\n## Aus Reviews\n${origin.join("\n")}`, reason: `aus ${comments.length} Review-Kommentaren`, approved: true })
      target = `skill:${name}`
    }
    // every comment is a source of the rule paragraph
    const i = target.indexOf(":")
    if (target && i > 0) {
      for (const x of comments.slice(0, 6)) {
        await this.ctx.ops.addSource(run, target.slice(0, i) as any, target.slice(i + 1), { paragraph: a.as === "vorgabe" ? a.text.trim() : `1. ${a.text.trim()}`, type: "comment", ref: x.url ?? `${x.repo}#${x.pr}`, quote: x.body }).catch(() => undefined)
      }
    }
    await this.update((s) => {
      const k = s.candidates[id]
      k.status = "bestaetigt"
      k.decidedAt = nowIso()
      k.entry = target
    })
    return target
  }

  async reject(id: string): Promise<void> {
    await this.update((s) => {
      const k = s.candidates[id]
      if (!k) throw new GuardError("Kandidat nicht gefunden")
      k.status = "abgelehnt"
      k.decidedAt = nowIso()
    })
  }

  /** Confirmed conventions from reviews (and all conventions of the project when asked). */
  rules(all = false): Array<{ id: string; title: string; text: string; comments: string[] }> {
    const st = this.state()
    const byEntry = new Map(Object.values(st.candidates).filter((c) => c.entry).map((c) => [c.entry!, c.comments]))
    let project = ""
    try {
      project = this.ctx.scope().project
    } catch {
      project = ""
    }
    return this.ctx.store
      .list("memory")
      .filter((e) => e.tier === "active" && str(e.fields.type) === "vorgabe" && (str(e.fields.scope) === "global" || !str(e.fields.project) || str(e.fields.project) === project))
      .filter((e) => all || e.tags.includes("review") || byEntry.has(`memory:${e.name}`))
      .map((e) => ({ id: `memory:${e.name}`, title: e.title, text: e.body.split("\n## Aus Reviews")[0].trim(), comments: byEntry.get(`memory:${e.name}`) ?? [] }))
  }

  /**
   * Pre-PR check: the diff of the branch (against `base`, default the merge base with
   * origin/main or main) against the confirmed conventions, in a read-only session.
   */
  async prCheck(dir: string, base?: string): Promise<{ base: string; findings: PrFinding[]; rules: number; summary: string }> {
    const rules = this.rules(this.ctx.options.reviews.checkAllConventions)
    const bin = this.ctx.git.bin ?? (await this.ctx.git.init().then(() => this.ctx.git.bin))
    let ref = base
    if (!ref) {
      for (const cand of ["origin/main", "origin/master", "main", "master"]) {
        const r = await gitIn(bin, dir, ["merge-base", cand, "HEAD"], 15_000)
        if (r.code === 0 && r.stdout.trim()) {
          ref = r.stdout.trim()
          break
        }
      }
    }
    if (!ref) throw new GuardError("Basis für den Diff nicht gefunden (origin/main, main …) – base angeben")
    const d = await gitIn(bin, dir, ["diff", "--unified=3", ref], 60_000)
    if (d.code !== 0) throw new GuardError(`git diff: ${truncate(d.stderr, 200)}`)
    const diff = this.ctx.redactor.redact(d.stdout)
    if (!diff.trim()) return { base: ref, findings: [], rules: rules.length, summary: "keine Änderungen gegenüber der Basis" }
    if (!rules.length) return { base: ref, findings: [], rules: 0, summary: "keine bestätigten Vorgaben aus Reviews" }
    const res = await runAgentSession({
      client: this.ctx.client,
      agent: ASSISTANT_AGENT,
      title: "skillsmith-vor-pr-prüfung",
      prompt: [
        "Prüfe den folgenden Diff gegen die Vorgaben des Teams. Melde nur echte Verstöße in geänderten Zeilen, mit Datei und Zeile (neue Zeilennummer).",
        'Antworte nur mit JSON: ```json\n[{"file": "src/A.java", "line": 12, "rule": "R1", "text": "was gegen die Vorgabe verstößt"}]\n``` – leere Liste, wenn alles passt.',
        "",
        "## Vorgaben",
        ...rules.map((r, i) => `R${i + 1}: ${r.title} – ${truncate(r.text.replace(/\s+/g, " "), 400)}`),
        "",
        "## Diff",
        truncate(diff, 80_000),
      ].join("\n"),
      timeoutMs: this.ctx.options.reviewTimeoutMin * 60_000,
      keepSession: this.ctx.options.keepAgentSessions,
      log: this.ctx.log,
      model: resolveModel(this.ctx, "docsmith", "reviewer"),
      collectText: true,
    })
    const m = /```(?:json)?\s*([\s\S]*?)```/.exec(res.text ?? "") ?? /(\[[\s\S]*\])/.exec(res.text ?? "")
    let raw: Array<Record<string, unknown>> = []
    try {
      raw = m ? (JSON.parse(m[1]) as Array<Record<string, unknown>>) : []
    } catch {
      raw = []
    }
    if (!m && !res.ok) throw new GuardError(`Prüfung fehlgeschlagen: ${res.error ?? "keine Antwort"}`)
    const findings: PrFinding[] = raw
      .filter((f) => f && typeof f === "object" && f.text)
      .map((f) => {
        const k = Number(String(f.rule ?? "").replace(/^R/i, "")) - 1
        const rule = rules[k]
        return { file: f.file ? String(f.file) : undefined, line: Number(f.line) || undefined, rule: rule?.id ?? String(f.rule ?? ""), text: truncate(String(f.text), 600), comments: rule?.comments.slice(0, 5) ?? [] }
      })
    return { base: ref, findings, rules: rules.length, summary: findings.length ? `${findings.length} Befund(e) gegen ${rules.length} Vorgabe(n)` : `keine Verstöße gegen ${rules.length} Vorgabe(n)` }
  }
}

/** Fold for tests. */
export const _fold = fold
