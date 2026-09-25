/**
 * A short id that scopes a spec's fixture-doc prefix to THIS run only.
 *
 * All E2E runs (PR branches, main, the production smoke) share one fixture
 * sub-account. A spec's `afterEach(purge)` deletes every doc whose name
 * starts with its PREFIX — with a fixed PREFIX, a concurrent run's purge
 * deletes another run's freshly seeded docs mid-test (observed
 * 2026-09-24 on availability-rules.spec.ts: "Booking page not found — it
 * may have been deleted."). Folding a run id into PREFIX makes each run's
 * docs distinct, so purge only ever matches its own.
 *
 * CI sets GITHUB_RUN_ID (stable for every job in one workflow run) plus
 * GITHUB_RUN_ATTEMPT (distinct across re-runs of the same run id). Locally,
 * where neither is set, a random id is generated once and cached for the
 * process, so every spec in one local invocation shares it too.
 */
let _cached: string | null = null;

export function runId(): string {
  if (_cached) return _cached;
  const ghRunId = process.env.GITHUB_RUN_ID;
  _cached = ghRunId
    ? `${ghRunId}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`
    : Math.random().toString(36).slice(2, 10);
  return _cached;
}
