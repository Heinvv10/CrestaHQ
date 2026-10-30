import { expect, test } from "@playwright/test";
import {
  defaultScenario,
  gbpLifecycle,
  latestRun,
  primaryId,
  primaryRef,
  reviewDocs,
  runCron,
  setScenario,
  summary,
} from "../lib/gbp";

/**
 * E2E 6 (sync half) — a revoked grant with good cached data. After a
 * successful sync the grant is revoked at "Google" while our cached access
 * token is still fresh. The next scheduled sync must end reconnect_required
 * (not failed), keep every cached review, and the page must say so — with the
 * date of the cached data and no claim of being live.
 */

test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "needs GBP_PROVIDER=fake, which a deployed target refuses by design");

gbpLifecycle(test);

test("a revoked grant records reconnect_required, keeps the reviews and says so", async ({ page, request }) => {
  await runCron(request);
  expect(await reviewDocs()).toHaveLength(7);

  await setScenario({ ...defaultScenario(), revoked: true });
  await runCron(request);

  expect(await latestRun()).toMatchObject({ trigger: "scheduled", status: "reconnect_required", removed: 0 });
  const docs = await reviewDocs();
  expect(docs).toHaveLength(7);
  expect(docs.every((d) => d.state === "active" && typeof d.comment !== "undefined")).toBe(true);
  expect(await summary()).toMatchObject({ health: "reconnect_required", averageRating: 3.6, totalReviewCount: 7 });
  expect((await primaryRef().get()).data()?.googleConnectionMeta).toMatchObject({
    reconnectRequired: true,
    reconnectReason: "revoked",
  });

  await page.goto(`/sa/${primaryId()}/ai-agents/google-business`);
  await expect(page.getByTestId("gbp-state-reconnect")).toBeVisible({ timeout: 30_000 });
  const banner = page.getByTestId("gbp-banner-reconnect");
  await expect(banner).toContainText("Google access was revoked — reconnect to resume syncing.", { timeout: 30_000 });
  await expect(banner).toContainText("Showing cached reviews from");
  await expect(page.getByTestId("gbp-summary")).toContainText("Last synced");
  await expect(page.getByTestId("gbp-health-reconnect_required")).toBeVisible();
  await expect(page.locator('[data-testid^="gbp-review-fake-"]')).toHaveCount(7);
  await expect(page.getByTestId("gbp-sync-now")).toHaveCount(0);
  expect((await page.getByTestId("gbp-state-reconnect").innerText()).toLowerCase()).not.toContain("live");
});
