import "server-only";

import { isAppLoopbackUrl } from "../../gbp/provider/loopback.mjs";
import { aiIsConfigured } from "@/lib/comms/ai/openrouter";

/**
 * Which Reviews AI provider this deployment runs — decided from server env
 * alone, with the SAME fence as the GBP, WhatsApp settings, SMS and Google
 * Calendar fakes:
 *   1. REVIEWS_AI_PROVIDER === "fake" (exactly)
 *   2. NEXT_PUBLIC_APP_URL is on the narrow loopback allow-list (loopback.mjs)
 *   3. NODE_ENV !== "production", OR REVIEWS_AI_FAKE_ALLOW_PROD_BUILD === "1"
 *      (CI's Playwright job boots the production bundle on 127.0.0.1)
 *   4. REVIEWS_AI_FAKE_AGENCY_ID is set — select.ts then requires the
 *      sub-account to belong to it, because dev and CI use production Firestore
 * Fake requested with any clause failing THROWS. It never falls back to
 * OpenRouter silently.
 *
 * The refusal message on clause 2 is load-bearing: scripts/gbp-deploy-check.mjs
 * finds it in the built server chunks and reads the URL literal the build
 * inlined next to it. Change the text there and here together.
 */

export class ReviewsAiFakeRefusedError extends Error {
  constructor(reason: string) {
    super(`Reviews AI fake provider refused: ${reason}`);
    this.name = "ReviewsAiFakeRefusedError";
  }
}

function appUrl(): string | undefined {
  // A literal `process.env.NEXT_PUBLIC_APP_URL` so a Next build constant-folds
  // it: the production bundle carries the production URL whatever the runtime env says.
  return process.env.NEXT_PUBLIC_APP_URL;
}

/** "openrouter" or "fake"; throws ReviewsAiFakeRefusedError when fake is requested but unsafe. */
export function reviewsAiMode(): "openrouter" | "fake" {
  if (process.env.REVIEWS_AI_PROVIDER !== "fake") return "openrouter";
  if (!isAppLoopbackUrl(appUrl())) {
    throw new ReviewsAiFakeRefusedError("NEXT_PUBLIC_APP_URL is not loopback (Reviews AI fake)");
  }
  if (process.env.NODE_ENV === "production" && process.env.REVIEWS_AI_FAKE_ALLOW_PROD_BUILD !== "1") {
    throw new ReviewsAiFakeRefusedError("production build without REVIEWS_AI_FAKE_ALLOW_PROD_BUILD=1");
  }
  if (!process.env.REVIEWS_AI_FAKE_AGENCY_ID) {
    throw new ReviewsAiFakeRefusedError("REVIEWS_AI_FAKE_AGENCY_ID is not set");
  }
  return "fake";
}

/**
 * True when Reviews AI can run here: an OpenRouter key in real mode, or an
 * ALLOWED fake. A refused fake is "not configured" — never OpenRouter.
 */
export function reviewsAiConfigured(): boolean {
  if (process.env.REVIEWS_AI_PROVIDER === "fake") {
    try {
      return reviewsAiMode() === "fake";
    } catch (err) {
      if (err instanceof ReviewsAiFakeRefusedError) return false;
      throw err;
    }
  }
  return aiIsConfigured();
}
