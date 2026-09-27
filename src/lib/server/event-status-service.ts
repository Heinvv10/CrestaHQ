import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { sendCancelNotice, type CancelNoticeExpect } from "@/lib/server/event-cancel-notice";
import { holdFailuresOf, type AgentActor, type HeldEnrolment, type HoldFailure } from "@/lib/workflows/agent-hold";
import {
  fireBookingTrigger,
  recordBookingActivity,
} from "@/lib/booking/lifecycle";
import { eventStatus, isValidStatusTransition } from "@/types/events";
import type { ActivityType } from "@/types/contacts";
import type { AutomationTriggerType } from "@/types";
import type {
  CalendarEvent,
  EventNotifySkipReason,
  EventStatus,
} from "@/types/events";
import { pushBookingToGoogle } from "@/lib/google-calendar/push";

/**
 * The single place that flips an event's status. Used by BOTH the
 * operator-facing mark-status route and the v1 public API's PATCH — before
 * this existed, v1 wrote `status` raw with no transition check, no
 * activity row, no trigger, and no cancel email, so an API key could
 * un-cancel a booking (re-occupying its slot) or jump straight to
 * "completed" from "awaiting_payment".
 *
 * Covers:
 *   - "completed"  — meeting actually happened
 *   - "no_show"    — attendee didn't show
 *   - "cancelled"  — cancel (emails the visitor)
 *
 * `awaiting_payment` → use POST /api/events/by-id/[id]/mark-paid instead.
 * `scheduled` → "completed" / "no_show" / "cancelled" allowed.
 * `completed` ↔ `no_show` → allowed as a correction either direction.
 * `cancelled` is always final. Any other flip is rejected.
 */

/**
 * Re-exported from types/events.ts (the pure, client-safe home for the
 * transition table) so existing imports of this module keep working.
 */
export { isValidStatusTransition };

/**
 * Why `current → next` is refused, or null when it's allowed. Worded for
 * both surfaces that show it (the dashboard toast and the v1 API error).
 */
export function statusTransitionError(
  current: EventStatus,
  next: EventStatus,
): string | null {
  if (isValidStatusTransition(current, next)) return null;
  if (current === "cancelled") {
    return "This event was cancelled — its status can't change.";
  }
  if (current === "awaiting_payment") {
    return "Mark as paid first if the visitor paid, or cancel to release the slot.";
  }
  return "That status change isn't allowed.";
}

/**
 * `startAt` as a plain Date, whether it arrives as a Firestore Timestamp
 * (from a stored event) or an already-converted Date (a v1 PATCH's
 * post-patch `startAt`, computed before the write hits Firestore).
 */
function toDateSafe(value: unknown): Date | null {
  if (value instanceof Date) return value;
  const d = (value as { toDate?: () => Date } | null)?.toDate?.();
  return d instanceof Date ? d : null;
}

/** Has `event.startAt` already passed (as of `nowMs`)? No readable timestamp = not started. */
function eventHasStarted(
  event: { startAt: CalendarEvent["startAt"] | Date },
  nowMs: number,
): boolean {
  const d = toDateSafe(event.startAt);
  return d !== null && d.getTime() < nowMs;
}

/**
 * Why `event → next` is refused, or null when it's allowed — combines the
 * transition table with the start-time gate below. This is the single
 * pre-check both `changeEventStatus` and the v1 route's PATCH handler use,
 * so a route that writes fields before calling `changeEventStatus` can
 * refuse the whole request (writing nothing) using the same rule the
 * write itself will apply.
 */
export function statusChangeError(
  event: { startAt: CalendarEvent["startAt"] | Date } & Pick<CalendarEvent, "status">,
  next: EventStatus,
  nowMs: number,
): string | null {
  const current = eventStatus(event);
  const transitionError = statusTransitionError(current, next);
  if (transitionError) return transitionError;
  // Defense in depth: the UI only offers Mark completed/no-show once an
  // appointment's scheduled time has passed, but a raw API/route call
  // bypasses the UI entirely — this is the chokepoint both funnel through,
  // so it's the only place that can actually stop a future booking from
  // being flipped (which fires the matching workflow trigger and frees the
  // slot, irreversibly, on a meeting that hasn't happened).
  if ((next === "completed" || next === "no_show") && !eventHasStarted(event, nowMs)) {
    return "This appointment hasn't happened yet.";
  }
  return null;
}

export interface StatusChangeOutcome {
  ok: boolean;
  /** HTTP status the caller should respond with. */
  httpStatus: number;
  status?: EventStatus;
  noop?: boolean;
  error?: string;
  emailSent?: boolean;
  emailSkipReason?: SideEffectResult["emailSkipReason"];
  workflowsSkipped?: true;
  workflowsStepsChanged?: string[];
  /** Agent writes only: the enrolments held for approval, and the matched
   *  workflows that could be neither held nor run. */
  held?: HeldEnrolment[];
  holdFailures?: HoldFailure[];
}

export interface StatusChangeOptions {
  /** An API agent made this change: its booking trigger is held and awaited (ruling Q). */
  actor?: AgentActor;
  /** An approved agent cancel: send only this notice (null: none), refusing one that now differs. */
  expectNotice?: CancelNoticeExpect | null;
  /** An approved agent cancel: the contact its approver saw; another one starts no workflows. */
  expectContactId?: string | null;
  /** An approved agent cancel: the workflows its approver saw (id -> steps fingerprint); only those, unchanged, start. */
  expectedStepsFingerprints?: Record<string, string>;
}

/**
 * Validate + apply a status change on `event`, then run the matching
 * side effects (activity row, workflow trigger, and — for a cancel — the
 * visitor notification email). Returns an outcome describing exactly what
 * happened so callers can translate it into their own response shape.
 */
export async function changeEventStatus(
  event: CalendarEvent,
  next: EventStatus,
  reason = "",
  opts: StatusChangeOptions = {},
): Promise<StatusChangeOutcome> {
  const current = eventStatus(event);
  if (current === next) {
    return { ok: true, httpStatus: 200, status: next, noop: true };
  }
  const error = statusChangeError(event, next, Date.now());
  if (error) {
    return { ok: false, httpStatus: 409, error };
  }

  const patch: Record<string, unknown> = {
    status: next,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (next === "cancelled") {
    patch.cancelledAt = FieldValue.serverTimestamp();
    patch.cancelledByVisitor = false;
    patch.cancelReason = reason || "by_operator";
  }
  // The transition is decided on the status read in the write's own
  // transaction: of two callers changing it at once, only the winner writes
  // and runs the side effects, on the event as read there (its live contact).
  const ref = getAdminDb().collection("events").doc(event.id);
  let outcome: "write" | "noop" | string;
  let live: CalendarEvent = event;
  try {
    outcome = await getAdminDb().runTransaction(async (tx) => {
      live = { ...event, ...((await tx.get(ref)).data() as Partial<CalendarEvent> | undefined), id: event.id };
      if (eventStatus(live) === next) return "noop";
      const refused = statusChangeError(live, next, Date.now());
      if (refused) return refused;
      tx.update(ref, patch);
      return "write";
    });
  } catch (err) {
    console.error("[event-status-service] update failed", err);
    return { ok: false, httpStatus: 500, error: "Couldn't update event." };
  }
  if (outcome === "noop") return { ok: true, httpStatus: 200, status: next, noop: true };
  if (outcome !== "write") return { ok: false, httpStatus: 409, error: outcome };
  if (next === "cancelled") await pushBookingToGoogle(live.id);

  // A test-mode event (v1 `lsk_test_*` key) gets the validated status write
  // only — no activity row, no workflow trigger, no email. The public API
  // promises test mode never fires real automations or messages, and the
  // workflow engine itself has no mode gate. Undefined mode = live
  // (booking-page / voice / client-written events carry none).
  if ((event.mode ?? "live") !== "live") {
    return {
      ok: true,
      httpStatus: 200,
      status: next,
      emailSent: false,
      emailSkipReason: "test_mode",
    };
  }
  const sideEffects = await runStatusSideEffects(live, next, reason, opts);
  return {
    ok: true,
    httpStatus: 200,
    status: next,
    emailSent: sideEffects.emailSent,
    emailSkipReason: sideEffects.emailSkipReason,
    ...(sideEffects.workflowsSkipped ? { workflowsSkipped: true as const } : {}),
    ...(sideEffects.workflowsStepsChanged ? { workflowsStepsChanged: sideEffects.workflowsStepsChanged } : {}),
    ...(opts.actor ? { held: sideEffects.held ?? [], holdFailures: sideEffects.holdFailures ?? [] } : {}),
  };
}

interface SideEffectResult {
  held?: HeldEnrolment[];
  holdFailures?: HoldFailure[];
  emailSent: boolean;
  /** Why the cancellation email did NOT send — surfaced to the operator toast. */
  emailSkipReason?: EventNotifySkipReason;
  /** An approved cancel whose contact was re-linked: its workflows were not started. */
  workflowsSkipped?: true;
  /** An approved cancel: reviewed workflows not started because their steps changed. */
  workflowsStepsChanged?: string[];
}

async function runStatusSideEffects(
  event: CalendarEvent,
  next: EventStatus,
  reason: string,
  opts: StatusChangeOptions,
): Promise<SideEffectResult> {
  if (!event.contactId) {
    return {
      emailSent: false,
      emailSkipReason: next === "cancelled" ? "no_contact" : "not_cancelled",
    };
  }

  // Map status → activity type + trigger.
  const activityType =
    next === "completed"
      ? "booking_completed"
      : next === "no_show"
        ? "booking_no_show"
        : "booking_cancelled";
  const triggerType: Extract<AutomationTriggerType, `event_${string}`> =
    next === "cancelled"
      ? "event_cancelled"
      : next === "completed"
        ? "event_completed"
        : "event_no_show";

  await recordBookingActivity(
    {
      id: event.id,
      title: event.title || "Meeting",
      contactId: event.contactId,
      bookingPageSlug: event.bookingPageSlug ?? null,
      subAccountId: event.subAccountId,
    },
    activityType satisfies ActivityType,
    { extra: reason || null },
  );
  // An approved agent cancel whose event was re-linked to another contact
  // since the approver's check starts no workflows (and sends no notice).
  const relinked = opts.expectContactId !== undefined && event.contactId !== opts.expectContactId;
  const fired = relinked ? null : await fireBookingTrigger(
    {
      id: event.id,
      agencyId: event.agencyId,
      subAccountId: event.subAccountId,
      contactId: event.contactId,
      bookingPageSlug: event.bookingPageSlug ?? null,
    },
    triggerType,
    // Only an agent's call carries the actor or the reviewed workflows: the human call is unchanged.
    ...((opts.expectedStepsFingerprints
      ? [opts.actor, opts.expectedStepsFingerprints]
      : opts.actor ? [opts.actor] : []) as [AgentActor?, Record<string, string>?]),
  );
  const held = fired ? { held: fired.held ?? [], holdFailures: holdFailuresOf(fired) } : {};
  const changed = fired?.skipped.filter((s) => s.reason === "steps_changed").map((s) => s.workflowId) ?? [];
  if (changed.length) Object.assign(held, { workflowsStepsChanged: changed });

  // Operator-cancelled bookings notify the visitor via email. An approved
  // agent cancel sends only the notice its approver saw (`expectNotice`),
  // and none at all when its contact was re-linked since.
  if (next !== "cancelled") return { ...held, emailSent: false, emailSkipReason: "not_cancelled" };
  if (relinked) return { emailSent: false, emailSkipReason: "changed_since_approval", workflowsSkipped: true };
  return { ...held, ...(await sendCancelNotice(event, opts.expectNotice)) };
}
