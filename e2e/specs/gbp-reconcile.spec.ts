import { expect, test, type Page } from "@playwright/test";
import {
  LOC_A,
  defaultScenario,
  gbpLifecycle,
  latestRun,
  primaryId,
  resetManualCooldown,
  reviewDocs,
  runCron,
  setScenario,
} from "../lib/gbp";

/**
 * E2E 3 — a changed, then removed, review. After a baseline scheduled sync,
 * Google changes one review's text and reply: "Sync now" in the UI (the
 * MANUAL path) updates the same doc, no new one. Then Google drops it: the
 * next sync tombstones it, the run explains the reconciliation, and the
 * dashboard no longer shows it.
 */

test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "needs GBP_PROVIDER=fake, which a deployed target refuses by design");

gbpLifecycle(test);

async function syncNowInUi(page: Page, expected: string) {
  await page.goto(`/sa/${primaryId()}/ai-agents/google-business`);
  await page.getByTestId("gbp-sync-now").click({ timeout: 30_000 });
  await expect(page.getByTestId("gbp-sync-result")).toContainText(expected, { timeout: 30_000 });
}

test("an edit updates the same review; a removal tombstones it after a full pass", async ({ page, request }) => {
  await runCron(request);
  const before = await reviewDocs();
  const r6 = before.find((d) => d.reviewId === "fake-r6");
  expect(r6).toBeDefined();

  // --- Edit text + reply at "Google", then Sync now.
  const changed = defaultScenario();
  const target = changed.reviews[LOC_A].reviews.find((r) => r.reviewId === "fake-r6")!;
  target.comment = "Fixture review: technician arrived late, but fixed it the same day.";
  target.updateTime = "2026-09-01T09:00:00Z";
  target.reply = { comment: "Sorry about the delay — fixture team.", updateTime: "2026-09-01T12:00:00Z" };
  await setScenario(changed);
  await syncNowInUi(page, "Synced: 0 new, 1 updated, 0 removed.");

  const afterEdit = await reviewDocs();
  expect(afterEdit).toHaveLength(7);
  const edited = afterEdit.find((d) => d.reviewId === "fake-r6")!;
  expect(edited.id).toBe(r6!.id);
  expect(edited.comment).toBe("Fixture review: technician arrived late, but fixed it the same day.");
  expect(edited.reply).toEqual({ comment: "Sorry about the delay — fixture team.", updateTime: "2026-09-01T12:00:00Z" });
  expect(await latestRun()).toMatchObject({ trigger: "manual", status: "success", created: 0, updated: 1 });
  await expect(page.getByTestId("gbp-review-fake-r6")).toContainText("but fixed it the same day");
  await expect(page.getByTestId("gbp-review-fake-r6")).toContainText("Sorry about the delay");

  // --- Google drops it: the next full pass tombstones it.
  changed.reviews[LOC_A].reviews = changed.reviews[LOC_A].reviews.filter((r) => r.reviewId !== "fake-r6");
  changed.reviews[LOC_A].totalReviewCount = 6;
  await setScenario(changed);
  await resetManualCooldown();
  await syncNowInUi(page, "Synced: 0 new, 0 updated, 1 removed.");

  const afterRemoval = await reviewDocs();
  expect(afterRemoval).toHaveLength(7);
  expect(afterRemoval.find((d) => d.id === r6!.id)).toMatchObject({
    state: "removed", comment: null, reviewer: null, reply: null,
  });
  expect(await latestRun()).toMatchObject({ status: "success", removed: 1, reconciliation: "full" });
  await expect(page.locator('[data-testid^="gbp-review-fake-"]')).toHaveCount(6);
  await expect(page.getByTestId("gbp-review-fake-r6")).toHaveCount(0);
});
