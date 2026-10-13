/**
 * Step 5c: code anchors (parse, locate Java/TS, pin on save, check after commits: changed,
 * moved, deleted; inbox; "passt noch"), provenance per paragraph (sources on write, kept for
 * unchanged paragraphs, history evidence, per-paragraph mode), quality score.
 */
import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { codeHash, locate, parseAnchors } from "../../src/core/anchors"
import { executeAction } from "../../src/core/actions"
import { inbox } from "../../src/core/inbox"
import { GuardError } from "../../src/core/ops"
import { paragraphs, provenanceView } from "../../src/core/provenance"
import { cmdRun, makeCtx, makeRun, tmp } from "./helpers"

const JAVA = `package de.acme.auth;

import java.util.Map;

/** Stores refresh tokens. */
public class TokenStore {
  private final Map<String, String> tokens;

  public TokenStore(Map<String, String> tokens) {
    this.tokens = tokens;
  }

  public void revoke(String id) {
    if (id == null) { throw new IllegalArgumentException("id"); }
    tokens.remove(id);
  }

  public String find(String id) {
    return tokens.get(id); // "}" in a comment
  }
}
`

const TS = `export interface Session { id: string }

export async function revoke(id: string): Promise<void> {
  const s = { id }
  await store.delete(s.id)
}

export const helper = (x: number) => x * 2
`

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString()
}

function repo(): string {
  const dir = tmp("anchor-repo-")
  git(dir, "init", "-q")
  mkdirSync(join(dir, "src/main/java/de/acme/auth"), { recursive: true })
  mkdirSync(join(dir, "web/src"), { recursive: true })
  writeFileSync(join(dir, "src/main/java/de/acme/auth/TokenStore.java"), JAVA)
  writeFileSync(join(dir, "web/src/session.ts"), TS)
  git(dir, "add", "-A")
  git(dir, "commit", "-qm", "init")
  return dir
}

describe("anchors: parse and locate", () => {
  test("syntax variants", () => {
    const refs = parseAnchors("See [[code:TokenStore#revoke]], [[code:src/a/B.java]], [[code:web/src/session.ts#L3-L6]] and [[code:session.ts#revoke|Funktion]]. `[[code:ignored]]`")
    expect(refs.map((r) => r.ref)).toEqual(["TokenStore#revoke", "src/a/B.java", "web/src/session.ts#L3-L6", "session.ts#revoke"])
    expect(refs[0]).toMatchObject({ symbol: "TokenStore", member: "revoke" })
    expect(refs[1]).toMatchObject({ path: "src/a/B.java" })
    expect(refs[2]).toMatchObject({ path: "web/src/session.ts", lines: [3, 6] })
    expect(refs[3]).toMatchObject({ path: "session.ts", member: "revoke" })
  })

  test("Java class and method blocks (braces in strings/comments ignored)", () => {
    const cls = locate(JAVA, { symbol: "TokenStore" })!
    expect(cls.kind).toBe("class")
    expect(cls.lines[0]).toBe(6)
    expect(cls.lines[1]).toBe(JAVA.split("\n").length - 1)
    const m = locate(JAVA, { symbol: "TokenStore", member: "revoke" })!
    expect(m.kind).toBe("method")
    expect(m.text).toContain("tokens.remove(id)")
    expect(m.text).not.toContain("find(")
    expect(m.signature).toBe("public void revoke(String id)")
    const f = locate(JAVA, { symbol: "TokenStore", member: "find" })!
    expect(f.text.trim().endsWith("}")).toBe(true)
    expect(locate(JAVA, { symbol: "TokenStore", member: "nope" })).toBeUndefined()
  })

  test("TypeScript functions, arrow functions, line ranges; whitespace-insensitive hash", () => {
    expect(locate(TS, { member: "revoke" })!.text).toContain("store.delete")
    expect(locate(TS, { member: "helper" })!.lines).toEqual([8, 8])
    expect(locate(TS, { lines: [3, 4] })!.text.split("\n")).toHaveLength(2)
    expect(codeHash("a  b\n\n  c")).toBe(codeHash("a  b\nc"))
  })
})

describe("anchors: pin, check, inbox", () => {
  test("pinned on save, changed after a commit, passt noch re-pins", async () => {
    const dir = repo()
    const ctx = makeCtx()
    await ctx.git.init()
    await executeAction({ ctx, actor: "web" }, { action: "project.save", args: { name: "auth", title: "Auth", home_path: dir } })
    const r = await executeAction({ ctx, actor: "web" }, { action: "doc.create", args: { title: "Token widerrufen", body: "Tokens werden mit [[code:TokenStore#revoke]] widerrufen.\n\nDie Sitzung endet in [[code:web/src/session.ts#revoke]]." } })
    const name = r.target!.slice("knowledge:".length)
    const e = ctx.store.getOwned("knowledge", name)!
    expect(e.meta!.anchors).toHaveLength(2)
    expect(e.meta!.anchors![0]).toMatchObject({ ref: "TokenStore#revoke", project: "auth", path: "src/main/java/de/acme/auth/TokenStore.java", kind: "method", signature: "public void revoke(String id)" })
    expect(e.meta!.anchors![0].commit).toMatch(/^[0-9a-f]{40}$/)
    // first check: unchanged
    let res = await ctx.anchors!.runJob("Start")
    expect(res.summary).toContain("2 Anker geprüft")
    expect(ctx.anchors!.statusOf(r.target!).every((s) => s.status === "unchanged")).toBe(true)
    expect((await ctx.anchors!.runJob("Takt")).status).toBe("skipped")
    // change the method and commit
    writeFileSync(join(dir, "src/main/java/de/acme/auth/TokenStore.java"), JAVA.replace("tokens.remove(id);", "tokens.remove(id);\n    audit.log(id);"))
    git(dir, "commit", "-qam", "audit")
    res = await ctx.anchors!.runJob("Takt")
    const st = ctx.anchors!.statusOf(r.target!).find((s) => s.ref === "TokenStore#revoke")!
    expect(st.status).toBe("changed")
    expect(st.before).toContain("tokens.remove(id);")
    expect(st.after).toContain("audit.log(id)")
    const item = inbox(ctx, { since: "2000-01-01" }).items.find((i) => i.type === "code-changed")!
    expect(item.title).toContain("TokenStore#revoke")
    expect(item.actions.map((a) => a.action)).toEqual(["anchor.accept", "anchor.fix"])
    // passt noch → new hash, status cleared, one commit
    const acc = await executeAction({ ctx, actor: "web" }, { action: "anchor.accept", target: r.target, args: { ref: "TokenStore#revoke" } })
    expect(acc.commit).toBeTruthy()
    const after = ctx.store.getOwned("knowledge", name)!.meta!.anchors!.find((a) => a.ref === "TokenStore#revoke")!
    expect(after.hash).not.toBe(e.meta!.anchors![0].hash)
    await ctx.anchors!.runJob("Takt")
    expect(ctx.anchors!.statusOf(r.target!).find((s) => s.ref === "TokenStore#revoke")!.status).toBe("unchanged")
  })

  test("renamed file → moved (git), deleted symbol → deleted", async () => {
    const dir = repo()
    const ctx = makeCtx()
    await ctx.git.init()
    await executeAction({ ctx, actor: "web" }, { action: "project.save", args: { name: "auth", title: "Auth", home_path: dir } })
    const r = await executeAction({ ctx, actor: "web" }, { action: "doc.create", args: { title: "Session", body: "Siehe [[code:web/src/session.ts#revoke]] und [[code:web/src/session.ts#helper]]." } })
    git(dir, "mv", "web/src/session.ts", "web/src/sessions.ts")
    git(dir, "commit", "-qm", "rename")
    await ctx.anchors!.runJob("Takt")
    let st = ctx.anchors!.statusOf(r.target!)
    expect(st.map((s) => s.status)).toEqual(["moved", "moved"])
    expect(st[0].newPath).toBe("web/src/sessions.ts")
    // remove helper
    writeFileSync(join(dir, "web/src/sessions.ts"), TS.replace("export const helper = (x: number) => x * 2\n", ""))
    git(dir, "commit", "-qam", "drop helper")
    await ctx.anchors!.runJob("Takt")
    st = ctx.anchors!.statusOf(r.target!)
    expect(st.find((s) => s.ref.endsWith("helper"))!.status).toBe("deleted")
    // accepting the move pins the new path
    await executeAction({ ctx, actor: "web" }, { action: "anchor.accept", target: r.target, args: { ref: "web/src/session.ts#revoke" } })
    const name = r.target!.slice(10)
    expect(ctx.store.getOwned("knowledge", name)!.meta!.anchors!.find((a) => a.ref.endsWith("revoke"))!.path).toBe("web/src/sessions.ts")
  })

  test("anchors written before 5c are pinned by the job; code links are no broken links", async () => {
    const dir = repo()
    const ctx = makeCtx()
    await ctx.git.init()
    await executeAction({ ctx, actor: "web" }, { action: "project.save", args: { name: "auth", title: "Auth", home_path: dir } })
    ctx.options.anchors.enabled = false
    const r = await executeAction({ ctx, actor: "web" }, { action: "doc.create", args: { title: "Alt", body: "Vor 5c: [[code:TokenStore]]" } })
    expect(ctx.store.getOwned("knowledge", r.target!.slice(10))!.meta!.anchors).toBeUndefined()
    expect(ctx.links.broken()).toHaveLength(0)
    ctx.options.anchors.enabled = true
    const res = await ctx.anchors!.runJob("Start")
    expect(res.commits).toHaveLength(1)
    expect(ctx.store.getOwned("knowledge", r.target!.slice(10))!.meta!.anchors![0]).toMatchObject({ kind: "class", symbol: "TokenStore" })
    const subject = (await ctx.git.git(["log", "-1", "--format=%s"])).stdout.trim()
    expect(subject).toStartWith("docsmith(curator): anchor knowledge")
  })

  test("an unknown anchor is a warning, not an error", async () => {
    const ctx = makeCtx()
    const run = cmdRun(ctx, "docsmith")
    const msg = await ctx.ops.create(run, "knowledge", { name: "x", title: "X", description: "Ein Test", body: "## Text\nSiehe [[code:GibtEsNicht]]", approved: true })
    expect(msg).toContain("code anchors not found")
  })
})

describe("provenance per paragraph", () => {
  const HAY = "Nutzer: Der Export läuft jede Nacht um 2 Uhr über den Cronjob export-nightly. Tool: Der Job schreibt nach s3://exports/daily und braucht etwa 20 Minuten."

  test("paragraphs: headings and code are neutral", () => {
    const ps = paragraphs("# Titel\n\nErster Absatz\nzweite Zeile\n\n```sh\nls\n\nmehr\n```\n\n- [[a]]\n- [[b]]\n\nLetzter.")
    expect(ps.map((p) => [p.neutral, p.text.slice(0, 6)])).toEqual([
      [true, "# Tite"],
      [false, "Erster"],
      [true, "```sh\n"],
      [true, "- [[a]"],
      [false, "Letzte"],
    ])
  })

  test("agent writes: the evidence of the change, sources per paragraph, kept for unchanged paragraphs", async () => {
    const ctx = makeCtx()
    const run = makeRun(ctx, "reviewer", { smith: "docsmith", userText: HAY, haystack: HAY })
    const body = "## Ablauf\nDer Export läuft jede Nacht um 2 Uhr.\n\nDie Dateien landen in s3://exports/daily."
    const msg = await ctx.ops.create(run, "knowledge", {
      name: "export",
      title: "Export",
      description: "Nächtlicher Export",
      body,
      evidence: "Der Export läuft jede Nacht um 2 Uhr",
      sources: [{ paragraph: "Die Dateien landen in s3", evidence: "Der Job schreibt nach s3://exports/daily" }],
    })
    expect(msg).toContain("created")
    let e = ctx.store.getOwned("knowledge", "export")!
    const view = provenanceView(e)
    const st = view.paragraphs.filter((p) => !p.neutral)
    expect(st.map((p) => p.status)).toEqual(["belegt", "belegt"])
    expect(st[0].sources[0]).toMatchObject({ type: "session", quote: "Der Export läuft jede Nacht um 2 Uhr", scope: "change", ref: "ses_test_1" })
    expect(st[1].sources[0]).toMatchObject({ quote: "Der Job schreibt nach s3://exports/daily", scope: "paragraph" })
    // the user changes the second paragraph: the first keeps its source
    await ctx.ops.update(cmdRun(ctx, "docsmith"), "knowledge", { name: "export", body: body.replace("landen in", "liegen in") })
    e = ctx.store.getOwned("knowledge", "export")!
    const v2 = provenanceView(e).paragraphs.filter((p) => !p.neutral)
    expect(v2[0].sources[0].type).toBe("session")
    expect(v2[1].sources[0].type).toBe("user")
    expect(Object.keys(e.meta!.provenance!)).toHaveLength(2)
  })

  test("invented sources are rejected; pflicht needs a source per changed paragraph", async () => {
    const ctx = makeCtx()
    const run = makeRun(ctx, "reviewer", { smith: "docsmith", userText: HAY, haystack: HAY, limits: { maxNew: 5, maxChanges: 10, maxNotes: 5 } })
    const base = { name: "e2", title: "E", description: "Export", evidence: "Der Export läuft jede Nacht um 2 Uhr" }
    await expect(ctx.ops.create(run, "knowledge", { ...base, body: "## A\nDer Export läuft nachts.", sources: [{ paragraph: "Der Export läuft nachts", evidence: "Das steht nirgends im Transkript" }] })).rejects.toThrow(GuardError)
    await expect(ctx.ops.create(run, "knowledge", { ...base, body: "## A\nDer Export läuft nachts.", sources: [{ paragraph: "Der Export läuft nachts", type: "ticket", ref: "ABC-999" }] })).rejects.toThrow(/does not appear/)
    ctx.options.provenance.perParagraph = "pflicht"
    await expect(ctx.ops.create(run, "knowledge", { ...base, body: "## A\nDer Export läuft nachts.\n\nEr dauert etwa 20 Minuten." })).rejects.toThrow(/its own source/)
    ctx.options.provenance.perParagraph = "warnen"
    const msg = await ctx.ops.create(run, "knowledge", { ...base, body: "## A\nDer Export läuft nachts.\n\nEr dauert etwa 20 Minuten." })
    expect(msg).toContain("provenance:")
  })

  test("evidence from before 5c counts only where its quote is found", () => {
    const ctx = makeCtx()
    const e = {
      kind: "knowledge",
      name: "x",
      title: "X",
      description: "",
      tags: [],
      fields: {},
      body: "Der Export läuft jede Nacht um 2 Uhr über den Cronjob.\n\nEin anderer Satz ohne Beleg.",
      tier: "active",
      owned: true,
      dir: "",
      file: "",
      version: "1",
      meta: { kind: "knowledge", name: "x", createdAt: "2024-01-01", createdBy: "reviewer", updatedAt: "2024-01-01", tierChangedAt: "2024-01-01", history: [], evidence: [{ at: "2024-01-01", source: "user", text: "jede Nacht um 2 Uhr" }] },
    } as any
    const v = provenanceView(e)
    expect(v.paragraphs.map((p) => p.status)).toEqual(["belegt", "unbelegt"])
    expect(v.paragraphs[0].fromHistory).toBe(true)
    expect(v.share).toBe(0.5)
    void ctx
  })
})

describe("quality score", () => {
  test("parts, re-weighting, own documents, inbox below the threshold", async () => {
    const ctx = makeCtx()
    const HAY = "Der Export läuft jede Nacht um 2 Uhr über den Cronjob export-nightly."
    const run = makeRun(ctx, "reviewer", { smith: "docsmith", userText: HAY, haystack: HAY, limits: { maxNew: 5, maxChanges: 10, maxNotes: 5 } })
    await ctx.ops.create(run, "knowledge", { name: "gut", title: "Gut", description: "Export", body: "## A\nDer Export läuft jede Nacht um 2 Uhr.", evidence: "Der Export läuft jede Nacht um 2 Uhr" })
    const q = ctx.quality!.score("knowledge", "gut")!
    expect(q).toBeGreaterThanOrEqual(90)
    const parts = ctx.quality!.of(ctx.store.getOwned("knowledge", "gut")!).parts.map((p) => p.id)
    expect(parts).toEqual(["belegt", "frische", "zweifel"])
    // doubts lower the score; the inbox lists entries below the threshold
    await ctx.ops.flagKnowledge(makeRun(ctx, "reviewer", { smith: "docsmith" }), { name: "gut", note: "widerspricht dem Runbook" })
    await ctx.ops.flagKnowledge(makeRun(ctx, "reviewer", { smith: "docsmith" }), { name: "gut", note: "Uhrzeit geändert?" })
    await ctx.ops.flagKnowledge(makeRun(ctx, "reviewer", { smith: "docsmith" }), { name: "gut", note: "dritter Zweifel" })
    ctx.options.quality.lowThreshold = 90
    const low = ctx.quality!.of(ctx.store.getOwned("knowledge", "gut")!)
    expect(low.score).toBeLessThan(90)
    expect(low.reasons.join(" ")).toContain("Zweifel")
    expect(inbox(ctx, { since: "2000-01-01" }).items.some((i) => i.type === "low-quality" && i.target === "knowledge:gut")).toBe(true)
    // own documents: paragraphs are the user's input
    const d = await executeAction({ ctx, actor: "web" }, { action: "doc.create", args: { title: "Eigen", body: "Mein Text ohne Quelle." } })
    const own = ctx.quality!.of(ctx.store.getOwned("knowledge", d.target!.slice(10))!)
    expect(own.parts.find((p) => p.id === "belegt")!.reason).toBe("eigenes Dokument")
  })
})

void rmSync
void renameSync
