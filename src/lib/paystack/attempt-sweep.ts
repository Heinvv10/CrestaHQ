import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { BillingError } from "@/lib/billing/errors";
import { getAdminDb } from "@/lib/firebase/admin";
import { verifyPaystackTransaction } from "@/lib/paystack/billing-api";
import { paystackKeyFingerprint } from "@/lib/paystack/key-fingerprint";
import { reconcilePaystackCharge } from "@/lib/paystack/payment-link-reconciler";
import { isPastOrderLifetime } from "@/lib/server/paystack-order-expiry";
import { markOrderExpired } from "@/lib/server/product-link-orders";
import type { Order } from "@/types/orders";
import type { PaymentAttempt } from "@/types/payment-attempts";
import type { PaymentLink } from "@/types/payment-links";

/**
 * Tidying a connection change, so abandoned checkouts do not become false
 * "the customer may have paid" flags that bury the real ones.
 *
 * The route lists the attempts open under the outgoing key BEFORE it commits
 * the change, commits, and only THEN sweeps them with the outgoing key held in
 * memory — Paystack being slow can never hold up replacing or deleting a key.
 * A webhook that lands in between flags its attempt; the sweep's reconcile
 * still settles it.
 *
 * Per attempt, Paystack is asked with the key it was opened with:
 *   success                        → recorded through the normal reconciler;
 *   reversed, or unknown to Paystack → closed as `refused` (no money can come);
 *                                    except a buy-page attempt under 24 h old,
 *                                    which stays open with its order for the
 *                                    expiry sweep;
 *   abandoned / failed             → closed only if its link is already paid or
 *                                    withdrawn (a buy-page order's: no longer
 *                                    pending, or older than 24 h and expired
 *                                    with it). Paystack lets the customer
 *                                    resume or retry on the same reference, so
 *                                    on a live link it may still take money;
 *   no answer                      → left open, for `flagStaleAttempts`.
 */

const CLOSED = new Set(["reversed", "not_found"]);
const RESUMABLE = new Set(["abandoned", "failed"]);
const CONCURRENCY = 5;

export async function listOpenAttempts(subAccountId: string, secretKey: string): Promise<string[]> {
  const fingerprint = paystackKeyFingerprint(secretKey);
  const open = await getAdminDb()
    .collection("paymentAttempts")
    .where("subAccountId", "==", subAccountId)
    .where("state", "==", "open")
    .get();
  return open.docs
    .filter((d) => (d.data() as PaymentAttempt).keyFingerprint === fingerprint)
    .map((d) => d.id);
}

export async function sweepAttempts(
  subAccountId: string,
  secretKey: string,
  references: string[],
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  for (let i = 0; i < references.length; i += CONCURRENCY) {
    await Promise.all(
      references.slice(i, i + CONCURRENCY).map((reference) =>
        sweepOne(subAccountId, secretKey, reference, opts.timeoutMs ?? 5_000),
      ),
    );
  }
}

async function paystackStatus(reference: string, secretKey: string, timeoutMs: number): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const tx = await Promise.race([
      verifyPaystackTransaction(reference, secretKey),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer in ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return tx.status;
  } catch (err) {
    if (err instanceof BillingError && err.providerStatus === 404) return "not_found";
    console.error(`[paystack/attempt-sweep] ref=${reference} verify failed`, err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Never throws: a failure here leaves the attempt open, and the caller's
 * `flagStaleAttempts` — which must still run — flags it.
 */
async function sweepOne(subAccountId: string, secretKey: string, reference: string, timeoutMs: number) {
  try {
    await settleOrClose(subAccountId, secretKey, reference, timeoutMs);
  } catch (err) {
    console.error(`[paystack/attempt-sweep] sa=${subAccountId} ref=${reference} left open`, err);
  }
}

async function settleOrClose(subAccountId: string, secretKey: string, reference: string, timeoutMs: number) {
  const status = await paystackStatus(reference, secretKey, timeoutMs);
  if (status === "success") {
    await reconcilePaystackCharge({ subAccountId, secretKey, reference });
    return;
  }
  if (!status || !(CLOSED.has(status) || RESUMABLE.has(status))) return;

  const db = getAdminDb();
  const attemptRef = db.doc(`paymentAttempts/${reference}`);
  // A buy-page order that is over (reversed, or any answer past its lifetime:
  // a younger unknown reference leaves both open) is expired first, so
  // a crash before the attempt closes below leaves an open attempt for the
  // next sweep rather than an order stuck pending.
  const before = (await attemptRef.get()).data() as PaymentAttempt | undefined;
  if (before?.state === "open" && before.orderId && (status === "reversed" || isPastOrderLifetime(before.createdAt))) {
    await markOrderExpired(before.orderId);
  }
  await db.runTransaction(async (t) => {
    const attempt = (await t.get(attemptRef)).data() as PaymentAttempt | undefined;
    // Only ever open → refused: a payment may have settled it meanwhile.
    if (attempt?.state !== "open") return;
    // A young buy-page reference Paystack doesn't know yet: left open with its
    // order pending, so the 24 h expiry sweep closes both together.
    if (status === "not_found" && attempt.orderId && !isPastOrderLifetime(attempt.createdAt)) return;
    if (RESUMABLE.has(status)) {
      const link = attempt.paymentLinkId
        ? ((await t.get(db.doc(`paymentLinks/${attempt.paymentLinkId}`))).data() as PaymentLink | undefined)
        : undefined;
      if (link && link.status !== "paid" && link.active) return;
      // A buy-page order is payable on its checkout while it is pending and
      // younger than its lifetime (after that the expiry sweep closes it).
      const order = attempt.orderId
        ? ((await t.get(db.doc(`orders/${attempt.orderId}`))).data() as Pick<Order, "status"> | undefined)
        : undefined;
      if (order?.status === "pending" && !isPastOrderLifetime(attempt.createdAt)) return;
    }
    t.update(attemptRef, {
      state: "refused",
      reason: `Checkout ended without payment (Paystack: ${status}).`,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}
