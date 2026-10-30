import { describe, expect, it } from "vitest";
import { isOverdue, matchesFilter, paidThisMonth, sumByCurrency } from "@/lib/billing/invoice-filters";
import type { BillingChargeResponse } from "@/types/billing";

const base: BillingChargeResponse = {
  id: "c1", subAccountId: "sa1", description: "x", amountCents: 1000, currency: "zar", status: "pending",
  createdAt: null, paidAt: null, extraPaymentCount: 0, kind: "usage", usageMonth: "2026-09", dueAt: null,
};
const NOW = new Date(2026, 9, 16, 5, 0);

describe("isOverdue", () => {
  it("is past the due calendar day, not on it, and only for a pending charge", () => {
    const due = (d: Date) => ({ ...base, dueAt: d.toISOString() });
    expect(isOverdue(due(new Date(2026, 9, 15, 23, 59)), NOW)).toBe(true);
    expect(isOverdue(due(new Date(2026, 9, 16, 0, 1)), NOW)).toBe(false);
    expect(isOverdue(due(new Date(2026, 9, 17, 12, 0)), NOW)).toBe(false);
    expect(isOverdue({ ...due(new Date(2026, 9, 1)), status: "paid" }, NOW)).toBe(false);
    expect(isOverdue({ ...due(new Date(2026, 9, 1)), status: "canceled" }, NOW)).toBe(false);
  });

  it("a charge with no or an unreadable due date is never overdue", () => {
    expect(isOverdue(base, NOW)).toBe(false);
    expect(isOverdue({ ...base, dueAt: "garbage" }, NOW)).toBe(false);
  });
});

describe("matchesFilter / sumByCurrency / paidThisMonth", () => {
  it("filters by status", () => {
    expect(matchesFilter({ ...base, status: "paid" }, "paid", NOW)).toBe(true);
    expect(matchesFilter({ ...base, status: "paid" }, "outstanding", NOW)).toBe(false);
    expect(matchesFilter({ ...base, status: "canceled" }, "canceled", NOW)).toBe(true);
    expect(matchesFilter({ ...base, status: "canceled" }, "all", NOW)).toBe(true);
  });

  it("never adds one currency to another", () => {
    const out = sumByCurrency([base, { ...base, amountCents: 500 }, { ...base, currency: "usd", amountCents: 200 }]);
    expect(out).toContain("15.00 ZAR");
    expect(out).toContain("2.00 USD");
    expect(sumByCurrency([])).toBe("—");
  });

  it("collected counts only this calendar month's payments", () => {
    const paid = (at: Date) => ({ ...base, status: "paid" as const, paidAt: at.toISOString() });
    const list = [paid(new Date(2026, 9, 2)), paid(new Date(2026, 8, 30, 23, 0)), { ...base, status: "paid" as const, paidAt: null }];
    expect(paidThisMonth(list, NOW)).toHaveLength(1);
  });
});
