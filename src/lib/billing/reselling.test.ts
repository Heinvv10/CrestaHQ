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
  it("excludes archived plans from the rows but counts them separately", () => {
    const active = plan({ id: "p-active", status: "active" });
    const archived = plan({ id: "p-archived", status: "archived" });
    const rows = buildResellingRows([active, archived], []);
    expect(rows).toHaveLength(1);
    expect(rows[0].plan.id).toBe("p-active");
    expect(archivedPlanCount([active, archived])).toBe(1);
  });

  it("is empty for zero plans", () => {
    expect(buildResellingRows([], [])).toEqual([]);
    expect(archivedPlanCount([])).toBe(0);
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
