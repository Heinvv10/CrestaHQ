import "server-only";

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Checkout-link tokens for sub-account plan billing. Format (mirrors the
 * quote-token pattern in lib/quotes/token.ts):
 *
 *   `${subAccountId}.${nonce}.${HMAC-SHA256(`${subAccountId}.${nonce}`, SECRET)}`
 *
 * The 16-byte nonce makes every issued link unique: re-sending rotates the
 * token and the stored hash, so a previously-emailed link goes dead without
 * a blacklist. Firestore only ever stores the SHA-256 of the active token
 * (`billing.checkoutTokenHash`) — a DB dump can't be used to start a
 * checkout on someone else's behalf.
 *
 * Signed with the same `AUTOMATIONS_TOKEN_SECRET` as quote + unsubscribe
 * links; rotating that secret invalidates outstanding checkout links too.
 */

const TOKEN_PARTS = 3;

function getSecret(): string {
  const s = process.env.AUTOMATIONS_TOKEN_SECRET;
  if (!s || s.length < 16) {
    throw new Error(
      "AUTOMATIONS_TOKEN_SECRET is not set (or too short). Generate one with `openssl rand -base64 32`.",
    );
  }
  return s;
}

/** Issue a fresh checkout token. Caller persists the hash to
 *  `billing.checkoutTokenHash`. */
export function issueCheckoutToken(subAccountId: string): {
  token: string;
  hash: string;
} {
  if (!/^[A-Za-z0-9_-]+$/.test(subAccountId)) {
    throw new Error("Unexpected subAccountId format for checkout token");
  }
  const nonce = randomBytes(16).toString("hex");
  const payload = `${subAccountId}.${nonce}`;
  const sig = createHmac("sha256", getSecret()).update(payload).digest("hex");
  const token = `${payload}.${sig}`;
  return { token, hash: hashCheckoutToken(token) };
}

export function hashCheckoutToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Verify a presented token. Returns `{subAccountId, hash}` on a valid
 * signature, null otherwise. Caller must still confirm the hash matches
 * `billing.checkoutTokenHash` (that's the rotation check).
 */
export function verifyCheckoutToken(
  token: string,
): { subAccountId: string; hash: string } | null {
  const parts = token.split(".");
  if (parts.length !== TOKEN_PARTS) return null;
  const [subAccountId, nonce, presentedSig] = parts;
  if (!subAccountId || !nonce || !presentedSig) return null;

  let expectedSig: string;
  try {
    expectedSig = createHmac("sha256", getSecret())
      .update(`${subAccountId}.${nonce}`)
      .digest("hex");
  } catch {
    return null;
  }
  if (presentedSig.length !== expectedSig.length) return null;
  if (!timingSafeEqual(Buffer.from(presentedSig), Buffer.from(expectedSig))) {
    return null;
  }

  return { subAccountId, hash: hashCheckoutToken(token) };
}

/** Full shareable /pay URL. Empty string when NEXT_PUBLIC_APP_URL is unset. */
export function buildCheckoutUrl(token: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!base) return "";
  return `${base}/pay/${token}`;
}

// ---------------------------------------------------------------------------
// One-time charge tokens (/pay/charge/[token])
// ---------------------------------------------------------------------------

/**
 * Same construction as plan checkout tokens but with a `charge.` domain
 * prefix inside the HMAC payload, so a token minted for one purpose can
 * never verify for the other even though both use AUTOMATIONS_TOKEN_SECRET.
 * Payload id = the billingCharges doc id.
 */
export function issueChargeToken(chargeId: string): {
  token: string;
  hash: string;
} {
  if (!/^[A-Za-z0-9_-]+$/.test(chargeId)) {
    throw new Error("Unexpected chargeId format for charge token");
  }
  const nonce = randomBytes(16).toString("hex");
  const sig = createHmac("sha256", getSecret())
    .update(`charge.${chargeId}.${nonce}`)
    .digest("hex");
  const token = `${chargeId}.${nonce}.${sig}`;
  return { token, hash: hashCheckoutToken(token) };
}

/**
 * Verify a presented charge token. Returns `{chargeId, hash}` on a valid
 * signature, null otherwise. Caller must still match the hash against the
 * charge doc's `tokenHash` (the rotation/consumption check).
 */
export function verifyChargeToken(
  token: string,
): { chargeId: string; hash: string } | null {
  const parts = token.split(".");
  if (parts.length !== TOKEN_PARTS) return null;
  const [chargeId, nonce, presentedSig] = parts;
  if (!chargeId || !nonce || !presentedSig) return null;

  let expectedSig: string;
  try {
    expectedSig = createHmac("sha256", getSecret())
      .update(`charge.${chargeId}.${nonce}`)
      .digest("hex");
  } catch {
    return null;
  }
  if (presentedSig.length !== expectedSig.length) return null;
  if (!timingSafeEqual(Buffer.from(presentedSig), Buffer.from(expectedSig))) {
    return null;
  }

  return { chargeId, hash: hashCheckoutToken(token) };
}

/** Full shareable /pay/charge URL. Empty when NEXT_PUBLIC_APP_URL unset. */
export function buildChargeCheckoutUrl(token: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!base) return "";
  return `${base}/pay/charge/${token}`;
}
