import { BillingError } from "@/lib/billing/errors";
import type { PaystackVerifiedTransaction } from "@/lib/paystack/billing-api";

/** Reading Paystack's `GET /transaction/verify` answer, for every reconciler. */

/**
 * The amount the link asked for. With customer-borne fees Paystack's `amount`
 * is the request PLUS fees, so `requested_amount` is the figure that must
 * equal the link. Source: PaystackOSS/openapi `dist/paystack.yaml`,
 * `VerifyResponse.data.requested_amount` (integer, required). Falls back to
 * `amount` only if a response ever omits it.
 */
export function requestedAmount(tx: PaystackVerifiedTransaction): number {
  return typeof tx.requested_amount === "number" ? tx.requested_amount : tx.amount;
}

/** Paystack answered that the reference does not exist on this account. */
export function isNotFound(err: unknown): boolean {
  if (!(err instanceof BillingError)) return false;
  return (
    err.providerStatus === 404 ||
    (err.providerStatus === 400 && /not found/i.test(err.message))
  );
}
