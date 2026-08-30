import "server-only";

/**
 * Per-IP rate limit for the public checkout session endpoint.
 *
 * The endpoint is unauthenticated by necessity (buyers aren't logged in) and
 * each call creates a Contact + a pending Order + a Stripe Checkout Session.
 * Unbounded, that's a cheap way for someone to fill a tenant's CRM with junk
 * contacts and orders. Nothing is CHARGED without completing Stripe's payment
 * page, so this is anti-noise rather than anti-fraud.
 *
 * In-memory LRU, same model as the web-chat limiter — deliberately not
 * Firestore-backed. It resets on cold start, which is acceptable for an
 * abuse-dampener and avoids a write on every page view.
 */

const PER_IP_LIMIT = 15;
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_TRACKED_IPS = 5_000;

interface Bucket {
  count: number;
  windowStartedAt: number;
}

const buckets = new Map<string, Bucket>();

export interface CheckoutRateLimitResult {
  ok: boolean;
  retryAfterSec: number;
}

export function checkCheckoutRateLimit(ip: string): CheckoutRateLimitResult {
  const now = Date.now();

  // Cheap eviction — drop the oldest half rather than tracking true LRU.
  if (buckets.size > MAX_TRACKED_IPS) {
    const cutoff = now - WINDOW_MS;
    for (const [key, b] of buckets) {
      if (b.windowStartedAt < cutoff) buckets.delete(key);
    }
    if (buckets.size > MAX_TRACKED_IPS) buckets.clear();
  }

  let bucket = buckets.get(ip);
  if (!bucket || now - bucket.windowStartedAt > WINDOW_MS) {
    bucket = { count: 0, windowStartedAt: now };
  }

  if (bucket.count >= PER_IP_LIMIT) {
    buckets.set(ip, bucket);
    return {
      ok: false,
      retryAfterSec: Math.max(
        1,
        Math.ceil((bucket.windowStartedAt + WINDOW_MS - now) / 1000),
      ),
    };
  }

  bucket.count += 1;
  buckets.set(ip, bucket);
  return { ok: true, retryAfterSec: 0 };
}

/** Best-effort client IP from the proxy headers Vercel/Railway set. */
export function clientIpFrom(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}
