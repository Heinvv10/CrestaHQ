import { expect, test } from "@playwright/test";
import { baseURL } from "../lib/env";

/**
 * A logged-out visitor must reach a WORKING login page on the origin they
 * asked for, carrying ?redirect so they can be bounced back.
 *
 * Scope: this does NOT reproduce the localhost:4300 bug that prompted it, and
 * the reason is narrower than "impossible locally" — say what was measured, so
 * the next person can pick it up rather than be warned off.
 *
 * The obvious shape fails: with NEXT_PUBLIC_APP_URL on a loopback IP, Next
 * aliases 127.0.0.1 -> localhost in the Location, so pinning HOSTNAME makes the
 * FIXED code emit a mismatched origin too and the gate goes red on correct
 * code. Measured.
 *
 * A reproduction IS achievable: serve with HOSTNAME=127.0.0.1 while both
 * DEFAULT_BASE_URL and NEXT_PUBLIC_APP_URL use a NON-loopback-literal name that
 * still resolves to loopback (e.g. a multi-label *.localhost, so
 * funnelSubdomainFrom does not treat it as a funnel host). Fixed then emits a
 * relative Location (green) and unfixed an absolute localhost one (red). Not
 * adopted here only because it changes the base URL for all six specs and that
 * was not re-verified; it is the right next step if this gate is wanted.
 *
 * Meanwhile the regression is covered by src/middleware.test.ts, which is
 * mutation-proven, and by the e2e-smoke job against the real deployment, where
 * the mismatch is genuine and where this spec did detect it.
 *
 * What it still buys: the whole unauthenticated path — middleware classifying a
 * protected route, the redirect, and a login page that actually LOADS rather
 * than merely a plausible URL.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const PROTECTED = ["/agency", "/agency/sub-accounts"];

for (const path of PROTECTED) {
  test(`a logged-out visit to ${path} lands on the real login page`, async ({
    page,
  }) => {
    const response = await page.goto(path);

    // Same origin the visitor asked for — never the server's bind address.
    expect(new URL(page.url()).origin).toBe(new URL(baseURL()).origin);
    expect(page.url()).not.toContain("localhost:4300");
    expect(new URL(page.url()).pathname).toBe("/login");

    // It has to be a REACHABLE login page, not just a plausible URL.
    expect(response?.status(), "login page did not load").toBeLessThan(400);
    await expect(page.locator("#email")).toBeVisible();

    // And it must remember where the visitor was headed.
    expect(new URL(page.url()).searchParams.get("redirect")).toBe(path);
  });
}
