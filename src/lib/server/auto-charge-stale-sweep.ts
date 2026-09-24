import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { raiseChargeTask } from "@/lib/server/auto-charge-alerts";
import { recheckCardCharge } from "@/lib/server/auto-charge-recheck";
import { fireChargeTrigger, parseAutoChargeReference } from "@/lib/server/recurring-auto-charge";
import { chargeFallback } from "@/lib/server/recurring-charge-fallback";
import { toDate } from "@/lib/server/recurring-invoice-cycle";
import type { PaymentAttempt } from "@/types/payment-attempts";
import type { Quote } from "@/types/quotes";
import type { RecurringInvoiceDoc } from "@/types/recurring-invoices";

/**
 * The daily sweep's "Re-check card charge", for every card cycle whose charge
 * got no definitive answer: Paystack's webhook reports only successes, so a
 * charge that later FAILED would otherwise wait for an operator's click.
 *
 * Runs the same `recheckCardCharge` as the button, then does what a
 * synchronous outcome does in `chargeCycle`:
 *   paid        → nothing more (the reconciler fired `charge_succeeded`);
 *   declined    → the invoice emailed with its pay link, `charge_failed` —
 *                 only by the call whose transaction moved the charge to
 *                 declined, so a racing button or webhook cannot double it;
 *   pending     → left; after 72h ONE Task, claimed by `staleAlertedAt`;
 *   refused (the key changed, …) → left quietly, for `flagStaleAttempts`.
 */

const MIN_AGE_MS = 60 * 60 * 1000;
const ALERT_AGE_MS = 72 * 60 * 60 * 1000;
export const STALE_RECHECK_BATCH = 25;

export type StaleRecheckSummary = { checked: number; paid: number; declined: number; alerted: number };

export async function recheckStaleAutoCharges(now: Date): Promise<StaleRecheckSummary> {
  const open = await getAdminDb()
    .collection("paymentAttempts")
    .where("state", "==", "open")
    .where("paymentLinkId", "==", null)
    .where("createdAt", "<=", new Date(now.getTime() - MIN_AGE_MS))
    .orderBy("createdAt")
    .limit(STALE_RECHECK_BATCH)
    .get();
  const summary: StaleRecheckSummary = { checked: 0, paid: 0, declined: 0, alerted: 0 };
  for (const doc of open.docs) {
    const attempt = { ...doc.data(), id: doc.id } as PaymentAttempt;
    if (!attempt.mandateId || !attempt.invoiceId || !parseAutoChargeReference(attempt.id)) continue;
    summary.checked += 1;
    try {
      const outcome = await recheckOne(attempt, now);
      if (outcome) summary[outcome] += 1;
    } catch (err) {
      console.error(`[auto-charge/stale] ref=${attempt.id} re-check failed`, err);
    }
  }
  return summary;
}

async function recheckOne(attempt: PaymentAttempt, now: Date): Promise<"paid" | "declined" | "alerted" | null> {
  const db = getAdminDb();
  const tag = `[auto-charge/stale] ref=${attempt.id}`;
  const invoiceId = attempt.invoiceId!;
  const snap = attempt.recurringInvoiceId ? await db.doc(`recurringInvoices/${attempt.recurringInvoiceId}`).get() : null;
  if (!snap?.exists) {
    console.error(`${tag} schedule not found; left for the operator`);
    return null;
  }
  const schedule = { ...(snap.data() as RecurringInvoiceDoc), id: snap.id };

  const res = await recheckCardCharge(attempt.subAccountId, invoiceId);
  if (!res.ok) {
    // The key changed (flagStaleAttempts owns it), a webhook or the button got
    // there first, or the invoice moved on: nothing for the sweep to add.
    console.warn(`${tag} not re-checked: ${res.error}`);
    return null;
  }
  if (res.outcome === "paid") return "paid";
  if (res.outcome === "declined") {
    const invoice = (await db.doc(`quotes/${invoiceId}`).get()).data() as Quote | undefined;
    const label = invoice?.quoteNumber || invoiceId;
    const { emailInstead } = chargeFallback(schedule, invoiceId, label, tag);
    await emailInstead(`Card declined for invoice ${label} (${invoice?.autoCharge?.reason ?? "declined"}).`);
    await fireChargeTrigger(schedule, "invoice.charge_failed");
    return "declined";
  }
  if (res.outcome !== "pending") return null;

  const createdAt = toDate(attempt.createdAt);
  if (!createdAt || now.getTime() - createdAt.getTime() < ALERT_AGE_MS) return null;
  const ref = db.doc(`paymentAttempts/${attempt.id}`);
  const claimed = await db.runTransaction(async (t) => {
    const live = (await t.get(ref)).data() as PaymentAttempt | undefined;
    if (live?.state !== "open" || live.staleAlertedAt) return false;
    t.update(ref, { staleAlertedAt: FieldValue.serverTimestamp() });
    return true;
  });
  if (!claimed) return null;
  const invoice = (await db.doc(`quotes/${invoiceId}`).get()).data() as Quote | undefined;
  const label = invoice?.quoteNumber || invoiceId;
  try {
    await raiseChargeTask(
      schedule,
      `Card charge for invoice ${label} is still unconfirmed after 3 days: check Paystack (reference ${attempt.id})`,
      `Paystack still gives no final answer for the saved-card charge on invoice ${label} (reference ${attempt.id}). ` +
        `Check it in your Paystack dashboard. Do not send a pay link: it would charge the customer twice.`,
    );
  } catch (err) {
    // Release the claim so the next sweep raises it.
    await ref.update({ staleAlertedAt: FieldValue.delete() }).catch((e: unknown) => console.error(`${tag} claim not released`, e));
    throw err;
  }
  return "alerted";
}
