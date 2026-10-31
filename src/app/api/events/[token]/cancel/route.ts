import "server-only";

import { NextResponse } from "next/server";

import { hashEventToken, verifyEventToken } from "@/lib/booking/event-token";
import { cancelBooking } from "@/lib/server/booking-changes-service";

/**
 * Public cancel endpoint. The HMAC token IS the credential; we don't
 * need session auth. The cancel itself — the transactional flip (a fast
 * double-click cancels once), the visitor email, activity row, automation
 * trigger, webhook and Google push — is `cancelBooking`; the guard here
 * accepts only the event this token is the live link for.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;

  const verified = verifyEventToken(token);
  if (!verified) {
    return NextResponse.json({ error: "Invalid link" }, { status: 404 });
  }

  const tokenHash = hashEventToken(token);
  const result = await cancelBooking({
    eventId: verified.eventId,
    guard: (event) => event.publicTokenHash === tokenHash,
    note: "by attendee",
  });
  if (result.ok) return NextResponse.json({ ok: true });
  if (result.code === "invalid") {
    return NextResponse.json({ error: "Invalid link" }, { status: 404 });
  }
  if (result.code === "bad_state") {
    return NextResponse.json({ error: result.message }, { status: 409 });
  }
  return NextResponse.json(
    { error: "Couldn't cancel. Try again." },
    { status: 500 },
  );
}
