import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import type { SubAccountDoc } from "@/types";
import { nextSummary } from "./summary";
import { runsCollection, type GbpSummary, type SyncRunRecord, type SyncTrigger } from "./types";

/**
 * A sync that THREW before it could record itself (the sweep's isolation,
 * Sync now's catch): write its `failed` run, and advance the summary's
 * `lastRunAt` so the tenant rotates to the back of the sweep instead of
 * starving it — only if the listing is still the one it was run for.
 * Best effort: a failure here is logged, never thrown.
 */
export async function recordFailedRun(
  subAccountId: string,
  sub: SubAccountDoc & { gbpSummary?: GbpSummary | null },
  trigger: SyncTrigger,
  actorUid: string | null,
  startedAt: Date,
): Promise<SyncRunRecord> {
  const db = getAdminDb();
  const ref = db.collection(runsCollection(subAccountId)).doc();
  const locationName = sub.googleListing?.locationName ?? null;
  const rec: SyncRunRecord = {
    runId: ref.id, agencyId: sub.agencyId, subAccountId,
    createdByUid: sub.googleListing?.selectedByUid ?? actorUid, trigger, actorUid,
    startedAt, finishedAt: new Date(), locationName,
    status: "failed", pagesFetched: 0, reviewsSeen: 0, created: 0, updated: 0, unchanged: 0,
    removed: 0, purged: 0, reconciliation: "deferred", resumedFromCursor: false,
    errorKind: "internal", skipReason: null,
  };
  try {
    await ref.create({ ...rec });
    if (locationName) {
      const subRef = db.doc(`subAccounts/${subAccountId}`);
      await db.runTransaction(async (tx) => {
        const fresh = (await tx.get(subRef)).data() as typeof sub | undefined;
        if (fresh?.googleListing?.locationName !== locationName) return;
        const prev = fresh.gbpSummary?.locationName === locationName ? fresh.gbpSummary : null;
        const summary = nextSummary(rec, prev, { expired: false, rating: null }, startedAt);
        tx.set(subRef, { gbpSummary: summary }, { merge: true });
      });
    }
  } catch (e) {
    console.error(`[gbp/sync] could not record the failure sa=${subAccountId}`, e instanceof Error ? e.name : typeof e);
  }
  return rec;
}
