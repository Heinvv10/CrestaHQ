import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { verifyPaystackTransaction, type PaystackVerifiedTransaction } from "@/lib/paystack/billing-api";
import { reconcileAutoCharge } from "@/lib/paystack/auto-charge-reconciler";
import { paystackKeyFingerprint } from "@/lib/paystack/key-fingerprint";
import { isNotFound } from "@/lib/paystack/payment-link-reconciler";
import { readPaystackConnectionSecret } from "@/lib/paystack/sub-account-client";
import { loadPaymentAttempt } from "@/lib/server/payment-attempts";
import { countDecline } from "@/lib/server/payment-mandates";
import type { PaymentAttempt } from "@/types/payment-attempts";
import type { Quote } from "@/types/quotes";

/**
 * "Re-check card charge": ask Paystack, with the workspace's CURRENT key,
 * what became of a recurring card charge left pending or unknown — the
 * webhook only reports successes, so a charge that failed would otherwise
 * leave its invoice with no way to be paid. The operator asserts nothing;
 * only Paystack's answer is recorded:
 *
 *   success          → the auto-charge reconciler, exactly as the webhook;
 *   failed / abandoned / reversed / not found
 *                    → declined: attempt refused (if still open), the invoice's
 *                      `autoCharge` declined, the decline counted on the card.
 *                      The invoice can then be sent with a pay link — unless
 *                      it was marked paid by hand meanwhile: then only the
 *                      attempt is refused (`failed_but_paid`);
 *   anything else, or no answer → nothing changes.
 *
 * Fires no workflow trigger of its own; a success fires what the reconciler does.
 */

export type RecheckOutcome = "paid" | "declined" | "failed_but_paid" | "pending" | "needs_attention";
/** Why a re-check was refused: the connection (`flagStaleAttempts` owns those), a race, or the records themselves. */
export type RecheckRefusal = "connection" | "changed" | "records";
export type RecheckResult =
  | { ok: true; outcome: RecheckOutcome }
  | { ok: false; status: number; error: string; refusal: RecheckRefusal };

const fail = (status: number, error: string, refusal: RecheckRefusal = "records") => ({ ok: false as const, status, error, refusal });
const NOT_PAID = new Set(["failed", "abandoned", "reversed"]);
const RECHECKABLE = new Set(["pending", "unknown"]);

export async function recheckCardCharge(subAccountId: string, invoiceId: string): Promise<RecheckResult> {
  const db = getAdminDb();
  const quoteRef = db.doc(`quotes/${invoiceId}`);
  const quote = (await quoteRef.get()).data() as Quote | undefined;
  if (!quote || quote.subAccountId !== subAccountId) return fail(404, "Invoice not found");
  const charge = quote.autoCharge;
  if (!charge || !RECHECKABLE.has(charge.state)) {
    return fail(409, "Only a card charge that is still pending or unconfirmed can be re-checked.");
  }
  const { reference } = charge;
  const attempt = await loadPaymentAttempt(reference);
  if (!attempt || attempt.subAccountId !== subAccountId || attempt.invoiceId !== invoiceId) {
    return fail(409, "No record of this card charge was found. Check your Paystack dashboard.");
  }
  const conn = await readPaystackConnectionSecret(subAccountId);
  if (!conn) return fail(409, "Connect Paystack under Settings → Payments first.", "connection");
  // Another key asks another Paystack account (or mode) about this reference.
  if (paystackKeyFingerprint(conn.secretKey) !== attempt.keyFingerprint) {
    return fail(409, "The Paystack key changed since this charge; check your Paystack dashboard.", "connection");
  }

  let tx: PaystackVerifiedTransaction | null = null;
  try {
    tx = await verifyPaystackTransaction(reference, conn.secretKey);
  } catch (err) {
    console.error(`[auto-charge/recheck] ref=${reference} verify failed`, err);
    if (!isNotFound(err)) return { ok: true, outcome: "pending" };
  }

  if (tx?.status === "success") {
    const res = await reconcileAutoCharge({ subAccountId, secretKey: conn.secretKey, reference });
    const after = (await quoteRef.get()).data() as Quote | undefined;
    if (after?.status === "paid" && after.paidVia?.rail === "paystack_auto" && after.paidVia.reference === reference) {
      return { ok: true, outcome: "paid" };
    }
    // Not recorded: Paystack could not be asked again, or the reconciler raised a Task.
    return { ok: true, outcome: res.retry ? "pending" : "needs_attention" };
  }
  if (tx && !NOT_PAID.has(tx.status)) return { ok: true, outcome: "pending" };

  const reason = tx ? `Paystack reports the charge ${tx.status}` : "Paystack has no record of this charge";
  const attemptRef = db.doc(`paymentAttempts/${reference}`);
  const declined = await db.runTransaction(async (t) => {
    const a = (await t.get(attemptRef)).data() as PaymentAttempt | undefined;
    const invoice = (await t.get(quoteRef)).data() as Quote | undefined;
    const live = invoice?.autoCharge;
    if (!live || live.reference !== reference || !RECHECKABLE.has(live.state)) return null;
    // Settled or flagged: money may have arrived after all. Leave it to the operator.
    if (a?.state !== "open" && a?.state !== "refused") return null;
    const refuse = () => t.update(attemptRef, { state: "refused", reason, updatedAt: FieldValue.serverTimestamp() });
    // Marked paid by hand meanwhile: the card failed, but the invoice is not
    // un-paid, re-sent or counted against the card. Only the call that closes
    // the attempt reports it.
    if (invoice.status === "paid") {
      if (a.state !== "open") return null;
      refuse();
      return "failed_but_paid" as const;
    }
    if (a.state === "open") refuse();
    t.update(quoteRef, { autoCharge: { ...live, state: "declined", reason }, updatedAt: FieldValue.serverTimestamp() });
    return "declined" as const;
  });
  if (!declined) return fail(409, "This card charge changed while it was being re-checked. Reload and check again.", "changed");
  if (declined === "failed_but_paid") return { ok: true, outcome: declined };

  const schedule = attempt.recurringInvoiceId
    ? (await db.doc(`recurringInvoices/${attempt.recurringInvoiceId}`).get()).data()
    : undefined;
  if (attempt.mandateId) {
    await countDecline(attempt.mandateId, reason, Number(schedule?.unpaidEscalationThreshold ?? 0)).catch((err: unknown) =>
      console.error(`[auto-charge/recheck] ref=${reference} decline not counted on the mandate`, err),
    );
  }
  return { ok: true, outcome: "declined" };
}
