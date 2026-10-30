import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Paystack signs every webhook with HMAC-SHA512 of the RAW body, keyed on the
 * account's secret key, in `x-paystack-signature`.
 *
 * The secret key doubles as the signing key — there is no separate webhook
 * secret to configure — so a valid signature is proof the event came from
 * Paystack and not from anyone who guessed the URL.
 */
export function verifyPaystackSignature(
  rawBody: string,
  signature: string | null,
  secretKey: string,
): boolean {
  if (!signature) return false;
  const expected = createHmac("sha512", secretKey).update(rawBody).digest("hex");
  const given = Buffer.from(signature, "utf8");
  const want = Buffer.from(expected, "utf8");
  // Length-check first: timingSafeEqual throws on a mismatch rather than
  // returning false, and a wrong-length signature is a mismatch either way.
  if (given.length !== want.length) return false;
  return timingSafeEqual(given, want);
}
