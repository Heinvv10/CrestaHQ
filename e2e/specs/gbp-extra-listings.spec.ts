import { expect, test } from "@playwright/test";
import { stallFirestoreListen } from "../lib/firestore-listen";
import { LOC_A, LOC_B, gbpLifecycle, primaryId, primaryRef, reviewDocs, setScenario, twoListingScenario } from "../lib/gbp";

/**
 * Extra listings (MULTI_LISTING_V1_PLAN.md PR 3) end to end, on the fixture
 * PRIMARY with the fenced GBP fake serving two locations — the main LOC_A
 * (seven reviews) and LOC_B (two). The admin ticks the second listing under
 * "Additional listings", saves, and clicks Sync now: the cache then holds
 * reviews for BOTH locations, and a sync run was recorded for each.
 */

test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "needs GBP_PROVIDER=fake, which a deployed target refuses by design");

gbpLifecycle(test);

test("an extra listing is connected from the Google Business page and synced beside the main", async ({ page }) => {
  await setScenario(twoListingScenario());
  await page.goto(`/sa/${primaryId()}/ai-agents/google-business`);

  const block = page.getByTestId("gbp-extra-listings");
  await block.getByTestId("gbp-manage-extra-listings").click({ timeout: 30_000 });
  // The main listing is not offered; the second one is.
  await expect(block.getByRole("checkbox")).toHaveCount(1, { timeout: 30_000 });
  await block.getByRole("checkbox", { name: /Gqeberha North/ }).check();
  // The card must show the save from its 200, not the doc's next snapshot.
  await stallFirestoreListen(page);
  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith("/google/extra-listings"));
  await block.getByTestId("gbp-save-extra-listings").click();
  expect((await saved).status()).toBe(200);
  await expect(block.getByTestId("gbp-extra-listing")).toContainText("Velo Test Fibre — Gqeberha North");
  expect((await primaryRef().get()).data()?.googleLocationNames).toEqual([LOC_A, LOC_B]);

  const synced = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/gbp/sync"), { timeout: 60_000 });
  await page.getByTestId("gbp-sync-now").click({ timeout: 30_000 });
  expect((await synced).status()).toBe(200);

  const docs = await reviewDocs();
  expect(docs.filter((d) => d.locationName === LOC_A)).toHaveLength(7);
  expect(docs.filter((d) => d.locationName === LOC_B).map((d) => d.reviewId).sort()).toEqual(["fake-b1", "fake-b2"]);
  const runs = (await primaryRef().collection("gbpSyncRuns").get()).docs.map((d) => d.data());
  expect(runs.filter((r) => r.locationName === LOC_A && r.status === "success")).toHaveLength(1);
  expect(runs.filter((r) => r.locationName === LOC_B && r.status === "success")).toHaveLength(1);
});
