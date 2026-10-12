/**
 * Minimal OpenAI-compatible chat-completions mock (streaming + non-streaming).
 * Every request is appended to `requests` (and optionally a JSONL file) so tests
 * can assert on what opencode actually sent to the model.
 *
 * Behaviour is scripted through `respond(req)`, which returns either
 *   { text: string }                       -> plain assistant text
 *   { tools: [{ name, args }] }            -> one or more tool calls
 */
import { appendFileSync } from "node:fs"

export type MockReply = { text: string } | { tools: Array<{ name: string; args: Record<string, unknown> }> }
export type MockRequest = {
  model: string
  messages: Array<{ role: string; content?: unknown; tool_calls?: any[]; tool_call_id?: string }>
  tools?: Array<{ type: string; function: { name: string; description?: string; parameters?: unknown } }>
  stream?: boolean
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("\n")
  return ""
}

/** Deterministic "semantic" embedding: synonym groups → shared dimensions, other words hashed. */
const CONCEPTS: string[][] = [
  ["deploy", "deployment", "deployen", "produktion", "prod", "ausliefern", "ausrollen", "release", "rollout"],
  ["service", "dienst", "anwendung", "app"],
  ["certificate", "zertifikat", "pkix", "truststore", "ssl", "tls", "certification"],
  ["test", "tests", "testen", "pruefen"],
  ["customer", "kunde", "kunden", "kundendaten", "kundenstamm"],
  ["csv", "spalte", "spalten", "column", "tabelle"],
  ["count", "zaehlen", "zaehlt", "haeufigkeit", "haeufigkeiten", "anzahl"],
]
export function mockEmbedding(text: string, dims = 64): number[] {
  const t = text.includes("\nQuery:") ? text.slice(text.indexOf("\nQuery:") + 7) : text
  const v = new Array(dims).fill(0)
  const fold = (w: string) => w.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
  for (const w of fold(t).split(/[^a-z0-9]+/).filter((x) => x.length > 2)) {
    const ci = CONCEPTS.findIndex((g) => g.some((x) => w === x || (x.length > 4 && w.startsWith(x))))
    if (ci >= 0) v[ci] += 3
    else {
      let h = 7
      for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0
      v[8 + (h % (dims - 8))] += 1
    }
  }
  return v
}

export function startMock(opts: {
  port?: number
  log?: string
  respond: (req: MockRequest, index: number) => MockReply | Promise<MockReply>
}) {
  const requests: MockRequest[] = []
  const embeddings: string[][] = []
  let callCounter = 0
  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: "mock-1", object: "model" }, { id: "qwen3-embedding-8b", object: "model" }] })
      }
      if (url.pathname.endsWith("/embeddings")) {
        const body = (await request.json()) as { model: string; input: string[] | string }
        const input = Array.isArray(body.input) ? body.input : [body.input]
        embeddings.push(input)
        return Response.json({ object: "list", model: body.model, data: input.map((t, index) => ({ object: "embedding", index, embedding: mockEmbedding(t) })) })
      }
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const body = (await request.json()) as MockRequest
      const index = requests.length
      requests.push(body)
      if (opts.log) appendFileSync(opts.log, JSON.stringify(body) + "\n")
      let reply: MockReply
      try {
        reply = await opts.respond(body, index)
      } catch (err) {
        reply = { text: `mock error: ${(err as Error).message}` }
      }
      const id = `chatcmpl-${index}`
      const created = Math.floor(Date.now() / 1000)
      const base = { id, object: "chat.completion.chunk", created, model: body.model }
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }

      if (!body.stream) {
        const message: any = { role: "assistant", content: "text" in reply ? reply.text : null }
        if ("tools" in reply) {
          message.tool_calls = reply.tools.map((t) => ({
            id: `call_${++callCounter}`,
            type: "function",
            function: { name: t.name, arguments: JSON.stringify(t.args) },
          }))
        }
        return Response.json({
          id,
          object: "chat.completion",
          created,
          model: body.model,
          choices: [{ index: 0, message, finish_reason: "tools" in reply ? "tool_calls" : "stop" }],
          usage,
        })
      }

      const chunks: unknown[] = []
      chunks.push({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })
      if ("text" in reply) {
        chunks.push({ ...base, choices: [{ index: 0, delta: { content: reply.text }, finish_reason: null }] })
        chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
      } else {
        reply.tools.forEach((t, i) => {
          chunks.push({
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: i,
                      id: `call_${++callCounter}`,
                      type: "function",
                      function: { name: t.name, arguments: JSON.stringify(t.args) },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          })
        })
        chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })
      }
      chunks.push({ ...base, choices: [], usage })
      const payload = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n"
      return new Response(payload, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    },
  })
  return { server, requests, embeddings, url: `http://127.0.0.1:${server.port}/v1` }
}
