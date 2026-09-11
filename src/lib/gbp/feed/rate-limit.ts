import "server-only";

/**
 * Per-IP-and-widget rate limit for the public reviews feed
 * (`/api/public/gbp/feed/[publicId]`). Same shape as the review-feedback
 * limiter (`src/lib/reviews/rate-limit.ts`), its OWN bucket, so feed traffic
 * can never starve another public flow.
 *
 * In-memory, resets on cold start: an abuse-dampener in front of a cacheable
 * (max-age=300) read, not a security boundary. A normal visitor makes one
 * request per page view.
 */

const PER_KEY_LIMIT = 120;
const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_TRACKED_KEYS = 10_000;

interface Bucket {
  count: number;
  windowStartedAt: number;
}

const buckets = new Map<string, Bucket>();

export interface FeedRateLimitResult {
  ok: boolean;
  retryAfterSec: number;
}

export function checkFeedRateLimit(ip: string, publicId: string): FeedRateLimitResult {
  const now = Date.now();
  const key = `${ip}|${publicId}`;

  // Cheap eviction, as in the other limiters.
  if (buckets.size > MAX_TRACKED_KEYS) {
    const cutoff = now - WINDOW_MS;
    for (const [k, b] of buckets) {
      if (b.windowStartedAt < cutoff) buckets.delete(k);
    }
    if (buckets.size > MAX_TRACKED_KEYS) buckets.clear();
  }

  let bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStartedAt >= WINDOW_MS) {
    bucket = { count: 0, windowStartedAt: now };
    buckets.set(key, bucket);
  }

  bucket.count += 1;
  if (bucket.count > PER_KEY_LIMIT) {
    const elapsed = now - bucket.windowStartedAt;
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((WINDOW_MS - elapsed) / 1000)) };
  }
  return { ok: true, retryAfterSec: 0 };
}
