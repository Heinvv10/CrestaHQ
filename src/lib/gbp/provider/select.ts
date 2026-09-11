import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { createFakeGbpProvider } from "./fake";
import { FirestoreScenarioStore } from "./fake-scenario";
import { googleGbpProvider } from "./google";
import type { GbpProvider } from "./types";

/**
 * The ONLY way to obtain a GBP provider: `getGbpProviderFor(subAccountId)`.
 * Selection is from server-side env alone — never from a request value.
 *
 * The fake is selected only when ALL of these hold:
 *   1. GBP_PROVIDER === "fake"
 *   2. NEXT_PUBLIC_APP_URL's host is loopback (127.0.0.1 / localhost / [::1])
 *   3. NODE_ENV !== "production", OR GBP_FAKE_ALLOW_PROD_BUILD === "1"
 *   4. GBP_FAKE_AGENCY_ID is set — and the sub-account belongs to that agency
 *
 * Why clause 3 has an opt-in: CI's Playwright job boots the PRODUCTION bundle
 * (`pnpm e2e:server`, NODE_ENV=production) on 127.0.0.1, so a bare NODE_ENV
 * clause would make the E2E gate impossible. The production deploy bakes
 * `https://crm.crestahq.com` into NEXT_PUBLIC_APP_URL at build time and
 * carries no opt-in, so it fails two independent clauses.
 *
 * Why clause 4 exists: local dev and CI both run against the PRODUCTION
 * Firestore (there is no staging project). A fake OAuth callback for a real
 * tenant would overwrite that tenant's real `private/googleConnection` with
 * fake tokens, so fake mode is fenced to the E2E fixture agency.
 *
 * GBP_PROVIDER === "fake" with any clause failing THROWS. It never falls back
 * to Google silently: a misconfigured environment must be loud.
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

let fakeProvider: GbpProvider | null = null;

/**
 * The provider for work on one sub-account. Every tenant-touching caller —
 * connect, callback exchange, token refresh, discovery, selection, disconnect
 * revoke — goes through here, so the fixture-agency fence cannot be skipped.
 */
export async function getGbpProviderFor(subAccountId: string): Promise<GbpProvider> {
  if (gbpProviderMode() === "google") return googleGbpProvider;

  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const agencyId = snap.exists ? snap.data()?.agencyId : undefined;
  if (agencyId !== process.env.GBP_FAKE_AGENCY_ID) {
    throw new GbpFakeRefusedError("sub-account is not in the fixture agency");
  }
  fakeProvider ??= createFakeGbpProvider(new FirestoreScenarioStore());
  return fakeProvider;
}
