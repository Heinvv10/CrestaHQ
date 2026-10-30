import "server-only";

import type { QueryDocumentSnapshot } from "firebase-admin/firestore";

import { BillingError } from "@/lib/billing/errors";
import { getAdminDb } from "@/lib/firebase/admin";
import { verifyPaystackTransaction } from "@/lib/paystack/billing-api";
import { paystackKeyFingerprint } from "@/lib/paystack/key-fingerprint";
import { reconcilePaystackCharge } from "@/lib/paystack/payment-link-reconciler";
import { readPaystackConnectionSecret } from "@/lib/paystack/sub-account-client";
import { isNotFound } from "@/lib/paystack/verify-answer";
import { flagKeyRejected } from "@/lib/server/paystack-key-rejected-flag";
import { refuseAttempt, retireOldKeyAttempt, type RetireCounts } from "@/lib/server/paystack-order-old-key";
import {
  EXPIRY_MAX_PAGES,
  EXPIRY_PAGE,
  isPastOrderLifetime,
  OLD_KEY_RETIRE_MS,
  PAYSTACK_ORDER_LIFETIME_MS,
  STUCK_ATTEMPT_LIFETIME_MS,
} from "@/lib/server/paystack-order-lifetime";
import { flagStaleAttempts } from "@/lib/server/payment-attempts";
import { markOrderExpired } from "@/lib/server/product-link-orders";
import { expireOrderKeepingFlag, isOrderPendingUnheld } from "@/lib/server/product-link-paystack-orders";
import type { PaymentAttempt } from "@/types/payment-attempts";
import type { PaystackConnectionSecret } from "@/types/paystack-connection";

export { isPastOrderLifetime, PAYSTACK_ORDER_LIFETIME_MS, STUCK_ATTEMPT_LIFETIME_MS };

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
 * An attempt flagged by a connection change whose key is the workspace's again
 * (reconnected) is asked about the same way once past 24 h, if its order is
 * still pending and unheld (the order's note is kept when it expires).
 * An attempt (open or flagged) whose key is no longer the workspace's can't be
 * asked: past 72 h (Paystack's webhook retries) its order is expired and the
 * attempt closed without calling Paystack, the order's attention note kept.
 * An expired order is terminal: a payment that still lands is flagged by the
 * reconciler, never dropped. Bounded: at most `EXPIRY_BATCH` Paystack calls and
 * `BUDGET_MS` per run; the oldest go first. An attempt skipped for its key or
 * connection costs only a place in the read, not one of the calls, and one
 * workspace's attempts that never resolve cannot use up the run's calls: after
 * three unresolved asks the rest of its attempts wait for the next run.
 *
 * Throws (so the housekeeping route answers 500 and QStash retries) only for a
 * Paystack outage across at least two workspaces: every ask failed with a
 * network, timeout or 5xx error. A workspace whose key Paystack rejects
 * (401/403) is listed in `keyRejected` and its admins are emailed once per key;
 * rejections in several workspaces are logged at error level but never thrown:
 * they are each tenant's own problem, and a 500 retries the whole job for all
 * of them. Firestore write failures are counted apart (`writeErrors`) and never make
 * it look like a Paystack outage.
 */

export const EXPIRY_BATCH = 25;
/** Unresolved asks (no answer, still ongoing) one workspace may use per run. */
const UNRESOLVED_PER_TENANT = 3;
const BUDGET_MS = 40_000;
const CLOSED = new Set(["abandoned", "failed", "reversed", "not_found"]);

export interface PaystackOrderExpirySummary extends RetireCounts {
  /** Paystack asks made (at most `EXPIRY_BATCH`). */
  checked: number;
  reconciled: number;
  /** Asks that got no answer from Paystack (network, timeout, 5xx). */
  errors: number;
  /** Workspaces whose key Paystack rejected (401/403) this run: reported and emailed, not an error. */
  keyRejected: string[];
  /** Skipped for a workspace's attempts that keep not resolving this run. */
  skipped: number;
  /** Not started because the run's time budget was spent. */
  overBudget: number;
}

export async function expireStalePaystackOrders(
  now = new Date(),
  budgetMs = BUDGET_MS,
): Promise<PaystackOrderExpirySummary> {
  const startedAt = Date.now();
  const cutoff = new Date(now.getTime() - PAYSTACK_ORDER_LIFETIME_MS);
  const flaggedCutoff = new Date(now.getTime() - OLD_KEY_RETIRE_MS);
  const summary: PaystackOrderExpirySummary = {
    checked: 0,
    expired: 0,
    reconciled: 0,
    errors: 0,
    writeErrors: 0,
    keyRejected: [],
    skipped: 0,
    retired: 0,
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
  const healed = new Set<string>();
  const seen = new Set<string>();
  // "open" attempts, then "flagged" ones (a connection change flagged them):
  // a flagged attempt whose key is again the workspace's, with its order still
  // pending and unheld, is asked about like an open one.
  for (const state of ["open", "flagged"] as const) {
    // A flagged row is actionable only from OLD_KEY_RETIRE_MS on (asked if its
    // key is the workspace's again, retired if the key is gone), so that is
    // where its read starts: rows that can't be acted on yet never sit in the
    // read window, and one workspace's pile of flagged buys can't push the
    // others out of it.
    const query = getAdminDb()
      .collection("paymentAttempts")
      .where("state", "==", state)
      .where("paymentLinkId", "==", "")
      .where("createdAt", "<=", state === "open" ? cutoff : flaggedCutoff)
      .orderBy("createdAt");
    let cursor: QueryDocumentSnapshot | null = null;
    pages: for (let page = 0; page < EXPIRY_MAX_PAGES; page += 1) {
      const snap = await (cursor ? query.startAfter(cursor) : query).limit(EXPIRY_PAGE).get();
      let healedThisPage = false;
      for (const doc of snap.docs) {
        const attempt = { ...doc.data(), id: doc.id } as PaymentAttempt;
        if (!attempt.orderId || seen.has(attempt.id)) continue;
        seen.add(attempt.id);
        const sa = attempt.subAccountId;
        if (!connections.has(sa)) connections.set(sa, await readPaystackConnectionSecret(sa));
        const conn = connections.get(sa);
        // Opened with a key this workspace no longer holds: Paystack can't be asked.
        if (!conn || paystackKeyFingerprint(conn.secretKey) !== attempt.keyFingerprint) {
          if (state === "open" && !isPastOrderLifetime(attempt.createdAt, now.getTime(), OLD_KEY_RETIRE_MS)) {
            // An open attempt on a gone key should have been flagged by the
            // connection change (it is, normally). If one was missed, flag all
            // of this workspace's now, once per run: they leave the open read,
            // where they would sit until they can be retired and push the other
            // workspaces out of the window.
            if (!healed.has(sa)) {
              healed.add(sa);
              healedThisPage = true;
              try {
                await flagStaleAttempts(sa, conn ? paystackKeyFingerprint(conn.secretKey) : null);
              } catch (err) {
                summary.writeErrors += 1;
                console.error(`[paystack/order-expiry] sa=${sa} old-key attempts not flagged: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          } else {
            await retireOldKeyAttempt(attempt, summary, now.getTime());
          }
          continue;
        }
        if (summary.checked >= EXPIRY_BATCH) break pages;
        if ((unresolved.get(sa) ?? 0) >= UNRESOLVED_PER_TENANT) {
          summary.skipped += 1;
          continue;
        }
        if (state === "flagged" && !(await isOrderPendingUnheld(attempt.orderId))) continue;
        if (Date.now() - startedAt >= budgetMs) {
          summary.overBudget += 1;
          continue;
        }
        summary.checked += 1;
        askedWorkspaces.add(sa);
        const answer = await paystackStatus(attempt.id, conn.secretKey);
        let resolved = false;
        if (answer === null) {
          summary.errors += 1;
        } else if ("rejected" in answer) {
          // This workspace's own key: its problem, not Paystack's. Reported once per key.
          if (!summary.keyRejected.includes(sa)) {
            summary.keyRejected.push(sa);
            await flagKeyRejected(attempt);
          }
        } else {
          try {
            resolved = await settle(attempt, answer.status, conn.secretKey, now, summary);
          } catch (err) {
            summary.writeErrors += 1;
            console.error(`[paystack/order-expiry] ref=${attempt.id} left open: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (!resolved) unresolved.set(sa, (unresolved.get(sa) ?? 0) + 1);
      }
      if (snap.size < EXPIRY_PAGE) break;
      // Rows just flagged left the query, so a cursor on one of them would
      // point outside it: read again from the start (rows already handled are
      // skipped through `seen`).
      cursor = healedThisPage ? null : snap.docs[snap.docs.length - 1];
    }
  }
  // Keys rejected in several workspaces: logged loudly and reported in the
  // summary, never thrown. It is each tenant's own problem, and a 500 makes
  // QStash retry ALL of daily-housekeeping for every tenant.
  if (summary.keyRejected.length >= 2) {
    console.error(`[paystack/order-expiry] Paystack rejected keys in ${summary.keyRejected.length} workspaces`);
  }
  // A Paystack-wide failure: every ask failed on the network or with a 5xx,
  // across more than one workspace. One workspace's trouble is reported, not
  // thrown.
  if (askedWorkspaces.size >= 2 && summary.errors === summary.checked) {
    console.error(`[paystack/order-expiry] all ${summary.checked} Paystack ask(s) failed across ${askedWorkspaces.size} workspaces`);
    throw new Error(`paystack-order-expiry: all ${summary.checked} Paystack ask(s) failed across ${askedWorkspaces.size} workspaces`);
  }
  return summary;
}

/** Acts on Paystack's answer for one attempt; true when the attempt is resolved. Throws on a failed write. */
async function settle(
  attempt: PaymentAttempt,
  status: string,
  secretKey: string,
  now: Date,
  summary: PaystackOrderExpirySummary,
): Promise<boolean> {
  if (status === "success") {
    const result = await reconcilePaystackCharge({ subAccountId: attempt.subAccountId, secretKey, reference: attempt.id });
    if (!result.retry) {
      summary.reconciled += 1;
      return true;
    }
    // "verify unavailable" is Paystack not answering; any other retry is ours (Firestore).
    if (result.detail === "verify unavailable") summary.errors += 1;
    else summary.writeErrors += 1;
    return false;
  }
  if (CLOSED.has(status) || isPastOrderLifetime(attempt.createdAt, now.getTime(), STUCK_ATTEMPT_LIFETIME_MS)) {
    const reason = `${attempt.reason ? `${attempt.reason} ` : ""}Checkout ended without payment (Paystack: ${status}).`;
    if (attempt.state === "flagged") {
      // The order carries the connection change's flag: expire it, keep the note.
      if ((await expireOrderKeepingFlag(attempt.orderId as string)) === "expired") summary.expired += 1;
      await refuseAttempt(attempt.id, reason, ["flagged"]);
    } else {
      if (await markOrderExpired(attempt.orderId as string)) summary.expired += 1;
      await refuseAttempt(attempt.id, reason);
    }
    return true;
  }
  return false;
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
