import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { territoryGate } from "@/lib/auth/territory-filter";
import { removeBookingFromGoogle } from "@/lib/google-calendar/push";

/**
 * Delete a calendar event that is mirrored in a host's Google Calendar.
 *
 *   DELETE /api/events/by-id/[id]
 *
 * The rules refuse a client delete while `googleEventIds` is non-empty (its
 * Google copy would be orphaned, and a completed / no-show booking can't be
 * cancelled first). This route takes the Google copies down, then deletes.
 * Same permission as the client delete it stands in for: an active member of
 * the event's own sub-account, within their territory scope.
 */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ref = getAdminDb().collection("events").doc(id);
  const snap = await ref.get();
  if (!snap.exists) return NextResponse.json({ error: "Event not found" }, { status: 404 });
  const event = snap.data() as { subAccountId: string; territoryId?: string | null };
  const access = await requireSubAccountMember(request, event.subAccountId);
  if (access instanceof NextResponse) return access;
  const gate = await territoryGate(access, event.territoryId ?? null);
  if (gate) return gate;

  await removeBookingFromGoogle(id);
  await ref.delete();
  return NextResponse.json({ ok: true });
}
