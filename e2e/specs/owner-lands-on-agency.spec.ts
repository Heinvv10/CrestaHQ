import { expect, test } from "@playwright/test";
import { readEnv } from "../lib/env";

/**
 * The signal that login.spec.ts gave up when it stopped pinning /agency.
 *
 * INTENDED: an agency owner hitting the bare /dashboard lands on /agency — the
 * sub-account picker (the `agencyRole === "owner"` branch of `LegacyRedirect`).
 *
 * ACTUAL: intermittently they are dropped into /sa/{first}/dashboard instead.
 * `LegacyRedirect` takes the owner branch only when `agencyRole === "owner"`,
 * which `AuthProvider` sets from custom claims alone, read behind a
 * `getIdTokenResult(true).catch(() => null)`. `agencyId` falls back to
 * `userDoc.primaryAgencyId`; `agencyRole` has no fallback, so a failed token
 * refresh silently demotes an owner.
 *
 * Note it is a FLAKE, not a reliable red: `LegacyRedirect` also routes to
 * /agency while `memberships` is still empty, which is the first state after
 * login, so /agency is the dominant outcome. `fixme` rather than `fail` for
 * exactly that reason — `test.fail` flags an unexpected PASS.
 *
 * Kept rather than deleted: this is a real user-facing defect, and a spec that
 * names it is worth more than a promise in a comment. Fixing it means giving
 * `agencyRole` a fallback — `UserDoc` has no role field today
 * (`src/types/firebase.ts`), so ownership would have to come from the agency
 * doc. That is a change to shared auth state, not a two-line patch.
 *
 * Remove the fixme with the fix.
 */
// A clean session, and NO trace or screenshot: this spec submits E2E_PASSWORD,
// and the suite default is `retain-on-failure` — while this is fixme'd for a
// race whose failure is the EXPECTED state, the first un-fixme'd run would
// otherwise write the signInWithPassword request body into an artifact CI
// uploads. Same reason login.spec.ts opts out.
test.use({
  storageState: { cookies: [], origins: [] },
  trace: "off",
  screenshot: "off",
});

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
