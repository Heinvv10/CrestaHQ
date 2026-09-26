import type { ProspectFinding } from "@/types";
import { measured, unavailable, type Scored, type SectionInput } from "./types";

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
/** Review count at which the volume half of the score is full. */
const VOLUME_CAP = 50;

export function score(raw: ReputationRaw): Scored {
  const count = raw.reviewsCount ?? 0;
  if (count === 0) {
    return {
      score: 0,
      findings: [{ code: "no_reviews", text: "There are no Google reviews yet." }],
    };
  }
  const findings: ProspectFinding[] = [];
  if (count < FEW_REVIEWS) {
    findings.push({ code: "few_reviews", text: `Only ${count} Google review${count === 1 ? "" : "s"}.` });
  }
  if (raw.rating !== null && raw.rating < LOW_RATING) {
    findings.push({
      code: "low_rating",
      text: `The Google rating is ${raw.rating.toFixed(1)} out of 5, below 4.0.`,
    });
  }
  const volume = Math.min(count, VOLUME_CAP) / VOLUME_CAP;
  const points = raw.rating === null ? volume * 100 : volume * 40 + (raw.rating / 5) * 60;
  return { score: Math.round(points), findings };
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
