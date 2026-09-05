import { expect, test } from "@playwright/test";

/**
 * Traces record request bodies, and this is the only spec that submits
 * E2E_PASSWORD (to Firebase's signInWithPassword) — a repository secret that
 * must not be re-emitted into an uploaded CI artifact. Every other spec starts
 * from a saved session and never sees it, so they keep their traces.
 */
test.use({ trace: "off", screenshot: "off" });
import { readEnv } from "../lib/env";

/**
 * The one spec that drives the real login form. Every other spec starts from
 * the storageState global setup minted — testing the login page five times
 * and the rest once would be the wrong trade.
 */

// No session: this spec is about acquiring one.
test.use({ storageState: { cookies: [], origins: [] } });

test("agency owner signs in through the login form", async ({
  page,
  context,
}) => {
  const env = readEnv();

  await page.goto("/login");
  await page.locator("#email").fill(env.E2E_EMAIL);
  await page.locator("#password").fill(env.E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();

  // The form pushes /dashboard, which redirects an agency owner to /agency.
  await page.waitForURL(/\/agency$/, { timeout: 30_000 });
  await expect(
    page.getByRole("heading", { level: 1 }).first(),
  ).toBeVisible();

  const session = (await context.cookies()).find((c) => c.name === "__session");
  expect(session?.value, "__session cookie was not set").toBeTruthy();
});
