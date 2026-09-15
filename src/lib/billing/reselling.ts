import { effectiveBillingState, monthlyEquivalentCents } from "./status";
import {
  PLAN_GATE_KEYS,
  PLAN_GATE_LABELS,
  type BillingPlanResponse,
  type PlanGateKey,
} from "@/types/billing";
import type { UsageQuotas } from "@/types/usage";
import type { SubAccountDoc } from "@/types";

/**
 * Pure helpers behind the agency "Reselling overview" section
 * (`src/components/agency/reselling-table.tsx`) — DISPLAY ONLY, no writes.
 *
 * Note on scope: GHL's Reselling table shows "Your price / Customer's price
 * / Your profit" because GHL agencies buy sub-accounts wholesale from GHL.
 * This codebase has no such wholesale-cost field on `BillingPlanDoc` — the
 * agency owns its own Stripe account and sets one price, full stop. There is
 * nothing to subtract a profit from, so this table shows price + subscriber
 * counts + MRR instead of a fabricated profit column.
 */

/** Subscriber counts for one plan, bucketed by `EffectiveBillingState`. */
export interface PlanSubscriberCounts {
  active: number;
  pending: number;
  /** past_due, whether still in grace or lapsed. */
  pastDue: number;
}

export function planSubscriberCounts(
  plan: Pick<BillingPlanResponse, "id">,
  subs: SubAccountDoc[],
): PlanSubscriberCounts {
  const counts: PlanSubscriberCounts = { active: 0, pending: 0, pastDue: 0 };
  for (const s of subs) {
    if (s.billing?.planId !== plan.id) continue;
    const state = effectiveBillingState(s.billing);
    if (state === "active") counts.active++;
    else if (state === "pending") counts.pending++;
    else if (state === "grace" || state === "lapsed") counts.pastDue++;
  }
  return counts;
}

/**
 * Monthly recurring revenue for one plan, in integer cents: the sum of each
 * ACTIVE subscriber's own charge (their special price if one is set,
 * otherwise the plan price), normalized to a monthly figure for annual
 * subscriptions (÷12). Pending and past-due subscribers are excluded — they
 * are not currently paying.
 */
export function planMrrCents(
  plan: Pick<BillingPlanResponse, "id">,
  subs: SubAccountDoc[],
): number {
  let total = 0;
  for (const s of subs) {
    if (s.billing?.planId !== plan.id) continue;
    if (effectiveBillingState(s.billing) !== "active") continue;
    total += monthlyEquivalentCents(
      s.billing.priceCents,
      s.billing.billingInterval,
    );
  }
  return total;
}

/** One row of the reselling matrix — everything the table needs per plan. */
export interface ResellingRow {
  plan: BillingPlanResponse;
  counts: PlanSubscriberCounts;
  mrrCents: number;
}

/** Active plans only (archived plans are excluded, see `archivedCount`). */
export function buildResellingRows(
  plans: BillingPlanResponse[],
  subs: SubAccountDoc[],
): ResellingRow[] {
  return plans
    .filter((p) => p.status === "active")
    .map((plan) => ({
      plan,
      counts: planSubscriberCounts(plan, subs),
      mrrCents: planMrrCents(plan, subs),
    }));
}

export function archivedPlanCount(plans: BillingPlanResponse[]): number {
  return plans.filter((p) => p.status === "archived").length;
}

/** One currency's totals row — MRR and active-subscriber count never sum across currencies. */
export interface ResellingCurrencyTotal {
  currency: string;
  mrrCents: number;
  activeCount: number;
}

export function resellingTotalsByCurrency(
  rows: ResellingRow[],
): ResellingCurrencyTotal[] {
  const byCurrency = new Map<string, ResellingCurrencyTotal>();
  for (const row of rows) {
    const currency = row.plan.currency;
    const existing = byCurrency.get(currency) ?? {
      currency,
      mrrCents: 0,
      activeCount: 0,
    };
    existing.mrrCents += row.mrrCents;
    existing.activeCount += row.counts.active;
    byCurrency.set(currency, existing);
  }
  return [...byCurrency.values()];
}

/** Gate labels a plan includes, in `PLAN_GATE_KEYS` order — the chip list. */
export function planIncludedGateLabels(plan: BillingPlanResponse): string[] {
  return PLAN_GATE_KEYS.filter((k) => plan.gates[k]).map(
    (k) => PLAN_GATE_LABELS[k],
  );
}

/** ✓/— per gate for the plan-comparison matrix, keyed by gate. */
export function planGateMatrixRow(
  plan: BillingPlanResponse,
): Record<PlanGateKey, boolean> {
  const row = {} as Record<PlanGateKey, boolean>;
  for (const k of PLAN_GATE_KEYS) row[k] = plan.gates[k];
  return row;
}

const QUOTA_LABELS: Record<keyof UsageQuotas, string> = {
  emailsPerMonth: "emails/mo",
  smsSegmentsPerMonth: "SMS/mo",
  whatsappPerMonth: "WhatsApp/mo",
  aiTokensPerMonth: "AI tokens/mo",
  voiceMinutesPerMonth: "voice min/mo",
};

/** "5,000 emails/mo, 200 SMS/mo"-style summary, or null when unset/unlimited. */
export function formatQuotasSummary(
  quotas: UsageQuotas | null | undefined,
): string | null {
  if (!quotas) return null;
  const parts: string[] = [];
  for (const key of Object.keys(QUOTA_LABELS) as (keyof UsageQuotas)[]) {
    const value = quotas[key];
    if (typeof value !== "number" || value <= 0) continue;
    parts.push(`${value.toLocaleString("en-US")} ${QUOTA_LABELS[key]}`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}
