import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  emailIsConfigured,
  sendEmail,
  tenantFrom,
} from "@/lib/comms/resend";
import {
  fireBookingTrigger,
  recordBookingActivity,
} from "@/lib/booking/lifecycle";
import { bookedEventLabel } from "@/lib/booking/calendar-types";
import { renderBookingCancelledEmail } from "@/lib/booking/email";
import { eventStatus, isValidStatusTransition } from "@/types/events";
import type { ActivityType } from "@/types/contacts";
import type { AutomationTriggerType } from "@/types";
import type { BookingPage } from "@/types/booking";
import type {
  CalendarEvent,
  EventNotifySkipReason,
  EventStatus,
} from "@/types/events";
import type { Contact } from "@/types/contacts";
import type { SubAccountDoc } from "@/types/tenancy";
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

/** Has `event.startAt` already passed? No readable timestamp = not started. */
function eventHasStarted(event: Pick<CalendarEvent, "startAt">): boolean {
  const d = (event.startAt as { toDate?: () => Date } | null)?.toDate?.();
  return d instanceof Date && d.getTime() < Date.now();
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
): Promise<StatusChangeOutcome> {
  const current = eventStatus(event);
  if (current === next) {
    return { ok: true, httpStatus: 200, status: next, noop: true };
  }
  const error = statusTransitionError(current, next);
  if (error) {
    return { ok: false, httpStatus: 409, error };
  }
  // Defense in depth: the UI only offers Mark completed/no-show once an
  // appointment's scheduled time has passed, but a raw API/route call
  // bypasses the UI entirely — this is the chokepoint both funnel through,
  // so it's the only place that can actually stop a future booking from
  // being flipped (which fires the matching workflow trigger and frees the
  // slot, irreversibly, on a meeting that hasn't happened).
  if ((next === "completed" || next === "no_show") && !eventHasStarted(event)) {
    return {
      ok: false,
      httpStatus: 409,
      error: "This appointment hasn't happened yet.",
    };
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
  try {
    await getAdminDb().collection("events").doc(event.id).update(patch);
  } catch (err) {
    console.error("[event-status-service] update failed", err);
    return { ok: false, httpStatus: 500, error: "Couldn't update event." };
  }
  if (next === "cancelled") await pushBookingToGoogle(event.id);

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
  const sideEffects = await runStatusSideEffects(event, next, reason);
  return {
    ok: true,
    httpStatus: 200,
    status: next,
    emailSent: sideEffects.emailSent,
    emailSkipReason: sideEffects.emailSkipReason,
  };
}

interface SideEffectResult {
  emailSent: boolean;
  /** Why the cancellation email did NOT send — surfaced to the operator toast. */
  emailSkipReason?: EventNotifySkipReason;
}

async function runStatusSideEffects(
  event: CalendarEvent,
  next: EventStatus,
  reason: string,
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
    },
    activityType satisfies ActivityType,
    { extra: reason || null },
  );
  await fireBookingTrigger(
    {
      id: event.id,
      agencyId: event.agencyId,
      subAccountId: event.subAccountId,
      contactId: event.contactId,
      bookingPageSlug: event.bookingPageSlug ?? null,
    },
    triggerType,
  );

  // Operator-cancelled bookings notify the visitor via email.
  if (next !== "cancelled") return { emailSent: false, emailSkipReason: "not_cancelled" };
  const db = getAdminDb();
  try {
    const [contactSnap, subSnap, pageSnap] = await Promise.all([
      db.collection("contacts").doc(event.contactId).get(),
      db.doc(`subAccounts/${event.subAccountId}`).get(),
      event.bookingPageSlug
        ? db
            .doc(
              `subAccounts/${event.subAccountId}/bookingPages/${event.bookingPageSlug}`,
            )
            .get()
        : Promise.resolve(null),
    ]);
    if (!contactSnap.exists || !subSnap.exists) {
      console.warn(
        `[event-status-service] missing records: contact=${contactSnap.exists} sub=${subSnap.exists} event=${event.id}`,
      );
      return { emailSent: false, emailSkipReason: "missing_records" };
    }
    const contact = contactSnap.data() as Contact;
    const sub = subSnap.data() as SubAccountDoc;
    if (!emailIsConfigured(sub)) {
      console.warn(
        `[event-status-service] email not configured — skipping cancel notify for event=${event.id}`,
      );
      return { emailSent: false, emailSkipReason: "email_not_configured" };
    }

    const page = (pageSnap?.data() ?? null) as BookingPage | null;
    if (!contact.email) {
      return { emailSent: false, emailSkipReason: "no_contact_email" };
    }
    if (contact.emailOptedOut) {
      return { emailSent: false, emailSkipReason: "contact_opted_out" };
    }
    const startAt = (
      event.startAt as { toDate?: () => Date } | null
    )?.toDate?.();
    const endAt = (
      event.endAt as { toDate?: () => Date } | null
    )?.toDate?.();
    if (!(startAt instanceof Date) || !(endAt instanceof Date)) {
      console.warn(
        `[event-status-service] bad timestamps event=${event.id} start=${typeof startAt} end=${typeof endAt}`,
      );
      return { emailSent: false, emailSkipReason: "bad_timestamps" };
    }

    const rendered = renderBookingCancelledEmail(
      {
        recipientName: contact.name ?? "",
        businessName: sub.name ?? "Booking",
        businessLogoUrl: sub.logoUrl,
        page: {
          ...bookedEventLabel(page, event, startAt, endAt),
          timezone: page?.timezone ?? "UTC",
          payment: page?.payment ?? null,
          confirmationMessage: page?.confirmationMessage ?? "",
        },
        startAt,
        endAt,
        publicEventUrl: "",
      },
      "by_operator",
    );
    try {
      await sendEmail({
        to: contact.email,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        replyTo: sub.replyToEmail ?? undefined,
        from: tenantFrom(sub),
        subAccount: sub,
        meter: { subAccountId: event.subAccountId },
      });
      return { emailSent: true };
    } catch (err) {
      console.warn(
        `[event-status-service] cancel notify send failed event=${event.id} to=${contact.email}`,
        err,
      );
      return { emailSent: false, emailSkipReason: "send_failed" };
    }
  } catch (err) {
    console.warn(
      `[event-status-service] side-effect read failed event=${event.id}`,
      err,
    );
    return { emailSent: false, emailSkipReason: "missing_records" };
  }
}
