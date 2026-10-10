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
 * request's own path before the handler returns (an earlier `await` is
 * fine) — or from inside a callback already running under `after()`. A
 * request's first `after()` hands its queue to the host's `waitUntil`
 * (next-server's own on `next start`, the platform's on Vercel) and starts
 * it from a `res.on('close')` listener. Made after the response has closed,
 * that listener never fires: the work never runs, on either host, and
 * nothing throws, so the fallback below does not fire (buyer-reported, Oct
 * 2026: form leads with no push). So work that can outlive the response
 * registers when it STARTS. Nesting is fine: a callback added while the
 * queue drains is awaited; one added after it has drained still runs, but
 * nothing keeps the function alive for it.
 *
 * Outside a request scope (scripts, tests) `after()` throws synchronously;
 * we fall back to plain fire-and-forget. A throw or rejection from `fn` is
 * logged here and never propagates.
 *
 * TESTS: the fallback's work is not awaited by anything, so a test that
 * asserts a side effect right after calling a handler races it. Call
 * `await flushAfterResponse()` after the action instead of sleeping or
 * guessing at ticks; it resolves once every fallback task (and any task
 * those schedule) has settled. It is for tests only — production code has no
 * use for it, and it does not wait for work handed to the real `after()`.
 */
const pending = new Set<Promise<void>>();

export async function flushAfterResponse(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}

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
    const task: Promise<void> = run().then(() => {
      pending.delete(task);
    });
    pending.add(task);
  }
}
