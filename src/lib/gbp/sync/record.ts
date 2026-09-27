import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import type { SubAccountDoc } from "@/types";
import { listingFor } from "../listings";
import { extraLocationNames, summaryIn, summaryPatch, type WithSummaries } from "./scope";
import { nextSummary } from "./summary";
import { runsCollection, type SyncRunRecord, type SyncTrigger } from "./types";

/**
 * A sync that THREW before it could record itself (the sweep's isolation,
 * Sync now's catch): write its `failed` run, and advance the summary's
 * `lastRunAt` so the tenant rotates to the back of the sweep instead of
 * starving it — only if the listing is still the one it was run for (in the
 * same role: `extra` null = the main listing, else that extra).
 * Best effort: a failure here is logged, never thrown.
 */
export async function recordFailedRun(
  subAccountId: string,
  sub: SubAccountDoc & WithSummaries,
  trigger: SyncTrigger,
  actorUid: string | null,
  startedAt: Date,
  /** `retention`: a housekeeping pass threw — record it as such, and leave the sync summary alone. */
  kind: "sync" | "retention" = "sync",
  extra: string | null = null,
): Promise<SyncRunRecord> {
  const db = getAdminDb();
  const ref = db.collection(runsCollection(subAccountId)).doc();
  const listing = extra === null ? sub.googleListing : listingFor(sub, extra);
  const locationName = extra ?? sub.googleListing?.locationName ?? null;
  const rec: SyncRunRecord = {
    runId: ref.id, agencyId: sub.agencyId, subAccountId,
    createdByUid: listing?.selectedByUid ?? actorUid, trigger, actorUid,
    startedAt, finishedAt: new Date(), locationName,
    status: "failed", pagesFetched: 0, reviewsSeen: 0, created: 0, updated: 0, unchanged: 0,
    removed: 0, purged: 0, reconciliation: "deferred", resumedFromCursor: false,
    errorKind: "internal", skipReason: kind === "retention" ? "retention_only" : null,
  };
  try {
    await ref.create({ ...rec });
    if (locationName && kind === "sync") {
      const subRef = db.doc(`subAccounts/${subAccountId}`);
      await db.runTransaction(async (tx) => {
        const fresh = (await tx.get(subRef)).data() as typeof sub | undefined;
        const current = extra === null
          ? fresh?.googleListing?.locationName
          : (fresh && extraLocationNames(fresh).includes(extra) ? extra : null);
        if (!fresh || current !== locationName) return;
        const stored = summaryIn(fresh, extra);
        const prev = stored?.locationName === locationName ? stored : null;
        const summary = nextSummary(rec, prev, { expired: false, rating: null }, startedAt);
        tx.set(subRef, summaryPatch(extra, summary), { merge: true });
      });
    }
  } catch (e) {
    console.error(`[gbp/sync] could not record the failure sa=${subAccountId}`, e instanceof Error ? e.name : typeof e);
  }
  return rec;
}
