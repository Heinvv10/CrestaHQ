import type { ProspectFinding, ProspectSectionResult } from "@/types";
import type { ApexgeoScan } from "../apexgeo-client";
import { finding, scoreOf } from "./findings";
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
  const lcp = seconds(vitals.lcp_ms);
  // One code per measure: slow_mobile replaces lcp_needs_improvement.
  if (vitals.lcp_ms > SLOW_LCP_MS) {
    findings.push(
      finding("slow_mobile", `On a phone the homepage takes ${lcp}s to show its main content (slow is over 4s).`),
    );
  } else if (vitals.lcp_ms > GOOD_LCP_MS) {
    findings.push(
      finding(
        "lcp_needs_improvement",
        `On a phone the homepage takes ${lcp}s to show its main content, slower than the 2.5s that counts as fast.`,
      ),
    );
  }
  if (technical.mobile_viewport === false) {
    findings.push(
      finding("no_mobile_viewport", "The website has no mobile layout, so phones show a shrunken desktop page."),
    );
  }
  return { score: scoreOf(findings), findings };
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
