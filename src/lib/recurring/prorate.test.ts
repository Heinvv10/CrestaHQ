import { describe, expect, it } from "vitest";

import { utcFromWallClock } from "@/lib/booking/availability";
import { computeQuoteTotals } from "@/lib/quotes/calc";
import { computeFirstRunAt, type Cadence } from "@/lib/recurring/cadence";

import { gapInvoiceTemplate, planProration, readProration, withProratedCredit, type ProrationRecord } from "./prorate";

const TZ = "Africa/Johannesburg";
const MONTHLY: Cadence = { unit: "month", interval: 1 };
/** Local midnight in Johannesburg (22:00 UTC the day before). */
const day = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return utcFromWallClock(y, m, d, 0, TZ);
};
/** R1,000 + 15% tax = R1,150 a cycle. */
const TEMPLATE = {
  lineItems: [{ id: "li1", description: "Fibre", quantity: 1, unitPrice: 1000 }],
  globalDiscount: null,
  globalTaxPercent: 15,
};

/** Billed on `lastDue` with anchor `from`; edited on `editOn` to anchor `to`. */
function plan(o: {
  lastDue: string;
  from: number;
  to: number;
  editOn: string;
  cyclesGenerated?: number;
  proration?: ProrationRecord | null;
  cadenceAfter?: Cadence;
}) {
  const cadenceAfter = o.cadenceAfter ?? MONTHLY;
  const next = computeFirstRunAt({ startAt: day(o.editOn), cadence: cadenceAfter, anchorDay: o.to, timezone: TZ });
  return planProration({
    timezone: TZ,
    before: {
      status: "active",
      cadence: MONTHLY,
      anchorDay: o.from,
      nextRunAt: null,
      lastDueAt: day(o.lastDue),
      cyclesGenerated: o.cyclesGenerated ?? 1,
      proration: o.proration ?? null,
    },
    after: { status: "active", cadence: cadenceAfter, anchorDay: o.to, nextRunAt: next, template: TEMPLATE },
  });
}

describe("a gap (billing day moved later)", () => {
  it("15th → 20th: one pro-rata for 15–20 Jul, R1,150 × 5 ÷ 31", () => {
    const p = plan({ lastDue: "2026-06-15", from: 15, to: 20, editOn: "2026-07-01" })!;
    expect(p.credit).toBeNull();
    expect(p.gap).toMatchObject({ days: 5, cycleDays: 31, taxable: 161.29, invoiceId: null });
    expect(p.gap!.label).toBe("Pro-rated: 15 Jul – 20 Jul (billing day changed)");
    // The dates are Johannesburg days, not the UTC instants (14 Jul 22:00).
    expect(p.gap!.from.toISOString()).toBe("2026-07-14T22:00:00.000Z");
    expect(p.coveredUntil).toEqual(day("2026-07-20"));
    const total = computeQuoteTotals(gapInvoiceTemplate(p.gap!, TEMPLATE)).total;
    expect(total).toBe(185.48);
    expect(total).toBe(Math.round(((1150 * 5) / 31) * 100) / 100);
  });

  it("February: 15 Feb – 20 Feb over a 28-day cycle, and 29 in a leap year", () => {
    expect(plan({ lastDue: "2026-01-15", from: 15, to: 20, editOn: "2026-02-01" })!.gap).toMatchObject({
      days: 5,
      cycleDays: 28,
      taxable: 178.57,
    });
    expect(plan({ lastDue: "2028-01-15", from: 15, to: 20, editOn: "2028-02-01" })!.gap).toMatchObject({
      days: 5,
      cycleDays: 29,
    });
  });

  it("month-end anchor: covered to a clamped 28 Feb, moved to the 5th → 28 Feb – 5 Mar", () => {
    const p = plan({ lastDue: "2026-01-31", from: 31, to: 5, editOn: "2026-02-10" })!;
    expect(p.gap).toMatchObject({ days: 5, cycleDays: 31, label: "Pro-rated: 28 Feb – 5 Mar (billing day changed)" });
  });
});

describe("an overlap (billing day moved earlier)", () => {
  it("20th → 15th: 15–20 Jul credited on the 15 Jul invoice", () => {
    const p = plan({ lastDue: "2026-06-20", from: 20, to: 15, editOn: "2026-07-01" })!;
    expect(p.gap).toBeNull();
    expect(p.coveredUntil).toEqual(day("2026-07-20"));
    expect(p.credit).toMatchObject({ days: 5, cycleDays: 31, taxable: 161.29 });
    expect(p.credit!.appliesToDueAt).toEqual(day("2026-07-15"));
    expect(p.credit!.label).toBe("Pro-rated credit: 15 Jul – 20 Jul (billing day changed)");
  });

  it("the credit lands only on the cycle it is owed on, and takes R1,150 × 5 ÷ 31 off it", () => {
    const p = plan({ lastDue: "2026-06-20", from: 20, to: 15, editOn: "2026-07-01" })!;
    const credited = withProratedCredit(TEMPLATE, p, day("2026-07-15"), "ZAR");
    expect(computeQuoteTotals(credited).total).toBe(964.52);
    expect(computeQuoteTotals(credited).total).toBe(Math.round(1150 * (1 - 5 / 31) * 100) / 100);
    expect(credited.lineItems[1]).toMatchObject({ unitPrice: 0 });
    expect(credited.lineItems[1].description).toContain("Pro-rated credit: 15 Jul – 20 Jul (billing day changed)");
    expect(withProratedCredit(TEMPLATE, p, day("2026-08-15"), "ZAR")).toEqual(TEMPLATE);
    expect(withProratedCredit(TEMPLATE, null, day("2026-07-15"), "ZAR")).toEqual(TEMPLATE);
  });

  it("an existing discount is kept, with the credit added to it", () => {
    const p = plan({ lastDue: "2026-06-20", from: 20, to: 15, editOn: "2026-07-01" })!;
    const credited = withProratedCredit({ ...TEMPLATE, globalDiscount: { type: "percent", value: 10 } }, p, day("2026-07-15"), "ZAR");
    expect(credited.globalDiscount).toEqual({ type: "flat", value: 261.29 });
  });
});

describe("what never pro-rates", () => {
  it("a schedule that has not billed yet", () => {
    expect(plan({ lastDue: "2026-06-15", from: 15, to: 20, editOn: "2026-07-01", cyclesGenerated: 0 })).toBeNull();
  });

  it("a cadence change (monthly → quarterly), even with the anchor moving too", () => {
    expect(
      plan({ lastDue: "2026-06-15", from: 15, to: 20, editOn: "2026-07-01", cadenceAfter: { unit: "quarter", interval: 1 } }),
    ).toBeNull();
  });
});

describe("a second change before the next bill starts from the first", () => {
  const first = () => plan({ lastDue: "2026-06-15", from: 15, to: 20, editOn: "2026-07-01" })!;

  it("15 → 20 → 25: the second gap is 20–25 Jul, not 15–25", () => {
    const second = plan({ lastDue: "2026-06-15", from: 20, to: 25, editOn: "2026-07-02", proration: first() })!;
    expect(second.gap).toMatchObject({ days: 5, label: "Pro-rated: 20 Jul – 25 Jul (billing day changed)" });
  });

  it("15 → 20 → 15: the days the pro-rata paid for are credited back", () => {
    const back = plan({ lastDue: "2026-06-15", from: 20, to: 15, editOn: "2026-07-02", proration: first() })!;
    expect(back.gap).toBeNull();
    expect(back.credit).toMatchObject({ days: 5, label: "Pro-rated credit: 15 Jul – 20 Jul (billing day changed)" });
  });

  it("20 → 15 → 20: the pending credit is withdrawn, and nothing is invoiced", () => {
    const credit = plan({ lastDue: "2026-06-20", from: 20, to: 15, editOn: "2026-07-01" })!;
    const back = plan({ lastDue: "2026-06-20", from: 15, to: 20, editOn: "2026-07-02", proration: credit })!;
    expect(back).toMatchObject({ gap: null, credit: null, coveredUntil: day("2026-07-20") });
  });

  it("a record from an earlier billed cycle is ignored", () => {
    const stale = first();
    const next = plan({ lastDue: "2026-07-20", from: 20, to: 25, editOn: "2026-08-01", proration: stale })!;
    expect(next.gap).toMatchObject({ label: "Pro-rated: 20 Aug – 25 Aug (billing day changed)" });
  });
});

it("readProration round-trips Timestamp-shaped dates", () => {
  const p = plan({ lastDue: "2026-06-20", from: 20, to: 15, editOn: "2026-07-01" })!;
  const ts = (d: Date) => ({ toDate: () => d });
  const stored = {
    forLastDueAt: ts(p.forLastDueAt!),
    coveredUntil: ts(p.coveredUntil),
    gap: null,
    credit: { ...p.credit!, from: ts(p.credit!.from), to: ts(p.credit!.to), appliesToDueAt: ts(p.credit!.appliesToDueAt) },
  };
  expect(readProration(stored)).toEqual(p);
  expect(readProration(null)).toBeNull();
});
