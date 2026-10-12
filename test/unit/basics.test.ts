import { describe, expect, test } from "bun:test"
import { resolveOptions } from "../../src/config"
import { createRedactor } from "../../src/core/redact"
import { lintBody, parseSkill, serializeSkill, validateBody, validateDescription, validateName } from "../../src/core/skill"
import { fold, slugify, stem, tokenize } from "../../src/util/text"

describe("text", () => {
  test("fold removes diacritics and ß", () => {
    expect(fold("Überweisung Größe")).toBe("uberweisung grosse")
  })
  test("tokenize splits camelCase, kebab and paths, drops stopwords", () => {
    const t = tokenize("Bitte den kafkaConsumer-reset für /etc/app.yaml")
    expect(t).toContain("kafka")
    expect(t).toContain("consum")
    expect(t).toContain("reset")
    expect(t).toContain("yaml")
    expect(t).not.toContain("bitte")
    expect(t).not.toContain("den")
  })
  test("stem is light and keeps short words", () => {
    expect(stem("deployments")).toBe("deployment")
    expect(stem("abfragen")).toBe("abfrag")
    expect(stem("db2")).toBe("db2")
  })
  test("slugify", () => {
    expect(slugify("DB2 Explain-Plan für Zugriffe!")).toBe("db2-explain-plan-fur-zugriffe")
  })
})

describe("config", () => {
  test("defaults and validation", () => {
    const { options, warnings } = resolveOptions({ reviewThreshold: 0, writeMode: "bogus", nope: 1, hints: { max: 99 } }, {})
    expect(options.reviewThreshold).toBe(1)
    expect(options.writeMode).toBe("auto")
    expect(options.hints.max).toBe(10)
    expect(warnings.some((w) => w.includes("nope"))).toBe(true)
    expect(warnings.some((w) => w.includes("writeMode"))).toBe(true)
  })
  test("env overrides", () => {
    const { options } = resolveOptions({}, { SKILLSMITH_DISABLED: "1", SKILLSMITH_HOME: "/tmp/x-store" })
    expect(options.enabled).toBe(false)
    expect(options.storeDir).toBe("/tmp/x-store")
  })
})

describe("redact", () => {
  const r = createRedactor({})
  test("redacts common secrets and PII", () => {
    const input = [
      "export API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      "jdbc:db2://dbhost:50000/PROD:user=svc;password=Geheim42;",
      "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123'",
      "postgres://admin:supersecret@db.internal:5432/app",
      "IBAN DE89 3704 0044 0532 0130 00 bitte prüfen",
      "Mail an max.mustermann@example.com",
      "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    ].join("\n")
    const out = r.redact(input)
    expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz123456")
    expect(out).not.toContain("Geheim42")
    expect(out).not.toContain("supersecret")
    expect(out).not.toContain("DE89 3704")
    expect(out).not.toContain("max.mustermann@example.com")
    expect(out).not.toContain("ghp_abcdef")
    expect(out).toContain("jdbc:db2://dbhost:50000")
  })
  test("scan blocks secrets but not placeholders or prose", () => {
    expect(r.scan("password=$DB_PASSWORD and token: <TOKEN>")).toEqual([])
    expect(r.scan("The token: the value comes from vault")).toEqual([])
    expect(r.scan("password=hunter22")).toContain("password-assignment")
    expect(r.scan("a jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c")).toContain("jwt")
    expect(r.scan("Contact max@example.com")).toEqual([])
    expect(r.scan("timestamp 1728412345678 and port 50000")).toEqual([])
  })
  test("custom patterns", () => {
    const c = createRedactor({ extraPatterns: ["KD-\\d{6}"] })
    expect(c.redact("Kunde KD-123456 meldet")).toBe("Kunde [REDACTED] meldet")
    expect(c.scan("KD-123456")).toEqual(["custom-1"])
  })
})

describe("skill format", () => {
  test("parses plain, quoted and block-scalar frontmatter", () => {
    const a = parseSkill('---\nname: a-skill\ndescription: "Quoted: with colon"\nmetadata:\n  team: x\n---\n\n# Body\n')
    expect(a.name).toBe("a-skill")
    expect(a.description).toBe("Quoted: with colon")
    expect(a.body).toBe("# Body")
    const b = parseSkill("---\nname: b\ndescription: |\n  line one\n  line two\nlicense: MIT\n---\nbody")
    expect(b.description).toBe("line one\nline two")
    expect(b.frontmatter.license).toBe("MIT")
    const c = parseSkill("---\nname: c\ndescription: >-\n  folded\n  text\n---\nx")
    expect(c.description).toBe("folded text")
    expect(parseSkill("no frontmatter").body).toBe("no frontmatter")
  })
  test("serialize round-trips", () => {
    const s = serializeSkill({ name: "x-y", description: 'Desc with "quotes": and colon', body: "## Steps\n1. a" })
    const p = parseSkill(s)
    expect(p.name).toBe("x-y")
    expect(p.description).toBe('Desc with "quotes": and colon')
    expect(p.body).toBe("## Steps\n1. a")
  })
  test("validation", () => {
    expect(validateName("good-name-1")).toBeUndefined()
    expect(validateName("Bad_Name")).toBeDefined()
    expect(validateName("a--b")).toBeDefined()
    expect(validateDescription("x".repeat(301), 300)).toBeDefined()
    expect(validateDescription("two\nlines", 300)).toBeDefined()
    expect(validateBody("TODO: fill", 8000)).toBeDefined()
    expect(validateBody("---\nname: x\n---", 8000)).toBeDefined()
    expect(lintBody("no sections here")).toHaveLength(1)
  })
})
