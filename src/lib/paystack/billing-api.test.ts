import { describe, expect, it } from "vitest";

import { notBeforeNow } from "./billing-api";

/**
 * A plan switch schedules the new subscription for the old one's renewal date.
 * On a past_due subscription that date is already behind us, and Paystack
 * rejects a start_date in the past — after the old subscription has already
 * been disabled, which would leave the client with no subscription at all.
 */
describe("notBeforeNow", () => {
  const now = new Date("2026-09-04T12:00:00.000Z");

  it("keeps a future renewal date exactly as Paystack gave it", () => {
    expect(notBeforeNow("2026-10-01T00:00:00.000Z", now)).toBe(
      "2026-10-01T00:00:00.000Z",
    );
  });

  it("pulls a renewal date that has already passed forward to now", () => {
    // The client owes this cycle already, so starting now is the correct
    // charge as well as the only one Paystack will accept.
    expect(notBeforeNow("2026-08-01T00:00:00.000Z", now)).toBe(
      now.toISOString(),
    );
  });

  it("treats a date it cannot read as past rather than passing it through", () => {
    // Failing the switch here strands the client; charging one cycle early at
    // worst does not.
    expect(notBeforeNow("not a date", now)).toBe(now.toISOString());
  });
});
