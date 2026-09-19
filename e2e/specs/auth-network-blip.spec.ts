import { expect, test } from "@playwright/test";
import { readEnv } from "../lib/env";
import { MARKER_PRIMARY_NAME } from "../lib/seed";

/**
 * A connection that drops while the session loads must not strand a signed-in
 * owner. The shared CI box starts and stops Docker containers all day; each
 * one moves a veth interface, Chrome answers with ERR_NETWORK_CHANGED on every
 * in-flight request, and Firestore flips to "offline". When that landed on the
 * auth context's first reads, the page fell to "Sign in to view your agency"
 * or /agency?error=no-access and stayed there — the same thing a real user on
 * a Wi-Fi → LTE hop sees — and whichever spec was running failed.
 *
 * Here Firestore's channel requests are reset on purpose for a moment, which
 * is the same client-side event without waiting for a container to churn.
 */

const FIRESTORE_CHANNEL =
  /firestore\.googleapis\.com\/google\.firestore\.v1\.Firestore\/(Listen|Write)\/channel/;

test("a dropped connection while the session loads does not strand the owner", async ({
  page,
}) => {
  const env = readEnv();
  let dropped = 0;
  let outageEndsAt = Infinity;
  await page.route(FIRESTORE_CHANNEL, (route) => {
    if (Date.now() >= outageEndsAt) return route.continue();
    dropped++;
    return route.abort("connectionreset");
  });

  await page.goto(`/sa/${env.E2E_SUBACCOUNT_ID}/contacts`);
  // A two-second outage from the first navigation — about what a container
  // start costs. Without the auth context's retry this lands the page on
  // "Sign in to view your agency", the same snapshot the CI traces show.
  outageEndsAt = Date.now() + 2_000;

  await expect(
    page.locator("tr").filter({ hasText: MARKER_PRIMARY_NAME }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(new RegExp(`/sa/${env.E2E_SUBACCOUNT_ID}/contacts$`));
  expect(dropped, "no channel request was dropped").toBeGreaterThan(0);
});
