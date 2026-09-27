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

/**
 * The Manage dialog's quota field: digits only (after trimming), 0–1000.
 * `Number()` alone would accept "", " ", "1e2" and "0x10". Null = refuse.
 */
export function parseProspectReportQuota(input: string): number | null {
  const t = input.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n <= 1000 ? n : null;
}

/**
 * First-touch prospect sends a day per sub-account (the approach guard's cap,
 * lib/prospecting/approach-guard.ts). The agency owner sets
 * `prospectingDailyFirstTouchCap` in the Manage dialog (integer 0–1000,
 * parsed like the report quota); unset gets this default.
 */
export const PROSPECTING_FIRST_TOUCH_CAP_DEFAULT = 20;

export function prospectingFirstTouchCap(
  sub: Pick<SubAccountDoc, "prospectingDailyFirstTouchCap"> | null | undefined,
): number {
  return typeof sub?.prospectingDailyFirstTouchCap === "number"
    ? sub.prospectingDailyFirstTouchCap
    : PROSPECTING_FIRST_TOUCH_CAP_DEFAULT;
}
