import "server-only";

import { isAppLoopbackUrl } from "../../../gbp/provider/loopback.mjs";

/**
 * Which WhatsApp settings provider this deployment runs — decided from server
 * env alone, with the same fence as the GBP fake (src/lib/gbp/provider/mode.ts):
 *   1. WHATSAPP_SETTINGS_PROVIDER === "fake" (exactly)
 *   2. NEXT_PUBLIC_APP_URL is on the narrow loopback allow-list (loopback.mjs)
 *   3. NODE_ENV !== "production", OR WHATSAPP_FAKE_ALLOW_PROD_BUILD === "1"
 *      (CI's Playwright job boots the production bundle on 127.0.0.1)
 *   4. WHATSAPP_FAKE_AGENCY_ID is set — select.ts then requires the
 *      sub-account to belong to it, because dev and CI use production Firestore
 * Fake requested with any clause failing THROWS; it never falls back to Meta.
 *
 * The refusal message on clause 2 is load-bearing: scripts/gbp-deploy-check.mjs
 * finds it in the built server chunks and reads the URL literal the build
 * inlined next to it. Change the text there and here together.
 */

export class WaFakeRefusedError extends Error {
  constructor(reason: string) {
    super(`WhatsApp fake provider refused: ${reason}`);
    this.name = "WaFakeRefusedError";
  }
}

function appUrl(): string | undefined {
  // Read as a literal `process.env.NEXT_PUBLIC_APP_URL` so a Next build
  // constant-folds it: the production bundle carries the production URL no
  // matter what the runtime environment says.
  return process.env.NEXT_PUBLIC_APP_URL;
}

/** "graph" or "fake"; throws WaFakeRefusedError when fake is requested but unsafe. */
export function whatsappSettingsProviderMode(): "graph" | "fake" {
  if (process.env.WHATSAPP_SETTINGS_PROVIDER !== "fake") return "graph";
  if (!isAppLoopbackUrl(appUrl())) {
    throw new WaFakeRefusedError("NEXT_PUBLIC_APP_URL is not loopback (WhatsApp fake)");
  }
  if (
    process.env.NODE_ENV === "production" &&
    process.env.WHATSAPP_FAKE_ALLOW_PROD_BUILD !== "1"
  ) {
    throw new WaFakeRefusedError("production build without WHATSAPP_FAKE_ALLOW_PROD_BUILD=1");
  }
  if (!process.env.WHATSAPP_FAKE_AGENCY_ID) {
    throw new WaFakeRefusedError("WHATSAPP_FAKE_AGENCY_ID is not set");
  }
  return "fake";
}
