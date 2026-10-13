/**
 * Notifications (idea 19): a proposal is ready, a question waits, the pipeline finished,
 * an agent task ended. Each event can be switched (notify.events); channels are the opencode
 * toast, the browser (via the live event stream, shown with the Notification API) and
 * optionally a macOS notification (osascript, no shell).
 */
import { execFile } from "node:child_process"
import type { Ctx } from "./context"

export type NotifyEvent = "proposal" | "permission" | "pipeline" | "agent-done" | "agent-error" | "job-failed" | "halted" | "inbox"

export function notify(
  ctx: Ctx,
  event: NotifyEvent,
  title: string,
  message: string,
  extra: { variant?: "info" | "success" | "warning" | "error"; link?: string } = {},
): void {
  const o = ctx.options.notify
  if (!o.events.includes(event)) return
  const variant = extra.variant ?? "info"
  if (o.toast) ctx.toast(`${title}: ${message}`, variant)
  if (o.browser) ctx.bus.emit("notify", { event, title, message, variant, link: extra.link })
  if (o.macos && process.platform === "darwin") {
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').slice(0, 240)
    try {
      execFile("/usr/bin/osascript", ["-e", `display notification "${esc(message)}" with title "skillsmith" subtitle "${esc(title)}"`], { timeout: 5000 }, () => {})
    } catch {
      // ignore
    }
  }
}
