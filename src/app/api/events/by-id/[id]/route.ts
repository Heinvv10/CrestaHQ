import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { territoryGate } from "@/lib/auth/territory-filter";
import { removeBookingFromGoogleBeforeDelete } from "@/lib/google-calendar/push";
import { isImportedEvent, type EventSource } from "@/types/events";

/**
 * Delete a calendar event that is mirrored in a host's Google Calendar.
 *
 *   DELETE /api/events/by-id/[id]
 *
 * The rules refuse a client delete while `googleEventIds` is non-empty (its
 * Google copy would be orphaned, and a completed / no-show booking can't be
 * cancelled first). This route takes the Google copies down, then deletes —
 * and refuses (409 `google_removal_failed`) while any copy is left.
 * Same permission as the client delete it stands in for: an active member of
 * the event's own sub-account, within their territory scope.
 */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ref = getAdminDb().collection("events").doc(id);
  const snap = await ref.get();
  if (!snap.exists) return NextResponse.json({ error: "Event not found" }, { status: 404 });
  const event = snap.data() as { subAccountId: string; territoryId?: string | null; source?: EventSource };
  const access = await requireSubAccountMember(request, event.subAccountId);
  if (access instanceof NextResponse) return access;
  const gate = await territoryGate(access, event.territoryId ?? null);
  if (gate) return gate;
  if (isImportedEvent(event)) {
    return NextResponse.json({ error: "Imported Google events are read-only." }, { status: 400 });
  }

  const removal = await removeBookingFromGoogleBeforeDelete(id);
  if (!removal.ok) {
    return NextResponse.json({ error: "google_removal_failed", message: removal.message }, { status: 409 });
  }
  await ref.delete();
  return NextResponse.json({ ok: true });
}
