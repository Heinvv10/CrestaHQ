import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { extraLocationNames, ownsDoc, scopeOf, summaryPatch } from "./scope";
import { LEASE_TTL_MS, reviewsCollection, syncStatePath } from "./types";

/**
 * Throwing synced data away — per listing (MULTI_LISTING_V1_PLAN.md H3).
 * Markers (`autoReplyNever`, `autoReplyDismissed`, `reviewAutoReplyAlerts`)
 * live outside the cache and are never touched here.
 */

const BATCH = 400;

async function deleteAll(paths: string[]): Promise<void> {
  const db = getAdminDb();
  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = db.batch();
    for (const p of paths.slice(i, i + BATCH)) batch.delete(db.doc(p));
    await batch.commit();
  }
}

/** The lease a cache clear holds while it deletes (an ordinary lease: it expires). */
export const CLEARING_RUN_ID = "clearing";

/**
 * Drop everything synced for ONE listing: its cached reviews, its summary and
 * its sync state (lease + cursor). `extra` null = the MAIN listing — every
 * doc not belonging to a current extra (for a sub-account without extras,
 * the whole cache, as before), `gbpSummary` and `private/gbpSyncState`; an
 * extra = only docs with that `locationName`, `gbpSummaries.{locId}` and its
 * own state doc. Called when a listing is cleared or replaced.
 *
 * FIRST it takes that listing's lease (`runId: "clearing"`): a run in flight
 * fails its next guarded write (lease lost) and a run starting now is refused
 * (`already_running`), so nothing lands behind the deletes. The state doc —
 * and with it the clearing lease — goes LAST. A clear that dies midway leaves
 * the lease to expire after its TTL.
 */
export async function clearGbpCache(subAccountId: string, extra: string | null = null): Promise<void> {
  const db = getAdminDb();
  const stateRef = db.doc(syncStatePath(subAccountId, extra));
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  // The first write also drops the cursor and the anomaly streak, so a clear
  // that dies midway leaves no stale pass for the next run to resume.
  const lease = { runId: CLEARING_RUN_ID, until: Date.now() + LEASE_TTL_MS };
  await stateRef.set({ lease, pass: null, anomalyStreak: null }, { merge: true });
  const reviews = db.collection(reviewsCollection(subAccountId));
  let ids: string[];
  if (extra !== null) {
    ids = (await reviews.where("locationName", "==", extra).get()).docs.map((d) => d.id);
  } else {
    const scope = scopeOf((await subRef.get()).data() ?? {}, null);
    ids = (await reviews.get()).docs.filter((d) => ownsDoc(scope, d.data().locationName)).map((d) => d.id);
  }
  await deleteAll(ids.map((id) => `${reviewsCollection(subAccountId)}/${id}`));
  await subRef.set(summaryPatch(extra, null), { merge: true });
  await stateRef.delete();
}

/**
 * Drop everything synced for the sub-account (Google gate off, disconnect,
 * every listing cleared): each current extra — plus `alsoExtras`, extras the
 * caller has just removed from the doc — then the main scope, which by then
 * is every remaining doc (a failed earlier clear's leftovers included), then
 * any extra state doc or summary such a failed clear left behind.
 */
export async function clearAllGbpCaches(subAccountId: string, alsoExtras: string[] = []): Promise<void> {
  const db = getAdminDb();
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  const sub = (await subRef.get()).data() ?? {};
  for (const loc of new Set([...extraLocationNames(sub), ...alsoExtras])) await clearGbpCache(subAccountId, loc);
  await clearGbpCache(subAccountId);
  const states = await db.collection(`subAccounts/${subAccountId}/private`).get();
  const orphans = states.docs.filter((d) => d.id.startsWith("gbpSyncState_"));
  await deleteAll(orphans.map((d) => `subAccounts/${subAccountId}/private/${d.id}`));
  if (sub.gbpSummaries) await subRef.set({ gbpSummaries: FieldValue.delete() }, { merge: true });
}
