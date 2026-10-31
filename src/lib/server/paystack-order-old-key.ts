import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { FLAG_GRACE_MS, isPastOrderLifetime, OLD_KEY_RETIRE_MS } from "@/lib/server/paystack-order-lifetime";
import { expireOrderKeepingFlag, isOrderPendingUnheld } from "@/lib/server/product-link-paystack-orders";
import type { PaymentAttempt } from "@/types/payment-attempts";

/**
 * Buy-page attempts (open, or flagged by a connection change) whose key is no
 * longer the workspace's: Paystack can't be asked about them, so past 72 h (it
 * retries a webhook for about that long) the expiry sweep
 * (paystack-order-expiry.ts) expires the order and closes the attempt without
 * calling Paystack. The order's attention note stays.
 */

/** What these helpers add to the sweep's summary. */
export interface RetireCounts {
  /** Orders this run actually moved pending → expired. */
  expired: number;
  /** Attempts closed without asking Paystack. */
  retired: number;
  /** Firestore writes that failed (not Paystack's fault). */
  writeErrors: number;
}

/** Only from the given states → refused: a payment may have settled the attempt meanwhile. */
export async function refuseAttempt(reference: string, reason: string, from: PaymentAttempt["state"][] = ["open"]): Promise<void> {
  const db = getAdminDb();
  const ref = db.doc(`paymentAttempts/${reference}`);
  await db.runTransaction(async (t) => {
    const state = ((await t.get(ref)).data() as PaymentAttempt | undefined)?.state;
    if (!state || !from.includes(state)) return;
    t.update(ref, { state: "refused", reason, updatedAt: FieldValue.serverTimestamp() });
  });
}

/**
 * Never throws: a failed write is counted in `writeErrors` and retried next
 * run. Only once the attempt is `OLD_KEY_RETIRE_MS` old, and (when its order is
 * still pending and would be expired) `FLAG_GRACE_MS` after it was flagged, so a
 * key change near hour 71 still gives the operator a day.
 *  - order pending and unheld → expired (its attention note kept), attempt closed;
 *  - any other order (paid, held, failed, expired, gone) → ONLY the attempt is
 *    closed, the order untouched: the order carries the story, and the attempt
 *    stops taking up the sweep's read window.
 */
export async function retireOldKeyAttempt(attempt: PaymentAttempt, counts: RetireCounts, now: number): Promise<void> {
  if (!attempt.orderId || !isPastOrderLifetime(attempt.createdAt, now, OLD_KEY_RETIRE_MS)) return;
  try {
    if (await isOrderPendingUnheld(attempt.orderId)) {
      if (attempt.state === "flagged" && attempt.flaggedAt && !isPastOrderLifetime(attempt.flaggedAt, now, FLAG_GRACE_MS)) return;
      if ((await expireOrderKeepingFlag(attempt.orderId)) === "expired") counts.expired += 1;
    }
    counts.retired += 1;
    await refuseAttempt(
      attempt.id,
      `${attempt.reason ? `${attempt.reason} ` : ""}Closed after 72 h: the key this checkout was opened with is no longer connected.`,
      ["open", "flagged"],
    );
  } catch (err) {
    counts.writeErrors += 1;
    console.error(`[paystack/order-expiry] ref=${attempt.id} not retired: ${err instanceof Error ? err.message : String(err)}`);
  }
}
