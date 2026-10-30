"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * Tabbed breakdown of landing-funnel clicks for the agency A/B/C page.
 *
 *   - Variants   → the existing hero-copy A/B/C table (winner-highlighted)
 *   - Sources    → where clicks ORIGINATE by channel (YouTube, Google, Direct…)
 *   - Locations  → where clicks originate geographically (country → cities)
 *
 * Sources + Locations are fed from the durable `landingSources` /
 * `landingGeo` rollups (server-aggregated). Every row shows the full
 * funnel — views, clicks, CTR, purchases — so the operator sees not just
 * volume but which channels/regions actually convert.
 *
 * Pure presentation: all counting happens server-side; this component
 * only formats + sorts what it's handed.
 */

export interface VariantRowData {
  id: string;
  label: string;
  pageViews: number;
  ctaClicks: number;
  purchases: number;
  conversionPct: number | null;
  buyRatePct: number | null;
}

export interface ReconcileRowData {
  label: string;
  hint: string;
  value: number;
}

export interface FunnelRowData {
  /** Stable key. */
  key: string;
  /** Display label (source label, or country name). */
  label: string;
  views: number;
  clicks: number;
  purchases: number;
}

export interface LocationRowData extends FunnelRowData {
  countryCode: string;
  cities: FunnelRowData[];
}

export interface LandingClickTabsProps {
  variants: VariantRowData[];
  winnerId: string | null;
  reconcileRows: ReconcileRowData[];
  totalPurchases: number;
  sources: FunnelRowData[];
  locations: LocationRowData[];
}

function pct(numerator: number, denominator: number, digits = 1): string {
  if (denominator <= 0) return "—";
  return `${+((numerator / denominator) * 100).toFixed(digits)}%`;
}

export function LandingClickTabs({
  variants,
  winnerId,
  reconcileRows,
  totalPurchases,
  sources,
  locations,
}: LandingClickTabsProps) {
  return (
    <Tabs defaultValue="variants" className="w-full">
      <TabsList>
        <TabsTrigger value="variants">Variants</TabsTrigger>
        <TabsTrigger value="sources">Sources</TabsTrigger>
        <TabsTrigger value="locations">Locations</TabsTrigger>
      </TabsList>

      <TabsContent value="variants">
        <VariantsTable
          variants={variants}
          winnerId={winnerId}
          reconcileRows={reconcileRows}
          totalPurchases={totalPurchases}
        />
      </TabsContent>

      <TabsContent value="sources">
        <SourcesTable sources={sources} />
      </TabsContent>

      <TabsContent value="locations">
        <LocationsTable locations={locations} />
      </TabsContent>
    </Tabs>
  );
}

function VariantsTable({
  variants,
  winnerId,
  reconcileRows,
  totalPurchases,
}: {
  variants: VariantRowData[];
  winnerId: string | null;
  reconcileRows: ReconcileRowData[];
  totalPurchases: number;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full text-sm">
        <thead className="border-b bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-4 py-3 font-medium">Variant</th>
            <th className="px-4 py-3 font-medium">Hypothesis</th>
            <th className="px-4 py-3 text-right font-medium">Views</th>
            <th className="px-4 py-3 text-right font-medium">Clicks</th>
            <th className="px-4 py-3 text-right font-medium">CTR</th>
            <th className="px-4 py-3 text-right font-medium">Purchases</th>
            <th className="px-4 py-3 text-right font-medium">Buy-rate</th>
          </tr>
        </thead>
        <tbody>
          {variants.map((row) => {
            const isWinner = winnerId === row.id;
            return (
              <tr
                key={row.id}
                className={`border-t ${isWinner ? "bg-emerald-500/5" : ""}`}
              >
                <td className="px-4 py-3">
                  <span className="inline-flex items-center gap-2">
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                      {row.id}
                    </code>
                    {isWinner && (
                      <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
                        Leading
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{row.label}</td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {row.pageViews.toLocaleString()}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {row.ctaClicks.toLocaleString()}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                  {row.conversionPct !== null ? `${row.conversionPct}%` : "—"}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {row.purchases.toLocaleString()}
                </td>
                <td className="px-4 py-3 text-right font-medium tabular-nums">
                  {row.buyRatePct !== null ? `${row.buyRatePct}%` : "—"}
                </td>
              </tr>
            );
          })}

          {reconcileRows.map((r) => (
            <tr key={r.label} className="border-t text-muted-foreground">
              <td className="px-4 py-3">
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide">
                  {r.label}
                </span>
              </td>
              <td className="px-4 py-3">{r.hint}</td>
              <td className="px-4 py-3 text-right">—</td>
              <td className="px-4 py-3 text-right">—</td>
              <td className="px-4 py-3 text-right">—</td>
              <td className="px-4 py-3 text-right tabular-nums text-foreground">
                {r.value.toLocaleString()}
              </td>
              <td className="px-4 py-3 text-right">—</td>
            </tr>
          ))}

          <tr className="border-t-2 bg-muted/40 font-semibold">
            <td className="px-4 py-3">Total</td>
            <td className="px-4 py-3 font-normal text-muted-foreground">
              All completed checkout sessions
            </td>
            <td className="px-4 py-3 text-right text-muted-foreground">—</td>
            <td className="px-4 py-3 text-right text-muted-foreground">—</td>
            <td className="px-4 py-3 text-right text-muted-foreground">—</td>
            <td className="px-4 py-3 text-right tabular-nums">
              {totalPurchases.toLocaleString()}
            </td>
            <td className="px-4 py-3 text-right text-muted-foreground">—</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function FunnelHeader({ first }: { first: string }) {
  return (
    <thead className="border-b bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
      <tr>
        <th className="px-4 py-3 font-medium">{first}</th>
        <th className="px-4 py-3 text-right font-medium">Views</th>
        <th className="px-4 py-3 text-right font-medium">Clicks</th>
        <th className="px-4 py-3 text-right font-medium">CTR</th>
        <th className="px-4 py-3 text-right font-medium">Purchases</th>
      </tr>
    </thead>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-dashed bg-background p-8 text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

function SourcesTable({ sources }: { sources: FunnelRowData[] }) {
  if (sources.length === 0) {
    return (
      <EmptyState message="No click sources recorded yet. Data starts collecting from now on — share a link with a UTM tag or from a social post to see it populate." />
    );
  }
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full text-sm">
        <FunnelHeader first="Source" />
        <tbody>
          {sources.map((row) => (
            <tr key={row.key} className="border-t">
              <td className="px-4 py-3 font-medium">{row.label}</td>
              <td className="px-4 py-3 text-right tabular-nums">
                {row.views.toLocaleString()}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {row.clicks.toLocaleString()}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                {pct(row.clicks, row.views)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {row.purchases.toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LocationsTable({ locations }: { locations: LocationRowData[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (locations.length === 0) {
    return (
      <EmptyState message="No locations recorded yet. As visitors land on the page their country (and city, when resolvable) starts aggregating here." />
    );
  }

  function toggle(code: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full text-sm">
        <FunnelHeader first="Location" />
        <tbody>
          {locations.map((row) => {
            const isOpen = expanded.has(row.countryCode);
            const hasCities = row.cities.length > 0;
            return (
              <FragmentRow
                key={row.countryCode}
                row={row}
                isOpen={isOpen}
                hasCities={hasCities}
                onToggle={() => toggle(row.countryCode)}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FragmentRow({
  row,
  isOpen,
  hasCities,
  onToggle,
}: {
  row: LocationRowData;
  isOpen: boolean;
  hasCities: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className={`border-t ${hasCities ? "cursor-pointer hover:bg-muted/30" : ""}`}
        onClick={hasCities ? onToggle : undefined}
      >
        <td className="px-4 py-3 font-medium">
          <span className="inline-flex items-center gap-1.5">
            {hasCities ? (
              <ChevronRight
                className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${isOpen ? "rotate-90" : ""}`}
              />
            ) : (
              <span className="inline-block w-3.5" />
            )}
            {row.label}
          </span>
        </td>
        <td className="px-4 py-3 text-right tabular-nums">
          {row.views.toLocaleString()}
        </td>
        <td className="px-4 py-3 text-right tabular-nums">
          {row.clicks.toLocaleString()}
        </td>
        <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
          {pct(row.clicks, row.views)}
        </td>
        <td className="px-4 py-3 text-right tabular-nums">
          {row.purchases.toLocaleString()}
        </td>
      </tr>
      {isOpen &&
        row.cities.map((city) => (
          <tr key={`${row.countryCode}:${city.key}`} className="border-t bg-muted/10">
            <td className="py-2 pl-11 pr-4 text-muted-foreground">
              {city.label}
            </td>
            <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
              {city.views.toLocaleString()}
            </td>
            <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
              {city.clicks.toLocaleString()}
            </td>
            <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
              {pct(city.clicks, city.views)}
            </td>
            <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
              {city.purchases.toLocaleString()}
            </td>
          </tr>
        ))}
    </>
  );
}
