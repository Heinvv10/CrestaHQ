import "server-only";

import { NextResponse } from "next/server";

import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { territoryGate } from "@/lib/auth/territory-filter";
import { RescheduleRejected } from "@/lib/booking/reschedule";
import { rescheduleBookingAsOperator } from "@/lib/server/booking-changes-service";
import { isDocId } from "@/lib/server/doc-id";

/**
 * Operator-side reschedule for a booking-page event. Unlike the public
 * token-authenticated endpoint, this does NOT re-check slot availability —
 * an operator moving a booking is trusted to have picked a sane time, same
 * as GHL. Runs the identical post-write bookkeeping (reminder reschedule,
 * activity row, `booking.rescheduled` trigger, visitor confirmation email)
 * via booking-changes-service so this doesn't drift from the public path.
 *
 * Manual (non-booking-page) events have no reschedule bookkeeping to apply
 * and keep editing their time through the plain calendar-event update.
 *
 * The response reports whether the visitor got the "Updated:" email
 * (`notifyEmailSent` / `notifyEmailSkipReason`, same vocabulary as
 * mark-status): the token rotation just killed their old manage link, so
 * the operator has to know when they weren't told.
 *
 * Auth: active sub-account member.
 */
interface RescheduleBody {
  startAt?: string;
  endAt?: string;
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: eventId } = await ctx.params;

  let body: RescheduleBody;
  try {
    body = (await request.json()) as RescheduleBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const newStart = body.startAt ? new Date(body.startAt) : null;
  const newEnd = body.endAt ? new Date(body.endAt) : null;
  if (
    !newStart ||
    !newEnd ||
    Number.isNaN(newStart.getTime()) ||
    Number.isNaN(newEnd.getTime()) ||
    newEnd <= newStart
  ) {
    return NextResponse.json(
      { error: "Pick a valid new time." },
      { status: 400 },
    );
  }

  if (!isDocId(eventId)) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }
  // Load the event first so we know which sub-account to authenticate
  // against — mirrors mark-paid/mark-status.
  const snap = await getAdminDb().collection("events").doc(eventId).get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }
  const { subAccountId } = snap.data() as { subAccountId: string };
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;
  const gate = await territoryGate(access, snap.data()?.territoryId as string | null | undefined);
  if (gate) return gate;

  let outcome: Awaited<ReturnType<typeof rescheduleBookingAsOperator>>;
  try {
    outcome = await rescheduleBookingAsOperator(eventId, newStart, newEnd);
  } catch (err) {
    if (err instanceof RescheduleRejected) {
      return NextResponse.json(
        { error: err.message, ...(err.code ? { code: err.code } : {}) },
        { status: err.httpStatus },
      );
    }
    console.error("[events/reschedule-operator] failed", err);
    return NextResponse.json(
      { error: "Couldn't reschedule. Try again." },
      { status: 500 },
    );
  }

  const { event, notify } = outcome;
  return NextResponse.json({
    ok: true,
    newStartAt: newStart.toISOString(),
    newEndAt: newEnd.toISOString(),
    rescheduleCount: event.rescheduleCount,
    notifyEmailSent: notify.emailSent,
    notifyEmailSkipReason: notify.emailSkipReason,
  });
}
