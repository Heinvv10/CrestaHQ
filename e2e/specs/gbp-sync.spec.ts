import { expect, test } from "@playwright/test";
import {
  TRANSLATED,
  gbpLifecycle,
  latestRun,
  primaryId,
  reviewDocs,
  runCron,
  summary,
} from "../lib/gbp";

/**
 * E2E 2 — automatic review synchronisation. A connected fixture listing, the
 * fake provider serving seven reviews in pages of three; the SCHEDULED path
 * (a QStash-signed POST to the real cron route) stores each review once,
 * writes the provider's summary and a successful run; a rerun duplicates
 * nothing; the dashboard shows it, the translated block verbatim.
 */

test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "needs GBP_PROVIDER=fake, which a deployed target refuses by design");

gbpLifecycle(test);

test("the scheduled sync stores each review once, and a rerun duplicates nothing", async ({ page, request }) => {
  const first = await runCron(request);
  expect(first.processed).toBeGreaterThanOrEqual(1);
  expect(first.byStatus.success).toBeGreaterThanOrEqual(1);

  const docs = await reviewDocs();
  expect(docs).toHaveLength(7);
  expect(new Set(docs.map((d) => d.reviewId)).size).toBe(7);
  expect(docs.every((d) => d.state === "active" && d.subAccountId === primaryId())).toBe(true);
  expect(docs.find((d) => d.reviewId === "fake-r5")?.comment).toBe(TRANSLATED);
  expect(await summary()).toMatchObject({ averageRating: 3.6, totalReviewCount: 7, lastRunStatus: "success", health: "ok" });
  expect(await latestRun()).toMatchObject({
    trigger: "scheduled", status: "success", pagesFetched: 3, reviewsSeen: 7, created: 7, reconciliation: "full",
  });

  await runCron(request);
  expect(await reviewDocs()).toHaveLength(7);
  expect(await latestRun()).toMatchObject({ trigger: "scheduled", status: "success", created: 0, updated: 0, unchanged: 7 });

  // --- Dashboard: rating, count, freshness, and the reviews as Google sent them.
  await page.goto(`/sa/${primaryId()}/ai-agents/google-business`);
  const card = page.getByTestId("gbp-summary");
  await expect(card).toContainText("3.6", { timeout: 30_000 });
  await expect(card).toContainText("7 reviews");
  await expect(card).toContainText("Last synced");
  await expect(card).toContainText("Syncs every 6 hours");
  await expect(page.getByTestId("gbp-health-ok")).toBeVisible();
  await expect(page.locator('[data-testid^="gbp-review-fake-"]')).toHaveCount(7);
  const translated = page.getByTestId("gbp-review-fake-r5").getByTestId("gbp-review-comment");
  expect(await translated.evaluate((el) => el.textContent)).toBe(TRANSLATED);
  await expect(page.getByTestId("gbp-review-fake-r7")).toContainText("Thank you from the fixture team.");
});
