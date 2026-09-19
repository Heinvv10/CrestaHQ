import "server-only";

/**
 * Per-user limit on minting WhatsApp attachment upload URLs
 * (POST /api/comms/whatsapp/upload-url). Each URL admits up to the rail's cap
 * (100 MB for a Cloud document) into the bucket, where it sits until the send
 * deletes it or the daily sweep does, so an unbounded mint loop is storage the
 * buyer pays for. Same shape as the bulk-contacts limiter: its own bucket,
 * keyed by uid, in-memory, resets on cold start.
 *
 * 30 per 10 minutes is one attachment every 20 seconds, sustained, which is
 * more than an operator working a thread by hand does (each needs a pick and
 * a Send); a burst of re-picks after a failed upload fits too. The most one
 * user can park is 30 × 100 MB per window.
 */

const PER_USER_LIMIT = 30;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_TRACKED = 5_000;

interface Bucket {
  count: number;
  windowStartedAt: number;
}

const buckets = new Map<string, Bucket>();

export interface UploadRateLimitResult {
  ok: boolean;
  retryAfterSec: number;
}

export function checkUploadUrlRateLimit(uid: string): UploadRateLimitResult {
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
