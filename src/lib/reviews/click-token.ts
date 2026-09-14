import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed tokens for a review request's tracked link, `/rr/{token}` (SP5 d2).
 *
 * `subAccountId.requestId.sig`, the HMAC taken over an `rr:`-prefixed payload
 * so a token minted for another public link with the same secret (tracked
 * links, `linkId.contactId.sig`) can never verify here. No nonce and nothing
 * stored: the link must stay the same across a request's reminders, and it
 * only says which request was clicked — the destination is always the
 * sub-account's configured review URL, read at click time.
 */

const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

function getSecret(): string {
  const s = process.env.AUTOMATIONS_TOKEN_SECRET;
  if (!s) throw new Error("AUTOMATIONS_TOKEN_SECRET is not configured");
  return s;
}

const sign = (subAccountId: string, requestId: string) =>
  createHmac("sha256", getSecret()).update(`rr:${subAccountId}.${requestId}`).digest("hex");

export function issueReviewClickToken(subAccountId: string, requestId: string): string {
  if (!ID_RE.test(subAccountId) || !ID_RE.test(requestId)) {
    throw new Error("Unexpected id format for a review click token");
  }
  return `${subAccountId}.${requestId}.${sign(subAccountId, requestId)}`;
}

export function verifyReviewClickToken(token: string): { subAccountId: string; requestId: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [subAccountId, requestId, presented] = parts;
  if (!ID_RE.test(subAccountId) || !ID_RE.test(requestId) || !presented) return null;
  let expected: string;
  try {
    expected = sign(subAccountId, requestId);
  } catch {
    return null;
  }
  if (presented.length !== expected.length) return null;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(expected)) ? { subAccountId, requestId } : null;
}

/** The URL the customer sees. Empty without NEXT_PUBLIC_APP_URL — the caller then sends the plain review link. */
export function buildReviewClickUrl(subAccountId: string, requestId: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!base) return "";
  return `${base}/rr/${issueReviewClickToken(subAccountId, requestId)}`;
}
