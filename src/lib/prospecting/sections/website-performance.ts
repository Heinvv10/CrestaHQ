import type { ProspectFinding, ProspectSectionResult } from "@/types";
import type { ApexgeoScan } from "../apexgeo-client";
import { measured, unavailable, type Scored } from "./types";

/**
 * Section 5 — website performance, from the ApexGEO scan's `technical`
 * block (Google PageSpeed, mobile strategy). A missing Core Web Vitals
 * result means "not measured", never "slow". `no_https` is not raised here:
 * business_details already owns it.
 */

export const key = "website_performance" as const;

/** Google's "poor" LCP threshold. */
const SLOW_LCP_MS = 4000;
const GOOD_LCP_MS = 2500;

const seconds = (ms: number) => Math.round(ms / 100) / 10;

export function score(technical: ApexgeoScan["technical"]): Scored | null {
  const vitals = technical?.core_web_vitals;
  if (!technical || !vitals) return null;
  const findings: ProspectFinding[] = [];
  let score = vitals.lcp_ms <= GOOD_LCP_MS ? 100 : vitals.lcp_ms <= SLOW_LCP_MS ? 70 : 30;
  if (vitals.lcp_ms > SLOW_LCP_MS) {
    findings.push({
      code: "slow_mobile",
      text: `On a phone the homepage takes ${seconds(vitals.lcp_ms)}s to show its main content (slow is over 4s).`,
    });
  }
  if (technical.mobile_viewport === false) score -= 20;
  return { score: Math.max(0, score), findings };
}

export function result(scan: ApexgeoScan): ProspectSectionResult {
  const technical = scan.technical;
  const scored = score(technical);
  if (!technical || !scored) return unavailable(key, "Page speed could not be measured for this website.");
  const vitals = technical.core_web_vitals!;
  return measured(key, scored, {
    lcpSeconds: seconds(vitals.lcp_ms),
    fcpSeconds: seconds(vitals.fcp_ms),
    speedIndexSeconds: seconds(vitals.speed_index_ms),
    tbtMs: Math.round(vitals.tbt_ms),
    cls: Math.round(vitals.cls * 1000) / 1000,
    mobileViewport: technical.mobile_viewport ?? "notMeasured",
  });
}
