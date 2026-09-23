import "server-only";

import {
  FieldValue,
  Timestamp,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { computeNextRunAt } from "@/lib/recurring/cadence";
import {
  generateInvoice,
  isAlreadyFinished,
  isFinalCycle,
  notifyDraftForReview,
  schedulesCollection,
  sendGeneratedInvoice,
  settleAfterCycle,
  toDate,
} from "@/lib/server/recurring-invoice-cycle";
import { chargeCycle } from "@/lib/server/recurring-auto-charge";
import { recordClaimFailure } from "@/lib/server/recurring-claim-failure";
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

/**
 * How stale a due date may be and still be billed.
 *
 * The claim advances exactly one cycle, so a schedule backdated a year would
 * raise AND SEND one real invoice per nightly sweep for a year. Anything older
 * than this is history an operator should raise deliberately, not something a
 * cron mails out — so the schedule fast-forwards to its next future cycle and
 * says it did.
 */
export const MAX_CATCHUP_DAYS = 31;

/** How many schedules one cron invocation will process before continuing. */
export const RECURRING_BATCH_SIZE = 25;

/** Due schedules read per query page while looking for ones not yet run. */
const SCAN_PAGE_SIZE = 100;

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
  const due = schedulesCollection()
    .where("status", "==", "active")
    .where("nextRunAt", "<=", Timestamp.fromDate(now))
    .orderBy("nextRunAt");
  const result: SweepResult = {
    processed: 0,
    generated: 0,
    skipped: 0,
    failed: 0,
    hasMore: false,
  };

  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    const page = await (cursor ? due.startAfter(cursor) : due)
      .limit(SCAN_PAGE_SIZE)
      .get();
    for (const doc of page.docs) {
      // Already handled today — billed, or its claim failed. Passed over
      // BEFORE the batch cap: a schedule still behind after today's cycle
      // stays due and sorts first, so counting it would have every
      // continuation re-read the same batch and never reach the rest.
      if (handledToday(doc.data(), now)) continue;
      if (result.processed >= RECURRING_BATCH_SIZE) {
        result.hasMore = true;
        return result;
      }
      // Sequential on purpose: each cycle issues a per-sub-account invoice
      // number in a transaction, and running them concurrently would put
      // those transactions into avoidable contention for no wall-clock gain
      // at this batch size.
      const outcome = await runOneSchedule(doc.id, now);
      result.processed += 1;
      if (outcome.kind === "generated") result.generated += 1;
      else if (outcome.kind === "skipped") result.skipped += 1;
      else result.failed += 1;
    }
    if (page.docs.length < SCAN_PAGE_SIZE) return result;
    cursor = page.docs[page.docs.length - 1];
  }
}

/** Same UTC calendar day: the sweep runs once a day, at 05:00 UTC. */
function sameUtcDay(a: Date, b: Date): boolean {
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

function handledToday(data: Record<string, unknown>, now: Date): boolean {
  return [data.lastRunAt, data.lastFailedAt].some((value) => {
    const at = toDate(value);
    return !!at && sameUtcDay(at, now);
  });
}

/**
 * One schedule's cycle: claim it, generate the invoice, send it (or charge
 * the saved card), then update arrears and completion.
 */
export async function runOneSchedule(
  scheduleId: string,
  now: Date = new Date(),
): Promise<RecurringCycleOutcome> {
  let claim: Awaited<ReturnType<typeof claimCycle>>;
  try {
    claim = await claimCycle(scheduleId, now);
  } catch (err) {
    // Bad data fails this schedule alone; a transient error fails the sweep
    // so QStash retries it today. See `recurring-claim-failure.ts`.
    const failure = await recordClaimFailure(scheduleId, err, now);
    if (failure.transient) throw err;
    return { kind: "failed", reason: failure.reason };
  }
  if (!claim.ok) return { kind: "skipped", reason: claim.reason };
  const schedule = claim.schedule;

  try {
    const invoice = await generateInvoice(schedule, now);
    const { invoiceId } = invoice;
    let sent = false;
    if (!schedule.reviewFirst) {
      // A card cycle charges the saved card instead, and emails only when it
      // cannot or the card is declined.
      sent =
        schedule.chargeMode === "card"
          ? await chargeCycle(schedule, invoiceId, claim.cycle, claim.dueAt)
          : await sendGeneratedInvoice(schedule, invoiceId);
    } else {
      // Review wins over card: nothing is charged, the draft waits for a human.
      notifyDraftForReview(schedule, invoice);
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
  | { ok: true; schedule: RecurringInvoiceDoc; cycle: number; dueAt: Date }
  | { ok: false; reason: string }
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
    // At most one cycle per schedule per day. One still behind after this
    // claim stays due, so a continuation or a retry of today's sweep would
    // otherwise bill its next cycle minutes later.
    const lastRunAt = toDate(schedule.lastRunAt);
    if (lastRunAt && sameUtcDay(lastRunAt, now)) {
      return { ok: false as const, reason: "ran_today" };
    }

    // Contacts are hard-deleted. Invoicing one that is gone raises an invoice
    // nobody can receive, every cycle, so the schedule stops and says why.
    const contact = await tx.get(
      getAdminDb().doc(`contacts/${schedule.contactId}`),
    );
    if (!contact.exists) {
      tx.update(ref, {
        status: "paused",
        lastError:
          "Paused: the contact this schedule bills was deleted. Cancel it, " +
          "or set up a new schedule for another contact.",
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { ok: false as const, reason: "contact_gone" };
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

    // Too far behind to bill: step forward without raising anything.
    const staleDays = (now.getTime() - dueAt.getTime()) / 86_400_000;
    if (staleDays > MAX_CATCHUP_DAYS) {
      tx.update(ref, {
        nextRunAt: Timestamp.fromDate(nextRunAt),
        lastError:
          `Skipped a cycle due ${dueAt.toISOString().slice(0, 10)} — more than ` +
          `${MAX_CATCHUP_DAYS} days old. Raise it by hand if it is still owed.`,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { ok: false as const, reason: "too_stale" };
    }

    const cyclesGenerated = (schedule.cyclesGenerated ?? 0) + 1;

    // Completion is decided HERE, from the cycle actually being claimed, and
    // written in the same transaction that advances the schedule. Deciding it
    // later — from `now`, or on the success path only — gets it wrong twice
    // over: a sweep catching up in a later month would compute a different
    // next run and complete the schedule one cycle early, and anything that
    // threw after the claim would leave it active to bill once too many.
    const finished = isFinalCycle(schedule, cyclesGenerated, nextRunAt);

    if (schedule.lastError) {
      console.warn(`[recurring] ${scheduleId} claimed; clearing lastError: ${schedule.lastError}`);
    }
    tx.update(ref, {
      nextRunAt: Timestamp.fromDate(nextRunAt),
      cyclesGenerated,
      lastRunAt: Timestamp.fromDate(now),
      // The card guard compares due dates (recurring-auto-charge.ts). Written
      // only here, for a cycle actually billed — never by a stale skip.
      lastDueAt: Timestamp.fromDate(dueAt),
      lastError: null,
      ...(finished ? { status: "completed" } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    // `cycle` numbers the auto-charge reference: one charge per cycle.
    // `schedule` is the pre-claim snapshot, so its `lastDueAt` is the
    // PREVIOUS cycle's due date.
    return { ok: true as const, schedule, cycle: cyclesGenerated, dueAt };
  });
}
