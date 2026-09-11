import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import type { SubAccountDoc } from "@/types";
import { GbpFakeRefusedError, gbpProviderMode } from "../provider/select";
import type { Sleep } from "./retry";
import { syncListing } from "./run";
import { runsCollection, toMillis, type GbpSummary, type SyncRunRecord } from "./types";

/**
 * The scheduled sweep behind POST /api/cron/gbp-sync (every 6 hours).
 *
 * Picks gated sub-accounts with equality-only queries (no composite index) —
 * in fake mode ALSO fenced to GBP_FAKE_AGENCY_ID, so a dev or CI box pointed
 * at production Firestore never sweeps a real tenant; `getGbpProviderFor`
 * still asserts that per tenant. Filters to connected + listing selected,
 * least recently run first (never-run first), at most {@link SWEEP_CAP} per
 * invocation, {@link CONCURRENCY} at a time. Each tenant is isolated: a throw
 * becomes that tenant's `failed` run and the sweep carries on.
 */

export const SWEEP_CAP = 25;
const CONCURRENCY = 3;

type Candidate = { id: string; sub: SubAccountDoc & { gbpSummary?: GbpSummary | null } };

export interface SweepResult {
  processed: number;
  byStatus: Record<string, number>;
}

async function candidates(): Promise<Candidate[]> {
  // Throws GbpFakeRefusedError on a misconfigured fake: the sweep cannot
  // start, the route answers 500, QStash retries — loudly.
  const fake = gbpProviderMode() === "fake";
  let q = getAdminDb().collection("subAccounts").where("googleEnabledByAgency", "==", true);
  if (fake) q = q.where("agencyId", "==", process.env.GBP_FAKE_AGENCY_ID);
  const snap = await q.get();
  return snap.docs
    .map((d) => ({ id: d.id, sub: d.data() as Candidate["sub"] }))
    .filter(({ sub }) => sub.googleConnectionMeta?.connected === true && !!sub.googleListing)
    .sort((a, b) => (toMillis(a.sub.gbpSummary?.lastRunAt) ?? -1) - (toMillis(b.sub.gbpSummary?.lastRunAt) ?? -1))
    .slice(0, SWEEP_CAP);
}

/** The tenant's sync threw before it could record itself: record it here. */
async function recordFailed({ id, sub }: Candidate, now: Date): Promise<void> {
  const db = getAdminDb();
  const ref = db.collection(runsCollection(id)).doc();
  const rec: SyncRunRecord = {
    runId: ref.id, agencyId: sub.agencyId, subAccountId: id,
    createdByUid: sub.googleListing?.selectedByUid ?? null, trigger: "scheduled", actorUid: null,
    startedAt: now, finishedAt: new Date(), locationName: sub.googleListing?.locationName ?? null,
    status: "failed", pagesFetched: 0, reviewsSeen: 0, created: 0, updated: 0, unchanged: 0,
    removed: 0, purged: 0, reconciliation: "deferred", resumedFromCursor: false,
    errorKind: "internal", skipReason: null,
  };
  await ref.create({ ...rec });
}

export async function runGbpSyncSweep(opts: { sleep?: Sleep } = {}): Promise<SweepResult> {
  const queue = await candidates();
  const byStatus: Record<string, number> = {};
  const count = (k: string) => (byStatus[k] = (byStatus[k] ?? 0) + 1);

  const one = async (c: Candidate) => {
    const now = new Date();
    try {
      count((await syncListing(c.id, { trigger: "scheduled", sleep: opts.sleep })).status);
    } catch (err) {
      const reason = err instanceof Error ? err.name : typeof err;
      if (err instanceof GbpFakeRefusedError) {
        // Outside the fake's fence: touch nothing of that tenant's.
        console.error(`[cron/gbp-sync] fake refused sa=${c.id}`);
        count("refused");
        return;
      }
      console.error(`[cron/gbp-sync] sync threw sa=${c.id}: ${reason}`);
      count("failed");
      await recordFailed(c, now).catch((e: unknown) =>
        console.error(`[cron/gbp-sync] could not record the failure sa=${c.id}`, e instanceof Error ? e.name : typeof e),
      );
    }
  };

  let next = 0;
  const worker = async () => {
    while (next < queue.length) await one(queue[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return { processed: queue.length, byStatus };
}
