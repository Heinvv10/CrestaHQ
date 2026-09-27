import type { ProspectFinding, ProspectSectionResult } from "@/types";
import type { ApexgeoScan } from "../apexgeo-client";
import { measured, unavailable, type Scored } from "./types";

/**
 * Section 7 — AI-agent readiness, from the ApexGEO scan's `ai_readiness`
 * block: can AI crawlers read the site, and does it describe itself as a
 * local business in structured data.
 *
 * Finding codes (decision D5): `ai_crawlers_blocked` when robots.txt blocks
 * any AI crawler (Bingbot is a search crawler, not counted) — ranked just
 * under `slow_mobile`, because a blocked crawler takes the business out of
 * AI answers outright. `no_local_business_schema` ranks low, beside
 * `listing_missing`: it weakens, it does not remove. A crawler whose robots
 * rule could not be read (null) is not measured and never counts as blocked.
 */

export const key = "ai_readiness" as const;

export const AI_CRAWLERS = ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended"] as const;

type Readiness = NonNullable<ApexgeoScan["ai_readiness"]>;

export function score(readiness: ApexgeoScan["ai_readiness"]): Scored | null {
  if (!readiness) return null;
  const findings: ProspectFinding[] = [];
  let score = 100;
  const blocked = blockedCrawlers(readiness);
  if (blocked.length > 0) {
    score -= 60;
    findings.push({
      code: "ai_crawlers_blocked",
      text: `The website's robots.txt blocks AI crawlers (${blocked.join(", ")}), so those assistants cannot read it.`,
    });
  }
  if (!readiness.local_business_schema) {
    score -= 30;
    findings.push({
      code: "no_local_business_schema",
      text: "The website has no LocalBusiness structured data telling search and AI engines what the business is and where.",
    });
  }
  return { score: Math.max(0, score), findings };
}

export function blockedCrawlers(readiness: Readiness): string[] {
  return AI_CRAWLERS.filter((bot) => readiness.robots[bot] === "blocked");
}

export function result(scan: ApexgeoScan): ProspectSectionResult {
  const readiness = scan.ai_readiness;
  const scored = score(readiness);
  if (!readiness || !scored) return unavailable(key, "AI readiness could not be measured for this website.");
  const raw: Record<string, unknown> = {
    localBusinessSchema: readiness.local_business_schema,
    robotsTxt: readiness.robots_txt ?? "notMeasured",
  };
  for (const bot of AI_CRAWLERS) raw[bot] = readiness.robots[bot] ?? "notMeasured";
  return measured(key, scored, raw);
}
