import "server-only";

import { FieldValue, type DocumentReference } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { raiseChargeTask } from "@/lib/server/auto-charge-alerts";
import { formatCurrency } from "@/lib/format";
import { gapInvoiceTemplate, planProration, readProration, type ProrationRecord } from "@/lib/recurring/prorate";
import type { ScheduleUpdateFields } from "@/lib/recurring/schedule-input";
import {
  generateInvoice,
  notifyDraftForReview,
  sendGeneratedInvoice,
  toDate,
} from "@/lib/server/recurring-invoice-cycle";
import type { RecurringInvoiceDoc } from "@/types/recurring-invoices";

/**
 * The persistence half of pro-rating a billing-day change (`prorate.ts` is the
 * arithmetic). The PATCH route calls these; nothing else raises a pro-rata.
 */

export type ProrationEdit = { record: ProrationRecord | null; note: string | null };

/**
 * What an edit pro-rates, or null when it touches nothing pro-rated.
 * `note`: a pending credit the edit orphaned (a frequency change or a resume
 * moved the cycle it was owed on) — told to the operator, never dropped quietly.
 */
export function prorationForEdit(schedule: RecurringInvoiceDoc, edit: ScheduleUpdateFields): ProrationEdit | null {
  const next = edit.recomputeNextRunFrom ?? null;
  if (!next) return null;
  const prior = readProration(schedule.proration);
  const lastDueAt = toDate(schedule.lastDueAt);
  const record = planProration({
    timezone: schedule.timezone,
    before: {
      status: schedule.status,
      cadence: schedule.cadence,
      anchorDay: schedule.anchorDay,
      nextRunAt: toDate(schedule.nextRunAt),
      lastDueAt,
      cyclesGenerated: schedule.cyclesGenerated ?? 0,
      proration: prior,
    },
    after: {
      status: edit.status ?? schedule.status,
      cadence: edit.cadence ?? schedule.cadence,
      anchorDay: "anchorDay" in edit ? (edit.anchorDay ?? null) : schedule.anchorDay,
      nextRunAt: next,
      template: {
        lineItems: edit.lineItems ?? schedule.lineItems,
        globalDiscount: edit.globalDiscount !== undefined ? edit.globalDiscount : schedule.globalDiscount,
        globalTaxPercent: edit.globalTaxPercent !== undefined ? edit.globalTaxPercent : schedule.globalTaxPercent,
      },
    },
  });
  if (record) return { record, note: null };
  const credit = prior?.credit;
  const pending = !!credit && (prior.forLastDueAt?.getTime() ?? null) === (lastDueAt?.getTime() ?? null);
  if (!pending || credit.appliesToDueAt.getTime() === next.getTime()) return null;
  const amount = formatCurrency(credit.taxable, schedule.currency);
  return {
    record: null,
    note: `${credit.label}: a credit of ${amount} excl. tax was not applied, because this edit moved the cycle it was owed on. Credit it by hand.`,
  };
}

/**
 * Write the edit and its pro-ration in ONE transaction that re-reads the
 * billing state the plan was computed from. A concurrent edit or a cycle
 * billing in between makes the plan stale, so this refuses rather than
 * pro-rating the same days twice.
 */
export async function commitWithProration(
  ref: DocumentReference,
  seen: RecurringInvoiceDoc,
  updates: Record<string, unknown>,
  proration: ProrationEdit,
): Promise<boolean> {
  const ms = (v: unknown) => toDate(v)?.getTime() ?? null;
  return getAdminDb().runTransaction(async (tx) => {
    const now = (await tx.get(ref)).data() as RecurringInvoiceDoc | undefined;
    if (
      !now ||
      now.status !== seen.status ||
      now.anchorDay !== seen.anchorDay ||
      now.cadence?.unit !== seen.cadence.unit ||
      now.cadence?.interval !== seen.cadence.interval ||
      (now.cyclesGenerated ?? 0) !== (seen.cyclesGenerated ?? 0) ||
      ms(now.nextRunAt) !== ms(seen.nextRunAt) ||
      ms(now.lastDueAt) !== ms(seen.lastDueAt)
    ) {
      return false;
    }
    tx.update(ref, {
      ...updates,
      ...(proration.record ? { proration: proration.record } : {}),
      ...(proration.note ? { lastError: proration.note } : {}),
    });
    return true;
  });
}

/**
 * Raise the one-off invoice for a gap, as the schedule stands after the edit.
 *
 * Raised now, not when the old cycle ends: every schedule invoice bills its
 * period in advance, and this one's period starts at the old billing day.
 * `reviewFirst` parks it as a draft. It is EMAILED even on a card schedule —
 * the customer authorised one fixed amount per cycle, and this is neither.
 * A failure is written to `lastError` for a human to raise it by hand.
 */
export async function raiseGapInvoice(ref: DocumentReference, now: Date): Promise<void> {
  // Claimed in a transaction first, so two callers can never both raise it.
  const claimed = await getAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const gap = readProration((snap.data() as RecurringInvoiceDoc | undefined)?.proration)?.gap;
    if (!gap || gap.invoiceId) return null;
    tx.update(ref, { "proration.gap.invoiceId": "raising" });
    return { gap, schedule: { ...(snap.data() as RecurringInvoiceDoc), id: snap.id } };
  });
  if (!claimed) return;
  const { gap, schedule } = claimed;
  try {
    const invoice = await generateInvoice({ ...schedule, ...gapInvoiceTemplate(gap, schedule) }, now);
    await ref.update({ "proration.gap.invoiceId": invoice.invoiceId, updatedAt: FieldValue.serverTimestamp() });
    if (schedule.reviewFirst) notifyDraftForReview(schedule, invoice);
    else await sendGeneratedInvoice(schedule, invoice.invoiceId);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[recurring/prorate] gap invoice failed for ${schedule.id}: ${reason}`);
    const note = `${gap.label}: the pro-rated invoice could not be raised (${reason}). Raise it by hand.`.slice(0, 500);
    await ref.update({ lastError: note, updatedAt: FieldValue.serverTimestamp() }).catch(() => {});
    await alertProration(schedule, note);
  }
}

/**
 * A Task for pro-rating that needs a human. `lastError` alone is not enough:
 * the next cycle or edit clears it (see the W5 notes on operator Tasks).
 */
export async function alertProration(schedule: RecurringInvoiceDoc, note: string): Promise<void> {
  await raiseChargeTask(schedule, `Pro-rating on "${schedule.name}" needs a hand`, note).catch((err: unknown) =>
    console.error(`[recurring/prorate] task not raised for ${schedule.id}`, err),
  );
}
