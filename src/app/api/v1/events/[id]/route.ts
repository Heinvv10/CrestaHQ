import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { withApiAuth } from "@/lib/api/auth";
import { apiError, apiOk } from "@/lib/api/responses";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import {
  parseEventPatch,
  serializeEventForApi,
} from "@/lib/api/serializers/events";
import { buildEventPublicUrl } from "@/lib/booking/event-token";
import {
  RescheduleRejected,
  rescheduleWithoutAvailabilityCheck,
  runRescheduleSideEffects,
} from "@/lib/booking/reschedule";
import { changeEventStatus } from "@/lib/server/event-status-service";
import { eventSource, eventStatus } from "@/types/events";
import type { BookingPage } from "@/types/booking";
import type { CalendarEvent } from "@/types/events";

function toDateOrNull(v: unknown): Date | null {
  const d = (v as { toDate?: () => Date } | null)?.toDate?.();
  return d instanceof Date ? d : null;
}

export const GET = withApiAuth<{ id: string }>(async ({ params, ctx }) => {
  const snap = await getAdminDb().doc(`events/${params.id}`).get();
  if (!snap.exists) {
    return apiError(ctx, "not_found", "event_not_found", "Event not found.");
  }
  const d = snap.data()!;
  if (d.subAccountId !== ctx.subAccountId || d.mode !== ctx.mode) {
    return apiError(ctx, "not_found", "event_not_found", "Event not found.");
  }
  return apiOk(ctx, { event: serializeEventForApi(snap.id, d, ctx.mode) });
});

export const PATCH = withApiAuth<{ id: string }>(async ({ body, params, ctx }) => {
  const parsed = parseEventPatch(body);
  if (!parsed.ok) {
    return apiError(ctx, "invalid_request", "invalid_body", parsed.error!);
  }
  const patch = parsed.value!;
  const ref = getAdminDb().doc(`events/${params.id}`);
  const snap = await ref.get();
  if (!snap.exists) {
    return apiError(ctx, "not_found", "event_not_found", "Event not found.");
  }
  const existing = snap.data()!;
  if (existing.subAccountId !== ctx.subAccountId || existing.mode !== ctx.mode) {
    return apiError(ctx, "not_found", "event_not_found", "Event not found.");
  }
  const event: CalendarEvent = { ...(existing as CalendarEvent), id: params.id };

  // Status changes go through the same transition table + side effects as
  // the operator mark-status route — bypassing this let an API key un-cancel
  // a booking (re-occupying its slot) or jump straight from awaiting_payment
  // to completed, with no activity row, trigger, or cancel email.
  if (patch.status !== undefined) {
    const outcome = await changeEventStatus(event, patch.status);
    if (!outcome.ok) {
      return apiError(
        ctx,
        "invalid_request",
        "invalid_status_transition",
        outcome.error!,
        { status: outcome.httpStatus },
      );
    }
  }

  const otherPatch: Record<string, unknown> = {};
  if (patch.title !== undefined) otherPatch.title = patch.title;
  if (patch.contactId !== undefined) otherPatch.contactId = patch.contactId;
  if (patch.location !== undefined) otherPatch.location = patch.location;
  if (patch.notes !== undefined) otherPatch.notes = patch.notes;

  // startAt/endAt: a booking-page event still holding a slot gets the full
  // reschedule bookkeeping (stamps + trigger + reminders + visitor email) —
  // and only when the time actually changes. A manual event, or a time-only
  // edit on a booking that's already cancelled/completed, is a plain field
  // write with no bookkeeping, same as title/location/notes.
  if (patch.startAt !== undefined || patch.endAt !== undefined) {
    const currentStart = toDateOrNull(event.startAt);
    const currentEnd = toDateOrNull(event.endAt);
    const newStart = patch.startAt ?? currentStart ?? new Date(0);
    const newEnd = patch.endAt ?? currentEnd ?? new Date(0);
    const timeChanged =
      !currentStart ||
      !currentEnd ||
      currentStart.getTime() !== newStart.getTime() ||
      currentEnd.getTime() !== newEnd.getTime();
    // Status read BEFORE any patch.status change above — combining a time
    // move with a status flip in one call is an edge case; the reschedule
    // eligibility check uses the state the caller found the event in.
    const statusBefore = eventStatus(event);

    if (
      timeChanged &&
      eventSource(event) === "booking_page" &&
      (statusBefore === "scheduled" || statusBefore === "awaiting_payment")
    ) {
      try {
        const rescheduled = await rescheduleWithoutAvailabilityCheck(
          params.id,
          newStart,
          newEnd,
        );
        const pageSnap = rescheduled.event.bookingPageSlug
          ? await getAdminDb()
              .doc(
                `subAccounts/${rescheduled.event.subAccountId}/bookingPages/${rescheduled.event.bookingPageSlug}`,
              )
              .get()
          : null;
        const page = (pageSnap?.data() as BookingPage | undefined) ?? undefined;
        await runRescheduleSideEffects({
          event: rescheduled.event,
          page,
          newRawToken: rescheduled.newToken,
          publicEventUrl: buildEventPublicUrl(rescheduled.newToken),
          startAt: newStart,
          endAt: newEnd,
          actor: "api",
        });
      } catch (err) {
        if (err instanceof RescheduleRejected) {
          return apiError(
            ctx,
            "invalid_request",
            "invalid_reschedule",
            err.message,
            { status: err.httpStatus },
          );
        }
        throw err;
      }
    } else {
      otherPatch.startAt = newStart;
      otherPatch.endAt = newEnd;
    }
  }

  if (Object.keys(otherPatch).length > 0) {
    otherPatch.updatedAt = FieldValue.serverTimestamp();
    await ref.set(otherPatch, { merge: true });
  }

  const fresh = await ref.get();
  return apiOk(ctx, {
    event: serializeEventForApi(fresh.id, fresh.data()!, ctx.mode),
  });
});

export const DELETE = withApiAuth<{ id: string }>(async ({ params, ctx }) => {
  const ref = getAdminDb().doc(`events/${params.id}`);
  const snap = await ref.get();
  if (!snap.exists) {
    return apiError(ctx, "not_found", "event_not_found", "Event not found.");
  }
  const d = snap.data()!;
  if (d.subAccountId !== ctx.subAccountId || d.mode !== ctx.mode) {
    return apiError(ctx, "not_found", "event_not_found", "Event not found.");
  }
  await ref.delete();
  void emitWebhookEvent({
    subAccountId: ctx.subAccountId,
    agencyId: ctx.agencyId,
    mode: ctx.mode,
    type: "booking.cancelled",
    payload: { event: { id: params.id, object: "event", deleted: true } },
  });
  return apiOk(ctx, { id: params.id, object: "event", deleted: true });
});
