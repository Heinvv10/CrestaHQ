import "server-only";

import { clientIpFrom } from "@/lib/checkout/rate-limit";

/**
 * Per-client rate limit for the public logo route (`/api/brand/logo/...`),
 * its OWN buckets so logo traffic can never starve another public flow. It
 * bounds the Firestore reads an unauthenticated caller can cause. Only
 * cache misses are counted (lib/brand/logo-cache.ts serves repeat requests
 * for a version without a read), so a shared prefetching proxy fetching one
 * broadcast's logo for many recipients is not refused.
 * The client is `clientIpFrom`'s answer, the one place that is decided.
 *
 * Same model as the reviews-feed limiter (lib/gbp/feed/rate-limit.ts): a
 * fixed one-minute window per client, the table least-recently-used (every
 * hit re-inserts its key, so a persistent abuser is never the one evicted),
 * and the oldest keys dropped one at a time when full, never a wholesale
 * clear. In-memory, per instance: an abuse-dampener, not a security boundary.
 */

export const LOGO_PER_IP_LIMIT = 1000;
const WINDOW_MS = 60 * 1000;
const MAX_TRACKED_KEYS = 10_000;

interface Bucket {
  count: number;
  windowStartedAt: number;
}

const buckets = new Map<string, Bucket>();

/** 0 when allowed, else the seconds until this client's window resets. */
export function checkLogoRateLimit(request: Request): number {
  const key = clientIpFrom(request);
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStartedAt >= WINDOW_MS) bucket = { count: 0, windowStartedAt: now };
  buckets.delete(key);
  buckets.set(key, bucket);
  while (buckets.size > MAX_TRACKED_KEYS) buckets.delete(buckets.keys().next().value!);
  bucket.count += 1;
  return bucket.count > LOGO_PER_IP_LIMIT
    ? Math.max(1, Math.ceil((WINDOW_MS - (now - bucket.windowStartedAt)) / 1000))
    : 0;
}
