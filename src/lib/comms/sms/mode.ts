import "server-only";

import { isAppLoopbackUrl } from "../../gbp/provider/loopback.mjs";

/**
 * Which SMS sender this deployment runs — decided from server env alone,
 * with the SAME fence as the GBP fake (src/lib/gbp/provider/mode.ts) and the
 * WhatsApp settings fake (src/lib/comms/whatsapp/settings/mode.ts):
 *   1. SMS_PROVIDER === "fake" (exactly)
 *   2. NEXT_PUBLIC_APP_URL is on the narrow loopback allow-list (loopback.mjs)
 *   3. NODE_ENV !== "production", OR SMS_FAKE_ALLOW_PROD_BUILD === "1"
 *      (CI's Playwright job boots the production bundle on 127.0.0.1)
 *   4. SMS_FAKE_AGENCY_ID is set — select.ts then requires the sub-account
 *      to belong to it, because dev and CI use production Firestore
 * Fake requested with any clause failing THROWS. It never falls back to
 * Twilio silently.
 *
 * The refusal message on clause 2 is load-bearing: scripts/gbp-deploy-check.mjs
 * finds it in the built server chunks and reads the URL literal the build
 * inlined next to it. Change the text there and here together.
 */

export class SmsFakeRefusedError extends Error {
  constructor(reason: string) {
    super(`SMS fake provider refused: ${reason}`);
    this.name = "SmsFakeRefusedError";
  }
}

function appUrl(): string | undefined {
  // Read as a literal `process.env.NEXT_PUBLIC_APP_URL` so a Next build
  // constant-folds it: the production bundle carries the production URL no
  // matter what the runtime environment says.
  return process.env.NEXT_PUBLIC_APP_URL;
}

/** "twilio" or "fake"; throws SmsFakeRefusedError when fake is requested but unsafe. */
export function smsProviderMode(): "twilio" | "fake" {
  if (process.env.SMS_PROVIDER !== "fake") return "twilio";
  if (!isAppLoopbackUrl(appUrl())) {
    throw new SmsFakeRefusedError("NEXT_PUBLIC_APP_URL is not loopback (SMS fake)");
  }
  if (
    process.env.NODE_ENV === "production" &&
    process.env.SMS_FAKE_ALLOW_PROD_BUILD !== "1"
  ) {
    throw new SmsFakeRefusedError("production build without SMS_FAKE_ALLOW_PROD_BUILD=1");
  }
  if (!process.env.SMS_FAKE_AGENCY_ID) {
    throw new SmsFakeRefusedError("SMS_FAKE_AGENCY_ID is not set");
  }
  return "fake";
}
