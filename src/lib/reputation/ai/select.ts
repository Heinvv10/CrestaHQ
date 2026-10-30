import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { defaultAiModel } from "@/lib/comms/ai/openrouter";
import { createFakeReviewsAi } from "./fake";
import { ReviewsAiFakeRefusedError, reviewsAiMode } from "./mode";
import { openRouterReviewsAi } from "./openrouter";
import type { ReviewsAi } from "./types";

/**
 * The ONLY way to obtain the Reviews AI. Selection is from server env alone
 * (mode.ts). In fake mode the sub-account must belong to
 * REVIEWS_AI_FAKE_AGENCY_ID (dev and CI run against the production
 * Firestore). Callers check `reviewsAiConfigured()` first; in real mode a
 * missing OpenRouter key makes the call itself throw.
 */
export async function getReviewsAiFor(subAccountId: string): Promise<ReviewsAi> {
  if (reviewsAiMode() === "openrouter") return openRouterReviewsAi(defaultAiModel());
  await assertReviewsAiFixtureAgency(subAccountId);
  return createFakeReviewsAi(subAccountId);
}

/** The fake's fixture-agency fence on its own: throws unless `subAccountId` belongs to REVIEWS_AI_FAKE_AGENCY_ID. */
export async function assertReviewsAiFixtureAgency(subAccountId: string): Promise<void> {
  const fixture = process.env.REVIEWS_AI_FAKE_AGENCY_ID;
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  if (!fixture || (snap.exists ? snap.data()?.agencyId : undefined) !== fixture) {
    throw new ReviewsAiFakeRefusedError("sub-account is not in the fixture agency");
  }
}
