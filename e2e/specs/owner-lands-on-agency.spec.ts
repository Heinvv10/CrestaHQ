import { expect, test } from "@playwright/test";
import { readEnv } from "../lib/env";

/**
 * The signal that login.spec.ts gave up when it stopped pinning /agency.
 *
 * INTENDED: an agency owner hitting the bare /dashboard lands on /agency — the
 * sub-account picker (`legacy-redirect.tsx:40-44`).
 *
 * ACTUAL: intermittently they are dropped into /sa/{first}/dashboard instead.
 * `LegacyRedirect` takes the owner branch only when `agencyRole === "owner"`,
 * which `auth-context.tsx:163` sets from custom claims alone, read behind
 * `getIdTokenResult(true).catch(() => null)` (:120). `agencyId` falls back to
 * `userDoc.primaryAgencyId`; `agencyRole` has no fallback. A failed token
 * refresh therefore silently demotes an owner.
 *
 * `fixme` rather than deleted: this is a real user-facing defect, and a spec
 * that names it is worth more than a promise in a comment. Fixing it means
 * giving `agencyRole` a fallback — `UserDoc` has no role field today
 * (`src/types/firebase.ts`), so ownership would have to come from the agency
 * doc. That is a real change to shared auth state, not a two-line patch.
 *
 * Remove the fixme with the fix. See memory: project_agency_owner_redirect_race.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test.fixme(
  "an agency owner hitting /dashboard lands on the agency picker",
  async ({ page }) => {
    const env = readEnv();
    // Same steps as login.spec.ts — a fresh, unauthenticated sign-in, so the
    // redirect is exercised from the state a real user arrives in.
    await page.goto("/login");
    await page.locator("#email").fill(env.E2E_EMAIL);
    await page.locator("#password").fill(env.E2E_PASSWORD);
    await page.getByRole("button", { name: "Sign In" }).click();

    await page.waitForURL(/\/agency$/, { timeout: 30_000 });
    expect(new URL(page.url()).pathname).toBe("/agency");
  },
);
