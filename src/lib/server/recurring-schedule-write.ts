import "server-only";

import { FieldValue, Timestamp, type DocumentReference } from "firebase-admin/firestore";

import { parseScheduleUpdate, type ScheduleCreateFields, type ScheduleUpdateFields } from "@/lib/recurring/schedule-input";
import { toDate } from "@/lib/server/recurring-invoice-cycle";
import { readProration } from "@/lib/recurring/prorate-record";
import { alertOrphanedCredits, prorationFields, prorationForEdit, raiseProrationGaps } from "@/lib/server/recurring-prorate";
import { RECURRING_INVOICE_DEFAULTS, type RecurringInvoiceDoc } from "@/types/recurring-invoices";

/**
 * Writing recurring-invoice schedules, shared by the schedule routes and the
 * agent's recurring capabilities: the document a create writes, and the
 * update an edit / pause / resume / cancel writes (with its pro-ration).
 */

export function scheduleCreateDoc(opts: {
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  contactId: string;
  fields: ScheduleCreateFields;
}): Omit<RecurringInvoiceDoc, "id"> {
  const { fields } = opts;
  return {
    agencyId: opts.agencyId,
    subAccountId: opts.subAccountId,
    createdByUid: opts.createdByUid,
    contactId: opts.contactId,
    name: fields.name,
    status: RECURRING_INVOICE_DEFAULTS.status,
    currency: fields.currency,
    lineItems: fields.lineItems ?? [],
    globalDiscount: fields.globalDiscount,
    globalTaxPercent: fields.globalTaxPercent,
    termsAndNotes: fields.termsAndNotes,
    billedToOrganization: fields.billedToOrganization,
    billingAddress: fields.billingAddress,
    paymentDueDays: fields.paymentDueDays,
    cadence: fields.cadence,
    anchorDay: fields.anchorDay,
    timezone: fields.timezone,
    startAt: Timestamp.fromDate(fields.startAt),
    nextRunAt: Timestamp.fromDate(fields.nextRunAt),
    endMode: fields.endMode,
    endAt: fields.endAt ? Timestamp.fromDate(fields.endAt) : null,
    maxCycles: fields.maxCycles,
    reviewFirst: fields.reviewFirst,
    chargeMode: fields.chargeMode,
    unpaidEscalationThreshold: fields.unpaidEscalationThreshold,
    cyclesGenerated: RECURRING_INVOICE_DEFAULTS.cyclesGenerated,
    lastRunAt: null,
    lastInvoiceId: null,
    outstandingInvoices: RECURRING_INVOICE_DEFAULTS.outstandingInvoices,
    lastEscalatedAt: null,
    lastEscalatedCount: null,
    lastError: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

export interface ScheduleEdit {
  parsed: ScheduleUpdateFields;
  updates: Record<string, unknown>;
  proration: ReturnType<typeof prorationForEdit>;
}

/** The update an edit writes, or why it is refused. */
export function planScheduleEdit(
  schedule: RecurringInvoiceDoc,
  body: Record<string, unknown>,
  now: Date,
): { ok: true; edit: ScheduleEdit } | { ok: false; error: string } {
  const parsed = parseScheduleUpdate(
    body,
    {
      cadence: schedule.cadence,
      anchorDay: schedule.anchorDay,
      timezone: schedule.timezone,
      status: schedule.status,
      nextRunAt: toDate(schedule.nextRunAt),
      reviewFirst: schedule.reviewFirst,
      currency: schedule.currency,
      chargeMode: schedule.chargeMode,
      lastRunAt: toDate(schedule.lastRunAt),
    },
    now,
  );
  if (!parsed.ok) return parsed;

  const { recomputeNextRunFrom, endAt, resumeNote, ...rest } = parsed.value;
  const updates: Record<string, unknown> = {
    ...rest,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (endAt !== undefined) {
    updates.endAt = endAt ? Timestamp.fromDate(endAt) : null;
  }
  if (recomputeNextRunFrom) {
    updates.nextRunAt = Timestamp.fromDate(recomputeNextRunFrom);
  }
  // Editing a schedule is the operator answering whatever the last run
  // complained about, so the stale complaint goes with the edit — unless the
  // edit itself has something to say (a resume that skipped cycles).
  if (Object.keys(rest).length > 0) updates.lastError = resumeNote ?? null;

  // A billing-day change on a schedule that has billed is pro-rated
  // (`prorate.ts`), which also picks the next run; committed against the
  // state it was computed from.
  const proration = prorationForEdit(schedule, parsed.value, now);
  if (proration) {
    // The end-date check in `parseScheduleUpdate` saw the pre-pro-ration next run.
    const end = endAt !== undefined ? endAt : toDate(schedule.endAt);
    if (end && proration.next.getTime() > end.getTime()) {
      return { ok: false, error: "The end date falls before the next billing date." };
    }
    Object.assign(updates, prorationFields(proration.record, now), { nextRunAt: Timestamp.fromDate(proration.next) });
  }
  return { ok: true, edit: { parsed: parsed.value, updates, proration } };
}

/** What follows a committed edit: its pro-ration gaps and orphaned credits. */
export async function afterScheduleEdit(ref: DocumentReference, schedule: RecurringInvoiceDoc, edit: ScheduleEdit, now: Date): Promise<void> {
  // Best effort: the daily sweep raises any gap this leaves pending.
  if (edit.proration?.record.gaps.some((g) => g.state === "pending")) {
    await raiseProrationGaps(ref, now).catch((err) => console.error("[recurring-invoices/patch] gap raise deferred to the sweep", err));
  }
  // Cancelled: no invoice will carry a credit still owed.
  const owed = readProration(schedule.proration)?.credits.filter((c) => c.cycle === null) ?? [];
  if (edit.parsed.status === "cancelled" && owed.length) await alertOrphanedCredits(schedule, owed);
}
