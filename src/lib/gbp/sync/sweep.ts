import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import type { SubAccountDoc } from "@/types";
import { GbpFakeRefusedError, gbpProviderMode } from "../provider/select";
import { recordFailedRun } from "./record";
import type { Sleep } from "./retry";
import { skipReasonFor, syncListing } from "./run";
import { toMillis, type GbpSummary } from "./types";

/**
 * The scheduled sweep behind POST /api/cron/gbp-sync (every 6 hours).
 *
 * Two kinds of work, both through `syncListing` under its lease:
 *  - SYNC: gated, connected sub-accounts with a listing — least recently run
 *    first (never-run first), at most {@link SWEEP_CAP} per invocation,
 *    {@link CONCURRENCY} at a time. The first rate_limited result stops new
 *    tenants from starting (the quota is project-wide).
 *  - RETENTION ONLY: sub-accounts that still hold a synced cache but can no
 *    longer sync (gate off, disconnected, no listing). No provider call —
 *    just Google's 30-day rule, so a cache never outlives it.
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
  byStatus: Record<string, number>;
  /** Retention-only passes run. */
  retained: number;
  stoppedOnRateLimit: boolean;
}

const eligible = (sub: Sub) => {
  const skip = skipReasonFor(sub);
  return skip === null || skip === "reconnect_required";
};
const hasCache = (sub: Sub) => toMillis(sub.gbpSummary?.lastRunAt) !== null;

async function candidates(): Promise<{ sync: Candidate[]; retain: Candidate[] }> {
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
    .sort((a, b) => (toMillis(a.sub.gbpSummary?.lastRunAt) ?? -1) - (toMillis(b.sub.gbpSummary?.lastRunAt) ?? -1))
    .slice(0, SWEEP_CAP);
  const retain = cached.filter(({ sub }) => !eligible(sub) && hasCache(sub));
  return { sync, retain };
}

async function pool(items: Candidate[], work: (c: Candidate) => Promise<void>, stop: () => boolean) {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stop()) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
}

export async function runGbpSyncSweep(opts: { sleep?: Sleep } = {}): Promise<SweepResult> {
  const { sync, retain } = await candidates();
  const byStatus: Record<string, number> = {};
  const count = (k: string) => (byStatus[k] = (byStatus[k] ?? 0) + 1);
  let processed = 0;
  let retained = 0;
  let rateLimited = false;

  const one = async (c: Candidate, onDone: (status: string, errorKind: string | null) => void) => {
    const now = new Date();
    try {
      const run = await syncListing(c.id, { trigger: "scheduled", sleep: opts.sleep });
      onDone(run.status, run.errorKind);
    } catch (err) {
      if (err instanceof GbpFakeRefusedError) {
        // Outside the fake's fence: touch nothing of that tenant's.
        console.error(`[cron/gbp-sync] fake refused sa=${c.id}`);
        onDone("refused", null);
        return;
      }
      console.error(`[cron/gbp-sync] sync threw sa=${c.id}: ${err instanceof Error ? err.name : typeof err}`);
      await recordFailedRun(c.id, c.sub, "scheduled", null, now);
      onDone("failed", "internal");
    }
  };

  await pool(sync, (c) => one(c, (status, errorKind) => {
    processed += 1;
    count(status);
    if (errorKind === "rate_limited") rateLimited = true;
  }), () => rateLimited);
  // No provider calls, so no quota to protect: always runs.
  await pool(retain, (c) => one(c, () => void (retained += 1)), () => false);
  return { processed, byStatus, retained, stoppedOnRateLimit: rateLimited };
}
