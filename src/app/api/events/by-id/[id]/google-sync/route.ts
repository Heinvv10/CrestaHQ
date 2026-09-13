import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { pushBookingToGoogle } from "@/lib/google-calendar/push";

/**
 * Retry a booking's Google Calendar sync (the event dialog's "Retry sync").
 *
 *   POST /api/events/by-id/[id]/google-sync → { ok, googleSyncError }
 *
 * Any active member of the event's sub-account. Runs the same push as every
 * booking path, with the same host checks (active members who are page hosts
 * or on the event's server-set hostUids) — a retry can reach no calendar a
 * normal push could not.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ref = getAdminDb().collection("events").doc(id);
  const snap = await ref.get();
  if (!snap.exists) return NextResponse.json({ error: "Event not found" }, { status: 404 });
  const access = await requireSubAccountMember(request, snap.data()?.subAccountId as string);
  if (access instanceof NextResponse) return access;

  await pushBookingToGoogle(id);
  const after = (await ref.get()).data();
  return NextResponse.json({ ok: true, googleSyncError: after?.googleSyncError?.message ?? null });
}
