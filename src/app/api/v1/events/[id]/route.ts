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
import {
  changeEventStatus,
  statusTransitionError,
} from "@/lib/server/event-status-service";
import { eventStatus } from "@/types/events";
import type { CalendarEvent } from "@/types/events";

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
  // Booking-page and voice bookings carry no `mode`, so they never match a
  // key's mode and are not exposed here — every event this route can reach
  // is a manual (API or dashboard) event.
  if (existing.subAccountId !== ctx.subAccountId || existing.mode !== ctx.mode) {
    return apiError(ctx, "not_found", "event_not_found", "Event not found.");
  }

  // Status changes go through the same transition table + side effects as
  // the dashboard's mark-status action — a raw write here let an API key
  // un-cancel an event or skip the activity row, trigger, and cancel email.
  // Refuse a bad transition before writing anything, so a rejected PATCH
  // leaves the event untouched.
  if (patch.status !== undefined) {
    const error = statusTransitionError(
      eventStatus(existing as CalendarEvent),
      patch.status,
    );
    if (error) {
      return apiError(ctx, "invalid_request", "invalid_status_transition", error, {
        status: 409,
      });
    }
  }

  const writePatch: Record<string, unknown> = {};
  if (patch.title !== undefined) writePatch.title = patch.title;
  if (patch.startAt !== undefined) writePatch.startAt = patch.startAt;
  if (patch.endAt !== undefined) writePatch.endAt = patch.endAt;
  if (patch.contactId !== undefined) writePatch.contactId = patch.contactId;
  if (patch.location !== undefined) writePatch.location = patch.location;
  if (patch.notes !== undefined) writePatch.notes = patch.notes;
  if (Object.keys(writePatch).length > 0) {
    writePatch.updatedAt = FieldValue.serverTimestamp();
    await ref.set(writePatch, { merge: true });
  }

  // Side effects run against the POST-patch event, so a PATCH changing
  // contact_id and status together notifies and enrols the NEW contact.
  if (patch.status !== undefined) {
    const patched = await ref.get();
    const outcome = await changeEventStatus(
      { ...(patched.data() as CalendarEvent), id: params.id },
      patch.status,
    );
    if (!outcome.ok) {
      return outcome.httpStatus === 409
        ? apiError(ctx, "invalid_request", "invalid_status_transition", outcome.error!, {
            status: 409,
          })
        : apiError(ctx, "internal_error", "internal_error", outcome.error!);
    }
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
