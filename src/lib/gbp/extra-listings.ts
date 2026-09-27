import "server-only";

import { FieldValue, type Transaction } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type { GoogleListing } from "@/types/google";
import { locationNamesOf, type ListingFields } from "./listings";
import type { GbpAccount, GbpLocation } from "./provider/types";
import { heldByAnotherSubAccount } from "./shared-location";
import { clearGbpCache } from "./sync/clear";

/**
 * Connecting and removing EXTRA listings (MULTI_LISTING_V1_PLAN.md PR 3).
 * Every write of `googleExtraListings` rewrites `googleLocationNames` in the
 * same transaction, with one `gbpEvents` entry per listing added or removed.
 * A removed listing's synced data goes AFTER the doc write, one listing at a
 * time (`clearGbpCache(id, loc)`): the main listing's cache, summary, drafts
 * and auto-reply settings are never touched. A listing connected AGAIN by the
 * time its clear starts (made the main, or re-added) is skipped; the listing
 * PUT refuses 409 `listing_clearing` while a clear holds its lease. A clear
 * that fails is logged and left to the retention / orphan sweeps — the save
 * itself has committed.
 */

export interface ListingPair {
  accountName: string;
  locationName: string;
}

export type ExtraRemovedReason = "admin_removed" | "not_accessible_after_reconnect";

type Sub = ListingFields & { agencyId?: string };

const keyOf = (l: ListingPair) => `${l.accountName}|${l.locationName}`;

/** The stored listing, from the provider's own re-fetch. */
export function listingFrom(account: GbpAccount, location: GbpLocation, byUid: string): GoogleListing {
  return {
    accountName: account.name,
    accountDisplayName: account.accountName,
    locationName: location.name,
    title: location.title,
    address: location.address,
    websiteUri: location.websiteUri,
    placeId: location.placeId,
    mapsUri: location.mapsUri,
    newReviewUri: location.newReviewUri,
    // A Date, not serverTimestamp(): Firestore refuses a sentinel inside an array.
    selectedAt: new Date(),
    selectedByUid: byUid,
  };
}

/** The stored extras, never the main (a stale duplicate of it is dropped). */
export function storedExtras(sub: Sub): GoogleListing[] {
  const main = sub.googleListing?.locationName;
  return (sub.googleExtraListings ?? []).filter((l) => l.locationName !== main);
}

function writeExtras(
  tx: Transaction,
  subAccountId: string,
  sub: Sub,
  next: GoogleListing[],
  changes: Array<{ type: "extra_listing_added" } | { type: "extra_listing_removed"; reason: ExtraRemovedReason }>,
  locations: string[],
  byUid: string,
): void {
  const db = getAdminDb();
  tx.update(db.doc(`subAccounts/${subAccountId}`), {
    googleExtraListings: next,
    googleLocationNames: locationNamesOf({ googleListing: sub.googleListing, googleExtraListings: next }),
    updatedAt: FieldValue.serverTimestamp(),
  });
  changes.forEach((change, i) =>
    tx.set(db.collection(`subAccounts/${subAccountId}/gbpEvents`).doc(), {
      ...change,
      agencyId: sub.agencyId,
      subAccountId,
      createdByUid: byUid,
      at: FieldValue.serverTimestamp(),
      locationName: locations[i],
    }),
  );
}

/** Clear each removed listing's synced data; true when a clear failed (data left behind). */
async function clearRemoved(subAccountId: string, removed: string[]): Promise<boolean> {
  const subRef = getAdminDb().doc(`subAccounts/${subAccountId}`);
  let pending = false;
  for (const loc of removed) {
    try {
      // Connected again meanwhile (e.g. made the main): its cache is live data now.
      if (locationNamesOf(((await subRef.get()).data() ?? {}) as Sub).includes(loc)) continue;
      await clearGbpCache(subAccountId, loc, { unlessHeld: true });
    } catch (err) {
      pending = true;
      console.error(`[gbp/extra-listings] removed listing's cache not cleared sa=${subAccountId} loc=${loc}: ${err instanceof Error ? err.name : typeof err}`);
    }
  }
  return pending;
}

const sameSet = (a: ListingPair[], b: ListingPair[]) => {
  const keys = new Set(a.map(keyOf));
  return keys.size === new Set(b.map(keyOf)).size && b.every((p) => keys.has(keyOf(p)));
};

export type SaveResult =
  | { ok: true; added: string[]; removed: string[]; cachePending?: true }
  | { ok: false; code: "no_listing" | "is_main" | "listing_shared" | "listings_changed" | "account_changed" };

/**
 * Replace the extras with `requested`, in that order — only if the stored
 * extras are still `expected` (what the caller saw), else `listings_changed`
 * and nothing is written: a stale or concurrent save never undoes another's.
 * A pair already stored
 * keeps its stored listing; a new pair must be in `fetched` (the caller's
 * provider re-fetch, keyed `accountName|locationName`) — if it is neither,
 * the extras changed since the caller looked and nothing is written.
 */
export async function saveExtraListings(
  subAccountId: string,
  byUid: string,
  requested: ListingPair[],
  expected: ListingPair[],
  fetched: Map<string, GoogleListing>,
): Promise<SaveResult> {
  const db = getAdminDb();
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  const result = await db.runTransaction(async (tx): Promise<SaveResult> => {
    const sub = ((await tx.get(subRef)).data() ?? {}) as Sub;
    const main = sub.googleListing?.locationName;
    // Extras always sit beside a main listing.
    if (!main) return { ok: false, code: "no_listing" };
    if (requested.some((p) => p.locationName === main)) return { ok: false, code: "is_main" };
    const current = storedExtras(sub);
    if (!sameSet(current, expected)) return { ok: false, code: "listings_changed" };
    const stored = new Map(current.map((l) => [keyOf(l), l]));
    const next: GoogleListing[] = [];
    for (const pair of requested) {
      const listing = stored.get(keyOf(pair)) ?? fetched.get(keyOf(pair));
      if (!listing) return { ok: false, code: "listings_changed" };
      next.push(listing);
    }
    const nextKeys = new Set(next.map(keyOf));
    const added = next.filter((l) => !stored.has(keyOf(l))).map((l) => l.locationName);
    const removed = current.filter((l) => !nextKeys.has(keyOf(l))).map((l) => l.locationName);
    // One location, one account per save: switching its Google account must go
    // remove → save → re-add, so the old account's cache is cleared on its own.
    if (added.some((loc) => removed.includes(loc))) return { ok: false, code: "account_changed" };
    for (const loc of added) {
      if (await heldByAnotherSubAccount(db, tx, loc, subAccountId)) return { ok: false, code: "listing_shared" };
    }
    if (added.length === 0 && removed.length === 0) return { ok: true, added, removed };
    const changes = [
      ...removed.map(() => ({ type: "extra_listing_removed" as const, reason: "admin_removed" as const })),
      ...added.map(() => ({ type: "extra_listing_added" as const })),
    ];
    writeExtras(tx, subAccountId, sub, next, changes, [...removed, ...added], byUid);
    return { ok: true, added, removed };
  });
  // A location removed and re-added under another Google account starts empty.
  if (result.ok && (await clearRemoved(subAccountId, result.removed))) return { ...result, cachePending: true };
  return result;
}

/**
 * Remove these extras — each only while the stored entry is still that exact
 * pair (the one checked) — audited with `reason`; returns what was removed.
 */
export async function removeExtraListings(
  subAccountId: string,
  byUid: string,
  pairs: ListingPair[],
  reason: ExtraRemovedReason,
): Promise<string[]> {
  const db = getAdminDb();
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  const removed = await db.runTransaction(async (tx) => {
    const sub = ((await tx.get(subRef)).data() ?? {}) as Sub;
    const current = storedExtras(sub);
    const checked = new Set(pairs.map(keyOf));
    const gone = current.filter((l) => checked.has(keyOf(l))).map((l) => l.locationName);
    if (gone.length === 0) return [];
    const next = current.filter((l) => !gone.includes(l.locationName));
    writeExtras(tx, subAccountId, sub, next, gone.map(() => ({ type: "extra_listing_removed", reason })), gone, byUid);
    return gone;
  });
  await clearRemoved(subAccountId, removed);
  return removed;
}
