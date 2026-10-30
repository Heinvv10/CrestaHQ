import type { SubAccountBilling } from "@/types/billing";
import type { UsageOverdue } from "@/types/tenancy";
import { BILLING_GRACE_DAYS } from "@/types/billing";
import {
  billingDateToMillis,
  effectiveBillingState,
  type EffectiveBillingState,
} from "@/lib/billing/status";

/**
 * Guard state from the subscription and unpaid usage; a comped client can
 * still owe usage.
 *
 * FAILS OPEN, deliberately the one place in this area that does: this decides
 * whether a client's live workspace is walled, so anything unreadable (no
 * flag, an unreadable due date, a `paywall` that is not exactly `true`) reads
 * as "nothing owed" or "banner only". The server decides whether a flag exists
 * at all (`refreshUsageOverdue`: both rebilling switches on, the invoice
 * emailed, past its due day).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type UsageDebtState = "none" | "grace" | "lapsed";

/**
 * Overdue usage: grace for BILLING_GRACE_DAYS after the due date, then lapsed
 * only if the agency allows the wall. Otherwise it stays a banner.
 */
export function usageDebtState(
  overdue: UsageOverdue | null | undefined,
  now: Date = new Date(),
): UsageDebtState {
  if (!overdue) return "none";
  const sinceMs = billingDateToMillis(overdue.since);
  if (sinceMs === null) return "none";
  if (now.getTime() < sinceMs + BILLING_GRACE_DAYS * DAY_MS) return "grace";
  return overdue.paywall === true ? "lapsed" : "grace";
}

/** When access pauses, or null when nothing is overdue or the wall is off. */
export function usageGraceEndsAt(overdue: UsageOverdue | null | undefined): number | null {
  if (overdue?.paywall !== true) return null;
  const sinceMs = billingDateToMillis(overdue.since);
  return sinceMs === null ? null : sinceMs + BILLING_GRACE_DAYS * DAY_MS;
}

export interface WorkspaceBillingState {
  state: EffectiveBillingState;
  /** Which debt causes a grace/lapsed/pending state; null when nothing does. */
  blockedBy: "plan" | "usage" | null;
}

export function workspaceBillingState(
  billing: SubAccountBilling | null | undefined,
  usageOverdue: UsageOverdue | null | undefined,
  now: Date = new Date(),
): WorkspaceBillingState {
  const plan = effectiveBillingState(billing, now);
  // An unpaid subscription is the bigger problem, so it shows first.
  if (plan === "pending" || plan === "lapsed") return { state: plan, blockedBy: "plan" };
  const usage = usageDebtState(usageOverdue, now);
  if (usage === "lapsed") return { state: "lapsed", blockedBy: "usage" };
  if (plan === "grace") return { state: "grace", blockedBy: "plan" };
  if (usage === "grace") return { state: "grace", blockedBy: "usage" };
  return { state: plan, blockedBy: null };
}
