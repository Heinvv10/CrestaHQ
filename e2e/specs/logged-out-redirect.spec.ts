import { expect, test } from "@playwright/test";
import { baseURL } from "../lib/env";

/**
 * The gap that let a real bug ship: every other spec is authenticated, and
 * login.spec visits /login directly — a PUBLIC path. Nothing exercised a
 * logged-out visitor hitting a protected route.
 *
 * On 2026-09-06 that visitor was 307'd to `https://localhost:4300/login`,
 * because middleware built the redirect from `request.nextUrl`, which under the
 * standalone server is the bind address rather than the Host header. Dead for
 * anyone following a bookmark, a deep link, or an expired session.
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
