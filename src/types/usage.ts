import type { FieldValue, Timestamp } from "firebase/firestore";

/**
 * Usage Metering v1 (see USAGE_METERING_V1_PLAN.md).
 *
 * One ledger doc per workspace per month at
 * `subAccounts/{id}/usage/{YYYY-MM}` — increment-only, server-only
 * (default-deny rules; reads go through the owner-only agency API).
 * A missing doc means zero usage; month keys handle rollover for free.
 */

/** The five metered units — field names on the month doc. */
export type UsageUnit =
  | "emailsSent"
  | "smsSegments"
  | "whatsappMessages"
  | "aiTokens"
  | "voiceSeconds";

export const USAGE_UNITS: UsageUnit[] = [
  "emailsSent",
  "smsSegments",
  "whatsappMessages",
  "aiTokens",
  "voiceSeconds",
];

/**
 * Per-month quotas. Every field optional; null/absent/<=0 = unlimited for
 * that unit, so a deployment that never configures quotas behaves exactly
 * as before. Voice is CONFIGURED in minutes (human-friendly) and compared
 * against the ledger's `voiceSeconds` × 60.
 *
 * Lives in two places, resolved workspace-override-first:
 *   - `BillingPlanDoc.quotas` — the plan's included allowance
 *   - `SubAccountDoc.usageQuotas` — per-workspace override (comped
 *     workspaces / special deals), agency-owner-only writes
 */
export interface UsageQuotas {
  emailsPerMonth?: number | null;
  smsSegmentsPerMonth?: number | null;
  whatsappPerMonth?: number | null;
  aiTokensPerMonth?: number | null;
  voiceMinutesPerMonth?: number | null;
}

/**
 * Overage SELL rates — what the workspace's client is charged per unit
 * beyond the included quota, in integer cents. Owner-typed (a business
 * decision), never derived from provider costs — costs vary by country/
 * model/account and drift, so a stored cost would silently mis-price.
 *
 * Units: email/segment/message are per item; AI tokens are per 1,000
 * tokens; voice is per minute. Null/absent/<=0 = no rate ( = that unit's
 * overage is not valued). Overage only exists past an included quota —
 * a rate with no quota bills nothing (unlimited included).
 *
 * Same two-level resolution as quotas: `SubAccountDoc.usageRates`
 * override → plan `rates` → none.
 */
export interface UsageRates {
  emailCents?: number | null;
  smsSegmentCents?: number | null;
  whatsappMessageCents?: number | null;
  aiTokensPer1kCents?: number | null;
  voiceMinuteCents?: number | null;
}

/** The month ledger doc. All counters FieldValue.increment-maintained. */
export interface UsageMonthDoc {
  emailsSent?: number;
  smsSegments?: number;
  whatsappMessages?: number;
  aiTokens?: number;
  voiceSeconds?: number;
  /** Once-per-month alert stamps, keyed by unit (80% / 100%). */
  warnedAt?: Partial<Record<UsageUnit, Timestamp | FieldValue>>;
  cappedAt?: Partial<Record<UsageUnit, Timestamp | FieldValue>>;
  updatedAt?: Timestamp | FieldValue;
}
