import { describe, expect, it } from "vitest";

import {
  computeFirstRunAt,
  computeNextRunAt,
  daysInMonth,
  normalizeAnchorDay,
  resolveAnchorDay,
} from "./cadence";

/**
 * Billing dates. Every case here is a date a customer would be invoiced on, so
 * getting one wrong bills someone early, late, or in the wrong month — every
 * cycle, unattended, until a human notices.
 */

const JHB = "Africa/Johannesburg"; // UTC+2, no DST
const NY = "America/New_York"; // DST, to prove the arithmetic is not UTC math

/** The local calendar date an instant falls on, as YYYY-MM-DD. */
function localDate(d: Date, tz: string): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  return p;
}

function next(previous: string, anchorDay: number | null, tz = JHB) {
  return localDate(
    computeNextRunAt({
      previous: new Date(previous),
      cadence: { unit: "month", interval: 1 },
      anchorDay,
      timezone: tz,
    }),
    tz,
  );
}

/**
 * Fixtures use NOON UTC so the instant falls on the same calendar day in
 * Johannesburg (UTC+2). A 22:00Z fixture is already the NEXT day there — which
 * is the whole reason this module reads dates in the schedule's timezone, and
 * is worth stating because it caught these tests out first.
 */
describe("month-end anchors", () => {
  it("clamps February and RETURNS to the 31st in March", () => {
    // The sharpest bug in this module: clamping from the previous cycle's
    // already-clamped day gives 31 Jan -> 28 Feb -> 28 Mar, and one February
    // costs the schedule its month-end anchor for good.
    const feb = next("2026-01-31T12:00:00.000Z", 31);
    expect(feb).toBe("2026-02-28");
    const mar = next("2026-02-28T12:00:00.000Z", 31);
    expect(mar).toBe("2026-03-31");
  });

  it("uses the 29th in a leap February", () => {
    expect(next("2028-01-31T12:00:00.000Z", 31)).toBe("2028-02-29");
  });

  it("clamps a 30th anchor in February and restores it in March", () => {
    expect(next("2026-01-30T12:00:00.000Z", 30)).toBe("2026-02-28");
    expect(next("2026-02-28T12:00:00.000Z", 30)).toBe("2026-03-30");
  });

  it("never rolls into the following month", () => {
    // Rolling (Feb 31 -> Mar 3) would walk a month-end schedule forward
    // until it drifted out of its month entirely.
    expect(next("2026-01-31T12:00:00.000Z", 31).startsWith("2026-02")).toBe(
      true,
    );
  });
});

describe("cadence units", () => {
  const at = (unit: "week" | "month" | "quarter" | "year", interval: number) =>
    localDate(
      computeNextRunAt({
        previous: new Date("2026-01-15T12:00:00.000Z"),
        cadence: { unit, interval },
        anchorDay: 16,
        timezone: JHB,
      }),
      JHB,
    );

  it("adds whole weeks from the date, ignoring the month anchor", () => {
    // 2026-01-15 is a Thursday; two weeks on is Thursday the 29th. The
    // anchorDay of 16 in this fixture must have no effect — a weekly schedule
    // that snapped to a day-of-month would drift off its weekday.
    expect(at("week", 2)).toBe("2026-01-29");
  });

  it("adds one month, three months and twelve months", () => {
    expect(at("month", 1)).toBe("2026-02-16");
    expect(at("quarter", 1)).toBe("2026-04-16");
    expect(at("year", 1)).toBe("2027-01-16");
  });

  it("multiplies the interval", () => {
    expect(at("month", 2)).toBe("2026-03-16");
    expect(at("quarter", 2)).toBe("2026-07-16");
  });

  it("crosses the year boundary", () => {
    expect(
      localDate(
        computeNextRunAt({
          previous: new Date("2026-11-15T12:00:00.000Z"),
          cadence: { unit: "quarter", interval: 1 },
          anchorDay: 16,
          timezone: JHB,
        }),
        JHB,
      ),
    ).toBe("2027-02-16");
  });

  it("treats a zero or negative interval as one rather than never advancing", () => {
    // A schedule that never advances would be re-raised by every sweep.
    expect(at("month", 0)).toBe("2026-02-16");
    expect(at("month", -3)).toBe("2026-02-16");
  });
});

describe("timezones", () => {
  it("bills on the local day, not the UTC one", () => {
    // 22:00 UTC on the 31st is already the 1st in Johannesburg. Reading the
    // date in UTC would put this schedule a month out.
    const d = computeNextRunAt({
      previous: new Date("2026-01-31T22:00:00.000Z"),
      cadence: { unit: "month", interval: 1 },
      anchorDay: 1,
      timezone: JHB,
    });
    expect(localDate(d, JHB)).toBe("2026-03-01");
  });

  it("lands on local midnight across a DST change", () => {
    // New York moves to DST in March; the instant differs, the local day
    // must not.
    const d = computeNextRunAt({
      previous: new Date("2026-02-10T05:00:00.000Z"),
      cadence: { unit: "month", interval: 1 },
      anchorDay: 10,
      timezone: NY,
    });
    expect(localDate(d, NY)).toBe("2026-03-10");
    expect(
      new Intl.DateTimeFormat("en-US", {
        timeZone: NY,
        hour: "2-digit",
        hour12: false,
      }).format(d),
    ).toBe("00");
  });
});

describe("computeFirstRunAt", () => {
  const first = (startAt: string, anchorDay: number | null, unit: "month" | "quarter" | "week" = "month") =>
    localDate(
      computeFirstRunAt({
        startAt: new Date(startAt),
        cadence: { unit, interval: 1 },
        anchorDay,
        timezone: JHB,
      }),
      JHB,
    );

  it("waits for the anchor rather than billing on the day it was created", () => {
    // Created on the 10th, anchored to the 1st: billing immediately would
    // charge the customer twice in one period.
    expect(first("2026-01-10T08:00:00.000Z", 1)).toBe("2026-02-01");
  });

  it("bills today when the start date IS the anchor", () => {
    expect(first("2026-01-01T08:00:00.000Z", 1)).toBe("2026-01-01");
  });

  it("bills later this month when the anchor is still ahead", () => {
    expect(first("2026-01-10T08:00:00.000Z", 20)).toBe("2026-01-20");
  });

  it("steps a whole cadence when the anchor has passed, not one month", () => {
    // A quarterly schedule must stay quarterly; falling back to "next month"
    // would bill three times as often as the operator asked.
    expect(first("2026-01-10T08:00:00.000Z", 1, "quarter")).toBe("2026-04-01");
  });

  it("starts a weekly schedule on its start date", () => {
    expect(first("2026-01-10T08:00:00.000Z", null, "week")).toBe("2026-01-10");
  });

  it("clamps a month-end anchor on the very first run", () => {
    expect(first("2026-02-01T08:00:00.000Z", 31)).toBe("2026-02-28");
  });
});

describe("anchor handling", () => {
  it("derives the anchor from the start date when none was given", () => {
    expect(
      resolveAnchorDay(
        { unit: "month", interval: 1 },
        new Date("2026-01-17T08:00:00.000Z"),
        JHB,
      ),
    ).toBe(17);
  });

  it("has no anchor for a weekly cadence", () => {
    expect(
      resolveAnchorDay(
        { unit: "week", interval: 1 },
        new Date("2026-01-17T08:00:00.000Z"),
        JHB,
      ),
    ).toBeNull();
  });

  it("pins a stored anchor into 1-31 so it cannot move a billing day", () => {
    expect(normalizeAnchorDay(0)).toBe(1);
    expect(normalizeAnchorDay(99)).toBe(31);
    expect(normalizeAnchorDay(NaN)).toBe(1);
    expect(normalizeAnchorDay(15.7)).toBe(15);
  });
});

describe("daysInMonth", () => {
  it("knows February in both kinds of year", () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2100, 2)).toBe(28); // centurial non-leap
  });
});
