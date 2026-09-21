import "server-only";

import { isLoopbackHostname } from "@/lib/gbp/provider/loopback.mjs";

/**
 * E2E-only escape hatch for the public booking routes' per-IP / per-sub-account
 * rate limiters (availability + book). The whole Playwright suite runs from
 * one loopback client, so a growing SP3 spec count exhausts the limiters
 * mid-run — a real visitor never gets close to these caps.
 *
 * True only when BOTH: `E2E_DISABLE_BOOKING_RATE_LIMITS=1` AND the
 * build-inlined `NEXT_PUBLIC_APP_URL` is loopback — the same wide fence
 * `instrumentation.ts` uses to skip schedule registration on a dev/CI server.
 * The env var name is refused by scripts/gbp-deploy-check.mjs exactly like
 * GBP_PROVIDER / GCAL_PROVIDER, so even a leaked "1" in a production env file
 * never reaches this far.
 */
export function bookingRateLimitsDisabled(): boolean {
  if (process.env.E2E_DISABLE_BOOKING_RATE_LIMITS !== "1") return false;
  let host: string;
  try {
    host = new URL(process.env.NEXT_PUBLIC_APP_URL ?? "").hostname;
  } catch {
    return false;
  }
  return isLoopbackHostname(host);
}
