import { AlertTriangle } from "lucide-react";
import type { GbpHealth } from "@/lib/gbp/sync/types";
import { absoluteTime } from "./format-time";

/**
 * Sync health as the summary card shows it — a badge, and for anything but
 * `ok` / `never_synced` a banner that says what it means for the reviews on
 * screen. Health comes from the API (derived at request time), never from a
 * guess here; nothing claims the data is "live": we poll every 6 hours.
 */

const LABEL: Record<GbpHealth, string> = {
  ok: "Up to date",
  stale: "Stale",
  partial: "Partial sync",
  reconnect_required: "Reconnect needed",
  error: "Sync failing",
  never_synced: "Not synced yet",
};

const TONE: Record<GbpHealth, string> = {
  ok: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  stale: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  partial: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  reconnect_required: "bg-red-500/10 text-red-700 dark:text-red-400",
  error: "bg-red-500/10 text-red-700 dark:text-red-400",
  never_synced: "bg-muted text-muted-foreground",
};

export function HealthBadge({ health }: { health: GbpHealth }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONE[health]}`} data-testid={`gbp-health-${health}`}>
      {LABEL[health]}
    </span>
  );
}

function Banner({ testId, children }: { testId: string; children: React.ReactNode }) {
  return (
    <div
      className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm"
      data-testid={testId}
      role="status"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      <p>{children}</p>
    </div>
  );
}

export function HealthBanner({
  health,
  lastErrorKind,
  lastSuccessfulSyncAt,
}: {
  health: GbpHealth;
  lastErrorKind: string | null;
  lastSuccessfulSyncAt: string | null;
}) {
  const since = lastSuccessfulSyncAt ? absoluteTime(lastSuccessfulSyncAt) : null;
  switch (health) {
    case "reconnect_required":
      return (
        <Banner testId="gbp-banner-reconnect">
          Google access was revoked — reconnect to resume syncing.{" "}
          {since ? `Showing cached reviews from ${since}.` : "No reviews have been synced yet."}
        </Banner>
      );
    case "stale":
      return (
        <Banner testId="gbp-banner-stale">
          These reviews may be out of date — {since ? `the last successful sync was ${since}.` : "no sync has succeeded yet."}
        </Banner>
      );
    case "partial":
      return (
        <Banner testId="gbp-banner-partial">
          The last sync didn&apos;t finish, so some reviews may be missing or out of date. The next sync
          carries on from where it stopped.
        </Banner>
      );
    case "error":
      return (
        <Banner testId="gbp-banner-error">
          {lastErrorKind === "retention_expired"
            ? "Sync has been failing for over 30 days, so cached reviews were removed under Google's 30-day storage policy."
            : "Sync is failing and there is no recent successful sync to show."}
        </Banner>
      );
    default:
      return null;
  }
}
