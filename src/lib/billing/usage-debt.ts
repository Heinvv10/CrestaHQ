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
 * When the wall would fall, or null when it cannot: the wall is off, or any of
 * the three dates is unreadable. Never earlier than 7 days after the latest of
 * the invoice's due date, the agency turning the paywall on, and the client's
 * switch turning on, so neither turning the paywall on nor re-enabling a client
 * walls a long-overdue workspace at once.
 */
function wallAtMs(overdue: UsageOverdue): number | null {
  if (overdue.paywall !== true) return null;
  const dates = [overdue.since, overdue.paywallSince, overdue.rebillingSince].map((d) =>
    billingDateToMillis(d ?? null),
  );
  if (dates.some((d) => d === null)) return null;
  return Math.max(...(dates as number[])) + BILLING_GRACE_DAYS * DAY_MS;
}

/**
 * Overdue usage: a banner while within BILLING_GRACE_DAYS of the due date,
 * then lapsed only once the wall time (above) has also passed. Otherwise it
 * stays a banner.
 */
export function usageDebtState(
  overdue: UsageOverdue | null | undefined,
  now: Date = new Date(),
): UsageDebtState {
  if (!overdue) return "none";
  const sinceMs = billingDateToMillis(overdue.since);
  if (sinceMs === null) return "none";
  if (now.getTime() < sinceMs + BILLING_GRACE_DAYS * DAY_MS) return "grace";
  const wallAt = wallAtMs(overdue);
  return wallAt !== null && now.getTime() >= wallAt ? "lapsed" : "grace";
}

/** When access pauses, or null when nothing is overdue or the wall is off. */
export function usageGraceEndsAt(overdue: UsageOverdue | null | undefined): number | null {
  return overdue ? wallAtMs(overdue) : null;
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
