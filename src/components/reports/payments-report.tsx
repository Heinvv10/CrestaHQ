"use client";

import { useMemo, useState } from "react";
import {
  CreditCard,
  PackagePlus,
  Receipt,
  TrendingUp,
} from "lucide-react";

import { BarChart, DonutChart } from "@/components/reports/charts";
import { formatCurrency, toDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Order, OrderSource, OrderStatus } from "@/types/orders";

/**
 * Payments tab of the Reports page (Payments v1, Phase B).
 *
 * Two jobs in one surface, because this is the ONLY place order data appears:
 *  - operational — "did this person pay, and what did they buy?"
 *  - analytical  — revenue, mix by source, and bump take rate
 *
 * Money rules applied consistently here:
 *  - revenue is NET of refunds (`totalCents - refundedCents`). A refunded
 *    order must never inflate a revenue figure.
 *  - only `paid` / `partially_refunded` orders count as revenue. `pending`
 *    means someone opened Stripe and may never have paid.
 *  - test-mode orders (`livemode: false`) are EXCLUDED by default. Setup
 *    payments with 4242 would otherwise permanently skew every number.
 */

const SOURCE_LABELS: Record<OrderSource, string> = {
  checkout_page: "Checkout page",
  quote: "Invoice",
  booking_deposit: "Booking deposit",
  community: "Community",
};

const SOURCE_COLORS: Record<OrderSource, string> = {
  checkout_page: "#6366f1",
  quote: "#10b981",
  booking_deposit: "#f59e0b",
  community: "#a855f7",
};

const STATUS_STYLES: Record<OrderStatus, string> = {
  paid: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  pending: "bg-muted text-muted-foreground",
  refunded: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
  partially_refunded: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  failed: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
};

/** Revenue actually retained: paid minus anything refunded back. */
function netCents(o: Order): number {
  return Math.max(0, (o.totalCents ?? 0) - (o.refundedCents ?? 0));
}

function countsAsRevenue(o: Order): boolean {
  return o.status === "paid" || o.status === "partially_refunded";
}

export function PaymentsReport({
  orders,
  rangeCutoff,
  currency,
}: {
  orders: Order[];
  /** Epoch ms; 0 = all time. Matches the Overview tab's range control,
   *  which passes a timestamp rather than a Date. */
  rangeCutoff: number;
  currency: string;
}) {
  const [includeTest, setIncludeTest] = useState(false);

  const hasAnyTest = useMemo(
    () => orders.some((o) => o.livemode === false),
    [orders],
  );

  const inRange = useMemo(() => {
    return orders
      .filter((o) => (includeTest ? true : o.livemode !== false))
      .filter((o) => {
        if (!rangeCutoff) return true;
        const created = toDate(o.createdAt);
        return created ? created.getTime() >= rangeCutoff : false;
      })
      .sort((a, b) => {
        const av = toDate(a.createdAt)?.getTime() ?? 0;
        const bv = toDate(b.createdAt)?.getTime() ?? 0;
        return bv - av;
      });
  }, [orders, rangeCutoff, includeTest]);

  const revenueOrders = useMemo(
    () => inRange.filter(countsAsRevenue),
    [inRange],
  );

  const netRevenueCents = useMemo(
    () => revenueOrders.reduce((s, o) => s + netCents(o), 0),
    [revenueOrders],
  );

  const refundedCents = useMemo(
    () => inRange.reduce((s, o) => s + (o.refundedCents ?? 0), 0),
    [inRange],
  );

  const avgOrderCents = revenueOrders.length
    ? Math.round(netRevenueCents / revenueOrders.length)
    : 0;

  // Bump take rate — the metric that justifies order bumps existing, and the
  // one thing no other surface in the app can show. Denominator is orders
  // that COULD have had a bump (checkout pages only); invoices, deposits and
  // community purchases have no bump slot, so including them would understate
  // the rate for no reason.
  const bumpEligible = useMemo(
    () => revenueOrders.filter((o) => o.source === "checkout_page"),
    [revenueOrders],
  );
  const withBump = useMemo(
    () => bumpEligible.filter((o) => o.lineItems.some((li) => li.isBump)),
    [bumpEligible],
  );
  const bumpRate = bumpEligible.length
    ? Math.round((withBump.length / bumpEligible.length) * 100)
    : 0;
  const bumpRevenueCents = useMemo(
    () =>
      revenueOrders.reduce(
        (s, o) =>
          s +
          o.lineItems
            .filter((li) => li.isBump)
            .reduce((t, li) => t + li.unitPriceCents * li.quantity, 0),
        0,
      ),
    [revenueOrders],
  );

  const bySource = useMemo(() => {
    const map = new Map<OrderSource, number>();
    for (const o of revenueOrders) {
      map.set(o.source, (map.get(o.source) ?? 0) + netCents(o));
    }
    return [...map.entries()]
      .map(([source, cents]) => ({
        label: SOURCE_LABELS[source] ?? source,
        value: cents / 100,
        color: SOURCE_COLORS[source] ?? "#71717a",
      }))
      .sort((a, b) => b.value - a.value);
  }, [revenueOrders]);

  // Per-bump performance: how often each bump is taken, and what it earned.
  const bumpBreakdown = useMemo(() => {
    const map = new Map<string, { name: string; count: number; cents: number }>();
    for (const o of revenueOrders) {
      for (const li of o.lineItems) {
        if (!li.isBump) continue;
        const key = li.productId ?? li.name;
        const cur = map.get(key) ?? { name: li.name, count: 0, cents: 0 };
        cur.count += 1;
        cur.cents += li.unitPriceCents * li.quantity;
        map.set(key, cur);
      }
    }
    return [...map.values()].sort((a, b) => b.cents - a.cents);
  }, [revenueOrders]);

  if (orders.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed p-10 text-center">
        <CreditCard className="mx-auto h-5 w-5 text-muted-foreground" />
        <p className="mt-3 text-sm font-medium">No payments yet</p>
        <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
          Orders appear here once a customer pays by card — through a checkout
          page, an invoice, a booking deposit, or a community purchase.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {hasAnyTest && (
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={includeTest}
            onChange={(e) => setIncludeTest(e.target.checked)}
          />
          Include test-mode orders
          <span className="text-[11px]">
            (excluded by default so setup payments don&apos;t skew revenue)
          </span>
        </label>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi
          icon={<CreditCard className="h-4 w-4" />}
          label="Paid revenue"
          value={formatCurrency(netRevenueCents / 100, currency)}
          hint={
            refundedCents > 0
              ? `Net of ${formatCurrency(refundedCents / 100, currency)} refunded`
              : "Net of refunds"
          }
          tone="text-emerald-600 dark:text-emerald-400"
          bg="bg-emerald-500/10"
        />
        <Kpi
          icon={<Receipt className="h-4 w-4" />}
          label="Orders"
          value={String(revenueOrders.length)}
          hint={`${inRange.length - revenueOrders.length} unpaid or failed`}
          tone="text-indigo-600 dark:text-indigo-400"
          bg="bg-indigo-500/10"
        />
        <Kpi
          icon={<TrendingUp className="h-4 w-4" />}
          label="Avg order value"
          value={formatCurrency(avgOrderCents / 100, currency)}
          hint={
            revenueOrders.length === 0
              ? "No paid orders yet"
              : `Across ${revenueOrders.length} order${revenueOrders.length === 1 ? "" : "s"}`
          }
          tone="text-violet-600 dark:text-violet-400"
          bg="bg-violet-500/10"
        />
        <Kpi
          icon={<PackagePlus className="h-4 w-4" />}
          label="Bump take rate"
          value={bumpEligible.length ? `${bumpRate}%` : "—"}
          hint={
            bumpEligible.length
              ? `${withBump.length}/${bumpEligible.length} checkouts · ${formatCurrency(
                  bumpRevenueCents / 100,
                  currency,
                )} extra`
              : "No checkout-page orders yet"
          }
          tone="text-amber-600 dark:text-amber-400"
          bg="bg-amber-500/10"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section className="rounded-2xl border bg-card p-5">
          <h2 className="mb-4 text-sm font-semibold">Revenue by source</h2>
          {bySource.length === 0 ? (
            <EmptyPanel text="No paid orders in this range." />
          ) : (
            <div className="flex flex-wrap items-center gap-6">
              <DonutChart data={bySource} />
              <ul className="min-w-0 flex-1 space-y-2">
                {bySource.map((s) => (
                  <li
                    key={s.label}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: s.color }}
                      />
                      <span className="truncate">{s.label}</span>
                    </span>
                    <span className="font-medium">
                      {formatCurrency(s.value, currency)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section className="rounded-2xl border bg-card p-5">
          <h2 className="mb-1 text-sm font-semibold">Order bump performance</h2>
          <p className="mb-4 text-xs text-muted-foreground">
            How often each add-on is taken at checkout, and what it earned.
          </p>
          {bumpBreakdown.length === 0 ? (
            <EmptyPanel text="No bumps taken yet." />
          ) : (
            <>
              <BarChart
                data={bumpBreakdown.map((b) => ({
                  x: b.name,
                  y: b.cents / 100,
                }))}
                tone="amber"
              />
              <ul className="mt-4 space-y-2">
                {bumpBreakdown.map((b) => (
                  <li
                    key={b.name}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <span className="truncate">{b.name}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {b.count}× ·{" "}
                      <span className="font-medium text-foreground">
                        {formatCurrency(b.cents / 100, currency)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>

      <section className="rounded-2xl border bg-card p-5">
        <h2 className="mb-4 text-sm font-semibold">Recent orders</h2>
        {inRange.length === 0 ? (
          <EmptyPanel text="No orders in this range." />
        ) : (
          <div className="-mx-5 overflow-x-auto px-5">
            <table className="w-full min-w-[620px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="pb-2 font-medium">Date</th>
                  <th className="pb-2 font-medium">Buyer</th>
                  <th className="pb-2 font-medium">Source</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {inRange.slice(0, 50).map((o) => {
                  const created = toDate(o.createdAt);
                  const bumps = o.lineItems.filter((li) => li.isBump).length;
                  return (
                    <tr key={o.id} className="border-b last:border-0">
                      <td className="py-2.5 pr-3 whitespace-nowrap text-muted-foreground">
                        {created
                          ? created.toLocaleDateString("en-GB", {
                              day: "numeric",
                              month: "short",
                            })
                          : "—"}
                      </td>
                      <td className="py-2.5 pr-3">
                        <span className="block truncate">
                          {o.buyerName || o.buyerEmail || "—"}
                        </span>
                        {bumps > 0 && (
                          <span className="text-[11px] text-amber-700 dark:text-amber-400">
                            +{bumps} bump{bumps === 1 ? "" : "s"}
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 whitespace-nowrap text-muted-foreground">
                        {SOURCE_LABELS[o.source] ?? o.source}
                      </td>
                      <td className="py-2.5 pr-3">
                        <span
                          className={cn(
                            "inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                            STATUS_STYLES[o.status],
                          )}
                        >
                          {o.status.replace("_", " ")}
                        </span>
                        {o.livemode === false && (
                          <span className="ml-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                            test
                          </span>
                        )}
                        {o.attention && (
                          <span
                            className={cn(
                              "mt-1 block max-w-xs text-[11px]",
                              o.attentionOpen === false
                                ? "text-muted-foreground"
                                : "text-amber-700 dark:text-amber-400",
                            )}
                          >
                            {o.attentionOpen === false && "Resolved — "}
                            {o.attention}
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 text-right whitespace-nowrap font-medium">
                        {formatCurrency(
                          (o.totalCents ?? 0) / 100,
                          (o.currency || currency).toUpperCase(),
                        )}
                        {(o.refundedCents ?? 0) > 0 && (
                          <span className="block text-[11px] font-normal text-rose-600 dark:text-rose-400">
                            −
                            {formatCurrency(
                              (o.refundedCents ?? 0) / 100,
                              (o.currency || currency).toUpperCase(),
                            )}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {inRange.length > 50 && (
              <p className="mt-3 text-xs text-muted-foreground">
                Showing the 50 most recent of {inRange.length} orders in range.
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function EmptyPanel({ text }: { text: string }) {
  return (
    <p className="py-8 text-center text-xs text-muted-foreground">{text}</p>
  );
}

function Kpi({
  icon,
  label,
  value,
  hint,
  tone,
  bg,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint: string;
  tone: string;
  bg: string;
}) {
  return (
    <div className="rounded-2xl border bg-card p-5">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-lg",
            bg,
            tone,
          )}
        >
          {icon}
        </span>
        <span className="text-xs font-medium text-muted-foreground">
          {label}
        </span>
      </div>
      <p className="mt-3 text-2xl font-bold tracking-tight">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
