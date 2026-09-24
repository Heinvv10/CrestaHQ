import { describe, expect, it } from "vitest";
import { PROSPECT_REPORT_QUOTA_DEFAULT, prospectReportQuota } from "./quota";

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
