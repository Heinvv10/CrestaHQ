import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { BillingError } from "@/lib/billing/errors";
import { getAdminDb } from "@/lib/firebase/admin";
import { verifyPaystackTransaction } from "@/lib/paystack/billing-api";
import { paystackKeyFingerprint } from "@/lib/paystack/key-fingerprint";
import { reconcilePaystackCharge } from "@/lib/paystack/payment-link-reconciler";
import type { PaymentAttempt } from "@/types/payment-attempts";

/** Paystack statuses after which the checkout took no money. */
const ENDED_UNPAID = new Set(["abandoned", "failed", "reversed"]);

/**
 * Called while `secretKey` is still the stored key, just before it is replaced
 * or deleted: ask Paystack, with that key, about every attempt still open
 * under it. A success is recorded now, through the normal reconciler; a
 * checkout that ended without payment (or that Paystack has no record of) is
 * closed as `refused`. Anything Paystack cannot answer for stays open, and
 * `flagStaleAttempts` flags it once the connection has changed.
 *
 * Without this, every abandoned checkout would become a "the customer may
 * have paid" flag on the next key change — burying the real ones.
 */
export async function sweepOpenAttempts(subAccountId: string, secretKey: string): Promise<void> {
  const db = getAdminDb();
  const fingerprint = paystackKeyFingerprint(secretKey);
  const open = await db
    .collection("paymentAttempts")
    .where("subAccountId", "==", subAccountId)
    .where("state", "==", "open")
    .get();
  for (const doc of open.docs) {
    if ((doc.data() as PaymentAttempt).keyFingerprint !== fingerprint) continue;
    const reference = doc.id;
    let status: string;
    try {
      status = (await verifyPaystackTransaction(reference, secretKey)).status;
    } catch (err) {
      if (!(err instanceof BillingError && err.providerStatus === 404)) {
        console.error(`[paystack/attempt-sweep] sa=${subAccountId} ref=${reference} verify failed`, err);
        continue;
      }
      status = "not_found";
    }
    if (status === "success") {
      await reconcilePaystackCharge({ subAccountId, secretKey, reference });
    } else if (ENDED_UNPAID.has(status) || status === "not_found") {
      await doc.ref.update({
        state: "refused",
        reason: `Checkout ended without payment (Paystack: ${status}).`,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  }
}
