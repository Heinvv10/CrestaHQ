import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { sendAutoReplyAlert } from "@/lib/reputation/auto-reply/alerts";
import type { GoogleListing } from "@/types/google";
import { findAccessibleLocation, findAccessibleLocations } from "./discovery";
import { removeExtraListings, storedExtras } from "./extra-listings";
import { clearAllGbpCaches } from "./sync/clear";
import { extraLocationNames } from "./sync/scope";
import type { GbpProvider } from "./provider/types";

/**
 * Clearing the selected Business Profile listing, always with an audit trail.
 * The clear and its `gbpEvents` entry commit in ONE transaction, and nothing
 * is logged when there was no listing to clear. Every clear — admin, disconnect,
 * reconnect re-verification — also drops the synced review cache, summary and
 * sync state of every listing (`clearAllGbpCaches`): the cache only ever
 * holds the current listings.
 * Every clear also switches review auto-reply off (`reviewsAutoReply.enabled`),
 * noting `disabledReason: "listing_changed"` when it was on — and then sends
 * one alert (it was on, so exactly one writer switches it off). Each extra
 * listing cleared with it gets its own `extra_listing_removed` event.
 */

export type ListingClearedReason =
  | "admin_cleared"
  | "disconnected"
  | "not_accessible_after_reconnect";

export async function clearListing(
  subAccountId: string,
  byUid: string,
  reason: ListingClearedReason,
  opts: {
    /** Other fields to clear in the same write (disconnect clears the meta too). */
    alsoSet?: Record<string, unknown>;
    /**
     * Clear ONLY if the stored listing is still this location — the one that
     * was checked. A newer selection made meanwhile is left alone.
     */
    onlyIf?: string;
  } = {},
): Promise<void> {
  const db = getAdminDb();
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  let switchedOff = false;
  let extras: string[] = [];
  const cleared = await db.runTransaction(async (tx) => {
    switchedOff = false;
    const sub = (await tx.get(subRef)).data() ?? {};
    extras = extraLocationNames(sub);
    const previous: string | null = sub.googleListing?.locationName ?? null;
    if (opts.onlyIf !== undefined && previous !== opts.onlyIf) return false;
    // Review auto-reply was enabled for this listing: switched off (modes kept);
    // resuming needs an explicit re-enable. When it was ON, the card says why.
    const wasOn = sub.reviewsAutoReply?.enabled === true;
    switchedOff = wasOn;
    const autoReplyOff = sub.reviewsAutoReply
      ? { reviewsAutoReply: { enabled: false, ...(wasOn ? { disabledReason: "listing_changed" } : {}) } }
      : {};
    // The extras' adopted review links go with them; the main's link is kept.
    const dropUrls = sub.googleReviewConfig?.listingUrls ? { googleReviewConfig: { listingUrls: FieldValue.delete() } } : {};
    tx.set(
      subRef,
      { ...opts.alsoSet, ...autoReplyOff, ...dropUrls, googleListing: null, googleExtraListings: [], googleLocationNames: [], updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    // Each extra cleared with it is audited on its own, with the same reason.
    for (const loc of extras) {
      tx.set(db.collection(`subAccounts/${subAccountId}/gbpEvents`).doc(), {
        type: "extra_listing_removed",
        reason,
        agencyId: sub.agencyId,
        subAccountId,
        createdByUid: byUid,
        at: FieldValue.serverTimestamp(),
        locationName: loc,
      });
    }
    if (!previous) return true;
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
    return true;
  });
  // A declined onlyIf means a NEWER listing is selected: its cache stays.
  if (cleared) await clearAllGbpCaches(subAccountId, extras);
  if (switchedOff) await sendAutoReplyAlert(subAccountId, { kind: "listing_changed" });
}

/**
 * After a (re)connect, the Google identity may differ from the one the listing
 * was picked through. Re-check the stored listing with the NEW token: clear it
 * (audited) if this grant provably cannot see it. If the check fails, or the
 * walk was truncated before finding it, keep the listing — a transient Google
 * error or a huge account must neither fail the connect nor throw away a good
 * selection.
 */
export async function reverifyListingAfterReconnect(
  subAccountId: string,
  byUid: string,
  provider: GbpProvider,
  accessToken: string,
  listing: Pick<GoogleListing, "accountName" | "locationName">,
): Promise<void> {
  let match: Awaited<ReturnType<typeof findAccessibleLocation>>;
  try {
    match = await findAccessibleLocation(provider, accessToken, listing.accountName, listing.locationName);
  } catch (err) {
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : typeof err;
    console.warn(`[google/callback] listing re-verify failed, keeping it sa=${subAccountId}`, reason);
    return;
  }
  // "unknown" = the walk was truncated: absence is not proven, keep it.
  if (match === null) {
    await clearListing(subAccountId, byUid, "not_accessible_after_reconnect", {
      onlyIf: listing.locationName,
    });
    return;
  }
  await reverifyExtrasAfterReconnect(subAccountId, byUid, provider, accessToken);
}

/**
 * The main listing stays: each EXTRA listing the new grant provably cannot see
 * is removed on its own (audited, only its synced data dropped). Same rules as
 * the main: a failed or truncated check keeps the listing.
 */
async function reverifyExtrasAfterReconnect(
  subAccountId: string,
  byUid: string,
  provider: GbpProvider,
  accessToken: string,
): Promise<void> {
  const extras = storedExtras((await getAdminDb().doc(`subAccounts/${subAccountId}`).get()).data() ?? {});
  if (extras.length === 0) return;
  let matches: Awaited<ReturnType<typeof findAccessibleLocations>>;
  try {
    matches = await findAccessibleLocations(provider, accessToken, extras);
  } catch (err) {
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : typeof err;
    console.warn(`[google/callback] extra listings re-verify failed, keeping them sa=${subAccountId}`, reason);
    return;
  }
  const missing = extras.filter((_, i) => matches[i] === null);
  if (missing.length > 0) await removeExtraListings(subAccountId, byUid, missing, "not_accessible_after_reconnect");
}
