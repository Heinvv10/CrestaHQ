import "server-only";

import { FieldValue, type QueryDocumentSnapshot } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { paystackKeyFingerprint } from "@/lib/paystack/key-fingerprint";
import { readPaystackConnectionSecret } from "@/lib/paystack/sub-account-client";
import { EXPIRY_MAX_PAGES, EXPIRY_PAGE, PAYSTACK_ORDER_LIFETIME_MS } from "@/lib/server/paystack-order-lifetime";
import { expireOrderKeepingFlag } from "@/lib/server/product-link-paystack-orders";
import type { PaymentAttempt } from "@/types/payment-attempts";
import type { PaystackConnectionSecret } from "@/types/paystack-connection";

/**
 * Buy-page attempts (open, or flagged by a connection change) whose key is no
 * longer the workspace's: Paystack can't be asked about them, so past 24 h the
 * expiry sweep (paystack-order-expiry.ts) expires the order and closes the
 * attempt without calling Paystack. The order's attention note stays.
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

/** Never throws: a failed write is counted in `writeErrors` and retried next run. */
export async function retireOldKeyAttempt(attempt: PaymentAttempt, counts: RetireCounts): Promise<void> {
  if (!attempt.orderId) return;
  try {
    const outcome = await expireOrderKeepingFlag(attempt.orderId);
    // A flagged attempt next to an already-closed order is a recorded late
    // payment: left as it is.
    if (outcome === "keep" || (outcome === "closed" && attempt.state !== "open")) return;
    if (outcome === "expired") counts.expired += 1;
    counts.retired += 1;
    await refuseAttempt(
      attempt.id,
      `${attempt.reason ? `${attempt.reason} ` : ""}Closed after 24 h: the key this checkout was opened with is no longer connected.`,
      ["open", "flagged"],
    );
  } catch (err) {
    counts.writeErrors += 1;
    console.error(`[paystack/order-expiry] ref=${attempt.id} not retired: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The flagged side: attempts a connection change flagged ("may have paid, not
 * recorded") whose order is still pending 24 h later. Same index as the open
 * query. Asks Paystack nothing, so no quota.
 */
export async function retireFlaggedOldKeyAttempts(
  now: Date,
  connections: Map<string, PaystackConnectionSecret | null>,
  counts: RetireCounts,
  deadline: number,
): Promise<void> {
  const flagged = getAdminDb()
    .collection("paymentAttempts")
    .where("state", "==", "flagged")
    .where("paymentLinkId", "==", "")
    .where("createdAt", "<=", new Date(now.getTime() - PAYSTACK_ORDER_LIFETIME_MS))
    .orderBy("createdAt");
  let cursor: QueryDocumentSnapshot | null = null;
  for (let page = 0; page < EXPIRY_MAX_PAGES; page += 1) {
    const snap = await (cursor ? flagged.startAfter(cursor) : flagged).limit(EXPIRY_PAGE).get();
    for (const doc of snap.docs) {
      if (Date.now() >= deadline) return;
      const attempt = { ...doc.data(), id: doc.id } as PaymentAttempt;
      if (!attempt.orderId) continue;
      if (!connections.has(attempt.subAccountId)) {
        connections.set(attempt.subAccountId, await readPaystackConnectionSecret(attempt.subAccountId));
      }
      const conn = connections.get(attempt.subAccountId);
      // Still the workspace's key (a held mismatch, a late payment): not ours.
      if (conn && paystackKeyFingerprint(conn.secretKey) === attempt.keyFingerprint) continue;
      await retireOldKeyAttempt(attempt, counts);
    }
    if (snap.size < EXPIRY_PAGE) return;
    cursor = snap.docs[snap.docs.length - 1];
  }
}
