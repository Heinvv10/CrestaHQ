import "server-only";

/**
 * Rate limits for the public report PDF (`/report/{token}/pdf`, R5). A render
 * holds a few MB and ~100–300 ms of CPU on velo-server (measured: see
 * docs/parity/evidence/r5-pdf/memory.md), so an unbounded public endpoint is
 * a cheap way to load the box. Two budgets, both must allow:
 *
 *   - per IP, 10 per 10 minutes — checked before the token is resolved, so it
 *     also bounds the Firestore reads of a caller guessing tokens. A prospect
 *     downloads once or twice; an office NAT sharing one address still has
 *     room for several people.
 *   - per share, 30 per hour — checked after the token resolves (keyed by its
 *     hash, never the raw token). Bounds a link that has been forwarded or
 *     posted widely, where every request arrives from a new address.
 *
 * In-memory, the same model as the checkout / review limiters: resets on a
 * restart, which is fine for a load-dampener in front of a token that is the
 * real credential. Separate maps from every other limiter, so a busy report
 * link cannot starve a booking or a checkout. The IP is `clientIpFrom`'s.
 */

export const PDF_IP_LIMIT = 10;
const PDF_IP_WINDOW_MS = 10 * 60 * 1000;
export const PDF_SHARE_LIMIT = 30;
const PDF_SHARE_WINDOW_MS = 60 * 60 * 1000;
const MAX_TRACKED = 5_000;

interface Bucket {
  count: number;
  windowStartedAt: number;
}

interface PdfRateLimitResult {
  ok: boolean;
  retryAfterSec: number;
}

function hit(buckets: Map<string, Bucket>, key: string, limit: number, windowMs: number): PdfRateLimitResult {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStartedAt >= windowMs) bucket = { count: 0, windowStartedAt: now };
  // Least-recently-used order, as checkReviewClickRateLimit: a full table drops
  // expired windows, then the least recently used — never a wholesale clear,
  // which would hand a persistent caller a fresh budget.
  buckets.delete(key);
  buckets.set(key, bucket);
  if (buckets.size > MAX_TRACKED) {
    for (const [k, b] of buckets) if (now - b.windowStartedAt >= windowMs) buckets.delete(k);
    while (buckets.size > MAX_TRACKED) buckets.delete(buckets.keys().next().value!);
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((windowMs - (now - bucket.windowStartedAt)) / 1000)) };
  }
  return { ok: true, retryAfterSec: 0 };
}

const ipBuckets = new Map<string, Bucket>();
const shareBuckets = new Map<string, Bucket>();

export function checkPdfIpRateLimit(ip: string): PdfRateLimitResult {
  return hit(ipBuckets, ip, PDF_IP_LIMIT, PDF_IP_WINDOW_MS);
}

/** `shareId` is the token's hash (the `prospectReportShares` doc id). */
export function checkPdfShareRateLimit(shareId: string): PdfRateLimitResult {
  return hit(shareBuckets, shareId, PDF_SHARE_LIMIT, PDF_SHARE_WINDOW_MS);
}
