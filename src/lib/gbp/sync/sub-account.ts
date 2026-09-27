import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import type { SyncedRun } from "@/lib/reputation/sentiment-after";
import type { SubAccountDoc } from "@/types";
import { GbpFakeRefusedError } from "../provider/select";
import { recordFailedRun } from "./record";
import { retainListing, syncListing, type SyncOptions } from "./run";
import { extraLocationNames, type WithSummaries } from "./scope";
import type { SyncRunRecord } from "./types";

/**
 * Every listing of a sub-account, one after another (MULTI_LISTING_V1_PLAN.md
 * H2). The MAIN listing goes first and is exactly the single-listing run of
 * before — a throw there propagates as it always did (the caller records it).
 * Then each extra listing, each under its own lease: an extra's throw becomes
 * that extra's failed run and the rest carry on; any other failure of the
 * extras phase is logged and the main run returned as it ended. A
 * sub-account without extras makes exactly one call.
 */

type Sub = SubAccountDoc & WithSummaries;

const readSub = async (sa: string) => ((await getAdminDb().doc(`subAccounts/${sa}`).get()).data() ?? {}) as Sub;

/** Google's quota is project-wide: once a listing hits it, the next listing would too. */
const quotaStop = (r: SyncRunRecord) => r.errorKind === "rate_limited" || r.errorKind === "access_not_approved";

async function eachExtra(
  sa: string,
  first: SyncRunRecord,
  run: (extra: string) => Promise<SyncRunRecord>,
  onThrow: (sub: Sub, extra: string) => Promise<SyncRunRecord>,
): Promise<SyncRunRecord[]> {
  const runs = [first];
  const why = (err: unknown) => (err instanceof Error ? err.name : typeof err);
  try {
    const sub = await readSub(sa);
    for (const extra of extraLocationNames(sub)) {
      if (quotaStop(runs[runs.length - 1])) break;
      try {
        runs.push(await run(extra));
      } catch (err) {
        // The fake's fence refuses the whole tenant: never write anything of ours there.
        if (err instanceof GbpFakeRefusedError) throw err;
        console.error(`[gbp/sync] listing threw sa=${sa}: ${why(err)}`);
        runs.push(await onThrow(sub, extra));
      }
    }
  } catch (err) {
    if (err instanceof GbpFakeRefusedError) throw err;
    // The main run has already returned: a failure among the extras (the
    // re-read included) must not turn it into a failed sync, nor skip the
    // after-sync work its caller runs. No extra to record it against — log it.
    console.error(`[gbp/sync] extra listings not synced sa=${sa}: ${why(err)}`);
  }
  return runs;
}

/**
 * Sync every listing. `synced` is ONE aggregate per sub-account (created +
 * updated summed, the earliest start), so review auto-reply and sentiment
 * still run once per tenant after the sync (after-sync.ts).
 */
export async function syncSubAccount(sa: string, opts: SyncOptions): Promise<{ runs: SyncRunRecord[]; synced: SyncedRun }> {
  const main = await syncListing(sa, opts);
  const runs = await eachExtra(
    sa,
    main,
    (extra) => syncListing(sa, opts, extra),
    (sub, extra) => recordFailedRun(sa, sub, opts.trigger, opts.actorUid ?? null, new Date(), "sync", extra),
  );
  const synced: SyncedRun = {
    subAccountId: sa,
    created: runs.reduce((n, r) => n + r.created, 0),
    updated: runs.reduce((n, r) => n + r.updated, 0),
    startedAt: new Date(Math.min(...runs.map((r) => r.startedAt.getTime()))),
  };
  return { runs, synced };
}

/** Retention only (no provider call) for every listing's cache — see `retainListing`. */
export async function retainSubAccount(sa: string, opts: { now?: Date } = {}): Promise<SyncRunRecord[]> {
  const main = await retainListing(sa, opts);
  return eachExtra(
    sa,
    main,
    (extra) => retainListing(sa, opts, extra),
    (sub, extra) => recordFailedRun(sa, sub, "scheduled", null, opts.now ?? new Date(), "retention", extra),
  );
}
