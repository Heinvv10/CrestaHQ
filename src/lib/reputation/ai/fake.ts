import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type { DraftInput, ReviewsAi, SentimentLabel } from "./types";

/**
 * Deterministic stand-in for the model, reachable only through select.ts
 * (fence: mode.ts + the fixture agency). The rule, in order:
 *   1. a negative phrase ("not happy", "late", "no signal", "bad", "poor",
 *      "terrible", "rude", "never") → negative
 *   2. a positive phrase ("promised", "fast", "friendly", "great",
 *      "excellent", "thank", "love", "good") → positive
 *   3. otherwise → neutral
 * Whole words only ("translated" is not "late"). Stars are not used — the
 * rule is about the text, like the real call.
 *
 * Every call appends `{at, ids, count}` — never text — to
 * `subAccounts/{id}/private/reviewsAiFakeLog`, so the E2E spec can count
 * what would have been billed. A reply draft appends `{at, kind: "draft",
 * stars}` to `drafts` in the same doc (its own array, so sentiment counts
 * stay exact).
 */

const NEGATIVE = ["not happy", "late", "no signal", "bad", "poor", "terrible", "rude", "never"];
const POSITIVE = ["promised", "fast", "friendly", "great", "excellent", "thank", "love", "good"];

export const fakeLogPath = (subAccountId: string) => `subAccounts/${subAccountId}/private/reviewsAiFakeLog`;

const has = (t: string, w: string) => new RegExp(`\\b${w}\\b`).test(t);

export function fakeLabel(text: string, _starRating: number): SentimentLabel {
  const t = text.toLowerCase();
  if (NEGATIVE.some((w) => has(t, w))) return "negative";
  if (POSITIVE.some((w) => has(t, w))) return "positive";
  return "neutral";
}

/** The fake's draft: the star rating, the first name, and the guidelines' first line echoed (so a test can see they arrived). */
export function fakeDraft(input: DraftInput): string {
  const hello = input.reviewerFirstName ? `Hi ${input.reviewerFirstName}, thank you` : "Thank you";
  const sign = input.guidelines?.split("\n")[0]?.trim().slice(0, 120);
  return `${hello} for your ${input.starRating}-star review of ${input.businessName}.${sign ? `\n${sign}` : ""}`;
}

export function createFakeReviewsAi(subAccountId: string): ReviewsAi {
  return {
    model: "fake",
    async classifySentiment(items) {
      await getAdminDb()
        .doc(fakeLogPath(subAccountId))
        .set({ calls: FieldValue.arrayUnion({ at: Date.now(), ids: items.map((i) => i.id), count: items.length }) }, { merge: true });
      return items.map((i) => ({ id: i.id, label: fakeLabel(i.text, i.starRating) }));
    },
    async draftReply(input) {
      await getAdminDb()
        .doc(fakeLogPath(subAccountId))
        .set({ drafts: FieldValue.arrayUnion({ at: Date.now(), kind: "draft", stars: input.starRating }) }, { merge: true });
      return { text: fakeDraft(input) };
    },
  };
}
