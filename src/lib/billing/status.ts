import type { BillingInterval, SubAccountBilling } from "@/types/billing";

/**
 * Client-safe billing state derivation — the single place that decides
 * whether a sub-account renders normally, shows the dunning banner, or is
 * behind a paywall. Used by the paywall wrapper, the settings card, and the
 * agency client table, so all three always agree.
 *
 * Grace is evaluated at read time against `graceUntil` (no cron): a
 * past_due sub-account inside the window is "grace" (banner only), past
 * the window it's "lapsed" (hard paywall). Deliberately NOT server-only —
 * the paywall computes this in the browser from the already-subscribed
 * sub-account doc.
 */

export type EffectiveBillingState =
  /** No billing / comped — never paywalled, gates are manual. */
  | "comped"
  /** Plan assigned, payment not completed — activation paywall. */
  | "pending"
  /** Paying and in good standing. */
  | "active"
  /** Renewal failed, inside the grace window — dunning banner. */
  | "grace"
  /** Grace exhausted or subscription canceled — hard paywall. */
  | "lapsed";

/** Firestore Timestamp / Date / null → epoch millis (null-safe). */
export function billingDateToMillis(
  value: SubAccountBilling["graceUntil"],
): number | null {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  if (
    typeof value === "object" &&
    "toMillis" in value &&
    typeof value.toMillis === "function"
  ) {
    return value.toMillis();
  }
  return null;
}

export function effectiveBillingState(
  billing: SubAccountBilling | null | undefined,
  now: Date = new Date(),
): EffectiveBillingState {
  if (!billing || billing.status === "comped") return "comped";
  switch (billing.status) {
    case "pending":
      return "pending";
    case "active":
      return "active";
    case "past_due": {
      const graceMs = billingDateToMillis(billing.graceUntil);
      return graceMs !== null && graceMs > now.getTime() ? "grace" : "lapsed";
    }
    case "canceled":
      return "lapsed";
  }
}

/** True when the workspace should be blocked for sub-account members. */
export function billingBlocksWorkspace(state: EffectiveBillingState): boolean {
  return state === "pending" || state === "lapsed";
}

/** "$97.00 AUD"-style label from integer cents + lowercase ISO currency. */
export function formatBillingPrice(
  priceCents: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (typeof priceCents !== "number" || !currency) return "—";
  const code = currency.toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
    }).format(priceCents / 100);
  } catch {
    return `${(priceCents / 100).toFixed(2)} ${code}`;
  }
}

/** Short per-interval suffix: "/mo" for monthly, "/yr" for annual. */
export function billingIntervalSuffix(
  interval: BillingInterval | null | undefined,
): string {
  return interval === "year" ? "/yr" : "/mo";
}

/** "$990.00 AUD/yr"-style label. Defaults to monthly when interval is null. */
export function formatBillingPriceWithInterval(
  priceCents: number | null | undefined,
  currency: string | null | undefined,
  interval: BillingInterval | null | undefined,
): string {
  const base = formatBillingPrice(priceCents, currency);
  if (base === "—") return base;
  return `${base}${billingIntervalSuffix(interval)}`;
}

/**
 * Normalize a per-interval charge to a monthly-equivalent for MRR roll-ups —
 * annual amounts are divided by 12.
 */
export function monthlyEquivalentCents(
  priceCents: number | null | undefined,
  interval: BillingInterval | null | undefined,
): number {
  if (typeof priceCents !== "number") return 0;
  return interval === "year" ? priceCents / 12 : priceCents;
}
