import "server-only";

import type { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { apiError, type ResponseMeta } from "@/lib/api/responses";

/**
 * Per-API-key cap on WORKFLOW ENROLMENTS caused by public-API writes.
 *
 * Why this exists: `/api/v1/contacts` now fires workflow triggers, and a
 * workflow can send WhatsApp / SMS / email to a real person. A looping
 * integration script would otherwise message hundreds of businesses before
 * anyone noticed. The cap makes that failure LOUD — the write is refused
 * with a 429, never silently truncated and never silently trigger-less.
 *
 * Counting model: hourly buckets at
 * `subAccounts/{subAccountId}/apiEnrolments/{keyId}_{YYYY-MM-DDTHH}`, the
 * same shape as the usage ledger's monthly docs (see lib/server/usage-meter).
 * A fixed hour bucket rather than a true sliding window — the worst case (a
 * burst either side of the hour boundary) is still bounded at two buckets'
 * worth.
 *
 * RESERVE, THEN RECONCILE — the gate must be synchronous, because the spend
 * is not. Enrolment happens inside a fire-and-forget `fireWorkflowTrigger`,
 * so a plain read-then-record cap would let a back-to-back loop through:
 * every request would read a count that this request's own enrolments had
 * not yet incremented, and the effective bound would be "however many
 * requests round-trip before the first increment lands", not 50.
 *
 * So `reserveEnrolment` charges 1 up front, in a transaction, and the route
 * AWAITS it before writing anything. Two concurrent requests can no longer
 * both read 49 and both pass. Once the trigger settles and the real number
 * is known, `reconcileEnrolments` adjusts the bucket by (actual − 1): a
 * request that enrolled nobody hands its reservation back, so "a request
 * that enrols nobody costs nothing" still holds, and one that enrolled three
 * ends up charged three.
 *
 * The consequence of reserving per REQUEST is that the cap is not a hard
 * ceiling on enrolments: a burst of in-flight requests is bounded at 50
 * un-reconciled requests, and each of those may enrol into more than one
 * matching workflow before its reconciliation lands. It is a fuse on a
 * runaway caller, not a quota.
 *
 * Fails OPEN on infrastructure error, matching `checkQuota` — a Firestore
 * blip must not take a customer's integration down. That applies ONLY to the
 * error path: an over-budget reservation always refuses.
 */

export const ENROLMENT_CAP_PER_HOUR = 50;

/** Bucket id for an instant, e.g. "2026-09-07T14" (UTC). */
export function enrolmentHourKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 13);
}

function bucketRef(subAccountId: string, keyId: string, hour: string) {
  return getAdminDb().doc(
    `subAccounts/${subAccountId}/apiEnrolments/${keyId}_${hour}`,
  );
}

/** Seconds remaining until the current hour bucket rolls over. */
function secondsToNextHour(now: Date): number {
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000));
}

export interface EnrolmentBudget {
  allowed: boolean;
  /**
   * Whether the bucket was actually incremented. False when the reservation
   * failed open, or when it was refused (and therefore handed back), so the
   * caller knows there is nothing outstanding to release.
   */
  charged: boolean;
  /** Reservations charged to this key in the current hour, post-increment. */
  used: number;
  limit: number;
  /** Seconds until the bucket resets. For the Retry-After header. */
  retryAfterSec: number;
}

/**
 * Charge one enrolment against this key's hour bucket and report whether it
 * fits. Transactional: the increment and the read-back are one atomic step,
 * so concurrent requests are serialized rather than both seeing the
 * pre-increment count.
 *
 * AWAIT this before the write. A refusal hands its own reservation straight
 * back, so a caller stuck in a refused loop keeps the bucket pinned at the
 * limit rather than inflating it.
 */
export async function reserveEnrolment(input: {
  subAccountId: string;
  keyId: string;
}): Promise<EnrolmentBudget> {
  const now = new Date();
  const limit = ENROLMENT_CAP_PER_HOUR;
  const ref = bucketRef(input.subAccountId, input.keyId, enrolmentHourKey(now));
  let reserved: number;
  try {
    reserved = await getAdminDb().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const next = ((snap.data()?.count as number | undefined) ?? 0) + 1;
      tx.set(
        ref,
        {
          count: next,
          keyId: input.keyId,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return next;
    });
  } catch (err) {
    // Infrastructure failure only — never the over-budget path.
    console.warn("[enrolment-cap] reservation failed (failing open)", {
      subAccountId: input.subAccountId,
      keyId: input.keyId,
      err,
    });
    return { allowed: true, charged: false, used: 0, limit, retryAfterSec: 0 };
  }

  if (reserved <= limit) {
    return { allowed: true, charged: true, used: reserved, limit, retryAfterSec: 0 };
  }
  // Refused: give the reservation back so a hammering caller doesn't inflate
  // the count past the limit (and the 429's "used" stays truthful).
  await adjustBucket(input.subAccountId, input.keyId, -1);
  return {
    allowed: false,
    charged: false,
    used: limit,
    limit,
    retryAfterSec: secondsToNextHour(now),
  };
}

/**
 * Settle a reservation against what the trigger actually did: charge
 * `actual` in total rather than the 1 already reserved. Best-effort — a
 * failure here only misstates the count for the rest of the hour, it can't
 * disable the fuse, but it IS something an operator should see.
 */
export async function reconcileEnrolments(input: {
  subAccountId: string;
  keyId: string;
  actual: number;
}): Promise<void> {
  const actual = Number.isFinite(input.actual) ? Math.floor(input.actual) : 0;
  const delta = actual - 1;
  if (delta === 0) return;
  try {
    await adjustBucket(input.subAccountId, input.keyId, delta);
  } catch (err) {
    console.error("[enrolment-cap] reconciliation failed — the hourly count " +
      "for this key is now off by " + delta, {
      subAccountId: input.subAccountId,
      keyId: input.keyId,
      err,
    });
  }
}

/** Add `delta` (may be negative) to this key's current hour bucket. */
async function adjustBucket(
  subAccountId: string,
  keyId: string,
  delta: number,
): Promise<void> {
  await bucketRef(subAccountId, keyId, enrolmentHourKey()).set(
    {
      count: FieldValue.increment(delta),
      keyId,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

/**
 * The outcome of opening the gate for one request. Exactly one of these is
 * true, and each has exactly one owner responsible for settling it:
 *
 *   refusal set        → nothing is owed. `reserveEnrolment` already handed
 *                        its own reservation back.
 *   reserved === false → nothing is owed. Either the request was test-mode
 *                        (never charged) or the reservation failed open.
 *   reserved === true  → ONE reservation is outstanding and MUST be settled,
 *                        by the trigger's `finally` if a trigger fired, or
 *                        by `releaseReservation` if it did not.
 */
export interface EnrolmentGate {
  /** Send this instead of doing the write. */
  refusal: NextResponse | null;
  /** True only when a reservation was actually charged to the bucket. */
  reserved: boolean;
  subAccountId: string;
  keyId: string;
}

/**
 * Reserve one enrolment for `ctx`'s key. AWAIT this before any
 * trigger-firing write, so a refusal leaves nothing behind and a concurrent
 * request can't slip past a stale count.
 *
 * Whoever calls this owns the reservation until something settles it — see
 * `EnrolmentGate`. The routes hand it to `releaseReservation` on every path
 * that does NOT end in a fired trigger, including a throw.
 */
export async function openEnrolmentGate(
  ctx: ResponseMeta & { subAccountId: string; keyId: string; mode: "live" | "test" },
): Promise<EnrolmentGate> {
  const gate = {
    refusal: null,
    reserved: false,
    subAccountId: ctx.subAccountId,
    keyId: ctx.keyId,
  };
  // Test-mode writes fire no triggers, so they can't enrol anyone: nothing
  // to reserve, nothing to refuse, and nothing to release afterwards.
  if (ctx.mode !== "live") return gate;

  const budget = await reserveEnrolment({
    subAccountId: ctx.subAccountId,
    keyId: ctx.keyId,
  });
  if (budget.allowed) {
    // `reserved` tracks whether the bucket was actually incremented — a
    // reservation that failed open charged nothing and must not be released,
    // or the release would drive the count negative.
    return { ...gate, reserved: budget.charged };
  }
  return {
    ...gate,
    refusal: apiError(
      ctx,
      "rate_limit_error",
      "workflow_enrolment_cap",
      `This API key has reached its limit of ${budget.limit} workflow enrolments per hour. The write was NOT applied. Check the integration for a loop, then retry after ${budget.retryAfterSec}s.`,
      {
        extraHeaders: {
          "Retry-After": String(budget.retryAfterSec),
          "X-Enrolment-Limit": String(budget.limit),
          "X-Enrolment-Remaining": "0",
        },
      },
    ),
  };
}

/**
 * Hand back a reservation whose request never fired a trigger — an ordinary
 * PATCH that changed a name, a contact that turned out not to exist, or a
 * throw between the reservation and the write. No-op when nothing was
 * charged.
 *
 * This is the ONLY release path outside `fireWorkflowTrigger`'s `finally`:
 * that `finally` can only cover requests that actually entered the trigger.
 */
export async function releaseReservation(gate: EnrolmentGate): Promise<void> {
  if (!gate.reserved) return;
  await reconcileEnrolments({
    subAccountId: gate.subAccountId,
    keyId: gate.keyId,
    actual: 0,
  });
}
