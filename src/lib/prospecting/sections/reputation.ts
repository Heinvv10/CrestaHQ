import type { ProspectFinding } from "@/types";
// Relative `.ts` imports: scripts/prospecting/backfill-r0b.ts imports this file.
import { finding, scoreOf } from "./findings.ts";
import { measured, unavailable, type Scored, type SectionInput } from "./types.ts";

/**
 * Section 3 — reputation from the Places rating + review count the contact
 * already carries (decision D2: no Atmosphere/reviews SKU). Review velocity
 * and owner reply rate need review samples, so they are reported as not
 * measured rather than estimated.
 */

export const key = "reputation" as const;

export interface ReputationRaw {
  rating: number | null;
  reviewsCount: number | null;
}

const FEW_REVIEWS = 10;
const LOW_RATING = 4.0;
/** Below these a business is behind the ones customers compare it with. */
const REVIEWS_TARGET = 50;
const RATING_TARGET = 4.8;

/** Each measure raises at most one code: the stricter replaces the milder. */
export function score(raw: ReputationRaw): Scored {
  const count = raw.reviewsCount ?? 0;
  if (count === 0) {
    const findings = [finding("no_reviews", "There are no Google reviews yet.")];
    return { score: scoreOf(findings), findings };
  }
  const findings: ProspectFinding[] = [];
  if (count < FEW_REVIEWS) {
    findings.push(finding("few_reviews", `Only ${count} Google review${count === 1 ? "" : "s"}.`));
  } else if (count < REVIEWS_TARGET) {
    findings.push(finding("reviews_under_50", `There are ${count} Google reviews, fewer than 50.`));
  }
  if (raw.rating !== null && raw.rating < LOW_RATING) {
    findings.push(finding("low_rating", `The Google rating is ${raw.rating.toFixed(1)} out of 5, below 4.0.`));
  } else if (raw.rating !== null && raw.rating < RATING_TARGET) {
    findings.push(finding("rating_under_4_8", `The Google rating is ${raw.rating.toFixed(1)} out of 5, below 4.8.`));
  }
  return { score: scoreOf(findings), findings };
}

export async function run(input: SectionInput) {
  const raw: ReputationRaw = {
    rating: input.business.rating,
    reviewsCount: input.business.reviewsCount,
  };
  const notMeasured = { velocity90d: "notMeasured", ownerReplyRate: "notMeasured" };
  if (raw.rating === null && raw.reviewsCount === null) {
    return unavailable(key, "Google returned no rating data for this business.", notMeasured);
  }
  return measured(key, score(raw), { ...raw, ...notMeasured });
}
