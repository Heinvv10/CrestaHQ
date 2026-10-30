import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type { ActivityType } from "@/types/contacts";

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
}): Promise<void> {
  if (!input.contactId) return;
  try {
    await getAdminDb()
      .collection("contacts")
      .doc(input.contactId)
      .collection("activities")
      .add({
        type: "meet_link_missing" satisfies ActivityType,
        content:
          "No Google Meet link could be made for this booking, and the customer was told the joining link will follow — send them one.",
        createdBy: "booking",
        agencyId: input.agencyId,
        subAccountId: input.subAccountId,
        meta: { eventId: input.eventId },
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn("[booking] meet_link_missing activity write failed", err instanceof Error ? err.message : String(err));
  }
}
