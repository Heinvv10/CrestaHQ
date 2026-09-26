import type { ProspectFinding } from "@/types";
import { detectTech, type TechCategory } from "./tech-rules";
import { measured, unavailable, type Scored, type SectionInput } from "./types";

/**
 * Section 6 — tech stack fingerprinted from the homepage (rules in
 * tech-rules.ts). Chat widgets are listed here but the `no_chat_widget`
 * finding belongs to lead_capture.
 */

export const key = "tech_stack" as const;

export interface TechStackRaw {
  detected: { name: string; category: TechCategory }[];
}

const ANALYTICS_POINTS = 60;
const PIXEL_POINTS = 40;

export function score(raw: TechStackRaw): Scored {
  const has = (category: TechCategory) => raw.detected.some((t) => t.category === category);
  const findings: ProspectFinding[] = [];
  let points = 0;
  if (has("analytics")) points += ANALYTICS_POINTS;
  else {
    findings.push({
      code: "no_analytics",
      text: "The website has no analytics, so visits and enquiries are not being measured.",
    });
  }
  if (has("ads_pixel")) points += PIXEL_POINTS;
  return { score: points, findings };
}

export async function run(input: SectionInput) {
  if (!input.business.website) return unavailable(key, "No website to inspect.");
  if (!input.homepage) return unavailable(key, "The website could not be fetched.");
  const raw: TechStackRaw = {
    detected: detectTech(input.homepage.html).map(({ name, category }) => ({ name, category })),
  };
  return measured(key, score(raw), { ...raw });
}
