import "server-only";

import { isAppLoopbackUrl } from "../../gbp/provider/loopback.mjs";

/**
 * Which Google Calendar provider this deployment runs — decided from server
 * env alone, with the SAME fence as the GBP fake (lib/gbp/provider/mode.ts),
 * the WhatsApp settings fake and the SMS fake:
 *   1. GCAL_PROVIDER === "fake" (exactly)
 *   2. NEXT_PUBLIC_APP_URL is on the narrow loopback allow-list (loopback.mjs)
 *   3. NODE_ENV !== "production", OR GCAL_FAKE_ALLOW_PROD_BUILD === "1"
 *      (CI's Playwright job boots the production bundle on 127.0.0.1)
 *   4. GCAL_FAKE_AGENCY_ID is set — select.ts then requires the sub-account
 *      to belong to it, because dev and CI use production Firestore
 * Fake requested with any clause failing THROWS. It never falls back to
 * Google silently.
 *
 * The refusal message on clause 2 is load-bearing: scripts/gbp-deploy-check.mjs
 * finds it in the built server chunks and reads the URL literal the build
 * inlined next to it. Change the text there and here together.
 */

export class GcalFakeRefusedError extends Error {
  constructor(reason: string) {
    super(`Google Calendar fake provider refused: ${reason}`);
    this.name = "GcalFakeRefusedError";
  }
}

function appUrl(): string | undefined {
  // Read as a literal `process.env.NEXT_PUBLIC_APP_URL` so a Next build
  // constant-folds it: the production bundle carries the production URL no
  // matter what the runtime environment says.
  return process.env.NEXT_PUBLIC_APP_URL;
}

/** "google" or "fake"; throws GcalFakeRefusedError when fake is requested but unsafe. */
export function gcalProviderMode(): "google" | "fake" {
  if (process.env.GCAL_PROVIDER !== "fake") return "google";
  if (!isAppLoopbackUrl(appUrl())) {
    throw new GcalFakeRefusedError("NEXT_PUBLIC_APP_URL is not loopback (Google Calendar fake)");
  }
  if (
    process.env.NODE_ENV === "production" &&
    process.env.GCAL_FAKE_ALLOW_PROD_BUILD !== "1"
  ) {
    throw new GcalFakeRefusedError("production build without GCAL_FAKE_ALLOW_PROD_BUILD=1");
  }
  if (!process.env.GCAL_FAKE_AGENCY_ID) {
    throw new GcalFakeRefusedError("GCAL_FAKE_AGENCY_ID is not set");
  }
  return "fake";
}

/** True when the deployment may run the fake; false when it is requested but refused. */
export function gcalFakeAllowed(): boolean {
  try {
    return gcalProviderMode() === "fake";
  } catch (err) {
    if (err instanceof GcalFakeRefusedError) return false;
    throw err;
  }
}

/**
 * True when Google Calendar is usable here: OAuth client credentials in
 * real-Google mode, or an ALLOWED fake. A refused fake is "not configured".
 */
export function gcalAppConfigured(): boolean {
  if (process.env.GCAL_PROVIDER === "fake") return gcalFakeAllowed();
  return !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;
}
