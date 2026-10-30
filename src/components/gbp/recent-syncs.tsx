import { absoluteTime } from "./format-time";
import type { ListingOption } from "./review-filters";
import { describeRun, type RunView } from "./run-text";

/**
 * The last runs (newest first), so "what did the sync do?" has an answer on
 * the page. With more than one listing, each run names its listing's title.
 */
export function RecentSyncs({ runs, listings = [] }: { runs: RunView[]; listings?: ListingOption[] }) {
  if (runs.length === 0) return null;
  const titleOf = (loc: string | null | undefined) =>
    listings.length > 1 ? (listings.find((l) => l.locationName === loc)?.title ?? null) : null;
  return (
    <section className="rounded-2xl border bg-card p-5">
      <h2 className="text-sm font-medium">Recent syncs</h2>
      <ul className="mt-2 space-y-1 text-xs text-muted-foreground" data-testid="gbp-runs">
        {runs.map((run, i) => (
          <li key={`${run.finishedAt ?? ""}-${i}`}>
            <span className="font-medium text-foreground">
              {run.skipReason === "retention_only" ? "Retention" : run.trigger === "manual" ? "Sync now" : "Scheduled"}
            </span>
            {titleOf(run.locationName) && <span data-testid="gbp-run-listing"> · {titleOf(run.locationName)}</span>}
            {run.finishedAt && ` · ${absoluteTime(run.finishedAt)}`} · {describeRun(run)}
          </li>
        ))}
      </ul>
    </section>
  );
}
