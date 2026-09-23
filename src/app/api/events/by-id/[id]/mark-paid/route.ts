import "server-only";

import { NextResponse } from "next/server";

import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { territoryGate } from "@/lib/auth/territory-filter";
import { markBookingPaidServerSide } from "@/lib/server/bookings-service";
import type { CalendarEvent } from "@/types/events";

/**
 * Operator-side "mark as paid" for a booking holding a slot in
 * `awaiting_payment`.
 *
 * The transition itself — status flip, token rotation, reminder scheduling,
 * ICS confirmation email, activity row, `event_paid` trigger — lives in
 * lib/server/bookings-service.ts so the Stripe order reconciler drives the
 * identical path when a deposit is paid by card. See PAYMENTS_V1_PLAN.md
 * ("no second paid-path").
 *
 * Auth: any active sub-account member (admins + collaborators). Same scope as
 * the contact-profile Email send — operators triage payments across the team,
 * not just admins.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: eventId } = await ctx.params;

  // Load the event first so we know which sub-account to authenticate against.
  const snap = await getAdminDb().collection("events").doc(eventId).get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }
  const event = snap.data() as CalendarEvent;

  const access = await requireSubAccountMember(request, event.subAccountId);
  if (access instanceof NextResponse) return access;
  const gate = await territoryGate(access, event.territoryId);
  if (gate) return gate;

  const result = await markBookingPaidServerSide({
    eventId,
    expectSubAccountId: event.subAccountId,
    paidByUid: access.uid,
  });

  if (!result.ok) {
    const status =
      result.code === "not_found"
        ? 404
        : result.code === "wrong_tenant"
          ? 403
          : result.code === "write_failed"
            ? 500
            : 409;
    return NextResponse.json(
      { error: result.message, ...(result.status ? { status: result.status } : {}) },
      { status },
    );
  }

  return NextResponse.json({
    ok: true,
    status: result.status,
    publicEventUrl: result.publicEventUrl,
  });
}
