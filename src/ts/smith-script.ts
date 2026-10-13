/**
 * Helper of the call_script contract (skillsmith 5e) for TypeScript scripts (node ≥ 22.18
 * or bun). Parameters arrive as JSON on stdin, the result leaves as JSON on stdout in the
 * envelope {ok, data} / {ok: false, error}; log output goes to stderr.
 *
 *   import { run } from "./smith-script.ts"
 *   export function main(params: { a: number; b: number }) { return { sum: params.a + params.b } }
 *   if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) await run(main)
 *
 * skillsmith copies this file next to the script when it runs or tests it.
 */
export function log(...args: unknown[]): void {
  console.error(...args)
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ""
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

export async function run(main: (params: any) => unknown, argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`usage: echo '{...json params...}' | node ${process.argv[1] ?? "script.ts"}\n`)
    return 0
  }
  try {
    const raw = await readStdin()
    const params = raw.trim() ? JSON.parse(raw) : {}
    const data = await main(params)
    process.stdout.write(JSON.stringify({ ok: true, data: data ?? null }) + "\n")
    return 0
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }) + "\n")
    process.exitCode = 1
    return 1
  }
}
