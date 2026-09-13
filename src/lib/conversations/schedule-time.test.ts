import { describe, expect, it } from "vitest";
import { checkSendLaterValue, zoneLabel } from "./schedule-time";

const NOW = Date.parse("2026-09-13T10:00:00Z");

describe("checkSendLaterValue", () => {
  it("reads the value in the given zone", () => {
    expect(checkSendLaterValue("2026-09-13T14:00", "Africa/Johannesburg", NOW)).toEqual({
      ok: true,
      iso: "2026-09-13T12:00:00.000Z",
    });
  });

  it.each([
    ["empty", ""],
    ["garbage", "tomorrow"],
    ["in the past", "2026-09-13T09:00"],
    ["under a minute ahead", "2026-09-13T10:00"],
    ["beyond 7 days", "2026-09-20T10:01"],
    ["far beyond", "2027-01-01T09:00"],
  ])("refuses %s with a reason", (_label, value) => {
    const r = checkSendLaterValue(value, "UTC", NOW);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBeTruthy();
  });

  it("accepts exactly 7 days ahead", () => {
    expect(checkSendLaterValue("2026-09-20T10:00", "UTC", NOW).ok).toBe(true);
  });
});

describe("zoneLabel", () => {
  it("does not repeat an abbreviation equal to the zone", () => {
    expect(zoneLabel("UTC", NOW)).toBe("UTC");
  });
  it("names the abbreviation when it differs", () => {
    expect(zoneLabel("Africa/Johannesburg", NOW)).toMatch(/^Africa\/Johannesburg \(.+\)$/);
  });
});
