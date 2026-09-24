import { describe, expect, it } from "vitest";

import { utcFromWallClock } from "@/lib/booking/availability";
import { computeQuoteTotals } from "@/lib/quotes/calc";
import type { Cadence } from "@/lib/recurring/cadence";

import {
  creditDueOn,
  gapInvoiceTemplate,
  planProration,
  readProration,
  withProratedCredit,
  type ProrationRecord,
} from "./prorate";

const TZ = "Africa/Johannesburg";
const MONTHLY: Cadence = { unit: "month", interval: 1 };
/** Local midnight in Johannesburg (22:00 UTC the day before). */
const day = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return utcFromWallClock(y, m, d, 0, TZ);
};
/** 10:00 SAST on a date. */
const at = (iso: string) => new Date(`${iso}T08:00:00.000Z`);
/** R1,000 + 15% tax = R1,150 a cycle. */
const TEMPLATE = {
  lineItems: [{ id: "li1", description: "Fibre", quantity: 1, unitPrice: 1000 }],
  globalDiscount: null,
  globalTaxPercent: 15,
};

/** Billed on `lastDue` (anchor `from`); edited on `editOn` to anchor `to`. */
function plan(o: {
  lastDue: string;
  from: number;
  to: number;
  editOn: string;
  cyclesGenerated?: number;
  proration?: ProrationRecord | null;
  cadenceAfter?: Cadence;
}) {
  return planProration({
    timezone: TZ,
    now: at(o.editOn),
    newGapDocId: () => `q-${o.editOn}`,
    before: {
      status: "active",
      cadence: MONTHLY,
      anchorDay: o.from,
      nextRunAt: null,
      lastDueAt: day(o.lastDue),
      lastRunAt: at(o.lastDue),
      cyclesGenerated: o.cyclesGenerated ?? 1,
      proration: o.proration ?? null,
    },
    after: { status: "active", cadence: o.cadenceAfter ?? MONTHLY, anchorDay: o.to, template: TEMPLATE },
  });
}
const gapOf = (p: ReturnType<typeof plan>) => p!.record.gaps.at(-1)!;

describe("a gap (billing day moved later)", () => {
  it("15th → 20th: next bill 20 Jul, and one pro-rata for 15–19 Jul, R1,150 × 5 ÷ 31", () => {
    const p = plan({ lastDue: "2026-06-15", from: 15, to: 20, editOn: "2026-07-01" })!;
    expect(p.next).toEqual(day("2026-07-20"));
    expect(p.record.credit).toBeNull();
    expect(p.record.gaps).toHaveLength(1);
    expect(gapOf(p)).toMatchObject({ days: 5, cycleDays: 31, taxable: 161.29, state: "pending", docId: "q-2026-07-01" });
    expect(gapOf(p).label).toBe("Pro-rated: 15 Jul – 19 Jul (billing day changed)");
    // Johannesburg days, not the UTC instants (14 Jul 22:00).
    expect(gapOf(p).from.toISOString()).toBe("2026-07-14T22:00:00.000Z");
    // Pending: coverage does not move until the invoice exists.
    expect(p.record.coveredUntil).toEqual(day("2026-07-15"));
    const total = computeQuoteTotals(gapInvoiceTemplate(gapOf(p), TEMPLATE)).total;
    expect(total).toBe(185.48);
    expect(total).toBe(Math.round(((1150 * 5) / 31) * 100) / 100);
  });

  it("edited before the new day this month (17 Jun): next bill 20 Jul, not 20 Jun — no extra cycle", () => {
    const p = plan({ lastDue: "2026-06-15", from: 15, to: 20, editOn: "2026-06-17" })!;
    expect(p.next).toEqual(day("2026-07-20"));
    expect(gapOf(p)).toMatchObject({ days: 5, label: "Pro-rated: 15 Jul – 19 Jul (billing day changed)" });
  });

  it("February: 15 – 19 Feb over a 28-day cycle, and 29 in a leap year", () => {
    expect(gapOf(plan({ lastDue: "2026-01-15", from: 15, to: 20, editOn: "2026-02-01" }))).toMatchObject({
      days: 5,
      cycleDays: 28,
      taxable: 178.57,
      label: "Pro-rated: 15 Feb – 19 Feb (billing day changed)",
    });
    expect(gapOf(plan({ lastDue: "2028-01-15", from: 15, to: 20, editOn: "2028-02-01" }))).toMatchObject({ days: 5, cycleDays: 29 });
  });

  it("month-end anchor: covered to a clamped 28 Feb, moved to the 5th after the 5th → 28 Feb – 4 Mar", () => {
    const p = plan({ lastDue: "2026-01-31", from: 31, to: 5, editOn: "2026-02-10" })!;
    expect(p.next).toEqual(day("2026-03-05"));
    expect(gapOf(p)).toMatchObject({ days: 5, cycleDays: 31, label: "Pro-rated: 28 Feb – 4 Mar (billing day changed)" });
  });
});

describe("an overlap (billing day moved earlier)", () => {
  const overlap = () => plan({ lastDue: "2026-06-20", from: 20, to: 15, editOn: "2026-07-01" })!;

  it("20th → 15th: next bill 15 Jul, with 15–19 Jul credited", () => {
    const p = overlap();
    expect(p.next).toEqual(day("2026-07-15"));
    expect(p.record.gaps).toEqual([]);
    expect(p.record.credit).toMatchObject({ days: 5, cycleDays: 31, taxable: 161.29, cycle: null });
    expect(p.record.credit!.appliesToDueAt).toEqual(day("2026-07-15"));
    expect(p.record.credit!.label).toBe("Pro-rated credit: 15 Jul – 19 Jul (billing day changed)");
  });

  it("the credit takes R1,150 × 5 ÷ 31 off, as a flat discount plus a line naming it", () => {
    const credited = withProratedCredit(TEMPLATE, overlap().record.credit, "ZAR");
    expect(computeQuoteTotals(credited).total).toBe(964.52);
    expect(computeQuoteTotals(credited).total).toBe(Math.round(1150 * (1 - 5 / 31) * 100) / 100);
    expect(credited.lineItems[1]).toMatchObject({ unitPrice: 0 });
    expect(credited.lineItems[1].description).toContain("Pro-rated credit: 15 Jul – 19 Jul (billing day changed)");
    expect(withProratedCredit(TEMPLATE, null, "ZAR")).toEqual(TEMPLATE);
    const withPercent = withProratedCredit({ ...TEMPLATE, globalDiscount: { type: "percent", value: 10 } }, overlap().record.credit, "ZAR");
    expect(withPercent.globalDiscount).toEqual({ type: "flat", value: 261.29 });
  });

  it("the credit is owed from its cycle on — carried to a later cycle if that one is skipped — and taken once", () => {
    const { record } = overlap();
    expect(creditDueOn(record, day("2026-07-14"))).toBeNull();
    expect(creditDueOn(record, day("2026-07-15"))).toBe(record.credit);
    expect(creditDueOn(record, day("2026-08-15"))).toBe(record.credit);
    expect(creditDueOn({ ...record, credit: { ...record.credit!, cycle: 4 } }, day("2026-08-15"))).toBeNull();
  });
});

describe("what never pro-rates", () => {
  it("a schedule that has not billed yet", () => {
    expect(plan({ lastDue: "2026-06-15", from: 15, to: 20, editOn: "2026-07-01", cyclesGenerated: 0 })).toBeNull();
  });

  it("a cadence change (monthly → quarterly), even with the anchor moving too", () => {
    expect(plan({ lastDue: "2026-06-15", from: 15, to: 20, editOn: "2026-07-01", cadenceAfter: { unit: "quarter", interval: 1 } })).toBeNull();
  });
});

describe("a second change before the next bill starts from the first", () => {
  const first = () => plan({ lastDue: "2026-06-15", from: 15, to: 20, editOn: "2026-07-01" })!.record;
  const raised = () => ({ ...first(), gaps: first().gaps.map((g) => ({ ...g, state: "raised" as const, invoiceId: g.docId })) });

  it("15 → 20, gap NOT yet raised, then back to 15: the pending gap is cancelled and nothing is credited", () => {
    const back = plan({ lastDue: "2026-06-15", from: 20, to: 15, editOn: "2026-07-02", proration: first() })!;
    expect(back.next).toEqual(day("2026-07-15"));
    expect(back.record).toMatchObject({ gaps: [], credit: null });
  });

  it("15 → 20, gap raised, then back to 15: the days the pro-rata billed are credited", () => {
    const back = plan({ lastDue: "2026-06-15", from: 20, to: 15, editOn: "2026-07-02", proration: raised() })!;
    expect(back.record.credit).toMatchObject({ days: 5, label: "Pro-rated credit: 15 Jul – 19 Jul (billing day changed)" });
    expect(back.record.gaps).toHaveLength(1); // the raised one stays as history
  });

  it("15 → 20 → 25 with the first unraised: ONE gap 15–24 Jul replaces it", () => {
    const second = plan({ lastDue: "2026-06-15", from: 20, to: 25, editOn: "2026-07-02", proration: first() })!;
    expect(second.record.gaps).toHaveLength(1);
    expect(gapOf(second)).toMatchObject({ days: 10, label: "Pro-rated: 15 Jul – 24 Jul (billing day changed)" });
  });

  it("15 → 20 → 25 with the first raised: a second gap 20–24 Jul", () => {
    const second = plan({ lastDue: "2026-06-15", from: 20, to: 25, editOn: "2026-07-02", proration: raised() })!;
    expect(second.record.gaps.map((g) => g.state)).toEqual(["raised", "pending"]);
    expect(gapOf(second)).toMatchObject({ days: 5, label: "Pro-rated: 20 Jul – 24 Jul (billing day changed)" });
  });

  it("a record from an earlier billed cycle is not reused, but its unraised gap is still owed", () => {
    const next = plan({ lastDue: "2026-07-20", from: 20, to: 25, editOn: "2026-08-01", proration: first() })!;
    expect(next.record.gaps.map((g) => g.label)).toEqual([
      "Pro-rated: 15 Jul – 19 Jul (billing day changed)",
      "Pro-rated: 20 Aug – 24 Aug (billing day changed)",
    ]);
  });
});

it("readProration round-trips Timestamp-shaped dates", () => {
  const { record } = plan({ lastDue: "2026-06-15", from: 15, to: 20, editOn: "2026-07-01" })!;
  const withCredit = { ...record, credit: plan({ lastDue: "2026-06-20", from: 20, to: 15, editOn: "2026-07-01" })!.record.credit };
  const ts = (v: unknown): unknown =>
    v instanceof Date
      ? { toDate: () => v }
      : Array.isArray(v)
        ? v.map(ts)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ts(x)]))
          : v;
  expect(readProration(ts(withCredit))).toEqual(withCredit);
  expect(readProration(null)).toBeNull();
});
