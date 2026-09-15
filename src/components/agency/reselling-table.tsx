"use client";

import { Check, Minus } from "lucide-react";
import { formatBillingPrice } from "@/lib/billing/status";
import {
  archivedPlanCount,
  buildResellingRows,
  formatQuotasSummary,
  planGateMatrixRow,
  planIncludedGateLabels,
  resellingTotalsByCurrency,
  unknownPlanSubscribers,
} from "@/lib/billing/reselling";
import { PLAN_GATE_KEYS, PLAN_GATE_LABELS, type BillingPlanResponse } from "@/types/billing";
import type { SubAccountDoc } from "@/types";

/**
 * "Reselling overview" — DISPLAY ONLY (GHL Reselling parity, see
 * SP13_V1_PLAN.md item (e)). No writes: reads the plans + sub-accounts the
 * billing page already loaded.
 *
 * GHL's reseller table has a "Your price / Customer's price / Your profit"
 * column set because GHL agencies buy sub-accounts wholesale. This
 * deployment has no wholesale-cost field on a plan (the agency owns its own
 * Stripe account and sets one price) — see the note in
 * `src/lib/billing/reselling.ts`. So this table shows price + subscribers +
 * MRR instead of a fabricated profit figure, plus a second table comparing
 * plan features side by side.
 */
export function ResellingTable({
  plans,
  subs,
}: {
  plans: BillingPlanResponse[];
  subs: SubAccountDoc[];
}) {
  const rows = buildResellingRows(plans, subs);
  const archived = archivedPlanCount(plans, subs);
  const totals = resellingTotalsByCurrency(rows);
  const unknown = unknownPlanSubscribers(plans, subs);

  return (
    <section className="space-y-3" data-testid="reselling-table">
      <div className="flex items-end justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Reselling overview
        </h2>
        {archived > 0 && (
          <p className="text-xs text-muted-foreground">
            {archived} archived plan{archived === 1 ? "" : "s"} with no
            remaining subscribers not shown.
          </p>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
          No active plans yet — create one above to see it here.
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-2xl border bg-card">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium">Plan</th>
                  <th className="px-4 py-2.5 text-left font-medium">
                    Customer&apos;s price
                  </th>
                  <th className="px-4 py-2.5 text-left font-medium">
                    Included features
                  </th>
                  <th className="px-4 py-2.5 text-left font-medium">Quotas</th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    Sub-accounts on plan
                  </th>
                  <th
                    className="px-4 py-2.5 text-right font-medium"
                    title="Sum of each ACTIVE subscriber's own charge (special price if set, else the plan price), normalized to monthly for annual subscriptions (÷12). Pending and past-due subscribers are excluded."
                  >
                    Monthly recurring
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ plan, counts, mrrCents, archived: isArchived }) => {
                  const labels = planIncludedGateLabels(plan);
                  const quotaSummary = formatQuotasSummary(plan.quotas);
                  return (
                    <tr
                      key={plan.id}
                      className={
                        isArchived
                          ? "border-t align-top opacity-70"
                          : "border-t align-top"
                      }
                      data-testid="reselling-row"
                      data-plan-id={plan.id}
                      data-archived={isArchived}
                    >
                      <td className="px-4 py-3 font-medium">
                        {plan.name}
                        {isArchived && (
                          <span className="ml-1.5 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                            Archived
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 tabular-nums">
                        {formatBillingPrice(plan.priceMonthlyCents, plan.currency)}
                        /mo
                        {plan.priceAnnualCents != null && (
                          <div className="text-xs text-muted-foreground">
                            or{" "}
                            {formatBillingPrice(plan.priceAnnualCents, plan.currency)}
                            /yr
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {labels.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {labels.map((label) => (
                              <span
                                key={label}
                                className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
                              >
                                {label}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {quotaSummary ?? "Unlimited"}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        <span
                          data-testid="reselling-subscribers"
                          data-active={counts.active}
                        >
                          {counts.active} active
                        </span>
                        {(counts.pending > 0 || counts.pastDue > 0) && (
                          <div className="text-xs text-muted-foreground">
                            {counts.pending} pending · {counts.pastDue} past due
                          </div>
                        )}
                      </td>
                      <td
                        className="px-4 py-3 text-right font-medium tabular-nums"
                        data-testid="reselling-mrr"
                      >
                        {formatBillingPrice(mrrCents, plan.currency)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {totals.length > 0 && (
                <tfoot>
                  {totals.map((t) => (
                    <tr
                      key={t.currency}
                      className="border-t bg-muted/20 font-medium"
                      data-testid="reselling-total"
                      data-currency={t.currency}
                    >
                      <td className="px-4 py-2.5" colSpan={4}>
                        Total ({t.currency.toUpperCase()})
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {t.activeCount} active
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {formatBillingPrice(t.mrrCents, t.currency)}
                      </td>
                    </tr>
                  ))}
                </tfoot>
              )}
            </table>
          </div>

          {/* Feature comparison matrix */}
          <div className="overflow-x-auto rounded-2xl border bg-card">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Feature</th>
                  {rows.map(({ plan }) => (
                    <th key={plan.id} className="px-4 py-2 text-center font-medium">
                      {plan.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PLAN_GATE_KEYS.map((key) => (
                  <tr key={key} className="border-t">
                    <td className="px-4 py-2 text-muted-foreground">
                      {PLAN_GATE_LABELS[key]}
                    </td>
                    {rows.map(({ plan }) => {
                      const enabled = planGateMatrixRow(plan)[key];
                      return (
                        <td key={plan.id} className="px-4 py-2 text-center">
                          {enabled ? (
                            <Check className="mx-auto h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                          ) : (
                            <Minus className="mx-auto h-3.5 w-3.5 text-muted-foreground/40" />
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {unknown.total > 0 && (
        <p
          className="text-xs text-muted-foreground"
          data-testid="reselling-unknown-plan"
          data-count={unknown.total}
        >
          {unknown.total} sub-account{unknown.total === 1 ? "" : "s"} on a
          deleted or unknown plan ({unknown.active} active, {unknown.pending}{" "}
          pending, {unknown.pastDue} past due) — not included in the totals
          above.
        </p>
      )}
    </section>
  );
}
