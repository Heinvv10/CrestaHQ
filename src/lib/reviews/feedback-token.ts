import "server-only";

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signed public tokens for the review-and-feedback page at `/r/[token]`.
 *
 * Same construction as the quote token (`lib/quotes/token.ts`): an HMAC over
 * `contactId.nonce`, with only the SHA-256 of the issued token persisted on the
 * contact (`reviewTokenHash`) so a database read can't reconstruct a live link.
 *
 * One token per contact per review-request send. Re-sending issues a fresh one
 * and invalidates the previous link, which is what stops an old forwarded URL
 * from staying live indefinitely.
 */

const TOKEN_PARTS = 3;

function getSecret(): string {
  const s = process.env.AUTOMATIONS_TOKEN_SECRET;
  if (!s) throw new Error("AUTOMATIONS_TOKEN_SECRET is not configured");
  return s;
}

/** Issue a fresh public token for a contact's review page. The caller must
 *  persist the returned hash to `contact.reviewTokenHash`. */
export function issueReviewToken(contactId: string): {
  token: string;
  hash: string;
} {
  if (!/^[A-Za-z0-9_-]+$/.test(contactId)) {
    // A "." in the id would break the split on verify.
    throw new Error("Unexpected contactId format for review token");
  }
  const nonce = randomBytes(16).toString("hex");
  const payload = `${contactId}.${nonce}`;
  const sig = createHmac("sha256", getSecret()).update(payload).digest("hex");
  const token = `${payload}.${sig}`;
  return { token, hash: hashReviewToken(token) };
}

/** SHA-256 hex of the token — what we persist on the contact doc. */
export function hashReviewToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Verify a presented token. Returns the contactId plus the token hash, or null
 * on any failure. The caller loads the contact by id and confirms
 * `contact.reviewTokenHash === hash` before trusting it.
 *
 * Timing-safe on the HMAC compare, so response latency doesn't leak the
 * signature a byte at a time.
 */
export function verifyReviewToken(
  token: string,
): { contactId: string; hash: string } | null {
  const parts = token.split(".");
  if (parts.length !== TOKEN_PARTS) return null;
  const [contactId, nonce, presentedSig] = parts;
  if (!contactId || !nonce || !presentedSig) return null;

  let expectedSig: string;
  try {
    expectedSig = createHmac("sha256", getSecret())
      .update(`${contactId}.${nonce}`)
      .digest("hex");
  } catch {
    return null;
  }
  if (presentedSig.length !== expectedSig.length) return null;
  if (!timingSafeEqual(Buffer.from(presentedSig), Buffer.from(expectedSig))) {
    return null;
  }

  return { contactId, hash: hashReviewToken(token) };
}

/** Full shareable URL for the review page. Empty string when
 *  NEXT_PUBLIC_APP_URL isn't configured — a broken link in dev beats a crash
 *  in the send path. */
export function buildReviewPageUrl(token: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!base) return "";
  return `${base}/r/${token}`;
}
