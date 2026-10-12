/**
 * In-process event bus: runs, commits, audit events, task and pipeline changes, agent
 * progress. The web server forwards everything to the browser as server-sent events;
 * changes of other opencode processes are picked up from git's reflog (see web/live.ts).
 */
export interface BusEvent {
  id: number
  type: string
  at: number
  data: Record<string, unknown>
}

type Listener = (e: BusEvent) => void

export class EventBus {
  private listeners = new Set<Listener>()
  private ring: BusEvent[] = []
  private seq = 0

  emit(type: string, data: Record<string, unknown> = {}): BusEvent {
    const e: BusEvent = { id: ++this.seq, type, at: Date.now(), data }
    this.ring.push(e)
    if (this.ring.length > 500) this.ring.splice(0, this.ring.length - 500)
    for (const l of [...this.listeners]) {
      try {
        l(e)
      } catch {
        // a broken listener must not break the emitter
      }
    }
    return e
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Events after an id (reconnecting browsers send Last-Event-ID). */
  since(id: number): BusEvent[] {
    return this.ring.filter((e) => e.id > id)
  }

  get size(): number {
    return this.listeners.size
  }
}
