import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type { ReviewsAi, SentimentLabel } from "./types";

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
 * what would have been billed.
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

export function createFakeReviewsAi(subAccountId: string): ReviewsAi {
  return {
    model: "fake",
    async classifySentiment(items) {
      await getAdminDb()
        .doc(fakeLogPath(subAccountId))
        .set({ calls: FieldValue.arrayUnion({ at: Date.now(), ids: items.map((i) => i.id), count: items.length }) }, { merge: true });
      return items.map((i) => ({ id: i.id, label: fakeLabel(i.text, i.starRating) }));
    },
  };
}
