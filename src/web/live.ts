/**
 * Live updates for the web view (server-sent events over a fetch stream, the token stays
 * in the header): events of this process (runs, tasks, pipeline, agents, notifications)
 * plus commits of other opencode processes, seen as new lines in git's reflog.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs"
import { join } from "node:path"
import type { BusEvent } from "../core/bus"
import type { Ctx } from "../core/context"

export class LiveFeed {
  private reflogSize = -1
  private timer?: ReturnType<typeof setInterval>
  private clients = 0

  constructor(private ctx: Ctx) {}

  private get reflog(): string {
    return join(this.ctx.store.root, ".git", "logs", "HEAD")
  }

  /** Watch the reflog while at least one browser listens. */
  private watch(): void {
    if (this.timer) return
    try {
      this.reflogSize = statSync(this.reflog).size
    } catch {
      this.reflogSize = 0
    }
    this.timer = setInterval(() => this.poll(), 2000)
    ;(this.timer as any).unref?.()
  }

  private unwatch(): void {
    if (this.clients > 0 || !this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  private poll(): void {
    let size: number
    try {
      size = statSync(this.reflog).size
    } catch {
      return
    }
    if (size <= this.reflogSize) {
      this.reflogSize = size
      return
    }
    const start = this.reflogSize
    this.reflogSize = size
    let text = ""
    try {
      const fd = openSync(this.reflog, "r")
      const buf = Buffer.alloc(Math.min(size - start, 256 * 1024))
      readSync(fd, buf, 0, buf.length, start)
      closeSync(fd)
      text = buf.toString("utf8")
    } catch {
      return
    }
    this.ctx.store.bump()
    for (const line of text.split("\n").filter(Boolean)) {
      const m = /^([0-9a-f]+) ([0-9a-f]+) .*?\t(.*)$/.exec(line)
      if (!m) continue
      const subject = m[3].replace(/^commit(?: \([^)]*\))?: /, "")
      this.ctx.bus.emit("commit", { hash: m[2].slice(0, 8), subject })
    }
  }

  /** Response with the event stream (one per browser tab). */
  stream(lastId: number, headers: Record<string, string>): Response {
    const ctx = this.ctx
    let off: (() => void) | undefined
    let ping: ReturnType<typeof setInterval> | undefined
    const enc = new TextEncoder()
    const self = this
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        self.clients++
        self.watch()
        const send = (e: BusEvent) => {
          try {
            controller.enqueue(enc.encode(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify({ ...e.data, at: e.at })}\n\n`))
          } catch {
            // closed
          }
        }
        controller.enqueue(enc.encode(`retry: 3000\n: skillsmith live\n\n`))
        // replay only on reconnect (a new page starts fresh – no flood of old notifications)
        if (lastId > 0) for (const e of ctx.bus.since(lastId)) send(e)
        off = ctx.bus.on(send)
        ping = setInterval(() => {
          try {
            controller.enqueue(enc.encode(`: ping ${Date.now()}\n\n`))
          } catch {
            // closed
          }
        }, 20_000)
        ;(ping as any).unref?.()
      },
      cancel() {
        off?.()
        if (ping) clearInterval(ping)
        self.clients--
        self.unwatch()
      },
    })
    return new Response(body, { headers: { ...headers, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" } })
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}
