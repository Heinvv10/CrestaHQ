import "server-only";

/**
 * Spam guard for the public form submit endpoint (`/api/forms/[id]/submit`).
 *
 * The endpoint is unauthenticated by necessity (visitors aren't logged in),
 * and every accepted submission is EXPENSIVE for the tenant: it mints a
 * Contact, can mint a Deal, fires `contact.created` + `form.submitted`
 * webhooks and workflows, and can trigger Speed-to-Lead SMS/email sends. So
 * spam here costs the sub-account money, not just clutter.
 *
 * Three free, zero-config checks — no keys, no captcha, nothing for the
 * operator to configure:
 *
 *   1. Honeypot — the hosted form + the HTML snippet render an off-screen
 *      text input real users never see. Anything in it → bot.
 *   2. Time-to-submit — the client reports how long the form was on screen
 *      before submit. Under {@link MIN_ELAPSED_MS} → bot (a human can't read
 *      and fill a form in under a second and a half; autofill + click still
 *      takes longer than that in practice).
 *   3. Per-IP rate limit — the direct-POST defence: bots that skip the page
 *      entirely and hammer the JSON endpoint. Two buckets so a burst against
 *      one form AND a slow spray across many forms are both caught.
 *
 * Trap verdicts (1 + 2) are answered with a SILENT fake success — the bot
 * sees the same `{ ok: true }` a real visitor gets, so it can't tell it was
 * filtered and adapt. Rate-limit verdicts return 429 with Retry-After — that
 * one can hit a legitimate visitor (shared office NAT), so it must be an
 * honest, retryable error rather than a silent drop.
 *
 * Both client signals are OPTIONAL in the request body. Absent = pass. That
 * keeps every existing integration working unchanged: HTML snippets pasted
 * before this shipped, developer-written custom forms that only keep the
 * `name` attributes matching, and any direct JSON POST. Only the rate limit
 * applies to those. Deliberately not tightened to "absent = suspicious" —
 * the docs promise the endpoint accepts a bare `{ values }` body.
 *
 * In-memory LRU for the limiter, same model as the checkout + web-chat
 * limiters — deliberately not Firestore-backed. It resets on cold start and
 * is per-instance on serverless hosts, which is fine for an abuse-dampener
 * and avoids a write on every submission.
 */

/** Client-reported time-on-form under this is treated as a bot. */
export const MIN_ELAPSED_MS = 1_500;

/**
 * Body key the hosted form + HTML snippet use for the honeypot value. Sent
 * OUTSIDE `values` so it can never collide with a real field id or leak into
 * the merge-tag bag / webhook payload.
 */
export const HONEYPOT_BODY_KEY = "hp";
/** Body key for the client-measured time-on-form (ms). */
export const ELAPSED_BODY_KEY = "elapsedMs";

// Rate limits. Per (ip, form): a burst against one form. Per ip: a slow
// spray across every form on the deployment. Generous enough that an agency
// demoing a form a dozen times, or a busy shared-NAT office, never trips it.
const PER_FORM_LIMIT = 12;
const PER_FORM_WINDOW_MS = 10 * 60 * 1000; // 10 min
const PER_IP_LIMIT = 60;
const PER_IP_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_TRACKED_KEYS = 10_000;

interface Bucket {
  count: number;
  windowStartedAt: number;
}

const perFormBuckets = new Map<string, Bucket>();
const perIpBuckets = new Map<string, Bucket>();

function evictIfNeeded(map: Map<string, Bucket>, windowMs: number, now: number) {
  if (map.size <= MAX_TRACKED_KEYS) return;
  const cutoff = now - windowMs;
  for (const [key, b] of map) {
    if (b.windowStartedAt < cutoff) map.delete(key);
  }
  if (map.size > MAX_TRACKED_KEYS) map.clear();
}

/**
 * Consume one hit from a bucket. Returns seconds until the window resets when
 * the limit is exceeded, else 0.
 */
function hit(
  map: Map<string, Bucket>,
  key: string,
  limit: number,
  windowMs: number,
  now: number,
): number {
  evictIfNeeded(map, windowMs, now);
  let bucket = map.get(key);
  if (!bucket || now - bucket.windowStartedAt > windowMs) {
    bucket = { count: 0, windowStartedAt: now };
  }
  if (bucket.count >= limit) {
    map.set(key, bucket);
    return Math.max(1, Math.ceil((bucket.windowStartedAt + windowMs - now) / 1000));
  }
  bucket.count += 1;
  map.set(key, bucket);
  return 0;
}

export type FormSpamVerdict =
  | { kind: "ok" }
  /** Bot trap tripped — answer with a silent fake success, create nothing. */
  | { kind: "trap"; reason: "honeypot" | "too_fast" }
  /** Too many submissions from this IP — answer 429 + Retry-After. */
  | { kind: "rate_limited"; retryAfterSec: number };

export function checkFormSpam(input: {
  ip: string | null;
  formId: string;
  /** Raw honeypot value from the body, if the client sent one. */
  honeypot: unknown;
  /** Raw client-measured time-on-form (ms) from the body, if sent. */
  elapsedMs: unknown;
}): FormSpamVerdict {
  // Traps first — they're free and don't consume rate-limit budget, so a
  // bot tripping the honeypot can't also lock a real visitor out of the
  // shared bucket.
  if (typeof input.honeypot === "string" && input.honeypot.trim().length > 0) {
    return { kind: "trap", reason: "honeypot" };
  }
  if (
    typeof input.elapsedMs === "number" &&
    Number.isFinite(input.elapsedMs) &&
    input.elapsedMs >= 0 &&
    input.elapsedMs < MIN_ELAPSED_MS
  ) {
    return { kind: "trap", reason: "too_fast" };
  }

  // Rate limit. Unknown IP (no proxy headers — local dev, odd hosts) is
  // still bucketed under "unknown" so a misconfigured deployment degrades to
  // one shared bucket rather than no limit at all.
  const ip = input.ip || "unknown";
  const now = Date.now();
  const perForm = hit(
    perFormBuckets,
    `${ip}:${input.formId}`,
    PER_FORM_LIMIT,
    PER_FORM_WINDOW_MS,
    now,
  );
  if (perForm > 0) return { kind: "rate_limited", retryAfterSec: perForm };
  const perIp = hit(perIpBuckets, ip, PER_IP_LIMIT, PER_IP_WINDOW_MS, now);
  if (perIp > 0) return { kind: "rate_limited", retryAfterSec: perIp };

  return { kind: "ok" };
}
