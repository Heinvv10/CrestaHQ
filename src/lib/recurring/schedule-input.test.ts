import { describe, expect, it } from "vitest";

import { parseScheduleCreate, parseScheduleUpdate } from "./schedule-input";
import type { RecurringInvoiceStatus } from "@/types/recurring-invoices";

/**
 * What an operator is allowed to ask for.
 *
 * Every refusal here is a schedule that would otherwise have been written and
 * then billed somebody wrongly, unattended, on a cadence — so the refusals
 * matter at least as much as the arithmetic.
 */

const JHB = "Africa/Johannesburg";

/** The local calendar date an instant falls on, as YYYY-MM-DD. */
function localDate(d: Date, tz = JHB): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

const LINE_ITEMS = [
  { id: "a", description: "Retainer", quantity: 1, unitPrice: 5000, productId: null },
];

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "Acme retainer",
    cadence: { unit: "month", interval: 1 },
    startDateString: "2026-01-15",
    timezone: JHB,
    currency: "ZAR",
    lineItems: LINE_ITEMS,
    ...overrides,
  };
}

function created(overrides: Record<string, unknown> = {}) {
  const result = parseScheduleCreate(createBody(overrides), "UTC");
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.value;
}

describe("parseScheduleCreate", () => {
  it("anchors the first run to the operator's chosen day, this month", () => {
    const value = created({ startDateString: "2026-01-15", anchorDay: 31 });
    expect(localDate(value.nextRunAt)).toBe("2026-01-31");
    expect(value.anchorDay).toBe(31);
  });

  it("waits for next cycle when the anchor has already passed this month", () => {
    // Created on the 15th, anchored to the 1st: billing immediately would
    // charge the customer twice in the period they are already in.
    const value = created({ startDateString: "2026-01-15", anchorDay: 1 });
    expect(localDate(value.nextRunAt)).toBe("2026-02-01");
  });

  it("takes the anchor from the start date when none is given", () => {
    const value = created({ startDateString: "2026-03-07" });
    expect(value.anchorDay).toBe(7);
    expect(localDate(value.nextRunAt)).toBe("2026-03-07");
  });

  it("has no anchor day for a weekly cadence and starts on the start date", () => {
    const value = created({
      cadence: { unit: "week", interval: 2 },
      startDateString: "2026-01-15",
      anchorDay: 9,
    });
    expect(value.anchorDay).toBeNull();
    expect(localDate(value.nextRunAt)).toBe("2026-01-15");
  });

  it("falls back to the sub-account's timezone, then UTC", () => {
    const withSub = parseScheduleCreate(
      { ...createBody(), timezone: undefined },
      JHB,
    );
    expect(withSub.ok && withSub.value.timezone).toBe(JHB);

    const withNeither = parseScheduleCreate(
      { ...createBody(), timezone: "Mars/Olympus" },
      "Also/Nonsense",
    );
    expect(withNeither.ok && withNeither.value.timezone).toBe("UTC");
  });

  it("defaults reviewFirst off and the escalation threshold to 2", () => {
    const value = created();
    expect(value.reviewFirst).toBe(false);
    expect(value.unpaidEscalationThreshold).toBe(2);
  });

  it("keeps a zero escalation threshold, which disables escalation", () => {
    // Clamping 0 up to the default would quietly re-enable Tasks for an
    // operator who deliberately turned them off.
    expect(created({ unpaidEscalationThreshold: 0 }).unpaidEscalationThreshold).toBe(0);
  });

  it("refuses a schedule with no line items", () => {
    const result = parseScheduleCreate(createBody({ lineItems: [] }), "UTC");
    expect(result.ok).toBe(false);
  });

  it("refuses a nameless schedule", () => {
    const result = parseScheduleCreate(createBody({ name: "   " }), "UTC");
    expect(result.ok).toBe(false);
  });

  it("refuses an unknown cadence unit or a zero interval", () => {
    expect(parseScheduleCreate(createBody({ cadence: { unit: "fortnight", interval: 1 } }), "UTC").ok).toBe(false);
    expect(parseScheduleCreate(createBody({ cadence: { unit: "month", interval: 0 } }), "UTC").ok).toBe(false);
  });

  it("refuses a malformed start date rather than rolling it forward", () => {
    // "2026-02-31" through the Date constructor would silently become 3 March.
    expect(parseScheduleCreate(createBody({ startDateString: "2026-02-31" }), "UTC").ok).toBe(false);
    expect(parseScheduleCreate(createBody({ startDateString: "15/01/2026" }), "UTC").ok).toBe(false);
  });

  it("refuses an end date that falls before the first billing date", () => {
    const result = parseScheduleCreate(
      createBody({
        startDateString: "2026-01-15",
        anchorDay: 1,
        endMode: "on_date",
        endDateString: "2026-01-20",
      }),
      "UTC",
    );
    // First run would be 1 Feb — the schedule would be born completed.
    expect(result.ok).toBe(false);
  });

  it("requires a count of at least one for endMode after_count", () => {
    expect(parseScheduleCreate(createBody({ endMode: "after_count", maxCycles: 0 }), "UTC").ok).toBe(false);
    const value = created({ endMode: "after_count", maxCycles: 12 });
    expect(value.maxCycles).toBe(12);
    expect(value.endAt).toBeNull();
  });
});

const CURRENT = {
  cadence: { unit: "month", interval: 1 } as const,
  anchorDay: 15,
  timezone: JHB,
  status: "active" as RecurringInvoiceStatus,
  nextRunAt: new Date("2026-06-15T22:00:00Z"),
};

function updated(body: Record<string, unknown>, now = new Date("2026-06-10T12:00:00Z")) {
  const result = parseScheduleUpdate(body, CURRENT, now);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.value;
}

describe("parseScheduleUpdate", () => {
  it("changes only the fields present in the body", () => {
    const value = updated({ name: "Renamed" });
    expect(value.name).toBe("Renamed");
    expect(Object.keys(value)).toEqual(["name"]);
  });

  it("recomputes the next run when the cadence moves, never into the past", () => {
    const now = new Date("2026-06-10T12:00:00Z");
    const value = updated({ cadence: { unit: "quarter", interval: 1 } }, now);
    // Anchored to the 15th, edited on the 10th: the 15th of this month.
    expect(value.recomputeNextRunFrom).toBeDefined();
    expect(localDate(value.recomputeNextRunFrom!)).toBe("2026-06-15");
    expect(value.recomputeNextRunFrom!.getTime()).toBeGreaterThanOrEqual(now.getTime());
  });

  it("recomputes the next run when only the anchor day moves", () => {
    const value = updated({ anchorDay: 28 });
    expect(localDate(value.recomputeNextRunFrom!)).toBe("2026-06-28");
  });

  it("leaves the next run alone for an edit that is not about timing", () => {
    expect(updated({ reviewFirst: true }).recomputeNextRunFrom).toBeUndefined();
  });

  it("allows pause, resume and cancel", () => {
    expect(updated({ status: "paused" }).status).toBe("paused");
    expect(updated({ status: "active" }).status).toBe("active");
    expect(updated({ status: "cancelled" }).status).toBe("cancelled");
  });

  it("refuses to let an operator declare a schedule completed", () => {
    // `completed` is the engine's word for "the end condition was met". A form
    // asserting it would let a schedule claim a history it does not have.
    const result = parseScheduleUpdate({ status: "completed" }, CURRENT, new Date());
    expect(result.ok).toBe(false);
  });

  it("refuses any change to a finished or cancelled schedule", () => {
    for (const status of ["completed", "cancelled"] as RecurringInvoiceStatus[]) {
      const result = parseScheduleUpdate(
        { status: "active" },
        { ...CURRENT, status },
        new Date(),
      );
      expect(result.ok).toBe(false);
    }
  });

  it("refuses to empty the line items of a live schedule", () => {
    const result = parseScheduleUpdate({ lineItems: [] }, CURRENT, new Date());
    expect(result.ok).toBe(false);
  });
});

describe("blank templates and dead-on-arrival edits", () => {
  it("refuses a template whose only line item bills for nothing", () => {
    // The sanitiser turns `{}` into a valid zero item, so a length check alone
    // would write a schedule that mails a nil invoice every cycle forever.
    const result = parseScheduleCreate(createBody({ lineItems: [{}] }), "UTC");
    expect(result.ok).toBe(false);
  });

  it("accepts a zero-priced line item that says what it is", () => {
    // An included-in-the-retainer line is a real thing to print on an invoice.
    const value = created({
      lineItems: [{ id: "a", description: "Hosting (included)", quantity: 1, unitPrice: 0 }],
    });
    expect(value.lineItems).toHaveLength(1);
  });

  it("refuses an end date that falls before the next billing date", () => {
    const result = parseScheduleUpdate(
      { endMode: "on_date", endDateString: "2026-06-01" },
      CURRENT,
      new Date("2026-05-20T12:00:00Z"),
    );
    expect(result.ok).toBe(false);
  });

  it("judges that end date against the cadence being set in the same edit", () => {
    // Moving to yearly pushes the next cycle out to 2027; an end date in 2026
    // that looked fine against the old monthly cycle no longer is.
    const result = parseScheduleUpdate(
      {
        cadence: { unit: "year", interval: 1 },
        endMode: "on_date",
        endDateString: "2026-12-31",
      },
      CURRENT,
      new Date("2026-06-20T12:00:00Z"),
    );
    expect(result.ok).toBe(false);
  });

  // Note: this pins the weekly behaviour, NOT the `"anchorDay" in out` guard
  // beside it in the source. That guard is unobservable today, because
  // `computeFirstRunAt` ignores `anchorDay` for week cadences entirely — it is
  // there so the next person to touch that function does not inherit a stale
  // anchor. A test asserting it would pass either way, which is worse than none.
  it("clears the day-of-month anchor when moving to a weekly cadence", () => {
    const result = parseScheduleUpdate(
      { cadence: { unit: "week", interval: 1 } },
      CURRENT,
      new Date("2026-06-10T12:00:00Z"),
    );
    expect(result.ok && result.value.anchorDay).toBeNull();
    // Weekly starts from the edit date itself, not from the old 15th anchor.
    expect(
      result.ok && localDate(result.value.recomputeNextRunFrom!),
    ).toBe("2026-06-10");
  });
});

describe("chargeMode", () => {
  const refusal = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error);

  it("defaults to invoice, and accepts card on a ZAR schedule", () => {
    expect(created().chargeMode).toBe("invoice");
    expect(created({ chargeMode: "card" }).chargeMode).toBe("card");
  });

  it("refuses card together with review-first — an unattended charge cannot wait", () => {
    expect(refusal(parseScheduleCreate(createBody({ chargeMode: "card", reviewFirst: true }), "UTC"))).toMatch(/review/i);
    // …whichever half the PATCH changes.
    const card = { ...CURRENT, currency: "ZAR", reviewFirst: false, chargeMode: "card" as const };
    expect(refusal(parseScheduleUpdate({ reviewFirst: true }, card, new Date()))).toMatch(/review/i);
    const review = { ...CURRENT, currency: "ZAR", reviewFirst: true };
    expect(refusal(parseScheduleUpdate({ chargeMode: "card" }, review, new Date()))).toMatch(/review/i);
  });

  it("refuses card on a non-ZAR schedule, on create and on a currency change", () => {
    expect(refusal(parseScheduleCreate(createBody({ chargeMode: "card", currency: "USD" }), "UTC"))).toMatch(/ZAR/);
    const card = { ...CURRENT, currency: "ZAR", reviewFirst: false, chargeMode: "card" as const };
    expect(refusal(parseScheduleUpdate({ currency: "USD" }, card, new Date()))).toMatch(/ZAR/);
    expect(parseScheduleUpdate({ chargeMode: "invoice", currency: "USD" }, card, new Date()).ok).toBe(true);
  });

  it("refuses an unknown mode", () => {
    expect(parseScheduleCreate(createBody({ chargeMode: "direct_debit" }), "UTC").ok).toBe(false);
  });
});
