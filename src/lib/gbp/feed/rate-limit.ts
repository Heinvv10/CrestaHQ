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
 * create a key. When the table is full the OLDEST keys go (a Map iterates in
 * insertion order and a bucket is re-inserted when its window restarts) —
 * never a wholesale clear, which would hand every abuser a fresh budget.
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

/**
 * The client, as the tunnel saw it: `cf-connecting-ip` (set by Cloudflare,
 * which the cloudflared tunnel fronts), else `x-real-ip`, else the shared
 * helper's left-most X-Forwarded-For — which a caller can spoof, so it comes last.
 */
export function feedClientKey(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-real-ip") ?? clientIpFrom(request);
}

function hit(key: string, limit: number, now: number): number {
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStartedAt >= WINDOW_MS) {
    buckets.delete(key);
    bucket = { count: 0, windowStartedAt: now };
    buckets.set(key, bucket);
    while (buckets.size > MAX_TRACKED_KEYS) buckets.delete(buckets.keys().next().value!);
  }
  bucket.count += 1;
  return bucket.count > limit ? Math.max(1, Math.ceil((WINDOW_MS - (now - bucket.windowStartedAt)) / 1000)) : 0;
}

export interface FeedRateLimitResult {
  ok: boolean;
  retryAfterSec: number;
}

export function checkFeedRateLimit(client: string, publicId: string): FeedRateLimitResult {
  const now = Date.now();
  const retry = Math.max(hit(`ip|${client}`, PER_IP_LIMIT, now), hit(`w|${client}|${publicId}`, PER_WIDGET_LIMIT, now));
  return { ok: retry === 0, retryAfterSec: retry };
}
