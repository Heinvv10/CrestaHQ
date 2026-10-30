import "server-only";

import type { FieldValue } from "firebase-admin/firestore";
import { monthStart } from "@/lib/billing/usage";
import type { UsageChargeLine } from "@/types/billing";
import type { UsageQuotas, UsageRates } from "@/types/usage";

/** Pieces the usage close shares between freezing a month and minting/emailing its charge. */

const CONCURRENCY = 8;
export const DAY_MS = 24 * 60 * 60 * 1000;
/** Server-only queue of frozen months whose charge is not yet minted and emailed. */
export const PENDING_COLLECTION = "usagePendingCharges";

export interface UsageClosedSnapshot {
  at: FieldValue | { toMillis(): number };
  /** Not billed (client or agency not rebilled at close, or switched on after the month). */
  skipped?: boolean;
  skippedReason?: string;
  totalCents: number;
  currency: string;
  lineItems: UsageChargeLine[];
  ratesSnapshot: UsageRates | null;
  includedSnapshot: UsageQuotas | null;
  carriedInCents: number;
  /** Below the minimum: rolls into next month's charge. */
  carryOutCents: number;
  chargeId: string | null;
  /** A switch was off when the charge came to be minted, so none was. */
  withheldAt?: FieldValue;
  /** Why: "rebilling_switched_off_before_invoice" or "invoice could not be sent". */
  withheldReason?: string;
}

export interface PendingChargeDoc {
  subAccountId: string;
  month: string;
  createdAt: FieldValue;
}

export function toMillis(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  const fn = (v as { toMillis?: unknown } | null)?.toMillis;
  return typeof fn === "function" ? (fn.call(v) as number) : null;
}

/**
 * Why a month is NOT billable, or null when it is. The one eligibility rule,
 * used at the freeze AND again when the charge is minted: a month is billed
 * only if it STARTED with both switches already on. A client enabled
 * mid-month is billed from its first full month, and a switch turned off and
 * on again after the month began does not bill it. Each `since` stamp must be
 * readable and at or before the month's first instant; a missing or
 * unreadable one with the switch on fails closed.
 */
export function unbillableReason(
  agency: Record<string, unknown> | undefined,
  client: Record<string, unknown> | undefined,
  month: string,
): string | null {
  const startMs = monthStart(month).getTime();
  const startedOn = (since: unknown) => {
    const ms = toMillis(since);
    return ms !== null && ms <= startMs;
  };
  if (agency?.usageRebillingEnabled !== true) return "agency_off";
  if (client?.usageRebillingEnabled !== true) return "client_off";
  if (!startedOn(agency.usageRebillingSince)) return "agency_switched_on_after_month_start";
  if (!startedOn(client.usageRebillingSince)) return "client_switched_on_after_month_start";
  return null;
}

export function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A PERMANENT refusal: retrying changes nothing until someone fixes the cause
 * (Paystack with no email to open a payment page for, an amount over the
 * ceiling, the provider or app URL not configured). Held and retried each day,
 * but reported in the result rather than as a failure, so the housekeeping job
 * does not answer 500 and have QStash re-run everything forever.
 */
export class UsageChargeRefused extends Error {
  readonly subAccountId: string;
  readonly month: string;
  constructor(subAccountId: string, month: string, message: string) {
    super(message);
    this.name = "UsageChargeRefused";
    this.subAccountId = subAccountId;
    this.month = month;
  }
}

export interface UsageRefusal {
  subAccountId: string;
  month: string;
  reason: string;
}

/** Runs `fn` over `items`; `failed` counts unexpected errors, `refusals` the permanent ones. */
export async function inPool<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
): Promise<{ failed: number; refusals: UsageRefusal[] }> {
  let i = 0;
  let failed = 0;
  const refusals: UsageRefusal[] = [];
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item).catch((err) => {
        if (err instanceof UsageChargeRefused) {
          refusals.push({ subAccountId: err.subAccountId, month: err.month, reason: err.message });
          console.error(`[usage-close] held, needs a fix sa=${err.subAccountId} month=${err.month}: ${err.message}`);
          return;
        }
        failed++;
        console.error(`[usage-close] item failed: ${reason(err)}`);
      });
    }
  });
  await Promise.all(workers);
  return { failed, refusals };
}
