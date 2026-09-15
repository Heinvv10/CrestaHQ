import { describe, expect, it } from "vitest";
import {
  archivedPlanCount,
  buildResellingRows,
  formatQuotasSummary,
  planGateMatrixRow,
  planIncludedGateLabels,
  planMrrCents,
  planSubscriberCounts,
  resellingTotalsByCurrency,
  unknownPlanSubscribers,
} from "./reselling";
import type { BillingPlanResponse, PlanGates } from "@/types/billing";
import { PLAN_GATE_KEYS } from "@/types/billing";
import type { SubAccountDoc } from "@/types";

function gates(trueKeys: string[] = []): PlanGates {
  const out = {} as PlanGates;
  for (const k of PLAN_GATE_KEYS) {
    out[k] = trueKeys.includes(k);
  }
  return out;
}

function plan(overrides: Partial<BillingPlanResponse> = {}): BillingPlanResponse {
  return {
    id: "plan-1",
    name: "Starter",
    description: null,
    priceMonthlyCents: 9700,
    priceAnnualCents: null,
    currency: "usd",
    gates: gates(),
    status: "active",
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function sub(overrides: Record<string, unknown> = {}): SubAccountDoc {
  return {
    id: "sub-1",
    billing: null,
    ...overrides,
  } as unknown as SubAccountDoc;
}

describe("planSubscriberCounts", () => {
  it("buckets active, pending, and past-due (grace + lapsed) subscribers", () => {
    const p = plan();
    const subs = [
      sub({ id: "a", billing: { status: "active", planId: p.id, priceCents: 9700, currency: "usd", billingInterval: "month", graceUntil: null } }),
      sub({ id: "b", billing: { status: "pending", planId: p.id, priceCents: 9700, currency: "usd", billingInterval: "month", graceUntil: null } }),
      sub({ id: "c", billing: { status: "past_due", planId: p.id, priceCents: 9700, currency: "usd", billingInterval: "month", graceUntil: new Date(Date.now() + 86400_000) } }), // grace
      sub({ id: "d", billing: { status: "past_due", planId: p.id, priceCents: 9700, currency: "usd", billingInterval: "month", graceUntil: new Date(Date.now() - 86400_000) } }), // lapsed
      sub({ id: "e", billing: { status: "canceled", planId: p.id, priceCents: 9700, currency: "usd", billingInterval: "month", graceUntil: null } }), // lapsed
      sub({ id: "f", billing: { status: "active", planId: "other-plan", priceCents: 9700, currency: "usd", billingInterval: "month", graceUntil: null } }),
      sub({ id: "g", billing: null }),
    ];
    expect(planSubscriberCounts(p, subs)).toEqual({
      active: 1,
      pending: 1,
      pastDue: 3,
    });
  });

  it("returns all-zero counts for a plan with no subscribers", () => {
    expect(planSubscriberCounts(plan(), [])).toEqual({
      active: 0,
      pending: 0,
      pastDue: 0,
    });
  });
});

describe("planMrrCents", () => {
  it("sums only ACTIVE subscribers, using each sub's own price", () => {
    const p = plan({ priceMonthlyCents: 9700 });
    const subs = [
      sub({ billing: { status: "active", planId: p.id, priceCents: 9700, currency: "usd", billingInterval: "month", graceUntil: null } }),
      // special price override — still counted at ITS OWN price, not the plan price
      sub({ billing: { status: "active", planId: p.id, priceCents: 5000, currency: "usd", billingInterval: "month", graceUntil: null } }),
      sub({ billing: { status: "pending", planId: p.id, priceCents: 9700, currency: "usd", billingInterval: "month", graceUntil: null } }),
    ];
    expect(planMrrCents(p, subs)).toBe(14700);
  });

  it("normalizes an annual subscription to its monthly-equivalent (÷12)", () => {
    const p = plan();
    const subs = [
      sub({ billing: { status: "active", planId: p.id, priceCents: 120000, currency: "usd", billingInterval: "year", graceUntil: null } }),
    ];
    expect(planMrrCents(p, subs)).toBe(10000);
  });

  it("is zero when there are no active subscribers", () => {
    const p = plan();
    const subs = [
      sub({ billing: { status: "pending", planId: p.id, priceCents: 9700, currency: "usd", billingInterval: "month", graceUntil: null } }),
    ];
    expect(planMrrCents(p, subs)).toBe(0);
  });
});

describe("buildResellingRows / archivedPlanCount", () => {
  it("excludes an archived plan with no subscribers from the rows but counts it separately", () => {
    const active = plan({ id: "p-active", status: "active" });
    const archived = plan({ id: "p-archived", status: "archived" });
    const rows = buildResellingRows([active, archived], []);
    expect(rows).toHaveLength(1);
    expect(rows[0].plan.id).toBe("p-active");
    expect(archivedPlanCount([active, archived], [])).toBe(1);
  });

  it("includes an archived plan that still has a subscriber, marked archived, and does NOT count it in archivedPlanCount", () => {
    const archived = plan({ id: "p-archived", status: "archived" });
    const subs = [
      sub({ billing: { status: "active", planId: archived.id, priceCents: 9700, currency: "usd", billingInterval: "month", graceUntil: null } }),
    ];
    const rows = buildResellingRows([archived], subs);
    expect(rows).toHaveLength(1);
    expect(rows[0].archived).toBe(true);
    expect(rows[0].counts.active).toBe(1);
    expect(rows[0].mrrCents).toBe(9700);
    expect(archivedPlanCount([archived], subs)).toBe(0);
  });

  it("an active plan's row is never marked archived", () => {
    const active = plan({ id: "p-active", status: "active" });
    expect(buildResellingRows([active], [])[0].archived).toBe(false);
  });

  it("is empty for zero plans", () => {
    expect(buildResellingRows([], [])).toEqual([]);
    expect(archivedPlanCount([], [])).toBe(0);
  });
});

describe("unknownPlanSubscribers", () => {
  it("surfaces a sub whose billing.planId matches no plan doc, bucketed by state", () => {
    const known = plan({ id: "p-known" });
    const subs = [
      sub({ billing: { status: "active", planId: "deleted-plan", priceCents: 9700, currency: "usd", billingInterval: "month", graceUntil: null } }),
      sub({ billing: { status: "pending", planId: "deleted-plan", priceCents: 9700, currency: "usd", billingInterval: "month", graceUntil: null } }),
      sub({ billing: { status: "active", planId: known.id, priceCents: 9700, currency: "usd", billingInterval: "month", graceUntil: null } }),
      sub({ billing: null }),
    ];
    expect(unknownPlanSubscribers([known], subs)).toEqual({
      total: 2,
      active: 1,
      pending: 1,
      pastDue: 0,
    });
  });

  it("counts a sub against an ARCHIVED plan as known, not unknown", () => {
    const archived = plan({ id: "p-archived", status: "archived" });
    const subs = [
      sub({ billing: { status: "active", planId: archived.id, priceCents: 9700, currency: "usd", billingInterval: "month", graceUntil: null } }),
    ];
    expect(unknownPlanSubscribers([archived], subs)).toEqual({
      total: 0,
      active: 0,
      pending: 0,
      pastDue: 0,
    });
  });

  it("is all-zero when there are no plans or subs", () => {
    expect(unknownPlanSubscribers([], [])).toEqual({
      total: 0,
      active: 0,
      pending: 0,
      pastDue: 0,
    });
  });
});

describe("resellingTotalsByCurrency", () => {
  it("never sums MRR or counts across currencies", () => {
    const usdPlan = plan({ id: "usd-plan", currency: "usd" });
    const zarPlan = plan({ id: "zar-plan", currency: "zar" });
    const subs = [
      sub({ billing: { status: "active", planId: usdPlan.id, priceCents: 9700, currency: "usd", billingInterval: "month", graceUntil: null } }),
      sub({ billing: { status: "active", planId: zarPlan.id, priceCents: 49900, currency: "zar", billingInterval: "month", graceUntil: null } }),
    ];
    const rows = buildResellingRows([usdPlan, zarPlan], subs);
    const totals = resellingTotalsByCurrency(rows);
    expect(totals).toEqual(
      expect.arrayContaining([
        { currency: "usd", mrrCents: 9700, activeCount: 1 },
        { currency: "zar", mrrCents: 49900, activeCount: 1 },
      ]),
    );
    expect(totals).toHaveLength(2);
  });

  it("is empty for zero rows", () => {
    expect(resellingTotalsByCurrency([])).toEqual([]);
  });
});

describe("planIncludedGateLabels / planGateMatrixRow", () => {
  it("lists only the labels for gates set true", () => {
    const p = plan({ gates: gates(["whatsappEnabledByAgency", "websiteEnabledByAgency"]) });
    expect(planIncludedGateLabels(p)).toEqual(["WhatsApp channel", "Website builder"]);
  });

  it("returns every gate key false for a plan with no gates enabled", () => {
    const p = plan();
    const row = planGateMatrixRow(p);
    expect(Object.values(row).every((v) => v === false)).toBe(true);
    expect(Object.keys(row)).toHaveLength(PLAN_GATE_KEYS.length);
  });
});

describe("formatQuotasSummary", () => {
  it("formats set quotas with thousands separators and unit labels", () => {
    expect(
      formatQuotasSummary({ emailsPerMonth: 5000, smsSegmentsPerMonth: 200 }),
    ).toBe("5,000 emails/mo, 200 SMS/mo");
  });

  it("omits unset or non-positive quotas", () => {
    expect(
      formatQuotasSummary({ emailsPerMonth: 0, aiTokensPerMonth: null }),
    ).toBeNull();
  });

  it("returns null for null/undefined quotas", () => {
    expect(formatQuotasSummary(null)).toBeNull();
    expect(formatQuotasSummary(undefined)).toBeNull();
  });
});
