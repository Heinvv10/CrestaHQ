"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Lock } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { HealthBadge, HealthBanner } from "@/components/gbp/sync-health";
import { RANGE_PRESETS, type RangePreset } from "@/lib/reputation/overview";
import { Checklist, RequestsCard, ResponseCard } from "./overview-cards";
import { SentimentCard } from "./overview-sentiment";
import { Distribution, Tiles, Trend } from "./overview-tiles";
import { RANGE_LABEL } from "./format";
import { SendReviewRequestButton } from "./send-review-request";
import type { OverviewResponse } from "./types";

/**
 * Reputation → Overview (SP5 a). Reads GET …/reputation/overview for the
 * chosen range. Review metrics appear only when the API has them; the
 * request half always shows. Freshness reuses the reviews inbox's health
 * badge and banner, so both pages say the same thing about stale data.
 */

type Load = { state: "loading" } | { state: "error" } | { state: "ready"; data: OverviewResponse };

function Note({ testId, children }: { testId: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground" data-testid={testId}>
      {children}
    </div>
  );
}

function ReviewState({ data, subAccountId, isAdmin }: { data: OverviewResponse; subAccountId: string; isAdmin: boolean }) {
  const setup = (
    <Link href={`/sa/${subAccountId}/ai-agents/google-business`} className="font-medium text-foreground underline-offset-2 hover:underline">
      AI Agents → Google Business
    </Link>
  );
  switch (data.reviewsUnavailable) {
    case "gate_off":
      return (
        <Note testId="rep-state-gate-off">
          <span className="flex items-center gap-2"><Lock className="h-4 w-4" /> Google reviews are not enabled for this sub-account.</span>
        </Note>
      );
    case "not_connected":
      return <Note testId="rep-state-not-connected">Google Business Profile is not connected. Connect it in {setup} to see review metrics.</Note>;
    case "no_listing":
      return <Note testId="rep-state-no-listing">No listing is selected. Choose one in {setup} to see review metrics.</Note>;
  }
  if (data.health === "never_synced") {
    return (
      <Note testId="rep-state-never-synced">
        Reviews have not been synced yet. {isAdmin ? "Run Sync now" : "A sub-account admin can run Sync now"} on the Reviews tab.
      </Note>
    );
  }
  if (!data.health || data.health === "ok") return null;
  return (
    <div data-testid="rep-state-health" data-health={data.health}>
      <HealthBanner
        health={data.health}
        lastErrorKind={data.lastErrorKind}
        lastReconciliation={data.lastReconciliation}
        lastSuccessfulSyncAt={data.lastSuccessfulSyncAt}
      />
    </div>
  );
}

export function ReputationOverview() {
  const { subAccountId, isAdmin } = useSubAccount();
  const [range, setRange] = useState<RangePreset>("90d");
  const [load, setLoad] = useState<Load>({ state: "loading" });
  /** Bumped after "Analyse now" so the counts refresh in place. */
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/reputation/overview?range=${range}`, { signal: controller.signal }).catch(() => null);
      const data = (await res?.json().catch(() => null)) as OverviewResponse | null;
      if (controller.signal.aborted) return;
      // A failed RE-read (Analyse now polling) keeps what is on screen, so the card
      // is not unmounted mid-poll; a first load or a range change shows the error.
      setLoad((prev) => (res?.ok && data?.requests ? { state: "ready", data } : prev.state === "ready" ? prev : { state: "error" }));
    })();
    return () => controller.abort();
  }, [subAccountId, range, reload]);

  const picker = (
    <select
      value={range}
      onChange={(e) => {
        setLoad({ state: "loading" });
        setRange(e.target.value as RangePreset);
      }}
      className="rounded-md border bg-background px-2 py-1 text-sm"
      data-testid="rep-range"
      aria-label="Date range"
    >
      {RANGE_PRESETS.map((p) => <option key={p} value={p}>{RANGE_LABEL[p]}</option>)}
    </select>
  );

  return (
    <div className="space-y-4" data-testid="rep-overview">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Reputation overview</h1>
        <div className="flex items-center gap-2">
          {picker}
          <SendReviewRequestButton onSent={() => setReload((n) => n + 1)} />
        </div>
      </div>
      {load.state === "loading" && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="rep-state-loading">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      )}
      {load.state === "error" && <Note testId="rep-state-error">The overview could not be loaded. Please try again.</Note>}
      {load.state === "ready" && (
        <Ready data={load.data} subAccountId={subAccountId} isAdmin={isAdmin} onAnalysed={refresh} />
      )}
    </div>
  );
}

function Ready({
  data,
  subAccountId,
  isAdmin,
  onAnalysed,
}: {
  data: OverviewResponse;
  subAccountId: string;
  isAdmin: boolean;
  onAnalysed: () => void;
}) {
  const r = data.reviews;
  const empty = (r ? r.count === 0 : true) && data.requests.sent === 0;
  return (
    <>
      <ReviewState data={data} subAccountId={subAccountId} isAdmin={isAdmin} />
      {r && data.health && (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="rep-listing">
          <HealthBadge health={data.health} />
          {data.listing?.averageRating != null && data.listing.totalReviewCount != null
            ? `Google shows ${data.listing.averageRating} from ${data.listing.totalReviewCount} reviews for this listing.`
            : "Google's listing rating is not available yet."}
          {data.truncated.reviews && " Figures cover the newest 500 stored reviews only."}
        </p>
      )}
      {empty && <Note testId="rep-state-empty">No reviews or review requests in this range.</Note>}
      <Tiles data={data} />
      {r && <Trend data={data} />}
      {r && (
        <div className="grid gap-4 md:grid-cols-2">
          <Distribution reviews={r} />
          <SentimentCard
            subAccountId={subAccountId}
            isAdmin={isAdmin}
            reviewsAi={data.reviewsAi}
            sentiment={r.sentiment}
            onAnalysed={onAnalysed}
          />
        </div>
      )}
      {r && <ResponseCard data={data} />}
      <RequestsCard data={data} />
      {data.truncated.requests && (
        <p className="text-xs text-muted-foreground" data-testid="rep-requests-truncated">Request figures cover the newest 2,000 requests in this range only.</p>
      )}
      <Checklist data={data} subAccountId={subAccountId} />
    </>
  );
}
