import { GbpProviderError, type GbpProviderErrorKind } from "../provider/types";

/**
 * Per-request retry for the kinds that can succeed on a second try: up to 3
 * attempts, waiting 1s then 2s — or Google's Retry-After when longer. A
 * Retry-After beyond 10s is NOT waited out or retried early: the quota is
 * project-wide, so the run stops (cursor kept) and the sweep backs off.
 * Everything else (auth, permission, not found, malformed) fails at once:
 * retrying cannot change the answer.
 */

const RETRYABLE = new Set<GbpProviderErrorKind>(["transient", "rate_limited"]);
const ATTEMPTS = 3;
const BACKOFF_MS = [1000, 2000];
const CAP_MS = 10_000;

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(fn: () => Promise<T>, sleep: Sleep): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof GbpProviderError) || !RETRYABLE.has(err.kind) || attempt >= ATTEMPTS) {
        throw err;
      }
      if ((err.retryAfterMs ?? 0) > CAP_MS) throw err;
      await sleep(Math.max(BACKOFF_MS[attempt - 1], err.retryAfterMs ?? 0));
    }
  }
}
