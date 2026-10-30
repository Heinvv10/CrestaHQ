import { formatBillingPrice } from "@/lib/billing/status";
import { localDay } from "@/lib/billing/usage";
import type { BillingChargeResponse } from "@/types/billing";

/** Pure helpers behind Agency > Client billing > Invoices (the panel's filters and totals). */

export type InvoiceFilter = "all" | "outstanding" | "overdue" | "paid" | "canceled";

export const INVOICE_FILTERS: { id: InvoiceFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "outstanding", label: "Outstanding" },
  { id: "overdue", label: "Overdue" },
  { id: "paid", label: "Paid" },
  { id: "canceled", label: "Canceled / waived" },
];

/**
 * Same rule as the server's overdue flag (`refreshUsageOverdue`): past the due
 * calendar day, not on it. Both sides read local days, which agree for an
 * owner in the server's time zone.
 */
export function isOverdue(c: BillingChargeResponse, now: Date): boolean {
  if (c.status !== "pending" || !c.dueAt) return false;
  const dueMs = Date.parse(c.dueAt);
  return Number.isFinite(dueMs) && localDay(dueMs) < localDay(now.getTime());
}

export function matchesFilter(c: BillingChargeResponse, f: InvoiceFilter, now: Date): boolean {
  if (f === "all") return true;
  if (f === "outstanding") return c.status === "pending";
  if (f === "overdue") return isOverdue(c, now);
  return c.status === f;
}

/** Totals stay per currency: adding USD to ZAR would be meaningless. */
export function sumByCurrency(list: BillingChargeResponse[]): string {
  const by = new Map<string, number>();
  for (const c of list) by.set(c.currency, (by.get(c.currency) ?? 0) + c.amountCents);
  if (by.size === 0) return "—";
  return [...by.entries()]
    .map(([cur, cents]) => `${formatBillingPrice(cents, cur)} ${cur.toUpperCase()}`)
    .join(" + ");
}

/** Charges paid in the calendar month (local) of `now`. */
export function paidThisMonth(list: BillingChargeResponse[], now: Date): BillingChargeResponse[] {
  const month = localDay(now.getTime()).slice(0, 7);
  return list.filter((c) => {
    if (c.status !== "paid" || !c.paidAt) return false;
    const paidMs = Date.parse(c.paidAt);
    return Number.isFinite(paidMs) && localDay(paidMs).slice(0, 7) === month;
  });
}
