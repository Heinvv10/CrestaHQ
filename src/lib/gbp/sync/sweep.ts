import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import type { SubAccountDoc } from "@/types";
import type { SyncedRun } from "@/lib/reputation/sentiment-after";
import { googleConnectionSecretPath } from "@/types/google";
import { isFakeRefreshToken } from "../provider/fake";
import { GbpFakeRefusedError, gbpProviderMode } from "../provider/select";
import { recordFailedRun } from "./record";
import type { Sleep } from "./retry";
import { skipReasonFor } from "./run";
import { retainSubAccount, syncSubAccount } from "./sub-account";
import { toMillis, type GbpSummary, type SyncRunRecord } from "./types";

/**
 * The two sweeps behind the GBP crons, both under each tenant's lease:
 *
 *  - `runGbpSyncSweep` (POST /api/cron/gbp-sync, every 6 hours, only while
 *    GBP_SYNC_SCHEDULE_ENABLED=1): SYNC gated, connected sub-accounts with a
 *    listing via `syncSubAccount` (every listing) — least recently run first (never-run first),
 *    at most {@link SWEEP_CAP} per invocation, {@link CONCURRENCY} at a time;
 *    the first rate_limited or access_not_approved result stops new tenants
 *    from starting (the quota is project-wide; `stoppedOnRateLimit` covers both). Then a retention-only pass for caches that can no
 *    longer sync (gate off, disconnected, no listing).
 *  - `runGbpRetentionSweep` (POST /api/cron/gbp-retention, daily, always on —
 *    and the sync cron while its flag is off): a retention-only pass via
 *    `retainSubAccount` for EVERY sub-account holding a cache, sync-eligible or
 *    not. Never reaches the provider — Google's 30-day rule is not a matter
 *    of configuration. A cache is found by `gbpSummary.lastRunAt`, which the
 *    lease transaction stamps before any review page can land (extra
 *    listings imply a main one, whose summary finds the tenant).
 *
 * Queries are equality or single-field inequality only — no composite
 * index. In fake mode ONE query fenced to GBP_FAKE_AGENCY_ID feeds both
 * (filtered in memory), so a dev or CI box pointed at production Firestore
 * never touches a real tenant; `getGbpProviderFor` still asserts per tenant.
 * Each tenant is isolated: a throw becomes that tenant's `failed` run.
 */

export const SWEEP_CAP = 25;
const CONCURRENCY = 3;

type Sub = SubAccountDoc & { gbpSummary?: GbpSummary | null };
type Candidate = { id: string; sub: Sub };

export interface SweepResult {
  /** Tenants synced this invocation. */
  processed: number;
  /** One per listing run (a tenant with extra listings counts each). */
  byStatus: Record<string, number>;
  /** Retention-only passes run. */
  retained: number;
  retentionRefused: number;
  retentionFailed: number;
  stoppedOnRateLimit: boolean;
}

const eligible = (sub: Sub) => {
  const skip = skipReasonFor(sub);
  return skip === null || skip === "reconnect_required";
};
const hasCache = (sub: Sub) => toMillis(sub.gbpSummary?.lastRunAt) !== null;

/**
 * Local dev and CI run against this same Firestore, and an E2E spec leaves its
 * fixture tenant gated, connected and listed while it runs. The real sweep
 * would take that tenant to Google with the fake's refresh token, get
 * `revoked`, and flag the fixture reconnect-required mid-spec — so it skips
 * any tenant holding a credential only the fake mints (never a real one).
 * A read that fails syncs the tenant as before: this guard never costs a sync.
 */
async function holdsFakeCredentials(id: string): Promise<boolean> {
  try {
    return isFakeRefreshToken((await getAdminDb().doc(googleConnectionSecretPath(id)).get()).data()?.refreshToken);
  } catch (err) {
    console.error(`[cron/gbp-sync] credential check failed sa=${id}: ${err instanceof Error ? err.name : typeof err}`);
    return false;
  }
}

/** The first {@link SWEEP_CAP} of `list`, in order; in Google mode, skipping fake-credentialed tenants (read one at a time, only as far as needed). */
async function takeForSync(list: Candidate[], fake: boolean): Promise<Candidate[]> {
  if (fake) return list.slice(0, SWEEP_CAP);
  const taken: Candidate[] = [];
  for (const c of list) {
    if (taken.length >= SWEEP_CAP) break;
    if (!(await holdsFakeCredentials(c.id))) taken.push(c);
  }
  return taken;
}

async function candidates(): Promise<{ sync: Candidate[]; cached: Candidate[]; fake: boolean }> {
  // Throws GbpFakeRefusedError on a misconfigured fake: the sweep cannot
  // start, the route answers 500, QStash retries — loudly.
  const fake = gbpProviderMode() === "fake";
  const subs = getAdminDb().collection("subAccounts");
  const docs = async (q: FirebaseFirestore.Query) =>
    (await q.get()).docs.map((d) => ({ id: d.id, sub: d.data() as Sub }));
  const [gated, cached] = fake
    ? await docs(subs.where("agencyId", "==", process.env.GBP_FAKE_AGENCY_ID)).then((all) => [all, all])
    : await Promise.all([
        docs(subs.where("googleEnabledByAgency", "==", true)),
        docs(subs.where("gbpSummary.lastRunAt", "!=", null)),
      ]);
  const sync = gated
    .filter(({ sub }) => eligible(sub))
    .sort((a, b) => (toMillis(a.sub.gbpSummary?.lastRunAt) ?? -1) - (toMillis(b.sub.gbpSummary?.lastRunAt) ?? -1));
  return { sync, cached: cached.filter(({ sub }) => hasCache(sub)), fake };
}

async function pool(items: Candidate[], work: (c: Candidate) => Promise<void>, stop: () => boolean) {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stop()) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
}

export interface RetentionTally {
  /** Passes that actually ran retention under the lease. */
  retained: number;
  /** Passes refused (a live lease, or the sub-account changed as it started). */
  refused: number;
  /** Passes that failed — each leaves a failed retention run. */
  failed: number;
}

/** Retention-only passes (`retainSubAccount`, no provider calls), each tenant isolated; tallied per listing. */
async function retainAll(list: Candidate[]): Promise<RetentionTally> {
  const tally: RetentionTally = { retained: 0, refused: 0, failed: 0 };
  await pool(list, async (c) => {
    const now = new Date();
    try {
      for (const rec of await retainSubAccount(c.id, { now })) {
        if (rec.skipReason === "already_running" || rec.skipReason === "listing_changed") tally.refused += 1;
        else if (rec.status === "failed") tally.failed += 1;
        else tally.retained += 1;
      }
    } catch (err) {
      console.error(`[cron/gbp-retention] retention threw sa=${c.id}: ${err instanceof Error ? err.name : typeof err}`);
      await recordFailedRun(c.id, c.sub, "scheduled", null, now, "retention");
      tally.failed += 1;
    }
  }, () => false);
  return tally;
}

/**
 * Daily housekeeping (POST /api/cron/gbp-retention, and the sync cron while
 * the sync schedule is off): a retention-only pass for EVERY sub-account
 * holding a cache — sync-eligible or not. Never reaches the provider.
 */
export async function runGbpRetentionSweep(): Promise<RetentionTally> {
  const { cached } = await candidates();
  return retainAll(cached);
}

export async function runGbpSyncSweep(
  opts: {
    sleep?: Sleep;
    /** Each synced tenant, aggregated over its listings (the cron hands them to auto-reply + sentiment, after responding). */
    onRun?: (run: SyncedRun) => void;
  } = {},
): Promise<SweepResult> {
  const { sync: queue, cached, fake } = await candidates();
  const sync = await takeForSync(queue, fake);
  const byStatus: Record<string, number> = {};
  const count = (k: string) => (byStatus[k] = (byStatus[k] ?? 0) + 1);
  let processed = 0;
  let retained = 0;
  let rateLimited = false;

  type Done = Pick<SyncRunRecord, "status" | "errorKind"> | { status: "refused"; errorKind: null };
  const one = async (c: Candidate, onDone: (runs: Done[]) => void) => {
    const now = new Date();
    try {
      const { runs, synced } = await syncSubAccount(c.id, { trigger: "scheduled", sleep: opts.sleep });
      opts.onRun?.(synced);
      onDone(runs);
    } catch (err) {
      if (err instanceof GbpFakeRefusedError) {
        // Outside the fake's fence: touch nothing of that tenant's.
        console.error(`[cron/gbp-sync] fake refused sa=${c.id}`);
        onDone([{ status: "refused", errorKind: null }]);
        return;
      }
      console.error(`[cron/gbp-sync] sync threw sa=${c.id}: ${err instanceof Error ? err.name : typeof err}`);
      await recordFailedRun(c.id, c.sub, "scheduled", null, now);
      onDone([{ status: "failed", errorKind: "internal" }]);
    }
  };

  await pool(sync, (c) => one(c, (done) => {
    processed += 1;
    for (const { status, errorKind } of done) {
      count(status);
      // access_not_approved is Google's quota-0 429: the same project-wide wall, only permanent.
      if (errorKind === "rate_limited" || errorKind === "access_not_approved") rateLimited = true;
    }
  }), () => rateLimited);
  // Caches that cannot sync: retention only (no provider calls, no quota to
  // protect — always runs). Eligible tenants get retention inside their sync.
  const retention = await retainAll(cached.filter(({ sub }) => !eligible(sub)));
  retained = retention.retained;
  return {
    processed, byStatus, retained, retentionRefused: retention.refused, retentionFailed: retention.failed,
    stoppedOnRateLimit: rateLimited,
  };
}
