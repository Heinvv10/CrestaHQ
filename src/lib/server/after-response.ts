import "server-only";

import { after } from "next/server";

/**
 * Run background work that must outlive the HTTP response.
 *
 * Serverless hosts (Vercel) freeze the function the moment a route returns,
 * so a bare `void doWork()` is cut off mid-flight — and only some of the
 * time, because it races the response. `after()` keeps the function alive
 * until the callback settles.
 *
 * RULE: register while the response is still open — anywhere on the
 * request's own path before the handler returns (an `await` earlier on that
 * path is fine) — or from inside a callback already running under `after()`.
 * Next arms its keep-alive on the FIRST `after()` of a request. On the
 * self-hosted Node server (`next start`) that is a `res.on('close')`
 * listener, so a first registration made after the response has closed
 * never runs and does not throw — the fallback below does not fire and the
 * work is silently dropped (on Vercel it is unprotected; buyer-reported,
 * Oct 2026: form leads with no push). Work that can outlive the response (a
 * deadline race, a detached chain) must therefore be registered when it
 * STARTS. Nesting is fine: `after()` inside a running `after()` callback
 * joins the queue still being drained, and is awaited.
 *
 * Outside a request scope (scripts, tests) `after()` throws synchronously;
 * we fall back to plain fire-and-forget. A throw or rejection from `fn` is
 * logged here and never propagates.
 */
export function runAfterResponse(fn: () => unknown): void {
  const run = () =>
    Promise.resolve()
      .then(fn)
      .catch((err) => {
        console.warn("[after-response] background task failed", err);
      });
  try {
    after(run);
  } catch {
    void run();
  }
}
