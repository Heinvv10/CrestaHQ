import "server-only";

/**
 * In-memory fixed-window limiter: `limit` hits per key per `windowMs`.
 * Per instance, resets on cold start — an abuse-dampener, same model as the
 * checkout and review limiters. Least-recently-used order: a full table drops
 * expired windows first, then the least recently used key — never a
 * wholesale clear, which would hand a persistent abuser a fresh budget.
 */
export function createFixedWindowLimiter(opts: {
  limit: number;
  windowMs: number;
  maxKeys?: number;
}): (key: string) => { ok: boolean; retryAfterSec: number } {
  const maxKeys = opts.maxKeys ?? 5_000;
  const buckets = new Map<string, { count: number; windowStartedAt: number }>();

  return (key) => {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStartedAt >= opts.windowMs) {
      bucket = { count: 0, windowStartedAt: now };
    }
    buckets.delete(key);
    buckets.set(key, bucket);
    if (buckets.size > maxKeys) {
      for (const [k, b] of buckets) {
        if (now - b.windowStartedAt >= opts.windowMs) buckets.delete(k);
      }
      while (buckets.size > maxKeys) {
        const oldest = buckets.keys().next().value;
        if (oldest === undefined) break;
        buckets.delete(oldest);
      }
    }

    bucket.count += 1;
    if (bucket.count > opts.limit) {
      const left = bucket.windowStartedAt + opts.windowMs - now;
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil(left / 1000)) };
    }
    return { ok: true, retryAfterSec: 0 };
  };
}
