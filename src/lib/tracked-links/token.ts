import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Per-contact tracked-link tokens for `/l/{token}`.
 *
 * Same construction as the review token (`lib/reviews/feedback-token.ts`):
 * an HMAC over the payload, appended to it, verified timing-safely. The
 * payload here is `linkId.contactId`, so a token names both halves of the
 * pair and cannot be replayed against a different link.
 *
 * Unlike the review token there is no nonce and no stored hash: a tracked
 * link is a permanent per-recipient URL that a campaign re-sends, and
 * nothing sensitive sits behind it — the token only says which contact
 * clicked. Re-minting for the same (link, contact) therefore yields the
 * same URL, which is what makes the mint endpoint idempotent.
 */

const TOKEN_PARTS = 3;
/** A "." in either id would break the split on verify. */
const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
/** What the issuer emits. Checked before the compare: a presented value of the
 *  right string length but with non-ASCII characters has a different BYTE
 *  length, and `timingSafeEqual` throws on unequal buffers. */
const SIG_RE = /^[0-9a-f]{64}$/;

/**
 * Callers validate ids against this before minting, so a bad id is a 400 from
 * the route rather than a throw from `issueTrackedLinkToken` further down.
 */
export function isTokenSafeId(id: string): boolean {
  return ID_RE.test(id);
}

function getSecret(): string {
  const s = process.env.AUTOMATIONS_TOKEN_SECRET;
  if (!s) throw new Error("AUTOMATIONS_TOKEN_SECRET is not configured");
  return s;
}

export function issueTrackedLinkToken(
  linkId: string,
  contactId: string,
): string {
  if (!ID_RE.test(linkId) || !ID_RE.test(contactId)) {
    throw new Error("Unexpected id format for tracked-link token");
  }
  const payload = `${linkId}.${contactId}`;
  const sig = createHmac("sha256", getSecret()).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

/** Verify a presented token. Returns the signed pair, or null on any
 *  failure — malformed shape, unknown id characters, or a bad signature. */
export function verifyTrackedLinkToken(
  token: string,
): { linkId: string; contactId: string } | null {
  const parts = token.split(".");
  if (parts.length !== TOKEN_PARTS) return null;
  const [linkId, contactId, presentedSig] = parts;
  if (!linkId || !contactId || !presentedSig) return null;
  if (!ID_RE.test(linkId) || !ID_RE.test(contactId)) return null;
  if (!SIG_RE.test(presentedSig)) return null;

  let expectedSig: string;
  try {
    expectedSig = createHmac("sha256", getSecret())
      .update(`${linkId}.${contactId}`)
      .digest("hex");
  } catch {
    return null;
  }
  if (!timingSafeEqual(Buffer.from(presentedSig), Buffer.from(expectedSig))) {
    return null;
  }

  return { linkId, contactId };
}

/** Full shareable URL for a tracked link. Empty string when
 *  NEXT_PUBLIC_APP_URL isn't configured — a broken link in dev beats a
 *  crash in the mint path (same call as `buildReviewPageUrl`). */
export function buildTrackedLinkUrl(token: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!base) return "";
  return `${base}/l/${token}`;
}
