/**
 * Redaction of secrets and personal data before anything reaches the reviewer
 * model, and a scanner that blocks writing such data into skills.
 */

interface Rule {
  name: string
  re: RegExp
  replace: string | ((match: string, ...groups: string[]) => string)
  /** block skill writes that contain this pattern */
  blocking: boolean
}

function luhnValid(digits: string): boolean {
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

/** Heuristic: does a value look like a credential rather than a word? */
function looksSecret(value: string): boolean {
  if (value.length >= 20) return true
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length
  return classes >= 2 && /\d|[^A-Za-z]/.test(value)
}

const BASE_RULES: Rule[] = [
  {
    name: "private-key",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: "[REDACTED:private-key]",
    blocking: true,
  },
  {
    name: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
    replace: "[REDACTED:jwt]",
    blocking: true,
  },
  {
    name: "bearer-token",
    re: /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    replace: (_m, kind) => `${kind} [REDACTED]`,
    blocking: true,
  },
  {
    name: "url-credentials",
    re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s@/]+)@/gi,
    replace: (_m, scheme, user) => `${scheme}${user}:[REDACTED]@`,
    blocking: true,
  },
  {
    name: "aws-access-key",
    re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: "[REDACTED:aws-key]",
    blocking: true,
  },
  {
    name: "github-token",
    re: /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g,
    replace: "[REDACTED:github-token]",
    blocking: true,
  },
  {
    name: "api-key",
    re: /\b(sk|pk|rk)-(live-|test-|proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g,
    replace: "[REDACTED:api-key]",
    blocking: true,
  },
  {
    name: "slack-token",
    re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    replace: "[REDACTED:slack-token]",
    blocking: true,
  },
  {
    name: "password-assignment",
    re: /\b((?:passw(?:or)?d|passwort|kennwort|pwd)["']?\s*[:=]\s*)(["']?)(?![$<{%*\[])([^\s"',;&]{3,})/gi,
    replace: (_m, key, quote) => `${key}${quote}[REDACTED]`,
    blocking: true,
  },
  {
    name: "token-assignment",
    re: /\b((?:api[_-]?key|apikey|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|credentials?)["']?\s*[:=]\s*)(["']?)(?![$<{%*\[])([^\s"',;&]{6,})/gi,
    replace: (m, key, quote, value) => (looksSecret(value) ? `${key}${quote}[REDACTED]` : m),
    blocking: true,
  },
  {
    name: "iban",
    re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g,
    replace: "[REDACTED:iban]",
    blocking: true,
  },
  {
    name: "card-number",
    re: /\b(?:\d{4}[ -]){3}\d{3,4}\b|\b\d{15,16}\b/g,
    replace: (m) => (luhnValid(m.replace(/[^\d]/g, "")) ? "[REDACTED:card]" : m),
    blocking: true,
  },
]

const EMAIL_RULE: Rule = {
  name: "email",
  re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  replace: "[EMAIL]",
  blocking: false,
}

export interface Redactor {
  redact(text: string): string
  /** names of blocking patterns found in text */
  scan(text: string): string[]
}

export function createRedactor(opts: { extraPatterns?: string[]; emails?: boolean } = {}): Redactor {
  const rules: Rule[] = [...BASE_RULES]
  if (opts.emails !== false) rules.push(EMAIL_RULE)
  for (const [i, pattern] of (opts.extraPatterns ?? []).entries()) {
    try {
      rules.push({ name: `custom-${i + 1}`, re: new RegExp(pattern, "g"), replace: "[REDACTED]", blocking: true })
    } catch {
      // invalid user pattern: ignore
    }
  }
  return {
    redact(text: string): string {
      if (!text) return text
      let out = text
      for (const rule of rules) {
        rule.re.lastIndex = 0
        out = out.replace(rule.re, rule.replace as any)
      }
      return out
    },
    scan(text: string): string[] {
      const found: string[] = []
      if (!text) return found
      for (const rule of rules) {
        if (!rule.blocking) continue
        rule.re.lastIndex = 0
        const matches = text.match(rule.re)
        if (!matches) continue
        if (rule.name === "card-number" && !matches.some((m) => luhnValid(m.replace(/[^\d]/g, "")))) continue
        if (rule.name === "token-assignment") {
          const real = matches.some((m) => {
            rule.re.lastIndex = 0
            const parts = new RegExp(rule.re.source, "i").exec(m)
            return parts ? looksSecret(parts[3] ?? "") : false
          })
          if (!real) continue
        }
        // a redaction placeholder written by the model is not a secret
        if (matches.every((m) => m.includes("[REDACTED"))) continue
        found.push(rule.name)
      }
      return found
    },
  }
}
