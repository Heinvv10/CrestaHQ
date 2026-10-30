import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { verifyPaystackTransaction } from "@/lib/paystack/billing-api";
import { paystackKeyFingerprint } from "@/lib/paystack/key-fingerprint";
import { reconcilePaystackCharge } from "@/lib/paystack/payment-link-reconciler";
import { readPaystackConnectionSecret } from "@/lib/paystack/sub-account-client";
import { isNotFound } from "@/lib/paystack/verify-answer";
import { markOrderExpired } from "@/lib/server/product-link-orders";
import { toDate } from "@/lib/server/recurring-invoice-cycle";
import type { PaymentAttempt } from "@/types/payment-attempts";

/**
 * A lifetime for unpaid Paystack buy-page orders. Paystack sends no expiry
 * event (Stripe's `checkout.session.expired` closes the Stripe ones), so an
 * abandoned click would otherwise stay `pending` with an `open` attempt for
 * good, and every key change would flag it as a possibly lost payment.
 *
 * `expireStalePaystackOrders` (daily-housekeeping) asks Paystack, with the key
 * the attempt was opened with, about every open buy-page attempt older than
 * 24 hours:
 *   success                                  → reconciled like a webhook (this
 *                                              also hears a payment whose
 *                                              webhook was never registered);
 *   abandoned / failed / reversed / unknown  → the order is expired and the
 *                                              attempt refused;
 *   anything else, or no answer              → left for the next run.
 * An expired order is terminal: a payment that still lands is flagged by the
 * reconciler, never dropped. Bounded: at most `EXPIRY_BATCH` Paystack calls and
 * `BUDGET_MS` per run; the oldest go first.
 */

export const PAYSTACK_ORDER_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const EXPIRY_BATCH = 25;
/** The page read is larger: attempts skipped without asking Paystack do not count. */
const PAGE = 100;
const BUDGET_MS = 40_000;
const CLOSED = new Set(["abandoned", "failed", "reversed", "not_found"]);

/** Whether `attempt` (a buy-page one) is past the order lifetime at `now`. */
export function isPastOrderLifetime(createdAt: unknown, now = Date.now()): boolean {
  const at = toDate(createdAt);
  return !!at && now - at.getTime() >= PAYSTACK_ORDER_LIFETIME_MS;
}

/** Only ever open → refused: a payment may have settled the attempt meanwhile. */
async function refuseAttempt(reference: string, reason: string): Promise<void> {
  const db = getAdminDb();
  const ref = db.doc(`paymentAttempts/${reference}`);
  await db.runTransaction(async (t) => {
    if (((await t.get(ref)).data() as PaymentAttempt | undefined)?.state !== "open") return;
    t.update(ref, { state: "refused", reason, updatedAt: FieldValue.serverTimestamp() });
  });
}

export interface PaystackOrderExpirySummary {
  checked: number;
  expired: number;
  reconciled: number;
  /** Not started because the run's time budget was spent. */
  overBudget: number;
}

export async function expireStalePaystackOrders(
  now = new Date(),
  budgetMs = BUDGET_MS,
): Promise<PaystackOrderExpirySummary> {
  const startedAt = Date.now();
  const stale = await getAdminDb()
    .collection("paymentAttempts")
    .where("state", "==", "open")
    .where("paymentLinkId", "==", "")
    .where("createdAt", "<=", new Date(now.getTime() - PAYSTACK_ORDER_LIFETIME_MS))
    .orderBy("createdAt")
    .limit(PAGE)
    .get();
  const summary: PaystackOrderExpirySummary = { checked: 0, expired: 0, reconciled: 0, overBudget: 0 };
  for (const doc of stale.docs) {
    if (summary.checked >= EXPIRY_BATCH) break;
    const attempt = { ...doc.data(), id: doc.id } as PaymentAttempt;
    if (!attempt.orderId) continue;
    // Opened with a key this workspace no longer holds: a connection change
    // flags those, it is not this sweep's to judge.
    const conn = await readPaystackConnectionSecret(attempt.subAccountId);
    if (!conn || paystackKeyFingerprint(conn.secretKey) !== attempt.keyFingerprint) continue;
    if (Date.now() - startedAt >= budgetMs) {
      summary.overBudget += 1;
      continue;
    }
    summary.checked += 1;
    try {
      const status = await paystackStatus(attempt.id, conn.secretKey);
      if (status === "success") {
        await reconcilePaystackCharge({ subAccountId: attempt.subAccountId, secretKey: conn.secretKey, reference: attempt.id });
        summary.reconciled += 1;
      } else if (status && CLOSED.has(status)) {
        await markOrderExpired(attempt.orderId);
        await refuseAttempt(attempt.id, `Checkout ended without payment (Paystack: ${status}).`);
        summary.expired += 1;
      }
    } catch (err) {
      console.error(`[paystack/order-expiry] ref=${attempt.id} left open: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return summary;
}

/** Paystack's status for `reference`, "not_found" for an unknown one, null when it can't be asked. */
async function paystackStatus(reference: string, secretKey: string): Promise<string | null> {
  try {
    return (await verifyPaystackTransaction(reference, secretKey)).status;
  } catch (err) {
    if (isNotFound(err)) return "not_found";
    console.error(`[paystack/order-expiry] ref=${reference} verify failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
