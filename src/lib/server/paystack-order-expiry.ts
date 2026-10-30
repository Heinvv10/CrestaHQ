import "server-only";

import { FieldValue, type QueryDocumentSnapshot } from "firebase-admin/firestore";

import { BillingError } from "@/lib/billing/errors";
import { getAdminDb } from "@/lib/firebase/admin";
import { verifyPaystackTransaction } from "@/lib/paystack/billing-api";
import { paystackKeyFingerprint } from "@/lib/paystack/key-fingerprint";
import { reconcilePaystackCharge } from "@/lib/paystack/payment-link-reconciler";
import { readPaystackConnectionSecret } from "@/lib/paystack/sub-account-client";
import type { PaystackConnectionSecret } from "@/types/paystack-connection";
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
 *   anything else (ongoing, pending, queued…) → left for the next run, until the
 *                                              attempt is 7 days old, then closed
 *                                              the same way, so a stuck one
 *                                              cannot hold a place for ever;
 *   no answer                                → left for the next run.
 * An expired order is terminal: a payment that still lands is flagged by the
 * reconciler, never dropped. Bounded: at most `EXPIRY_BATCH` Paystack calls and
 * `BUDGET_MS` per run; the oldest go first. An attempt skipped for its key or
 * connection costs only a place in the read, not one of the calls, and one
 * workspace's attempts that never resolve cannot use up the run's calls: after
 * three unresolved asks the rest of its attempts wait for the next run.
 *
 * Throws (so the housekeeping route answers 500 and QStash retries) only when
 * every ask of a run failed with a network, timeout or 5xx error across at
 * least two workspaces: Paystack is down. A workspace whose key Paystack rejects
 * (401/403) is listed in `keyRejected`; one workspace's trouble never fails the
 * job.
 */

export const PAYSTACK_ORDER_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** An attempt Paystack still calls ongoing/pending after this long will not be paid. */
export const STUCK_ATTEMPT_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export const EXPIRY_BATCH = 25;
/** Rows per read; attempts skipped without asking Paystack do not count as calls. */
const PAGE = 100;
/** Pages read per run at most (a bound on reads, not on calls). */
const MAX_PAGES = 10;
/** Unresolved asks (no answer, still ongoing) one workspace may use per run. */
const UNRESOLVED_PER_TENANT = 3;
const BUDGET_MS = 40_000;
const CLOSED = new Set(["abandoned", "failed", "reversed", "not_found"]);

/** Whether `attempt` (a buy-page one) is past the order lifetime at `now`. */
export function isPastOrderLifetime(createdAt: unknown, now = Date.now(), lifetimeMs = PAYSTACK_ORDER_LIFETIME_MS): boolean {
  const at = toDate(createdAt);
  return !!at && now - at.getTime() >= lifetimeMs;
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
  /** Paystack asks made (at most `EXPIRY_BATCH`). */
  checked: number;
  /** Orders this run actually moved pending → expired. */
  expired: number;
  reconciled: number;
  /** Asks that got no answer (network, timeout, 5xx), or whose follow-up write failed. */
  errors: number;
  /** Workspaces whose key Paystack rejected (401/403) this run: reported, not an error. */
  keyRejected: string[];
  /** Skipped for a key the workspace no longer holds, or no connection. */
  skipped: number;
  /** Not started because the run's time budget was spent. */
  overBudget: number;
}

export async function expireStalePaystackOrders(
  now = new Date(),
  budgetMs = BUDGET_MS,
): Promise<PaystackOrderExpirySummary> {
  const startedAt = Date.now();
  const stale = getAdminDb()
    .collection("paymentAttempts")
    .where("state", "==", "open")
    .where("paymentLinkId", "==", "")
    .where("createdAt", "<=", new Date(now.getTime() - PAYSTACK_ORDER_LIFETIME_MS))
    .orderBy("createdAt");
  const summary: PaystackOrderExpirySummary = {
    checked: 0,
    expired: 0,
    reconciled: 0,
    errors: 0,
    keyRejected: [],
    skipped: 0,
    overBudget: 0,
  };
  // Oldest first, so one workspace's attempts that never resolve (a revoked
  // key answering 401, a payment stuck "ongoing") would sit at the front of
  // the page and use every call, run after run. Two guards: a workspace gets
  // at most UNRESOLVED_PER_TENANT unresolved asks a run (the rest of its
  // attempts are skipped), and the read continues past the first page.
  const unresolved = new Map<string, number>();
  const askedWorkspaces = new Set<string>();
  const connections = new Map<string, PaystackConnectionSecret | null>();
  let cursor: QueryDocumentSnapshot | null = null;
  pages: for (let page = 0; page < MAX_PAGES; page += 1) {
    const snap = await (cursor ? stale.startAfter(cursor) : stale).limit(PAGE).get();
    for (const doc of snap.docs) {
      if (summary.checked >= EXPIRY_BATCH) break pages;
      const attempt = { ...doc.data(), id: doc.id } as PaymentAttempt;
      if (!attempt.orderId) continue;
      const sa = attempt.subAccountId;
      if ((unresolved.get(sa) ?? 0) >= UNRESOLVED_PER_TENANT) {
        summary.skipped += 1;
        continue;
      }
      // Opened with a key this workspace no longer holds: a connection change
      // flags those, it is not this sweep's to judge.
      if (!connections.has(sa)) connections.set(sa, await readPaystackConnectionSecret(sa));
      const conn = connections.get(sa);
      if (!conn || paystackKeyFingerprint(conn.secretKey) !== attempt.keyFingerprint) {
        summary.skipped += 1;
        continue;
      }
      if (Date.now() - startedAt >= budgetMs) {
        summary.overBudget += 1;
        continue;
      }
      summary.checked += 1;
      let resolved = false;
      try {
        askedWorkspaces.add(sa);
        const answer = await paystackStatus(attempt.id, conn.secretKey);
        const status = answer && "status" in answer ? answer.status : null;
        if (answer && "rejected" in answer) {
          // This workspace's own key: its problem, not Paystack's. Reported.
          if (!summary.keyRejected.includes(sa)) summary.keyRejected.push(sa);
        } else if (status === null) {
          summary.errors += 1;
        } else if (status === "success") {
          const result = await reconcilePaystackCharge({ subAccountId: sa, secretKey: conn.secretKey, reference: attempt.id });
          if (result.retry) summary.errors += 1;
          else {
            summary.reconciled += 1;
            resolved = true;
          }
        } else if (CLOSED.has(status) || isPastOrderLifetime(attempt.createdAt, now.getTime(), STUCK_ATTEMPT_LIFETIME_MS)) {
          if (await markOrderExpired(attempt.orderId)) summary.expired += 1;
          await refuseAttempt(attempt.id, `Checkout ended without payment (Paystack: ${status}).`);
          resolved = true;
        }
      } catch (err) {
        summary.errors += 1;
        console.error(`[paystack/order-expiry] ref=${attempt.id} left open: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!resolved) unresolved.set(sa, (unresolved.get(sa) ?? 0) + 1);
    }
    if (snap.size < PAGE) break;
    cursor = snap.docs[snap.docs.length - 1];
  }
  // A real Paystack outage: every ask failed (network, timeout, 5xx), across
  // more than one workspace. One workspace's trouble is reported, not thrown:
  // a 500 makes QStash retry ALL of daily-housekeeping.
  if (summary.checked > 0 && summary.errors >= summary.checked && askedWorkspaces.size >= 2) {
    throw new Error(`paystack-order-expiry: all ${summary.checked} Paystack ask(s) failed across ${askedWorkspaces.size} workspaces`);
  }
  return summary;
}

/**
 * Paystack's status for `reference` ("not_found" for an unknown one), `rejected`
 * when it refused this workspace's key (401/403), null when it can't be asked
 * (network, timeout, 5xx, 429).
 */
async function paystackStatus(
  reference: string,
  secretKey: string,
): Promise<{ status: string } | { rejected: true } | null> {
  try {
    return { status: (await verifyPaystackTransaction(reference, secretKey)).status };
  } catch (err) {
    if (isNotFound(err)) return { status: "not_found" };
    if (err instanceof BillingError && (err.providerStatus === 401 || err.providerStatus === 403)) {
      console.warn(`[paystack/order-expiry] ref=${reference} Paystack rejected the workspace's key`);
      return { rejected: true };
    }
    console.error(`[paystack/order-expiry] ref=${reference} verify failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
