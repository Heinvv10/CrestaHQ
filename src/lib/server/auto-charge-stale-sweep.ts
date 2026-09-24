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
 *   paid            → nothing more (the reconciler fired `charge_succeeded`);
 *   declined        → the invoice emailed with its pay link, `charge_failed` —
 *                     only by the call whose transaction moved the charge to
 *                     declined, so a racing button or webhook cannot double it;
 *   failed_but_paid → marked paid by hand meanwhile: ONE Task, nothing sent;
 *   pending         → left; after 72h ONE Task, claimed by `staleAlertedAt`;
 *   refused over the connection (key changed, disconnected) → left quietly,
 *                     for `flagStaleAttempts`;
 *   refused over its records (no invoice, no card charge on it, no schedule)
 *                   → after 72h flagged, so it leaves the open query, and ONE Task.
 */

const MIN_AGE_MS = 60 * 60 * 1000;
const ALERT_AGE_MS = 72 * 60 * 60 * 1000;
/** Re-checks that ask Paystack, per run. The page is larger, and attempts refused
 *  before Paystack is asked do not count, so they cannot starve the batch. */
export const STALE_RECHECK_BATCH = 25;
const PAGE = 100;
const BUDGET_MS = 60_000;

export type StaleRecheckSummary = {
  /** Re-checks that asked Paystack. */
  checked: number;
  paid: number;
  declined: number;
  alerted: number;
  /** Not started because the run's time budget was spent. */
  overBudget: number;
};

export async function recheckStaleAutoCharges(now: Date, budgetMs = BUDGET_MS): Promise<StaleRecheckSummary> {
  const startedAt = Date.now();
  const open = await getAdminDb()
    .collection("paymentAttempts")
    .where("state", "==", "open")
    .where("paymentLinkId", "==", null)
    .where("createdAt", "<=", new Date(now.getTime() - MIN_AGE_MS))
    .orderBy("createdAt")
    .limit(PAGE)
    .get();
  const summary: StaleRecheckSummary = { checked: 0, paid: 0, declined: 0, alerted: 0, overBudget: 0 };
  for (const doc of open.docs) {
    if (summary.checked >= STALE_RECHECK_BATCH) break;
    const attempt = { ...doc.data(), id: doc.id } as PaymentAttempt;
    if (!parseAutoChargeReference(attempt.id)) continue;
    if (Date.now() - startedAt >= budgetMs) {
      summary.overBudget += 1;
      continue;
    }
    try {
      const { asked, outcome } = await recheckOne(attempt, now);
      if (asked) summary.checked += 1;
      if (outcome) summary[outcome] += 1;
    } catch (err) {
      summary.checked += 1;
      console.error(`[auto-charge/stale] ref=${attempt.id} re-check failed`, err);
    }
  }
  return summary;
}

type Outcome = "paid" | "declined" | "alerted" | null;
/** `asked`: Paystack was asked, so it counts against the batch. */
type Result = { asked: boolean; outcome: Outcome };

async function recheckOne(attempt: PaymentAttempt, now: Date): Promise<Result> {
  const db = getAdminDb();
  const tag = `[auto-charge/stale] ref=${attempt.id}`;
  const ref = attempt.id;
  const invoiceId = attempt.invoiceId;
  const invoice = invoiceId ? ((await db.doc(`quotes/${invoiceId}`).get()).data() as Quote | undefined) : undefined;
  const label = invoice?.quoteNumber || invoiceId || "unknown";
  const owner = { ...attempt, contactId: invoice?.contactId ?? null };
  const alert = (title: string, notes: string) => raiseChargeTask(owner, title, notes);
  const created = toDate(attempt.createdAt);
  const stale = !!created && now.getTime() - created.getTime() >= ALERT_AGE_MS;
  const asked = (outcome: Outcome): Result => ({ asked: true, outcome });
  // Nothing the sweep can resolve by itself: after 3 days, flag it and tell the operator.
  const unresolvable = async (why: string): Promise<Result> => {
    console.warn(`${tag} cannot be re-checked: ${why}`);
    if (!stale) return { asked: false, outcome: null };
    const flag = `Not confirmed automatically after 3 days (${why}). The card may have been charged: check Paystack.`;
    const title = `Card charge ${ref} (invoice ${label}) could not be confirmed automatically — the card may have been charged. Check Paystack.`;
    return { asked: false, outcome: await alertOnce(ref, { state: "flagged", reason: flag }, () => alert(title, flag)) };
  };

  if (!attempt.mandateId || !invoiceId || !invoice) return unresolvable("its card or invoice is missing");
  const snap = attempt.recurringInvoiceId ? await db.doc(`recurringInvoices/${attempt.recurringInvoiceId}`).get() : null;
  if (!snap?.exists) return unresolvable("its recurring schedule is gone");
  const schedule = { ...(snap.data() as RecurringInvoiceDoc), id: snap.id };

  const res = await recheckCardCharge(attempt.subAccountId, invoiceId);
  if (!res.ok) {
    // The connection is `flagStaleAttempts`'. Otherwise a race the webhook or
    // the button won (the claim finds the attempt no longer open), or records
    // the sweep cannot act on.
    if (res.refusal === "connection") return { asked: false, outcome: null };
    const r = await unresolvable(res.error);
    return { ...r, asked: res.refusal === "changed" };
  }
  if (res.outcome === "paid") return asked("paid");
  if (res.outcome === "failed_but_paid") {
    await alert(
      `Card charge ${ref} for invoice ${label} failed at Paystack, but the invoice was already marked paid by hand — confirm the payment you recorded.`,
      `Paystack reports the saved-card charge for invoice ${label} (reference ${ref}) did not go through. The invoice was marked paid by hand before that was known, so nothing was changed or sent.`,
    );
    return asked("alerted");
  }
  if (res.outcome === "declined") {
    await declineFollowUp(schedule, invoiceId, label, tag, alert);
    return asked("declined");
  }
  if (res.outcome !== "pending" || !stale) return asked(null);
  return asked(
    await alertOnce(ref, {}, () =>
      alert(
        `Card charge for invoice ${label} is still unconfirmed after 3 days: check Paystack (reference ${ref})`,
        `Paystack still gives no final answer for the saved-card charge on invoice ${label} (reference ${ref}). ` +
          `Check it in your Paystack dashboard. Do not send a pay link: it would charge the customer twice.`,
      ),
    ),
  );
}

/**
 * What a synchronous decline does after recording it: email the invoice (its
 * failures raise their own Task, see `chargeFallback`) and fire `charge_failed`.
 * A throw before the email starts would leave a decline nobody hears of.
 */
async function declineFollowUp(
  schedule: RecurringInvoiceDoc,
  invoiceId: string,
  label: string,
  tag: string,
  alert: (title: string, notes: string) => Promise<void>,
) {
  let emailing = false;
  try {
    const reason = ((await getAdminDb().doc(`quotes/${invoiceId}`).get()).data() as Quote | undefined)?.autoCharge?.reason;
    emailing = true;
    await chargeFallback(schedule, invoiceId, label, tag).emailInstead(`Card declined for invoice ${label} (${reason ?? "declined"}).`);
  } catch (err) {
    console.error(`${tag} declined invoice not emailed`, err);
    if (!emailing) {
      const why = err instanceof Error ? err.message : String(err);
      await alert(
        `Card charge for invoice ${label} was declined, but the invoice could not be emailed automatically: ${why}. Send it by hand.`,
        `Paystack reports the saved-card charge for invoice ${label} did not go through. Send the invoice so the customer can pay.`,
      );
    }
  }
  await fireChargeTrigger(schedule, "invoice.charge_failed");
}

/**
 * Claim the attempt's one alert (`staleAlertedAt`, with `update`) in a
 * transaction that finds it still open; raise it; release the claim if the
 * Task cannot be created, so the next run tries again.
 */
async function alertOnce(reference: string, update: Record<string, unknown>, raise: () => Promise<void>): Promise<Outcome> {
  const db = getAdminDb();
  const attemptRef = db.doc(`paymentAttempts/${reference}`);
  const claimed = await db.runTransaction(async (t) => {
    const live = (await t.get(attemptRef)).data() as PaymentAttempt | undefined;
    if (live?.state !== "open" || live.staleAlertedAt) return false;
    t.update(attemptRef, { ...update, staleAlertedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    return true;
  });
  if (!claimed) return null;
  try {
    await raise();
  } catch (err) {
    await db
      .runTransaction(async (t) => {
        const live = (await t.get(attemptRef)).data() as PaymentAttempt | undefined;
        // Only while still ours: a payment may have settled a flagged attempt since.
        if (!live?.staleAlertedAt || (update.state && live.state !== update.state)) return;
        t.update(attemptRef, { staleAlertedAt: FieldValue.delete(), ...(update.state ? { state: "open", reason: null } : {}) });
      })
      .catch((e: unknown) => console.error(`[auto-charge/stale] ref=${reference} claim not released`, e));
    throw err;
  }
  return "alerted";
}
