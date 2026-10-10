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
 * RULE: call this synchronously, BEFORE the first `await` in the fire-and-
 * forget path. Registering `after()` further down a chain that has already
 * awaited is too late — Next only hands its keep-alive to the host on the
 * FIRST `after()` of a request, so a registration after the response has
 * closed is unprotected (buyer-reported, Oct 2026: form leads with no push).
 * Nesting is fine: `after()` inside a running `after()` callback is awaited.
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
