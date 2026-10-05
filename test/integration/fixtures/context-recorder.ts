import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Only loaded by the disposable integration profile. Never changes model context. */
export default function contextRecorder(pi: ExtensionAPI): void {
  const file = process.env.PI_ISOLATION_CAPTURE_FILE;
  if (!file) throw new Error("PI_ISOLATION_CAPTURE_FILE is required by the integration recorder.");

  const record = (kind: string, event: { messages: unknown[] }, ctx: any): void => {
    appendFileSync(file, `${JSON.stringify({
      kind,
      sessionId: ctx.sessionManager.getHeader()?.id,
      sessionFile: ctx.sessionManager.getSessionFile(),
      messages: event.messages,
    })}\n`, { mode: 0o600 });
  };

  // Register by string on purpose: the checkout's type dependency predates these events.
  // The harness verifies both runtime capabilities and a real full-context capture.
  const on = pi.on.bind(pi) as (event: string, handler: (event: any, ctx: any) => void) => unknown;
  on("context", (event, ctx) => record("context", event, ctx));
  on("context_with_system", (event, ctx) => record("context_with_system", event, ctx));
  on("before_provider_headers", (event, ctx) => {
    event.headers["x-pi-isolation-session"] = ctx.sessionManager.getHeader()?.id;
  });
}
