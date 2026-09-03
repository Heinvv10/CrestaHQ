import "server-only";

/**
 * Per-IP rate limit for the public review-feedback endpoint (`/r/[token]`).
 *
 * Deliberately its OWN bucket rather than reusing `checkCheckoutRateLimit`.
 * That limiter is a single module-level `Map` keyed only by IP and scoped, by
 * its own doc comment, to the checkout endpoint. Sharing it would couple two
 * unrelated public flows: an office NAT submitting review feedback could
 * exhaust the same 15/hour budget a paying customer needs to reach Stripe
 * Checkout, and vice versa. Same shape, separate map, no cross-starvation.
 *
 * In-memory, resets on cold start. That's fine — this is an abuse-dampener on
 * top of the real control (a token that is HMAC-signed, hash-matched and burnt
 * on submit), not a security boundary.
 */

const PER_IP_LIMIT = 20;
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_TRACKED_IPS = 5_000;

interface Bucket {
  count: number;
  windowStartedAt: number;
}

const buckets = new Map<string, Bucket>();

export interface ReviewRateLimitResult {
  ok: boolean;
  retryAfterSec: number;
}

export function checkReviewRateLimit(ip: string): ReviewRateLimitResult {
  const now = Date.now();

  // Cheap eviction — drop everything outside the window rather than tracking
  // true LRU. Same approach as the checkout + web-chat limiters.
  if (buckets.size > MAX_TRACKED_IPS) {
    const cutoff = now - WINDOW_MS;
    for (const [key, b] of buckets) {
      if (b.windowStartedAt < cutoff) buckets.delete(key);
    }
    if (buckets.size > MAX_TRACKED_IPS) buckets.clear();
  }

  let bucket = buckets.get(ip);
  if (!bucket || now - bucket.windowStartedAt >= WINDOW_MS) {
    bucket = { count: 0, windowStartedAt: now };
    buckets.set(ip, bucket);
  }

  bucket.count += 1;
  if (bucket.count > PER_IP_LIMIT) {
    const elapsed = now - bucket.windowStartedAt;
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((WINDOW_MS - elapsed) / 1000)),
    };
  }
  return { ok: true, retryAfterSec: 0 };
}
