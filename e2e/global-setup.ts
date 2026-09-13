import { chromium } from "@playwright/test";
import {
  FIXTURE_PRIMARY_NAME,
  FIXTURE_SECONDARY_NAME,
  STORAGE_STATE,
  baseURL,
  readEnv,
} from "./lib/env";
import { assertFixtureSubAccount } from "./lib/guard";
import { ensureSeed } from "./lib/seed";

/**
 * Runs once, before any spec. Everything here either passes or aborts the
 * whole run — there is no "carry on and hope". The name check is the point:
 * an id typo that resolved to a real client sub-account would otherwise be
 * discovered by the teardown deleting its contacts.
 */

/**
 * Sign in through the real form rather than minting the `__session` cookie
 * over HTTP.
 *
 * The cookie alone authenticates the SERVER (middleware reads it and stamps
 * x-user-uid). It does nothing for the Firebase JS SDK, which keeps its
 * session in IndexedDB — so dashboard pages that live-query Firestore from
 * the client render empty, and a spec asserting on them fails for a reason
 * that has nothing to do with the feature under test. Persisting IndexedDB
 * alongside the cookie is what makes both halves of the app authenticated.
 */
async function saveAuthenticatedState(): Promise<void> {
  const env = readEnv();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ baseURL: baseURL() });
    await page.goto("/login");
    // Same locators as login.spec.ts, so that spec fails first when the
    // form changes instead of every spec dying in setup.
    await page.locator("#email").fill(env.E2E_EMAIL);
    await page.locator("#password").fill(env.E2E_PASSWORD);
    await page.getByRole("button", { name: "Sign In" }).click();
    // Either landing page proves the session exists — see login.spec.ts for
    // why /agency is not pinned. Setup only needs to BE authenticated; which
    // of the two dashboards it lands on is irrelevant to saving storageState,
    // and pinning one would abort all six specs whenever the redirect went the
    // other way.
    await page.waitForURL(/\/(agency|sa\/[^/]+\/dashboard)$/, {
      timeout: 60_000,
    });
    await page
      .context()
      .storageState({ path: STORAGE_STATE, indexedDB: true });
  } finally {
    await browser.close();
  }
}

/**
 * NEXT_PUBLIC_APP_URL is baked into the build at build time; baseURL() (and
 * every helper that signs a URL for the running server, e.g. QStash/Twilio
 * signatures) is resolved at test-run time from E2E_PORT. Against the PR's
 * own webServer the two MUST agree, or the server verifies signatures against
 * one URL while the suite signs another — every signed-webhook spec would
 * fail with an opaque 401/403 instead of the one clear message below. Skipped
 * against an external deployment (PLAYWRIGHT_BASE_URL set): that build's
 * NEXT_PUBLIC_APP_URL was baked by someone else and has nothing to do with
 * this machine's E2E_PORT.
 */
function assertAppUrlMatchesBaseUrl(): void {
  if (process.env.PLAYWRIGHT_BASE_URL) return;
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  const expected = baseURL();
  if (configured !== expected) {
    throw new Error(
      `NEXT_PUBLIC_APP_URL (${configured ?? "unset"}) does not match the ` +
        `E2E base URL (${expected}). The app was built with a different ` +
        `URL baked in than the suite is signing requests for — rebuild with ` +
        `NEXT_PUBLIC_APP_URL=${expected} before running E2E on this port.`,
    );
  }
}

export default async function globalSetup(): Promise<void> {
  const env = readEnv();
  assertAppUrlMatchesBaseUrl();

  await assertFixtureSubAccount(env.E2E_SUBACCOUNT_ID, FIXTURE_PRIMARY_NAME);
  await assertFixtureSubAccount(
    env.E2E_SUBACCOUNT_ID_SECONDARY,
    FIXTURE_SECONDARY_NAME,
  );

  await ensureSeed();
  await saveAuthenticatedState();
}
