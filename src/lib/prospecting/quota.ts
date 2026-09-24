import type { SubAccountDoc } from "@/types";

/**
 * Monthly prospect-report quota per sub-account. The agency owner sets
 * `prospectingReportQuota` in the Manage dialog (integer 0–1000); a
 * sub-account that never had one set gets this default. Enforced by the
 * report route (Prospecting PR 2), not here.
 */
export const PROSPECT_REPORT_QUOTA_DEFAULT = 50;

export function prospectReportQuota(
  sub: Pick<SubAccountDoc, "prospectingReportQuota">,
): number {
  return typeof sub.prospectingReportQuota === "number"
    ? sub.prospectingReportQuota
    : PROSPECT_REPORT_QUOTA_DEFAULT;
}
