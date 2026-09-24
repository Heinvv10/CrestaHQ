import "server-only";

import { FieldValue, type DocumentReference } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  gapInvoiceTemplate,
  planProration,
  readProration,
  type ProrationGap,
  type ProrationRecord,
} from "@/lib/recurring/prorate";
import type { ScheduleUpdateFields } from "@/lib/recurring/schedule-input";
import { raiseChargeTask } from "@/lib/server/auto-charge-alerts";
import {
  generateInvoice,
  notifyDraftForReview,
  schedulesCollection,
  sendGeneratedInvoice,
  toDate,
} from "@/lib/server/recurring-invoice-cycle";
import type { RecurringInvoiceDoc } from "@/types/recurring-invoices";

/**
 * The persistence half of pro-rating a billing-day change (`prorate.ts` is the
 * arithmetic): the PATCH route plans and commits; the daily sweep raises every
 * pending gap invoice, retrying until it exists; the edit also tries at once.
 */

/** A claim older than this is presumed dead (a crashed raiser) and retaken. */
export const GAP_CLAIM_STALE_MS = 15 * 60_000;
/** Schedules with pending gaps handled per sweep invocation. */
const GAP_BATCH = 25;

/** What an edit pro-rates — the record and the next regular run — or null. */
export function prorationForEdit(
  schedule: RecurringInvoiceDoc,
  edit: ScheduleUpdateFields,
  now: Date,
): { record: ProrationRecord; next: Date } | null {
  if (!edit.recomputeNextRunFrom) return null; // no billing-day, frequency or resume change
  return planProration({
    timezone: schedule.timezone,
    now,
    newGapDocId: () => getAdminDb().collection("quotes").doc().id,
    before: {
      status: schedule.status,
      cadence: schedule.cadence,
      anchorDay: schedule.anchorDay,
      nextRunAt: toDate(schedule.nextRunAt),
      lastDueAt: toDate(schedule.lastDueAt),
      lastRunAt: toDate(schedule.lastRunAt),
      cyclesGenerated: schedule.cyclesGenerated ?? 0,
      proration: readProration(schedule.proration),
    },
    after: {
      status: edit.status ?? schedule.status,
      cadence: edit.cadence ?? schedule.cadence,
      anchorDay: "anchorDay" in edit ? (edit.anchorDay ?? null) : schedule.anchorDay,
      template: {
        lineItems: edit.lineItems ?? schedule.lineItems,
        globalDiscount: edit.globalDiscount !== undefined ? edit.globalDiscount : schedule.globalDiscount,
        globalTaxPercent: edit.globalTaxPercent !== undefined ? edit.globalTaxPercent : schedule.globalTaxPercent,
      },
    },
  });
}

/** The fields a pro-ration writes onto the schedule. */
export function prorationFields(record: ProrationRecord): Record<string, unknown> {
  return { proration: record, prorationPending: record.gaps.some((g) => g.state !== "raised") };
}

/**
 * Write the edit and its pro-ration in ONE transaction that re-reads the
 * billing state the plan was computed from. A concurrent edit, a cycle billing
 * or a gap being raised in between makes the plan stale, so this refuses
 * rather than pro-rating the same days twice.
 */
export async function commitWithProration(
  ref: DocumentReference,
  seen: RecurringInvoiceDoc,
  updates: Record<string, unknown>,
): Promise<boolean> {
  const ms = (v: unknown) => toDate(v)?.getTime() ?? null;
  const state = (d: RecurringInvoiceDoc) => JSON.stringify(readProration(d.proration));
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
      ms(now.lastDueAt) !== ms(seen.lastDueAt) ||
      state(now) !== state(seen)
    ) {
      return false;
    }
    tx.update(ref, updates);
    return true;
  });
}

/** The sweep's half: raise the pending gaps of every schedule that has one. */
export async function raisePendingProrations(now: Date = new Date()): Promise<number> {
  const snap = await schedulesCollection().where("prorationPending", "==", true).limit(GAP_BATCH).get();
  let raised = 0;
  for (const doc of snap.docs) raised += await raiseProrationGaps(doc.ref, now);
  return raised;
}

/**
 * Raise a schedule's pending gap invoices, as the schedule stands now.
 *
 * Each gap is claimed in a transaction before any work, under the quote id
 * fixed at the edit — so two raisers never both raise it, and a claim retaken
 * after a crash finds the invoice if it was created and does not raise another.
 * `reviewFirst` parks it as a draft. It is EMAILED even on a card schedule: the
 * customer authorised one fixed amount per cycle, and this is not it.
 * Every failure leaves the gap pending for the next sweep, with `lastError`
 * and a Task.
 */
export async function raiseProrationGaps(ref: DocumentReference, now: Date): Promise<number> {
  const db = getAdminDb();
  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const schedule = { ...(snap.data() as RecurringInvoiceDoc), id: snap.id };
    const record = readProration(schedule.proration);
    if (!record) return null;
    const cancelled = schedule.status === "cancelled";
    const due = (g: ProrationGap) =>
      g.state === "pending" || (g.state === "raising" && now.getTime() - (g.claimedAt?.getTime() ?? 0) > GAP_CLAIM_STALE_MS);
    const picked = cancelled ? [] : record.gaps.filter(due);
    // A cancelled agreement owes nothing for days after it ended.
    const gaps = record.gaps.flatMap((g) =>
      cancelled && g.state === "pending" ? [] : [picked.includes(g) ? { ...g, state: "raising" as const, claimedAt: now } : g],
    );
    tx.update(ref, prorationFields({ ...record, gaps }));
    return picked.length ? { schedule, picked } : null;
  });
  if (!claimed) return 0;
  let raised = 0;
  for (const gap of claimed.picked) {
    if (await raiseOne(ref, claimed.schedule, gap, now)) raised += 1;
  }
  return raised;
}

async function raiseOne(ref: DocumentReference, schedule: RecurringInvoiceDoc, gap: ProrationGap, now: Date): Promise<boolean> {
  const exists = (await getAdminDb().doc(`quotes/${gap.docId}`).get()).exists;
  try {
    if (exists) {
      // A retaken claim: the invoice was created, the send's outcome is unknown.
      // Never re-send on a guess (see recurring-invoice-service.ts).
      await alertProration(schedule, `${gap.label}: invoice ${gap.docId} was raised, but whether it was sent is unknown. Check it.`);
    } else {
      const invoice = await generateInvoice({ ...schedule, ...gapInvoiceTemplate(gap, schedule) }, now, {
        docId: gap.docId,
        prorated: "gap",
      });
      if (schedule.reviewFirst) notifyDraftForReview(schedule, invoice);
      else {
        const sent = await sendGeneratedInvoice(schedule, invoice.invoiceId);
        if (!sent.sent) await alertProration(schedule, `${gap.label}: invoice ${invoice.quoteNumber} was raised but not sent: ${sent.error}. Send it by hand.`);
        else if (schedule.chargeMode === "card") {
          await alertProration(
            schedule,
            `${gap.label}: invoice ${invoice.quoteNumber} was emailed, not charged to the saved card. This is a deliberate ` +
              `pro-rata for the billing-day change, so it differs from the amount the customer authorised — nothing to fix.`,
          );
        }
      }
    }
    await markGap(ref, gap.docId, { state: "raised", invoiceId: gap.docId });
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[recurring/prorate] gap invoice failed for ${schedule.id}: ${reason}`);
    const created = (await getAdminDb().doc(`quotes/${gap.docId}`).get().catch(() => null))?.exists ?? false;
    const note = `${gap.label}: the pro-rated invoice could not be ${created ? "sent" : "raised"} (${reason}). ${created ? "Send it by hand." : "It will be retried on the next daily run."}`;
    await markGap(ref, gap.docId, created ? { state: "raised", invoiceId: gap.docId } : { state: "pending", claimedAt: null }, note).catch(
      (e: unknown) => console.error(`[recurring/prorate] gap state not written for ${schedule.id}`, e),
    );
    await alertProration(schedule, note);
    return false;
  }
}

async function markGap(ref: DocumentReference, docId: string, patch: Partial<ProrationGap>, lastError?: string): Promise<void> {
  await getAdminDb().runTransaction(async (tx) => {
    const record = readProration((await tx.get(ref)).data()?.proration);
    if (!record) return;
    const gaps = record.gaps.map((g) => (g.docId === docId ? { ...g, ...patch } : g));
    tx.update(ref, {
      ...prorationFields({ ...record, gaps }),
      ...(lastError ? { lastError: lastError.slice(0, 500) } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

/**
 * A Task for pro-rating that needs a human. `lastError` alone is not enough:
 * the next cycle or edit clears it (see the W5 notes on operator Tasks).
 */
export async function alertProration(schedule: RecurringInvoiceDoc, note: string): Promise<void> {
  await raiseChargeTask(schedule, `Pro-rated invoice on "${schedule.name}"`, note).catch((err: unknown) =>
    console.error(`[recurring/prorate] task not raised for ${schedule.id}`, err),
  );
}
