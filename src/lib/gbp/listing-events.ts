import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";

/**
 * Clearing the selected Business Profile listing, always with an audit trail.
 * The clear and its `gbpEvents` entry commit in ONE transaction, and nothing
 * is logged when there was no listing to clear.
 */

export type ListingClearedReason =
  | "admin_cleared"
  | "disconnected"
  | "not_accessible_after_reconnect";

export async function clearListing(
  subAccountId: string,
  byUid: string,
  reason: ListingClearedReason,
  /** Other fields to clear in the same write (disconnect clears the meta too). */
  alsoSet: Record<string, unknown> = {},
): Promise<void> {
  const db = getAdminDb();
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  await db.runTransaction(async (tx) => {
    const sub = (await tx.get(subRef)).data() ?? {};
    const previous: string | null = sub.googleListing?.locationName ?? null;
    tx.set(
      subRef,
      { ...alsoSet, googleListing: null, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    if (!previous) return;
    tx.set(db.collection(`subAccounts/${subAccountId}/gbpEvents`).doc(), {
      type: "listing_cleared",
      reason,
      agencyId: sub.agencyId,
      subAccountId,
      createdByUid: byUid,
      at: FieldValue.serverTimestamp(),
      locationName: null,
      previousLocationName: previous,
    });
  });
}
