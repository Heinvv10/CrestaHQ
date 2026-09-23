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

/**
 * The client IP every per-IP limiter keys on — the ONE place this is decided.
 *
 *  1. `cf-connecting-ip`, only when `TRUST_CF_CONNECTING_IP=1` — set where the
 *     app is reachable solely through the Cloudflare tunnel (velo binds
 *     127.0.0.1), so Cloudflare, not the caller, wrote it. The app can't see
 *     the socket peer to check that itself: Next only fills X-Forwarded-For
 *     from the socket when the header is absent.
 *  2. The RIGHT-most X-Forwarded-For hop — the address our proxy appended.
 *     Everything to its left is whatever the caller sent, so the left-most
 *     entry would hand anyone a fresh budget per request.
 *  3. `x-real-ip`, else a shared sentinel (unconfigured envs still limit).
 */
export function clientIpFrom(request: Request): string {
  if (process.env.TRUST_CF_CONNECTING_IP === "1") {
    const cf = request.headers.get("cf-connecting-ip")?.trim();
    if (cf) return cf;
  }
  const hops = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  if (hops.length > 0) return hops[hops.length - 1]!;
  return request.headers.get("x-real-ip") ?? "unknown";
}
