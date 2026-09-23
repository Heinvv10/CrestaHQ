import "server-only";

import { NextResponse } from "next/server";

import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { territoryGate } from "@/lib/auth/territory-filter";
import { changeEventStatus } from "@/lib/server/event-status-service";
import type { CalendarEvent, EventStatus } from "@/types/events";

/**
 * Operator-side status flip. The only statuses this UI action offers —
 * see [src/lib/server/event-status-service.ts](../../../../../lib/server/event-status-service.ts)
 * for the full transition table + side effects, shared with the v1 API's
 * PATCH.
 *
 * Auth: active sub-account member.
 */

interface PatchBody {
  status?: EventStatus;
  /** Optional free-text cancel reason. */
  reason?: string;
}

const ALLOWED: EventStatus[] = ["completed", "no_show", "cancelled"];

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: eventId } = await ctx.params;

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.status || !ALLOWED.includes(body.status)) {
    return NextResponse.json(
      { error: `status must be one of: ${ALLOWED.join(", ")}` },
      { status: 400 },
    );
  }
  const next = body.status;
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 240) : "";

  const db = getAdminDb();
  const eventRef = db.collection("events").doc(eventId);
  const eventSnap = await eventRef.get();
  if (!eventSnap.exists) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }
  // Manual events (events-service, v1 POST) don't store an `id` field —
  // only booking-page and voice bookings do. The service writes to
  // `events/${event.id}`, so take the id from the path, not the doc.
  const event = { ...eventSnap.data(), id: eventId } as CalendarEvent;

  const access = await requireSubAccountMember(request, event.subAccountId);
  if (access instanceof NextResponse) return access;
  const gate = await territoryGate(access, event.territoryId);
  if (gate) return gate;

  const outcome = await changeEventStatus(event, next, reason);
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: outcome.httpStatus });
  }

  return NextResponse.json({
    ok: true,
    status: outcome.status,
    ...(outcome.noop ? { noop: true } : {}),
    // Surface the actual outcome so the operator UI can render an
    // accurate toast — "Visitor notified by email" vs "Couldn't email
    // the visitor (<reason>)" — instead of always claiming success.
    ...(next === "cancelled"
      ? {
          notifyEmailSent: outcome.emailSent,
          notifyEmailSkipReason: outcome.emailSkipReason,
        }
      : {}),
  });
}
