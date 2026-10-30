import "server-only";

import { NextResponse } from "next/server";

import { hashEventToken, verifyEventToken } from "@/lib/booking/event-token";
import { rescheduleBooking } from "@/lib/server/booking-changes-service";
import { readJsonCapped } from "@/lib/server/read-json-capped";

/**
 * Public reschedule endpoint. The HMAC token IS the credential. On
 * success: rotates the token (any previously-mailed link invalidates),
 * updates `startAt` + `endAt` in-place (preserves event id, automations,
 * activity history), re-publishes reminder callbacks for the new
 * schedule, and sends a fresh confirmation email + ICS.
 *
 * Important constraints:
 *   - Status must currently occupy a slot (scheduled / awaiting_payment).
 *     Cancelled / past meetings can't be rescheduled — visitor must
 *     re-book.
 *   - Payment-pending events keep the payment requirement on the new
 *     slot (operator still has to mark paid). The hold-expiry deadline
 *     is NOT extended — visitor should pay quickly regardless.
 *
 * The move, its availability re-check and its side effects are
 * `rescheduleBooking` (booking-changes-service); the guard here accepts only
 * the event this token is the live link for. The operator route goes
 * through the same service but skips the availability check.
 */

interface RescheduleBody {
  slot?: { startAt?: string; endAt?: string };
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;

  const verified = verifyEventToken(token);
  if (!verified) {
    return NextResponse.json({ error: "Invalid link" }, { status: 404 });
  }

  // The new slot (two timestamps): 16 KB.
  const read = await readJsonCapped(request, 16 * 1024);
  if (!read.ok) {
    return read.reason === "too_large"
      ? NextResponse.json({ error: "Request body too large" }, { status: 413 })
      : NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const body = (read.value ?? {}) as RescheduleBody;
  const newStart = body.slot?.startAt ? new Date(body.slot.startAt) : null;
  const newEnd = body.slot?.endAt ? new Date(body.slot.endAt) : null;
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
  if (newStart.getTime() <= Date.now()) {
    return NextResponse.json(
      { error: "Choose a time in the future." },
      { status: 400 },
    );
  }

  const tokenHash = hashEventToken(token);
  const result = await rescheduleBooking({
    eventId: verified.eventId,
    newStart,
    newEnd,
    guard: (event) => event.publicTokenHash === tokenHash,
  });

  if (result.ok) {
    return NextResponse.json({
      ok: true,
      newStartAt: result.newStart.toISOString(),
      newEndAt: result.newEnd.toISOString(),
      newToken: result.newToken,
      publicEventUrl: result.publicEventUrl,
    });
  }
  if (result.code === "invalid") {
    return NextResponse.json({ error: "Invalid link" }, { status: 404 });
  }
  if (result.code === "bad_request") {
    return NextResponse.json({ error: result.message }, { status: 400 });
  }
  if (result.code === "bad_state") {
    return NextResponse.json({ error: result.message }, { status: 409 });
  }
  if (result.code === "slot_taken") {
    return NextResponse.json(
      {
        error:
          "That time was just taken. Refresh and pick another option.",
      },
      { status: 409 },
    );
  }
  return NextResponse.json(
    { error: "Couldn't reschedule. Try again." },
    { status: 500 },
  );
}
