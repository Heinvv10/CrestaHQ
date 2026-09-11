import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { createFakeGbpProvider } from "./fake";
import { FirestoreScenarioStore } from "./fake-scenario";
import { googleGbpProvider } from "./google";
import { GbpFakeRefusedError, gbpProviderMode } from "./mode";
import type { GbpProvider } from "./types";

export { GbpFakeRefusedError, gbpProviderMode } from "./mode";

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

/**
 * The provider for work on one sub-account. Every tenant-touching caller —
 * connect, callback exchange, token refresh, discovery, selection, disconnect
 * revoke — goes through here. In fake mode the returned fake is BOUND to
 * `subAccountId`: it refuses any code or token naming another sub-account and
 * touches only this sub-account's scenario, so the fixture-agency fence
 * applies to what the fake does, not just to who may obtain it.
 */
export async function getGbpProviderFor(subAccountId: string): Promise<GbpProvider> {
  if (gbpProviderMode() === "google") return googleGbpProvider;

  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const agencyId = snap.exists ? snap.data()?.agencyId : undefined;
  if (agencyId !== process.env.GBP_FAKE_AGENCY_ID) {
    throw new GbpFakeRefusedError("sub-account is not in the fixture agency");
  }
  return createFakeGbpProvider(new FirestoreScenarioStore(), subAccountId);
}
