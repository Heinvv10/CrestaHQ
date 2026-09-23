import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HMAC-derived tokens that gate the per-sub-account calendar.ics feeds.
 *
 *   all bookings: token = base64url( HMAC-SHA256( AUTOMATIONS_TOKEN_SECRET,
 *                   "calfeedu:" + subAccountId + ":" + uid ) )
 *
 * Minted per MEMBER (the feed URL carries `?u=<uid>`), so the route can check
 * at every poll that the uid is still an active member — a removed
 * collaborator's copied URL stops returning data. Deterministic per
 * (sub-account, uid) → the URL a member pastes into Google Calendar is stable.
 * The earlier shared per-sub-account token (`calfeed:` + subAccountId) is no
 * longer accepted: it named no user, so it could not be revoked per person.
 * To rotate every URL at once, rotate `AUTOMATIONS_TOKEN_SECRET`.
 *
 * Domain-separated with literal prefixes so these can't be confused with any
 * other HMAC token derived from the same secret (event tokens, quote tokens,
 * unsubscribe tokens) or with each other.
 */

const DOMAIN_PREFIX = "calfeedu:";
// Distinct prefix for the per-host ("just my bookings") feed so a sub-account
// token can never be used as a host token, or vice-versa.
const HOST_DOMAIN_PREFIX = "calfeedhost:";

function getSecret(): string {
  const s = process.env.AUTOMATIONS_TOKEN_SECRET;
  if (!s) {
    throw new Error(
      "AUTOMATIONS_TOKEN_SECRET is required to mint calendar-feed tokens.",
    );
  }
  return s;
}

function toBase64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** The stable token for one member's all-bookings feed URL. */
export function generateCalendarFeedToken(
  subAccountId: string,
  uid: string,
): string {
  const mac = createHmac("sha256", getSecret())
    .update(`${DOMAIN_PREFIX}${subAccountId}:${uid}`, "utf8")
    .digest();
  return toBase64Url(mac);
}

/**
 * Constant-time check. Length-mismatch check first to avoid the
 * `timingSafeEqual` throw, then compare. Returns false rather than
 * throwing on any malformed input.
 */
export function verifyCalendarFeedToken(
  subAccountId: string,
  uid: string,
  presented: string,
): boolean {
  if (!presented || typeof presented !== "string") return false;
  if (!uid || typeof uid !== "string") return false;
  let expected: string;
  try {
    expected = generateCalendarFeedToken(subAccountId, uid);
  } catch {
    return false;
  }
  if (expected.length !== presented.length) return false;
  return timingSafeEqual(
    Buffer.from(expected, "utf8"),
    Buffer.from(presented, "utf8"),
  );
}

/**
 * Build a member's all-bookings feed URL. Operator copies this from the
 * settings UI and pastes into Google Calendar / Apple Calendar / Outlook as
 * a subscribed calendar.
 */
export function buildCalendarFeedUrl(subAccountId: string, uid: string): string {
  const base =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  const token = generateCalendarFeedToken(subAccountId, uid);
  return `${base}/api/sub-accounts/${subAccountId}/calendar.ics?u=${encodeURIComponent(uid)}&t=${token}`;
}

/**
 * Per-host ("just my bookings") feed token. Bound to BOTH the sub-account
 * and the member uid via a distinct domain prefix, so it can't be reused as
 * the all-bookings token and swapping the `?host=` uid breaks verification.
 */
export function generateHostCalendarFeedToken(
  subAccountId: string,
  uid: string,
): string {
  const mac = createHmac("sha256", getSecret())
    .update(`${HOST_DOMAIN_PREFIX}${subAccountId}:${uid}`, "utf8")
    .digest();
  return toBase64Url(mac);
}

/** Constant-time check for a per-host feed token. False on any malformed input. */
export function verifyHostCalendarFeedToken(
  subAccountId: string,
  uid: string,
  presented: string,
): boolean {
  if (!presented || typeof presented !== "string") return false;
  if (!uid || typeof uid !== "string") return false;
  let expected: string;
  try {
    expected = generateHostCalendarFeedToken(subAccountId, uid);
  } catch {
    return false;
  }
  if (expected.length !== presented.length) return false;
  return timingSafeEqual(
    Buffer.from(expected, "utf8"),
    Buffer.from(presented, "utf8"),
  );
}

/**
 * Build the per-host feed URL — only the bookings assigned to `uid`. The uid
 * is URL-encoded; the token authorises the (sub-account, uid) pair.
 */
export function buildHostCalendarFeedUrl(
  subAccountId: string,
  uid: string,
): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  const token = generateHostCalendarFeedToken(subAccountId, uid);
  return `${base}/api/sub-accounts/${subAccountId}/calendar.ics?host=${encodeURIComponent(uid)}&t=${token}`;
}
