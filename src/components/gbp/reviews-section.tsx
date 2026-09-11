"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { GbpHealth } from "@/lib/gbp/sync/types";
import { absoluteTime, relativeTime } from "./format-time";
import { RecentSyncs } from "./recent-syncs";
import { ReviewItem, type ReviewView } from "./review-item";
import { describeRun, type RunView } from "./run-text";
import { HealthBadge, HealthBanner } from "./sync-health";

/**
 * The synced reviews of the selected listing: a summary card (rating, count,
 * honest freshness + cadence, health), a banner for any degraded state, admin
 * "Sync now" with its result inline (no confirm()/alert()), and the reviews,
 * newest first, exactly as Google returned them.
 */

interface SummaryView {
  averageRating: number | null;
  totalReviewCount: number | null;
  lastSuccessfulSyncAt: string | null;
  lastErrorKind: string | null;
  lastReconciliation?: string | null;
  health: GbpHealth;
}
interface Ready {
  state: "ready";
  summary: SummaryView | null;
  reviews: ReviewView[];
  runs: RunView[];
  scheduled: boolean;
  truncated: boolean;
}
type Load = { state: "loading" } | { state: "error" } | Ready;

export function ReviewsSection({
  subAccountId,
  canSync,
  reconnect,
}: {
  subAccountId: string;
  canSync: boolean;
  /** The connection itself is flagged reconnect-required. */
  reconnect: boolean;
}) {
  const base = `/api/sub-accounts/${subAccountId}/gbp`;
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch(`${base}/reviews`).catch(() => null);
    const data = (await res?.json().catch(() => null)) as Partial<Omit<Ready, "state">> | null;
    if (!res?.ok || !data || !Array.isArray(data.reviews)) setLoad({ state: "error" });
    else {
      setLoad({
        state: "ready", summary: data.summary ?? null, reviews: data.reviews, runs: data.runs ?? [],
        scheduled: data.scheduled === true, truncated: data.truncated === true,
      });
    }
  }, [base]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const syncNow = async () => {
    setSyncing(true);
    setResult(null);
    const res = await fetch(`${base}/sync`, { method: "POST" }).catch(() => null);
    const data = (await res?.json().catch(() => null)) as { run?: RunView; error?: string } | null;
    setResult(data?.run ? describeRun(data.run) : (data?.error ?? "Sync could not be started. Please try again."));
    setSyncing(false);
    await refresh();
  };

  if (load.state === "loading") {
    return (
      <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground" data-testid="gbp-reviews-loading">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading reviews…
      </p>
    );
  }
  if (load.state === "error") {
    return <p className="mt-6 text-sm text-muted-foreground" data-testid="gbp-reviews-load-error">Reviews could not be loaded.</p>;
  }

  const s = load.summary;
  const health: GbpHealth = reconnect ? "reconnect_required" : (s?.health ?? "never_synced");
  return (
    <div className="mt-6 space-y-4">
      <section className="rounded-2xl border bg-card p-5" data-testid="gbp-summary">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1 text-2xl font-semibold">
              <Star className="h-5 w-5 fill-amber-400 text-amber-400" />
              {s?.averageRating ?? "—"}
            </span>
            <span className="text-sm text-muted-foreground">
              {s?.totalReviewCount != null ? `${s.totalReviewCount} reviews` : "No review count yet"}
            </span>
            <HealthBadge health={health} />
          </div>
          {canSync && !reconnect && (
            <Button type="button" size="sm" variant="outline" onClick={syncNow} disabled={syncing} data-testid="gbp-sync-now">
              {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Sync now
            </Button>
          )}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {s?.lastSuccessfulSyncAt
            ? `Last synced ${relativeTime(s.lastSuccessfulSyncAt)} (${absoluteTime(s.lastSuccessfulSyncAt)})`
            : "Not synced yet"}{" "}
          ·{" "}
          {load.scheduled
            ? "Syncs automatically every 6 hours"
            : "Automatic sync is not scheduled on this deployment — use Sync now"}
        </p>
        {result && <p className="mt-2 text-sm" data-testid="gbp-sync-result" role="status">{result}</p>}
      </section>

      <HealthBanner
        health={health}
        lastErrorKind={s?.lastErrorKind ?? null}
        lastReconciliation={s?.lastReconciliation ?? null}
        lastSuccessfulSyncAt={s?.lastSuccessfulSyncAt ?? null}
      />

      {load.truncated && (
        <p className="text-xs text-muted-foreground" data-testid="gbp-reviews-truncated">
          Showing the newest reviews only — this list reads at most 500 stored records.
        </p>
      )}

      {load.reviews.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground" data-testid="gbp-reviews-empty">
          No reviews to show yet.
        </p>
      ) : (
        <ul className="space-y-3" data-testid="gbp-reviews">
          {load.reviews.map((r) => <ReviewItem key={r.reviewId} review={r} />)}
        </ul>
      )}

      <RecentSyncs runs={load.runs} />
    </div>
  );
}
