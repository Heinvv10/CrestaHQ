import type { ProspectFinding } from "@/types";
import { finding, scoreOf } from "./findings";
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

/** An ads pixel is listed but not scored: a business that runs no ads needs none. */
export function score(raw: TechStackRaw): Scored {
  const has = (category: TechCategory) => raw.detected.some((t) => t.category === category);
  const findings: ProspectFinding[] = [];
  if (!has("analytics")) {
    findings.push(
      finding("no_analytics", "The website has no analytics, so visits and enquiries are not being measured."),
    );
  }
  return { score: scoreOf(findings), findings };
}

export async function run(input: SectionInput) {
  if (!input.business.website) return unavailable(key, "No website to inspect.");
  if (!input.homepage) return unavailable(key, "The website could not be fetched.");
  const raw: TechStackRaw = {
    detected: detectTech(input.homepage.html).map(({ name, category }) => ({ name, category })),
  };
  return measured(key, score(raw), { ...raw });
}
