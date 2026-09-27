import { describe, expect, it } from "vitest";
import {
  PROSPECT_REPORT_QUOTA_DEFAULT,
  PROSPECTING_FIRST_TOUCH_CAP_DEFAULT,
  parseProspectReportQuota,
  prospectReportQuota,
  prospectingFirstTouchCap,
} from "./quota";

describe("prospectReportQuota", () => {
  it("defaults to 50 when the sub-account has no quota set", () => {
    expect(PROSPECT_REPORT_QUOTA_DEFAULT).toBe(50);
    expect(prospectReportQuota({})).toBe(50);
  });

  it("returns the agency-set quota, including 0", () => {
    expect(prospectReportQuota({ prospectingReportQuota: 120 })).toBe(120);
    expect(prospectReportQuota({ prospectingReportQuota: 0 })).toBe(0);
  });
});

describe("parseProspectReportQuota (the Manage dialog's quota field)", () => {
  it.each([
    ["0", 0],
    ["50", 50],
    [" 120 ", 120],
    ["1000", 1000],
    ["007", 7],
  ])("accepts %j as %i", (input, expected) => {
    expect(parseProspectReportQuota(input)).toBe(expected);
  });

  it.each(["", " ", "1e2", "0x10", "12.0", "1.5", "-1", "+5", "1001", "abc", "5 0", "Infinity"])(
    "refuses %j",
    (input) => {
      expect(parseProspectReportQuota(input)).toBeNull();
    },
  );
});

describe("prospectingFirstTouchCap", () => {
  it("defaults to 20 when unset or the sub-account is missing", () => {
    expect(PROSPECTING_FIRST_TOUCH_CAP_DEFAULT).toBe(20);
    expect(prospectingFirstTouchCap({})).toBe(20);
    expect(prospectingFirstTouchCap(null)).toBe(20);
  });

  it("returns the agency-set cap, including 0", () => {
    expect(prospectingFirstTouchCap({ prospectingDailyFirstTouchCap: 2 })).toBe(2);
    expect(prospectingFirstTouchCap({ prospectingDailyFirstTouchCap: 0 })).toBe(0);
  });
});
