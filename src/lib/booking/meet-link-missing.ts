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

/** The row once the late link went out by email. */
export const MEET_LINK_SENT_NOTE =
  "The Google Meet link was made after the booking and has been emailed to the customer.";
/** The row when the late link reached the booking before the row was written. */
export const MEET_LINK_ON_BOOKING_NOTE =
  "The Google Meet link was made after the booking and is on it now; the customer was told the joining link will follow.";
/** The row once the late link exists but could not be emailed. */
export const MEET_LINK_NOT_EMAILED_NOTE =
  "The Google Meet link now exists on the booking, but it couldn't be emailed to the customer — send it to them.";

/** The once-only claim for the late link's email (reminder claims live beside it). */
export const meetLinkFollowUpClaimPath = (eventId: string) => `events/${eventId}/reminderSends/meet-link-follow-up`;

/** The booking's meet_link_missing rows on its contact. */
async function rowsFor(contactId: string, eventId: string) {
  return (
    await getAdminDb()
      .collection("contacts")
      .doc(contactId)
      .collection("activities")
      .where("type", "==", "meet_link_missing")
      .where("meta.eventId", "==", eventId)
      .get()
  ).docs;
}

/** Rewrite the booking's rows: the late link was emailed, or couldn't be. Never throws. */
export async function settleMeetLinkRows(
  contactId: string,
  eventId: string,
  outcome: "sent" | "not_emailed",
): Promise<void> {
  try {
    const rows = await rowsFor(contactId, eventId);
    await Promise.all(
      rows.map((d) =>
        d.ref.update(
          outcome === "sent"
            ? { content: MEET_LINK_SENT_NOTE, "meta.pending": false, "meta.resolved": true, "meta.resolvedAt": FieldValue.serverTimestamp() }
            : { content: MEET_LINK_NOT_EMAILED_NOTE, "meta.pending": false },
        ),
      ),
    );
  } catch (err) {
    console.warn(`[booking/meet-link] timeline rewrite failed event=${eventId}`, err instanceof Error ? err.message : String(err));
  }
}

/**
 * A detached push ended without storing a room: a "being created" row was
 * wrong. It now says no link could be made — or, when a link reached the
 * booking some other way meanwhile, that the link is on the booking now.
 * Never throws.
 */
export async function settleMeetLinkPending(eventId: string): Promise<void> {
  try {
    const snap = await getAdminDb().collection("events").doc(eventId).get();
    const e = snap.data() as { contactId?: string | null; meetingUrl?: string | null } | undefined;
    if (!e?.contactId) return;
    const content = e.meetingUrl ? MEET_LINK_ON_BOOKING_NOTE : meetLinkMissingNote(false);
    const rows = (await rowsFor(e.contactId, eventId)).filter((d) => d.data().meta?.pending === true);
    await Promise.all(rows.map((d) => d.ref.update({ content, "meta.pending": false })));
  } catch (err) {
    console.warn(`[booking/meet-link] pending row settle failed event=${eventId}`, err instanceof Error ? err.message : String(err));
  }
}

/**
 * A Google Meet booking whose booker was told "the joining link will follow"
 * when no host could be emailed about it (no host email, sending off, or the
 * send failed): a row on the contact's timeline, so someone in the workspace
 * sees a link is owed. If the late link's email already went out (its claim
 * exists), the row is written already resolved. Never throws — the booking
 * is already made.
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
    const db = getAdminDb();
    const [claim, event] = await Promise.all([
      db.doc(meetLinkFollowUpClaimPath(input.eventId)).get(),
      db.collection("events").doc(input.eventId).get(),
    ]);
    const sent = claim.exists;
    // The link may already be on the booking (a late room stored meanwhile):
    // then it isn't "being created" or impossible — the follow-up settles it.
    const linked = !!(event.data() as { meetingUrl?: string | null } | undefined)?.meetingUrl;
    await db
      .collection("contacts")
      .doc(input.contactId)
      .collection("activities")
      .add({
        type: "meet_link_missing" satisfies ActivityType,
        content: sent ? MEET_LINK_SENT_NOTE : linked ? MEET_LINK_ON_BOOKING_NOTE : meetLinkMissingNote(input.pending),
        createdBy: "booking",
        agencyId: input.agencyId,
        subAccountId: input.subAccountId,
        meta: {
          eventId: input.eventId,
          pending: sent || linked ? false : input.pending,
          ...(sent ? { resolved: true } : {}),
        },
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn("[booking] meet_link_missing activity write failed", err instanceof Error ? err.message : String(err));
  }
}
