import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { issueQuoteNumber } from "@/lib/quotes/number";
import { computeNextRunAt } from "@/lib/recurring/cadence";
import { createTaskServerSide } from "@/lib/server/tasks-service";
import { sendQuoteServerSide } from "@/lib/server/quote-send-service";
import { DEFAULT_QUOTE } from "@/types/quotes";
import {
  UNPAID_INVOICE_STATUSES,
  type RecurringInvoiceDoc,
} from "@/types/recurring-invoices";

/**
 * What one recurring cycle actually does: raise the invoice, send it, then
 * bring the schedule's arrears and completion state up to date.
 *
 * Split from `recurring-invoice-service.ts`, which owns the sweep and the
 * claim — the part that decides WHICH schedules run and guarantees each runs
 * once. Keeping them apart also keeps both under the file-size cap.
 */

export function schedulesCollection() {
  return getAdminDb().collection("recurringInvoices");
}

/** Mint an ordinary invoice from the schedule's snapshotted template. */
export async function generateInvoice(
  schedule: RecurringInvoiceDoc,
  now: Date,
): Promise<string> {
  const quoteNumber = await issueQuoteNumber(
    schedule.subAccountId,
    "invoice",
    now,
  );
  const ref = getAdminDb().collection("quotes").doc();
  await ref.set({
    ...DEFAULT_QUOTE,
    kind: "invoice",
    status: "draft",
    agencyId: schedule.agencyId,
    subAccountId: schedule.subAccountId,
    // The schedule's creator owns every invoice it raises, so the document
    // appears to the operator exactly as a hand-made one would.
    createdByUid: schedule.createdByUid,
    contactId: schedule.contactId,
    quoteNumber,
    currency: schedule.currency,
    lineItems: schedule.lineItems,
    globalDiscount: schedule.globalDiscount,
    globalTaxPercent: schedule.globalTaxPercent,
    termsAndNotes: schedule.termsAndNotes,
    billedToOrganization: schedule.billedToOrganization,
    billingAddress: schedule.billingAddress,
    paymentDueDays: schedule.paymentDueDays,
    recurringInvoiceId: schedule.id,
    publicTokenHash: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

/**
 * Send the generated invoice as the system.
 *
 * `Reply-To` is the sub-account's account contact, not a shared sender: a
 * customer replying to an automated invoice has to reach a human. A send
 * failure does not fail the cycle — the invoice exists and the operator can
 * send it by hand — but it is recorded on the schedule.
 */
export async function sendGeneratedInvoice(
  schedule: RecurringInvoiceDoc,
  invoiceId: string,
): Promise<boolean> {
  const replyTo = await accountContactEmail(schedule.subAccountId);
  const result = await sendQuoteServerSide({
    subAccountId: schedule.subAccountId,
    quoteId: invoiceId,
    replyTo,
    actor: {
      kind: "system",
      reason: `recurring invoice schedule ${schedule.id}`,
    },
  });
  if (!result.ok) {
    console.error(
      `[recurring] send failed for schedule ${schedule.id} invoice ${invoiceId}: ${result.failure.code} ${result.failure.error}`,
    );
    await schedulesCollection()
      .doc(schedule.id)
      .update({
        lastError: `Invoice raised but not sent: ${result.failure.error}`.slice(
          0,
          500,
        ),
        updatedAt: FieldValue.serverTimestamp(),
      })
      .catch(() => {});
    return false;
  }
  return true;
}

/** Arrears recount, escalation, and end-of-schedule completion. */
export async function settleAfterCycle(
  schedule: RecurringInvoiceDoc,
  invoiceId: string,
  sent: boolean,
  now: Date,
): Promise<void> {
  const unpaid = await countUnpaidInvoices(schedule.id);
  const updates: Record<string, unknown> = {
    lastInvoiceId: invoiceId,
    consecutiveUnpaid: unpaid,
    updatedAt: FieldValue.serverTimestamp(),
  };

  const threshold = schedule.unpaidEscalationThreshold;
  const shouldEscalate = threshold > 0 && unpaid >= threshold;
  if (shouldEscalate) {
    await escalateArrears(schedule, unpaid).catch((err) =>
      console.error("[recurring] arrears escalation failed", err),
    );
    updates.lastEscalatedAt = Timestamp.fromDate(now);
  }

  // `cyclesGenerated` was incremented by the claim, so this cycle counts.
  const cycles = (schedule.cyclesGenerated ?? 0) + 1;
  if (isFinished(schedule, cycles, now)) {
    updates.status = "completed";
  }

  await schedulesCollection().doc(schedule.id).update(updates);
  void sent;
}

/**
 * Unpaid invoices this schedule has raised.
 *
 * Counted from the invoices themselves rather than incremented, so an operator
 * marking one paid by hand is picked up without any second write path — and a
 * miscount cannot accumulate.
 */
export async function countUnpaidInvoices(scheduleId: string): Promise<number> {
  const snap = await getAdminDb()
    .collection("quotes")
    .where("recurringInvoiceId", "==", scheduleId)
    .where("status", "in", [...UNPAID_INVOICE_STATUSES])
    .get();
  return snap.size;
}

/** A Task the operator will actually see, rather than a log nobody reads. */
export async function escalateArrears(
  schedule: RecurringInvoiceDoc,
  unpaid: number,
): Promise<void> {
  await createTaskServerSide({
    agencyId: schedule.agencyId,
    subAccountId: schedule.subAccountId,
    createdByUid: schedule.createdByUid,
    title: `${unpaid} unpaid invoices on "${schedule.name}"`,
    notes:
      `The recurring schedule "${schedule.name}" has ${unpaid} invoices still unpaid. ` +
      `Invoices keep being raised on schedule — the debt is real — but a customer ` +
      `this far behind usually means a dead card or a dispute worth a phone call.`,
    contactId: schedule.contactId,
    dueAt: new Date(),
    dealId: null,
    eventId: null,
    // A real invoice was really raised, so this Task fires the same
    // `task.created` webhooks any other would.
    mode: "live",
  });
}

/** Whether this cycle was the schedule's last. */
export function isFinished(
  schedule: RecurringInvoiceDoc,
  cyclesGenerated: number,
  now: Date,
): boolean {
  if (schedule.endMode === "after_count") {
    return cyclesGenerated >= (schedule.maxCycles ?? 0);
  }
  if (schedule.endMode === "on_date") {
    const endAt = toDate(schedule.endAt);
    if (!endAt) return false;
    // Compared against the NEXT run: the schedule ends once its following
    // cycle would fall past the end date, so the last cycle on or before that
    // date is still raised.
    const nextRunAt = computeNextRunAt({
      previous: now,
      cadence: schedule.cadence,
      anchorDay: schedule.anchorDay,
      timezone: schedule.timezone,
    });
    return nextRunAt.getTime() > endAt.getTime();
  }
  return false;
}

export async function accountContactEmail(
  subAccountId: string,
): Promise<string | null> {
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  if (!snap.exists) return null;
  const contact = (snap.data() as Record<string, unknown>).accountContact as
    | { email?: string | null }
    | null
    | undefined;
  return contact?.email?.trim() || null;
}

export function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (
    value &&
    typeof (value as { toDate?: () => Date }).toDate === "function"
  ) {
    return (value as { toDate: () => Date }).toDate();
  }
  return null;
}
