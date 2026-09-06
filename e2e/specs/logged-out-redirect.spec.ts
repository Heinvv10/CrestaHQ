import { expect, test } from "@playwright/test";
import { baseURL } from "../lib/env";

/**
 * A logged-out visitor must reach a WORKING login page on the origin they
 * asked for, carrying ?redirect so they can be bounced back.
 *
 * Scope, stated honestly: this does NOT reproduce the localhost:4300 bug that
 * prompted it. That bug needs the server's bind host to differ from the browsed
 * host, which only happens behind the tunnel — here Playwright talks to the
 * server directly, and Next normalises loopback forms (127.0.0.1 -> localhost)
 * so a pinned HOSTNAME makes the FIXED code fail too. Measured both ways before
 * giving up on it; the regression itself is covered by src/middleware.test.ts,
 * which is mutation-proven, and by the e2e-smoke job against the real
 * deployment, where the mismatch is real and where this spec did detect it.
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
