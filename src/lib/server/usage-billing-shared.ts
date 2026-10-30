import "server-only";

import type { FieldValue } from "firebase-admin/firestore";
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

export function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function inPool<T>(items: T[], fn: (item: T) => Promise<void>): Promise<number> {
  let i = 0;
  let failed = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item).catch((err) => {
        failed++;
        console.error(`[usage-close] item failed: ${reason(err)}`);
      });
    }
  });
  await Promise.all(workers);
  return failed;
}
