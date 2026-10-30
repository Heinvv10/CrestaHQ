import type { ProspectFindingCode, ProspectSectionResult } from "@/types";

/**
 * Fixed severity ranking for the report headline, worst first. The first six
 * are the plan's order (docs/programme/prospecting-module.md); the rest put
 * what loses a customer today (no way to reach or trust the business) ahead
 * of what only limits growth (listings, analytics, ads).
 *
 * Imports types only: scripts/prospecting/backfill-r0b.ts runs it under
 * `node --experimental-strip-types`.
 */
export const SEVERITY_ORDER = [
  "no_website",
  "no_https",
  "not_in_ai_answers",
  "gbp_unclaimed",
  "slow_mobile",
  "ai_crawlers_blocked",
  "no_whatsapp_cta",
  "no_reviews",
  "low_rating",
  "no_contact_form",
  "no_phone_link",
  "gbp_no_phone",
  "gbp_no_hours",
  "no_booking",
  "few_reviews",
  "gbp_no_photos",
  "gbp_no_description",
  "listing_missing",
  "no_local_business_schema",
  "no_chat_widget",
  "no_analytics",
  "no_ads_running",
  // R0b: codes for deductions that had no finding before. Ranked below every
  // other code, so they are the headline only when nothing worse exists.
  "no_mobile_viewport",
  "lcp_needs_improvement",
  "ai_mentions_partial",
  "rating_under_4_8",
  "reviews_under_50",
] as const satisfies readonly ProspectFindingCode[];

// Compile-time exhaustiveness: adding a finding code without ranking it here
// fails typecheck.
type Unranked = Exclude<ProspectFindingCode, (typeof SEVERITY_ORDER)[number]>;
const _everyCodeRanked: [Unranked] extends [never] ? true : Unranked = true;

const RANK = new Map<ProspectFindingCode, number>(SEVERITY_ORDER.map((code, i) => [code, i]));

/**
 * The text of the worst finding among measured (`ok`) sections, or null.
 * Ties keep the first seen: section order, then finding order.
 */
export function headline(sections: ProspectSectionResult[]): string | null {
  let best: { rank: number; text: string } | null = null;
  for (const section of sections) {
    if (section.status !== "ok") continue;
    for (const finding of section.findings) {
      const rank = RANK.get(finding.code)!;
      if (!best || rank < best.rank) best = { rank, text: finding.text };
    }
  }
  return best?.text ?? null;
}
