import "server-only";

/**
 * Which GBP provider this deployment runs — decided from server env alone.
 * Dependency-free on purpose: `lib/google/oauth.ts` (googleAppConfigured)
 * imports it, and select.ts imports the providers that import oauth.ts.
 * The full rationale for each clause lives on `getGbpProviderFor` in select.ts.
 */

export class GbpFakeRefusedError extends Error {
  constructor(reason: string) {
    super(`GBP fake provider refused: ${reason}`);
    this.name = "GbpFakeRefusedError";
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function appHost(): string {
  // Read as a literal `process.env.NEXT_PUBLIC_APP_URL` so a Next build
  // constant-folds it: the production bundle carries the production URL no
  // matter what the runtime environment says.
  try {
    return new URL(process.env.NEXT_PUBLIC_APP_URL ?? "").hostname;
  } catch {
    return "";
  }
}

/** "google" or "fake"; throws GbpFakeRefusedError when fake is requested but unsafe. */
export function gbpProviderMode(): "google" | "fake" {
  if (process.env.GBP_PROVIDER !== "fake") return "google";
  if (!LOOPBACK.has(appHost())) {
    throw new GbpFakeRefusedError("NEXT_PUBLIC_APP_URL is not a loopback host");
  }
  if (
    process.env.NODE_ENV === "production" &&
    process.env.GBP_FAKE_ALLOW_PROD_BUILD !== "1"
  ) {
    throw new GbpFakeRefusedError("production build without GBP_FAKE_ALLOW_PROD_BUILD=1");
  }
  if (!process.env.GBP_FAKE_AGENCY_ID) {
    throw new GbpFakeRefusedError("GBP_FAKE_AGENCY_ID is not set");
  }
  return "fake";
}

/** True when the deployment may run the fake; false when it is requested but refused. */
export function fakeProviderAllowed(): boolean {
  try {
    return gbpProviderMode() === "fake";
  } catch (err) {
    if (err instanceof GbpFakeRefusedError) return false;
    throw err;
  }
}
