import { chromium } from "@playwright/test";
import { adminDb } from "./lib/admin";
import {
  FIXTURE_PRIMARY_NAME,
  FIXTURE_SECONDARY_NAME,
  STORAGE_STATE,
  baseURL,
  readEnv,
} from "./lib/env";
import { assertFixtureAgency } from "./lib/guard";
import { ensureSeed } from "./lib/seed";

/**
 * Runs once, before any spec. Everything here either passes or aborts the
 * whole run — there is no "carry on and hope". The name check is the point:
 * an id typo that resolved to a real client sub-account would otherwise be
 * discovered by the teardown deleting its contacts.
 */

async function assertFixtureSubAccount(
  subAccountId: string,
  expectedName: string,
): Promise<void> {
  await assertFixtureAgency(subAccountId);
  const snap = await adminDb().doc(`subAccounts/${subAccountId}`).get();
  const name = snap.data()?.name;
  if (name !== expectedName) {
    throw new Error(
      `Sub-account ${subAccountId} is named "${String(name)}", expected ` +
        `"${expectedName}". Refusing to run against it. ` +
        `Re-check E2E_SUBACCOUNT_ID / E2E_SUBACCOUNT_ID_SECONDARY.`,
    );
  }
}

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
    await page.getByLabel("Email").fill(env.E2E_EMAIL);
    await page.getByLabel("Password").fill(env.E2E_PASSWORD);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL(/\/agency$/, { timeout: 60_000 });
    await page
      .context()
      .storageState({ path: STORAGE_STATE, indexedDB: true });
  } finally {
    await browser.close();
  }
}

export default async function globalSetup(): Promise<void> {
  const env = readEnv();

  await assertFixtureSubAccount(env.E2E_SUBACCOUNT_ID, FIXTURE_PRIMARY_NAME);
  await assertFixtureSubAccount(
    env.E2E_SUBACCOUNT_ID_SECONDARY,
    FIXTURE_SECONDARY_NAME,
  );

  await ensureSeed();
  await saveAuthenticatedState();
}
