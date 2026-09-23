import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { formatCurrency } from "@/lib/format";
import type { PaymentAttempt } from "@/types/payment-attempts";
import type { PaymentLink } from "@/types/payment-links";

/**
 * Flagging `paymentAttempts` for the operator. A flag is how a payment that
 * could not be recorded stays visible: the attempt's `state`/`reason`, and the
 * same sentence appended to its link's `attention`, which the payment-links
 * page shows.
 */

export function loadPaymentAttempt(reference: string): Promise<PaymentAttempt | null> {
  return getAdminDb()
    .doc(`paymentAttempts/${reference}`)
    .get()
    .then((snap) => (snap.exists ? ({ ...snap.data(), id: snap.id } as PaymentAttempt) : null));
}

/**
 * Flag an attempt, once. A settled attempt is left alone (its money is
 * recorded), and an attempt already flagged keeps its first reason, so a
 * redelivery does not repeat the sentence on the link.
 */
export async function flagPaymentAttempt(
  reference: string,
  reason: (attempt: PaymentAttempt) => string,
): Promise<void> {
  const db = getAdminDb();
  const attemptRef = db.doc(`paymentAttempts/${reference}`);
  await db.runTransaction(async (t) => {
    const snap = await t.get(attemptRef);
    if (!snap.exists) return;
    const attempt = { ...snap.data(), id: snap.id } as PaymentAttempt;
    if (attempt.state === "settled" || attempt.state === "flagged") return;
    const linkRef = attempt.paymentLinkId ? db.doc(`paymentLinks/${attempt.paymentLinkId}`) : null;
    const link = linkRef ? ((await t.get(linkRef)).data() as PaymentLink | undefined) : undefined;
    const why = reason(attempt);
    t.update(attemptRef, { state: "flagged", reason: why, updatedAt: FieldValue.serverTimestamp() });
    if (linkRef && link) {
      t.update(linkRef, {
        attention: link.attention ? `${link.attention}\n${why}` : why,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  });
}

type Lost = "disconnected" | "switched";

function lostPaymentReason(what: Lost) {
  return (a: PaymentAttempt) =>
    `A ${a.mode}-mode checkout for ${formatCurrency(a.amountCents / 100, a.currency)} (Paystack reference ${a.id}) was still open when ${
      what === "disconnected" ? "Paystack was disconnected" : "the Paystack key was changed"
    }. If the customer paid, it was not recorded here — find the reference in your Paystack dashboard and record the payment by hand.`;
}

/**
 * After the connection changed: flag every open attempt made with a key
 * other than `currentFingerprint` (null = disconnected). Their payments would
 * otherwise arrive signed by a key this workspace no longer holds.
 */
export async function flagStaleAttempts(
  subAccountId: string,
  currentFingerprint: string | null,
): Promise<void> {
  const open = await getAdminDb()
    .collection("paymentAttempts")
    .where("subAccountId", "==", subAccountId)
    .where("state", "==", "open")
    .get();
  const reason = lostPaymentReason(currentFingerprint ? "switched" : "disconnected");
  // One failed write must not leave the attempts after it unflagged. Every
  // attempt is tried, then the call fails if any write did, so the operator
  // sees an error and a retry (which re-runs this) finishes the job.
  const failed: string[] = [];
  for (const doc of open.docs) {
    if ((doc.data() as PaymentAttempt).keyFingerprint === currentFingerprint) continue;
    try {
      await flagPaymentAttempt(doc.id, reason);
    } catch (err) {
      console.error(`[payment-attempts] sa=${subAccountId} ref=${doc.id} could not be flagged`, err);
      failed.push(doc.id);
    }
  }
  if (failed.length) throw new Error(`Could not flag ${failed.length} open payment attempt(s): ${failed.join(", ")}`);
}

/**
 * For a webhook that cannot be verified with the current connection: is
 * `reference` one of this sub-account's attempts made with a different key?
 * If so it is flagged (if still open) and the answer is true.
 *
 * The reference comes from an UNVERIFIED body, so it is used only to find our
 * own record, and what gets written is derived from that record alone: an
 * attempt whose key is gone is exactly what the connection change flags too.
 */
export async function flagIfStaleAttempt(
  subAccountId: string,
  reference: string | null,
  currentFingerprint: string | null,
): Promise<boolean> {
  // Untrusted: never let it name any path but one attempt doc.
  if (!reference || !/^[A-Za-z0-9-]{1,100}$/.test(reference)) return false;
  const attempt = await loadPaymentAttempt(reference);
  if (!attempt || attempt.subAccountId !== subAccountId) return false;
  if (attempt.keyFingerprint === currentFingerprint) return false;
  await flagPaymentAttempt(reference, lostPaymentReason(currentFingerprint ? "switched" : "disconnected"));
  return true;
}
