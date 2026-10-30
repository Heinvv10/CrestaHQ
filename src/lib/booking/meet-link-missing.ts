import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type { ActivityType } from "@/types/contacts";

/**
 * What the workspace is told when a Meet booking's confirmation went out
 * without a link. `pending`: the push was still running at the deadline, so
 * the link is on its way; otherwise no room could be made.
 */
export function meetLinkMissingNote(pending: boolean): string {
  return pending
    ? "The Google Meet link is being created and will appear on the booking (and in its reminders); the customer was told the joining link will follow."
    : "No Google Meet link could be made for this booking (check Settings → Calendar sync) — send the customer a joining link.";
}

/**
 * A Google Meet booking whose booker was told "the joining link will follow"
 * when no host could be emailed about it (no host email, sending off, or the
 * send failed): a row on the contact's timeline, so someone in the workspace
 * sees a link is owed. Never throws — the booking is already made.
 */
export async function recordMeetLinkMissing(input: {
  contactId: string | null | undefined;
  eventId: string;
  agencyId: string;
  subAccountId: string;
  pending: boolean;
}): Promise<void> {
  if (!input.contactId) return;
  try {
    await getAdminDb()
      .collection("contacts")
      .doc(input.contactId)
      .collection("activities")
      .add({
        type: "meet_link_missing" satisfies ActivityType,
        content: meetLinkMissingNote(input.pending),
        createdBy: "booking",
        agencyId: input.agencyId,
        subAccountId: input.subAccountId,
        meta: { eventId: input.eventId, pending: input.pending },
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn("[booking] meet_link_missing activity write failed", err instanceof Error ? err.message : String(err));
  }
}
