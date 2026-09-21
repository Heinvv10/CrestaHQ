import "server-only";

/**
 * Per-user rate limit for POST /api/contacts/bulk. One call can touch up to
 * 5,000 contacts, so a runaway client loop is the thing to dampen — a
 * single Firestore batch per 499 ids is cheap, thousands of calls are not.
 * Its own bucket, keyed by uid (the caller is always authenticated), same
 * shape as the checkout / review / web-chat limiters. In-memory, resets on
 * cold start.
 */

const PER_USER_LIMIT = 30;
const WINDOW_MS = 60 * 1000;
const MAX_TRACKED = 5_000;

interface Bucket {
  count: number;
  windowStartedAt: number;
}

const buckets = new Map<string, Bucket>();

export interface BulkRateLimitResult {
  ok: boolean;
  retryAfterSec: number;
}

export function checkBulkRateLimit(uid: string): BulkRateLimitResult {
  const now = Date.now();

  if (buckets.size > MAX_TRACKED) {
    const cutoff = now - WINDOW_MS;
    for (const [key, b] of buckets) {
      if (b.windowStartedAt < cutoff) buckets.delete(key);
    }
    if (buckets.size > MAX_TRACKED) buckets.clear();
  }

  let bucket = buckets.get(uid);
  if (!bucket || now - bucket.windowStartedAt >= WINDOW_MS) {
    bucket = { count: 0, windowStartedAt: now };
    buckets.set(uid, bucket);
  }

  bucket.count += 1;
  if (bucket.count > PER_USER_LIMIT) {
    const elapsed = now - bucket.windowStartedAt;
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((WINDOW_MS - elapsed) / 1000)),
    };
  }
  return { ok: true, retryAfterSec: 0 };
}
