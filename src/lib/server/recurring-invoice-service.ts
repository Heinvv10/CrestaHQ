import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { computeNextRunAt } from "@/lib/recurring/cadence";
import {
  generateInvoice,
  isAlreadyFinished,
  isFinalCycle,
  schedulesCollection,
  sendGeneratedInvoice,
  settleAfterCycle,
  toDate,
} from "@/lib/server/recurring-invoice-cycle";
import type {
  RecurringCycleOutcome,
  RecurringInvoiceDoc,
} from "@/types/recurring-invoices";

/**
 * The recurring-invoice engine: raise the next invoice from a schedule's
 * template, send it, and keep the schedule's own state honest.
 *
 * **Idempotency lives on the SCHEDULE, never on invoice status.** This is a
 * constraint, not an implementation detail. The send path swallows a failed
 * lifecycle write while the email still goes out, so an invoice can sit at
 * `draft` with no `sentAt` after the customer already received it. A sweep
 * that decided what to send by reading invoice status would re-send that
 * invoice on the next tick — to a paying customer, every night, until someone
 * noticed. Nobody may add a "re-send unsent invoices" pass on top of this
 * without fixing that write first.
 */

/** How many schedules one cron invocation will process before continuing. */
export const RECURRING_BATCH_SIZE = 25;

export interface SweepResult {
  processed: number;
  generated: number;
  skipped: number;
  failed: number;
  /** True when more schedules were due than the batch cap allowed. */
  hasMore: boolean;
}

/**
 * Run every schedule that has come due.
 *
 * Batch-capped with a `hasMore` flag so the caller can continue rather than
 * risk a serverless timeout, the same shape the API-cleanup sweep uses.
 */
export async function runRecurringInvoiceSweep(
  now: Date = new Date(),
): Promise<SweepResult> {
  const due = await schedulesCollection()
    .where("status", "==", "active")
    .where("nextRunAt", "<=", Timestamp.fromDate(now))
    .orderBy("nextRunAt")
    .limit(RECURRING_BATCH_SIZE + 1)
    .get();

  const batch = due.docs.slice(0, RECURRING_BATCH_SIZE);
  const result: SweepResult = {
    processed: 0,
    generated: 0,
    skipped: 0,
    failed: 0,
    hasMore: due.size > RECURRING_BATCH_SIZE,
  };

  for (const doc of batch) {
    // Sequential on purpose: each cycle issues a per-sub-account invoice
    // number in a transaction, and running them concurrently would put those
    // transactions into avoidable contention for no wall-clock gain at this
    // batch size.
    const outcome = await runOneSchedule(doc.id, now);
    result.processed += 1;
    if (outcome.kind === "generated") result.generated += 1;
    else if (outcome.kind === "skipped") result.skipped += 1;
    else result.failed += 1;
  }
  return result;
}

/**
 * One schedule's cycle: claim it, generate the invoice, send it, then update
 * arrears and completion.
 */
export async function runOneSchedule(
  scheduleId: string,
  now: Date = new Date(),
): Promise<RecurringCycleOutcome> {
  const claim = await claimCycle(scheduleId, now);
  if (!claim.ok) return { kind: "skipped", reason: claim.reason };
  const schedule = claim.schedule;

  try {
    const invoiceId = await generateInvoice(schedule, now);
    let sent = false;
    if (!schedule.reviewFirst) {
      sent = await sendGeneratedInvoice(schedule, invoiceId);
    }
    await settleAfterCycle(schedule, invoiceId);
    return { kind: "generated", invoiceId, sent };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // The claim already advanced `nextRunAt`, so a failed cycle is skipped
    // rather than retried into a duplicate invoice. It surfaces on the
    // operator's list instead, where a human can decide.
    console.error(`[recurring] cycle failed for ${scheduleId}: ${reason}`);
    await schedulesCollection()
      .doc(scheduleId)
      .update({
        lastError: reason.slice(0, 500),
        updatedAt: FieldValue.serverTimestamp(),
      })
      .catch(() => {});
    return { kind: "failed", reason };
  }
}

/**
 * Advance the schedule BEFORE doing any work, inside a transaction.
 *
 * A retried cron callback re-entering the same schedule finds `nextRunAt`
 * already past and does nothing, so the customer is invoiced once. This is the
 * same claim-to-make-idempotent shape the social publish callback uses.
 */
async function claimCycle(
  scheduleId: string,
  now: Date,
): Promise<
  { ok: true; schedule: RecurringInvoiceDoc } | { ok: false; reason: string }
> {
  const ref = schedulesCollection().doc(scheduleId);
  return getAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false as const, reason: "schedule_gone" };
    const schedule = {
      ...(snap.data() as RecurringInvoiceDoc),
      id: snap.id,
    };
    if (schedule.status !== "active") {
      return { ok: false as const, reason: `status_${schedule.status}` };
    }
    const dueAt = toDate(schedule.nextRunAt);
    if (!dueAt || dueAt.getTime() > now.getTime()) {
      return { ok: false as const, reason: "not_due" };
    }

    // The schedule is already over — its last cycle ran but never got marked,
    // because settling threw after the claim had advanced `nextRunAt`. Close
    // it here rather than billing a customer past the end of their agreement.
    if (isAlreadyFinished(schedule, dueAt)) {
      tx.update(ref, {
        status: "completed",
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { ok: false as const, reason: "already_finished" };
    }

    const nextRunAt = computeNextRunAt({
      previous: dueAt,
      cadence: schedule.cadence,
      anchorDay: schedule.anchorDay,
      timezone: schedule.timezone,
    });
    const cyclesGenerated = (schedule.cyclesGenerated ?? 0) + 1;

    // Completion is decided HERE, from the cycle actually being claimed, and
    // written in the same transaction that advances the schedule. Deciding it
    // later — from `now`, or on the success path only — gets it wrong twice
    // over: a sweep catching up in a later month would compute a different
    // next run and complete the schedule one cycle early, and anything that
    // threw after the claim would leave it active to bill once too many.
    const finished = isFinalCycle(schedule, cyclesGenerated, nextRunAt);

    tx.update(ref, {
      nextRunAt: Timestamp.fromDate(nextRunAt),
      cyclesGenerated,
      lastRunAt: Timestamp.fromDate(now),
      lastError: null,
      ...(finished ? { status: "completed" } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { ok: true as const, schedule };
  });
}

