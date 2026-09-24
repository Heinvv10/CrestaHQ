import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { sendPushForEvent } from "@/lib/push/send";
import { issueQuoteNumber } from "@/lib/quotes/number";
import { withProratedCredit, type ProrationCredit } from "@/lib/recurring/prorate";
import {
  createTaskServerSide,
  territoryForContact,
} from "@/lib/server/tasks-service";
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

/** Mint an invoice from the schedule's template, with a pro-rated `credit` the claim gave this cycle. */
export async function generateInvoice(
  schedule: RecurringInvoiceDoc,
  now: Date,
  opts: { credit?: ProrationCredit | null; docId?: string; prorated?: "gap" } = {},
): Promise<{ invoiceId: string; quoteNumber: string; territoryId: string }> {
  // Same stamp the hand-made path applies. Without it the rules read a null
  // territory and deny it to everyone but admins — so the rep who actually
  // owns the account cannot see the invoices raised for it.
  const territoryId = await territoryForContact(schedule.contactId);
  const quoteNumber = await issueQuoteNumber(
    schedule.subAccountId,
    "invoice",
    now,
  );
  const quotes = getAdminDb().collection("quotes");
  const ref = opts.docId ? quotes.doc(opts.docId) : quotes.doc();
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
    ...withProratedCredit(schedule, opts.credit ?? null, schedule.currency),
    ...(opts.prorated || opts.credit ? { prorated: opts.prorated ?? "credit" } : {}),
    termsAndNotes: schedule.termsAndNotes,
    billedToOrganization: schedule.billedToOrganization,
    billingAddress: schedule.billingAddress,
    paymentDueDays: schedule.paymentDueDays,
    recurringInvoiceId: schedule.id,
    territoryId,
    // "" is what the hand-made path writes, and what `Quote.publicTokenHash`
    // is declared as. `set()` on an untyped collection ref would not catch a
    // null here.
    publicTokenHash: "",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { invoiceId: ref.id, quoteNumber, territoryId };
}

/** Plan §1: a review-first draft nobody hears about is one nobody sends. */
export function notifyDraftForReview(
  schedule: RecurringInvoiceDoc,
  invoice: { invoiceId: string; quoteNumber: string; territoryId: string },
): void {
  void sendPushForEvent({
    subAccountId: schedule.subAccountId,
    agencyId: schedule.agencyId,
    title: "Recurring invoice ready to review",
    body: `${schedule.name} · ${invoice.quoteNumber}`,
    url: `/sa/${schedule.subAccountId}/quotes/${invoice.invoiceId}`,
    tag: `quote-${invoice.invoiceId}`,
    territoryId: invoice.territoryId,
  });
}

/**
 * Send the generated invoice as the system.
 *
 * `Reply-To` is the sub-account's account contact, not a shared sender: a
 * customer replying to an automated invoice has to reach a human. A send
 * failure does not fail the cycle — the invoice exists and the operator can
 * send it by hand — but it is recorded on the schedule, after any card `chargeNote`.
 * `cardLinkFallback`: a card-mode invoice went without its card-on-file link
 * (see `chooseInvoicePayRail`), sent or not; the card cycle folds it, and
 * `error`, into its one Task.
 */
export async function sendGeneratedInvoice(
  schedule: RecurringInvoiceDoc,
  invoiceId: string,
  chargeNote?: string,
): Promise<{ sent: boolean; cardLinkFallback: string | null; error: string | null }> {
  const replyTo = await accountContactEmail(schedule.subAccountId);
  const result = await sendQuoteServerSide({
    subAccountId: schedule.subAccountId,
    quoteId: invoiceId,
    replyTo,
    actor: { kind: "system", reason: `recurring invoice schedule ${schedule.id}` },
  });
  if (!result.ok) {
    console.error(
      `[recurring] send failed for schedule ${schedule.id} invoice ${invoiceId}: ${result.failure.code} ${result.failure.error}`,
    );
    const cardLinkFallback = result.cardLinkFallback ?? null;
    const lead = chargeNote ? `${chargeNote} Invoice not sent` : "Invoice raised but not sent";
    const lastError = [`${lead}: ${result.failure.error}`, cardLinkFallback].filter(Boolean).join(" ");
    await schedulesCollection()
      .doc(schedule.id)
      .update({ lastError: lastError.slice(0, 500), updatedAt: FieldValue.serverTimestamp() })
      .catch(() => {});
    return { sent: false, cardLinkFallback, error: result.failure.error };
  }
  return { sent: true, cardLinkFallback: result.cardLinkFallback ?? null, error: null };
}

/**
 * Arrears: recount, escalate when the situation worsens, and record the
 * invoice.
 *
 * Completion is NOT decided here — the claim transaction owns it, so that
 * anything throwing in this function cannot leave a finished schedule active
 * to bill one more time.
 */
export async function settleAfterCycle(
  schedule: RecurringInvoiceDoc,
  invoiceId: string,
): Promise<void> {
  // The invoice just raised is excluded: it cannot be overdue on the day it
  // was sent, and counting it made a threshold of 2 fire when exactly one
  // prior invoice was genuinely outstanding.
  const outstanding = await countOutstandingInvoices(schedule.id, invoiceId);
  const updates: Record<string, unknown> = {
    lastInvoiceId: invoiceId,
    outstandingInvoices: outstanding,
    updatedAt: FieldValue.serverTimestamp(),
  };

  const threshold = schedule.unpaidEscalationThreshold;
  // Only when it got WORSE than the last Task. Escalating on every cycle that
  // merely stays above the threshold buries the operator in duplicate Tasks —
  // each one firing its own `task.created` webhooks — until they stop reading
  // them, which is the opposite of what escalation is for.
  const worsened = outstanding > (schedule.lastEscalatedCount ?? 0);
  if (threshold > 0 && outstanding >= threshold && worsened) {
    await escalateArrears(schedule, outstanding).catch((err) =>
      console.error("[recurring] arrears escalation failed", err),
    );
    updates.lastEscalatedAt = FieldValue.serverTimestamp();
    updates.lastEscalatedCount = outstanding;
  } else if (outstanding < threshold && schedule.lastEscalatedCount) {
    // Caught up: forget the old mark, or falling behind again stays silent
    // until arrears pass wherever they peaked last time.
    updates.lastEscalatedCount = null;
  }

  await schedulesCollection().doc(schedule.id).update(updates);
}

/**
 * Invoices this schedule has SENT that remain unpaid, excluding the one just
 * raised.
 *
 * Counted from the invoices themselves rather than incremented, so an operator
 * marking one paid by hand is picked up without any second write path — and a
 * miscount cannot accumulate.
 */
async function countOutstandingInvoices(
  scheduleId: string,
  excludeInvoiceId: string,
): Promise<number> {
  const snap = await getAdminDb()
    .collection("quotes")
    .where("recurringInvoiceId", "==", scheduleId)
    .where("status", "in", [...UNPAID_INVOICE_STATUSES])
    .get();
  return snap.docs.filter((d) => d.id !== excludeInvoiceId).length;
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

/**
 * Whether the cycle just claimed is the schedule's last.
 *
 * Takes the next run the CLAIM computed rather than deriving its own from the
 * clock. A sweep catching up days late is in a different month from the cycle
 * it is raising, and recomputing here would complete the schedule a cycle
 * early — under-billing the customer for work they owe.
 */
export function isFinalCycle(
  schedule: RecurringInvoiceDoc,
  cyclesGenerated: number,
  nextRunAt: Date,
): boolean {
  if (schedule.endMode === "after_count") {
    const max = schedule.maxCycles;
    if (typeof max !== "number" || max < 1) {
      // `>= 0` would complete the schedule after its first cycle. Failing
      // safe silently is still failing: keep billing and say so.
      console.warn(
        `[recurring] schedule ${schedule.id} ends after_count with no maxCycles — treating as open-ended`,
      );
      return false;
    }
    return cyclesGenerated >= max;
  }
  if (schedule.endMode === "on_date") {
    const endAt = toDate(schedule.endAt);
    if (!endAt) return false;
    // The end date bounds the schedule; it does not cancel a cycle already
    // due. So the schedule ends once the FOLLOWING cycle would fall past it.
    return nextRunAt.getTime() > endAt.getTime();
  }
  return false;
}

/**
 * Whether the schedule was already over before this cycle — the state a
 * settle failure leaves behind, since the claim advances `nextRunAt` before
 * any work happens. Checked at claim time so a customer is never billed past
 * the end of their agreement because of a transient error days earlier.
 */
export function isAlreadyFinished(
  schedule: RecurringInvoiceDoc,
  dueAt: Date,
): boolean {
  if (schedule.endMode === "after_count") {
    const max = schedule.maxCycles;
    if (typeof max !== "number" || max < 1) return false;
    return (schedule.cyclesGenerated ?? 0) >= max;
  }
  if (schedule.endMode === "on_date") {
    const endAt = toDate(schedule.endAt);
    return !!endAt && dueAt.getTime() > endAt.getTime();
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
