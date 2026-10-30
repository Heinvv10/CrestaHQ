import "server-only";

import { clientIpFrom } from "@/lib/checkout/rate-limit";

/**
 * Rate limit for the public reviews feed (`/api/public/gbp/feed/[publicId]`),
 * its OWN buckets so feed traffic can never starve another public flow. Two
 * buckets per request, both must pass:
 *
 *   - per client:           PER_IP_LIMIT a minute across all widgets;
 *   - per client + widget:  PER_WIDGET_LIMIT a minute.
 *
 * The route checks the id's SHAPE before calling this, so junk ids never
 * create a key. A per-client refusal does not touch the per-widget bucket.
 * The table is least-recently-used — every hit re-inserts its key at the end
 * of the Map's order — so a persistent abuser is never the one evicted. When
 * it is full, expired windows are swept first, then the least recently used
 * keys go; never a wholesale clear, which would hand every abuser a fresh budget.
 * In-memory, per instance: an abuse-dampener in front of a 60s-cacheable
 * read, not a security boundary.
 */

export const PER_WIDGET_LIMIT = 120;
export const PER_IP_LIMIT = 300;
const WINDOW_MS = 60 * 1000;
export const MAX_TRACKED_KEYS = 10_000;

interface Bucket {
  count: number;
  windowStartedAt: number;
}

const buckets = new Map<string, Bucket>();
/** The expired-window sweep walks the whole table, so it runs at most once a second. */
const SWEEP_EVERY_MS = 1_000;
let lastSweepAt = 0;
let sweeps = 0;
/** For the cost test: how many full-table sweeps this instance has run. */
export const limiterStats = () => ({ sweeps });

/** The client — the shared helper's answer (see `clientIpFrom`). */
export function feedClientKey(request: Request): string {
  return clientIpFrom(request);
}

/**
 * Full table: drop expired windows first (at most once a second — a flood of
 * new clients must not walk 10,000 keys per request), then the least recently
 * used keys, which pop from the Map's front in O(1).
 */
function evict(now: number): void {
  if (now - lastSweepAt >= SWEEP_EVERY_MS) {
    lastSweepAt = now;
    sweeps += 1;
    for (const [key, b] of buckets) if (now - b.windowStartedAt >= WINDOW_MS) buckets.delete(key);
  }
  while (buckets.size > MAX_TRACKED_KEYS) buckets.delete(buckets.keys().next().value!);
}

function hit(key: string, limit: number, now: number): number {
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStartedAt >= WINDOW_MS) bucket = { count: 0, windowStartedAt: now };
  // Least-recently-used: every hit moves this key to the end of the Map's order.
  buckets.delete(key);
  buckets.set(key, bucket);
  if (buckets.size > MAX_TRACKED_KEYS) evict(now);
  bucket.count += 1;
  return bucket.count > limit ? Math.max(1, Math.ceil((WINDOW_MS - (now - bucket.windowStartedAt)) / 1000)) : 0;
}

export interface FeedRateLimitResult {
  ok: boolean;
  retryAfterSec: number;
}

export function checkFeedRateLimit(client: string, publicId: string): FeedRateLimitResult {
  const now = Date.now();
  const perClient = hit(`ip|${client}`, PER_IP_LIMIT, now);
  // Refused per client: the per-widget budget is not spent.
  if (perClient > 0) return { ok: false, retryAfterSec: perClient };
  const perWidget = hit(`w|${client}|${publicId}`, PER_WIDGET_LIMIT, now);
  return { ok: perWidget === 0, retryAfterSec: perWidget };
}
