import { describe, expect, it } from "vitest";

import { parseScheduleCreate } from "./schedule-input";
import { defaultScheduleValues, previewFirstRun, schedulePayload } from "./schedule-form";

/**
 * The form's promise to the operator.
 *
 * "First invoice on 1 February" is the one thing they read before creating a
 * schedule that then bills a real customer unattended. If the preview and the
 * server ever disagree, the operator was told a date that was never going to
 * happen — so the test is that they agree, not that either looks right alone.
 */

const JHB = "Africa/Johannesburg";

const CASES = [
  { startDateString: "2026-01-15", cadenceUnit: "month" as const, cadenceInterval: 1 },
  { startDateString: "2026-01-31", cadenceUnit: "month" as const, cadenceInterval: 1 },
  { startDateString: "2026-03-07", cadenceUnit: "quarter" as const, cadenceInterval: 1 },
  { startDateString: "2026-06-30", cadenceUnit: "week" as const, cadenceInterval: 2 },
  { startDateString: "2026-11-01", cadenceUnit: "year" as const, cadenceInterval: 1 },
];

describe("previewFirstRun", () => {
  it.each(CASES)(
    "shows the same first billing date the server computes ($startDateString, $cadenceUnit)",
    (override) => {
      const values = { ...defaultScheduleValues(JHB), name: "Retainer", ...override };
      const parsed = parseScheduleCreate(
        {
          ...schedulePayload(values),
          lineItems: [{ id: "a", description: "x", quantity: 1, unitPrice: 100 }],
        },
        JHB,
      );
      if (!parsed.ok) throw new Error(parsed.error);

      const serverDay = new Intl.DateTimeFormat("en-GB", {
        timeZone: JHB,
        day: "numeric",
        month: "long",
        year: "numeric",
      }).format(parsed.value.nextRunAt);

      expect(previewFirstRun(values)).toBe(serverDay);
    },
  );

  it("shows nothing rather than a guess when the date is incomplete", () => {
    const values = { ...defaultScheduleValues(JHB), startDateString: "2026-01" };
    expect(previewFirstRun(values)).toBeNull();
  });
});

describe("defaultScheduleValues", () => {
  it("starts today in the workspace's own timezone", () => {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: JHB,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    expect(defaultScheduleValues(JHB).startDateString).toBe(today);
  });

  it("defaults to monthly, auto-send, escalating at two unpaid invoices", () => {
    const values = defaultScheduleValues(JHB);
    expect(values.cadenceUnit).toBe("month");
    expect(values.reviewFirst).toBe(false);
    expect(values.unpaidEscalationThreshold).toBe(2);
  });
});
