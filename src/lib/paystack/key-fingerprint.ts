import { createHash } from "node:crypto";

import type { PaymentMode } from "@/types/payment-attempts";

/**
 * What a payment attempt records about the key it was charged with, without
 * storing the key. Pure — no Firestore import — so test fixtures can use it.
 */

/** `sk_live_…` charges real money; anything else is Paystack's test mode. */
export function paystackKeyMode(secretKey: string): PaymentMode {
  return secretKey.startsWith("sk_live_") ? "live" : "test";
}

/**
 * A truncated SHA-256 of the secret key. Enough to tell two keys apart; the
 * attempt doc is member-readable, so it never carries more than that.
 */
export function paystackKeyFingerprint(secretKey: string): string {
  return createHash("sha256").update(secretKey).digest("hex").slice(0, 24);
}
