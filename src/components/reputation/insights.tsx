"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Lock } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { ACCESS_NOT_APPROVED_TEXT } from "@/lib/gbp/error-text";
import { INSIGHTS_RANGES, type InsightsRange } from "@/lib/reputation/insights";
import { InsightsCharts, InsightsTiles, RANGE_TEXT, fmtDay, type InsightsData } from "./insights-parts";

/**
 * Reputation → Insights (SP5 G2/G3): Business Profile Performance numbers
 * from GET …/reputation/insights, fetched on demand (nothing stored). Admins
 * may pick any location the connection can see (GET …/google/locations,
 * admin-only); members see the selected listing. Picking a location never
 * changes the review listing — this page writes nothing.
 */

type Load = { state: "loading" } | { state: "failed"; code: string } | { state: "ready"; data: InsightsData };
type Option = { name: string; title: string };

const ERROR_TEXT: Record<string, string> = {
  transient: "Google is temporarily unavailable. Try again shortly.",
  rate_limited: "Google is rate-limiting requests. Try again in a minute.",
  reconnect_required: "Reconnect Google Business Profile to see insights.",
  not_connected: "Google Business Profile is not connected.",
  no_listing: "No listing is selected.",
  gate_off: "This feature is locked by your agency.",
  permission_denied: "This Google account doesn't have permission to see this listing's performance.",
  unknown_location: "That listing isn't available to this Google connection.",
  unverifiable_truncated: "This Google account has too many listings to verify that one.",
};

function Note({ testId, children }: { testId: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground" data-testid={testId}>
      {children}
    </div>
  );
}

const field = "h-9 rounded-md border bg-background px-2 text-sm";

export function ReputationInsights() {
  const { subAccountId, subAccount, isAdmin } = useSubAccount();
  const listing = subAccount?.googleListing ?? null;
  const ready = subAccount?.googleEnabledByAgency === true && !!subAccount.googleConnectionMeta?.connected && !!listing;
  const [range, setRange] = useState<InsightsRange>("28d");
  const [location, setLocation] = useState<string | null>(null);
  const [options, setOptions] = useState<Option[]>([]);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const target = location ?? listing?.locationName ?? "";

  useEffect(() => {
    if (!ready || !isAdmin) return;
    const controller = new AbortController();
    void (async () => {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/google/locations`, { signal: controller.signal }).catch(() => null);
      const data = (await res?.json().catch(() => null)) as { accounts?: Array<{ locations: Option[] }> } | null;
      if (controller.signal.aborted || !res?.ok || !data?.accounts) return;
      setOptions(data.accounts.flatMap((a) => a.locations.map((l) => ({ name: l.name, title: l.title }))));
    })();
    return () => controller.abort();
  }, [ready, isAdmin, subAccountId]);

  useEffect(() => {
    if (!ready || !target) return;
    const controller = new AbortController();
    setLoad({ state: "loading" });
    void (async () => {
      const qs = new URLSearchParams({ range, location: target });
      const res = await fetch(`/api/sub-accounts/${subAccountId}/reputation/insights?${qs}`, { signal: controller.signal }).catch(() => null);
      const data = (await res?.json().catch(() => null)) as (InsightsData & { code?: string }) | null;
      if (controller.signal.aborted) return;
      setLoad(res?.ok && data?.groups ? { state: "ready", data } : { state: "failed", code: data?.code ?? "network" });
    })();
    return () => controller.abort();
  }, [ready, subAccountId, range, target]);

  const setup = (
    <Link href={`/sa/${subAccountId}/ai-agents/google-business`} className="font-medium text-foreground underline-offset-2 hover:underline">
      AI Agents → Google Business
    </Link>
  );
  if (subAccount?.googleEnabledByAgency !== true) {
    return (
      <Note testId="rep-insights-gate-off">
        <span className="flex items-center gap-2"><Lock className="h-4 w-4" /> Google Business Profile is not enabled for this sub-account.</span>
      </Note>
    );
  }
  if (!subAccount.googleConnectionMeta?.connected) {
    return <Note testId="rep-insights-not-connected">Google Business Profile is not connected. Connect it in {setup} to see insights.</Note>;
  }
  if (!listing) return <Note testId="rep-insights-no-listing">No listing is selected. Choose one in {setup} to see insights.</Note>;

  const choices = options.some((o) => o.name === listing.locationName) ? options : [{ name: listing.locationName, title: listing.title }, ...options];
  const data = load.state === "ready" ? load.data : null;
  const empty = data && data.lastDataDate === null && Object.values(data.groups).every((g) => g.current === 0 && g.previous === 0);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        {isAdmin ? (
          <select aria-label="Location" className={field} value={target} onChange={(e) => setLocation(e.target.value)} data-testid="rep-insights-location">
            {choices.map((o) => <option key={o.name} value={o.name}>{o.title}</option>)}
          </select>
        ) : (
          <p className="text-sm font-medium" data-testid="rep-insights-location">{listing.title}</p>
        )}
        <select aria-label="Range" className={field} value={range} onChange={(e) => setRange(e.target.value as InsightsRange)} data-testid="rep-insights-range">
          {INSIGHTS_RANGES.map((r) => <option key={r} value={r}>{RANGE_TEXT[r]}</option>)}
        </select>
      </div>
      {data && !data.location.isListing && (
        <p className="text-xs text-muted-foreground" data-testid="rep-insights-other-location">
          Viewing {data.location.title}. Your reviews stay on {listing.title} — nothing here changes the listing.
        </p>
      )}
      {load.state === "loading" && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="rep-insights-loading">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading insights from Google…
        </p>
      )}
      {load.state === "failed" && load.code === "access_not_approved" && <Note testId="rep-insights-not-approved">{ACCESS_NOT_APPROVED_TEXT}</Note>}
      {load.state === "failed" && load.code !== "access_not_approved" && (
        <Note testId="rep-insights-error">{ERROR_TEXT[load.code] ?? "Insights could not be loaded. Try again shortly."}</Note>
      )}
      {empty && <Note testId="rep-insights-empty">Google has no performance data for this location in this range.</Note>}
      {data && !empty && (
        <>
          <InsightsTiles data={data} />
          <InsightsCharts data={data} />
          <p className="text-xs text-muted-foreground" data-testid="rep-insights-data-through">
            {fmtDay(data.window.current.start)} – {fmtDay(data.window.current.end)}.{" "}
            {data.lastDataDate ? `Google's data runs to ${fmtDay(data.lastDataDate)}` : "Google has reported nothing yet"} — it reports with a delay
            of a few days, so the latest days can read low. Views are unique people per day. Fetched from Google on demand; not stored.
          </p>
        </>
      )}
    </div>
  );
}
