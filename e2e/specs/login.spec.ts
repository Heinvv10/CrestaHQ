import { expect, test } from "@playwright/test";
import { readEnv } from "../lib/env";
/**
 * Traces record request bodies, and this spec submits E2E_PASSWORD (to
 * Firebase's signInWithPassword) — a repository secret that must not be
 * re-emitted into an uploaded CI artifact. Every spec that drives the login
 * form opts out of traces and screenshots for this reason; the rest start from
 * a saved session, never see the password, and keep their traces.
 */
test.use({ trace: "off", screenshot: "off" });

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

  // Subject is LOGIN, so assert what login guarantees: an authenticated
  // session on an authenticated surface. /agency is deliberately NOT pinned.
  //
  // The form pushes /dashboard, and `LegacyRedirect` sends an agency owner to
  // /agency on two different branches — when `memberships` is still empty (the
  // first state after login) and when `agencyRole === "owner"` has arrived.
  // `agencyRole` comes only from custom claims, read behind
  // `getIdTokenResult(true).catch(() => null)` (auth-context.tsx:120), and has
  // no `userDoc` fallback the way `agencyId` does — so when that read fails the
  // owner branch is skipped and the owner lands on a sub-account dashboard
  // instead. Both destinations are session-gated, so neither is reachable
  // without a valid __session: the assertion below still fails on a broken
  // login, which the __session check then confirms independently.
  //
  // The redirect itself is covered by owner-lands-on-agency.spec.ts, which
  // documents the race in full and is `test.fixme` until it is fixed.
  await page.waitForURL(/\/(agency|sa\/[^/]+\/dashboard)$/, {
    timeout: 30_000,
  });
  await expect(
    page.getByRole("heading", { level: 1 }).first(),
  ).toBeVisible();

  const session = (await context.cookies()).find((c) => c.name === "__session");
  expect(session?.value, "__session cookie was not set").toBeTruthy();
});
