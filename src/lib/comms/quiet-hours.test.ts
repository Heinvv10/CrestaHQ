import { describe, expect, it } from "vitest";
import { quietHoursHold, SELF_TRIGGERED_EXEMPT_MS } from "./quiet-hours";
import type { SubAccountDoc } from "@/types";

/**
 * The quiet-hours decision itself. The window is the workspace's sendWindow
 * (the hours automated messages MAY go out), in its own timezone.
 * 21:00Z is 23:00 in Johannesburg (UTC+2, no DST).
 */

const sub = {
  sendWindow: { startHour: 8, endHour: 20, timezone: "Africa/Johannesburg" },
} as Pick<SubAccountDoc, "sendWindow">;
const at2300Sast = new Date("2026-09-24T21:00:00Z");
const nextOpen = new Date("2026-09-25T06:00:00Z"); // 08:00 SAST

describe("quietHoursHold", () => {
  it("holds an automated send at 23:00 SAST until the window opens at 08:00", () => {
    const hold = quietHoursHold({ subAccount: sub, now: at2300Sast });
    expect(hold).toEqual({ retryAfterSec: 9 * 3600, until: nextOpen });
  });

  it("treats a caller that does not say as automated", () => {
    expect(quietHoursHold({ subAccount: sub, origin: undefined, now: at2300Sast })).not.toBeNull();
  });

  it("never holds a manual send", () => {
    expect(quietHoursHold({ subAccount: sub, origin: "manual", now: at2300Sast })).toBeNull();
  });

  it("does not hold inside the window", () => {
    expect(quietHoursHold({ subAccount: sub, now: new Date("2026-09-24T10:00:00Z") })).toBeNull();
  });

  it("before the window opens, holds until it opens the same day", () => {
    const hold = quietHoursHold({ subAccount: sub, now: new Date("2026-09-25T03:30:00Z") }); // 05:30
    expect(hold?.until).toEqual(nextOpen);
  });

  it("holds nothing for a workspace with no window set", () => {
    expect(quietHoursHold({ subAccount: { sendWindow: null }, now: at2300Sast })).toBeNull();
    expect(quietHoursHold({ subAccount: null, now: at2300Sast })).toBeNull();
  });

  it("lets a confirmation of the customer's own booking made minutes ago through", () => {
    const bookedAt = new Date(at2300Sast.getTime() - 3 * 60_000);
    expect(quietHoursHold({ subAccount: sub, selfTriggeredBookingAt: bookedAt, now: at2300Sast })).toBeNull();
  });

  it("holds a booking message once the booking is older than the exemption", () => {
    const bookedAt = new Date(at2300Sast.getTime() - SELF_TRIGGERED_EXEMPT_MS - 1000);
    expect(quietHoursHold({ subAccount: sub, selfTriggeredBookingAt: bookedAt, now: at2300Sast })).not.toBeNull();
  });
});
