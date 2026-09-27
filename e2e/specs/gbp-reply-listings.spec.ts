import { expect, test } from "@playwright/test";
import {
  ACCOUNT,
  LOC_A,
  LOC_B,
  gbpLifecycle,
  replyCalls,
  reviewDocs,
  runCron,
  primaryId,
  seedConnectedListing,
  setScenario,
  twoListingScenario,
} from "../lib/gbp";

/**
 * The Reviews tab across listings (MULTI_LISTING_V1_PLAN.md PR 4) on the
 * fixture PRIMARY, with the fenced GBP fake serving the main LOC_A (seven
 * reviews) and the extra LOC_B (two). "All listings" shows both, each row
 * labelled; picking the second listing narrows to it; a reply to its review
 * reaches the fake at THAT review's own name (so its own listing), and the
 * row shows it.
 */

test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "needs GBP_PROVIDER=fake, which a deployed target refuses by design");

gbpLifecycle(test);

const MAIN_TITLE = "Velo Test Fibre — Gqeberha";
const B_TITLE = "Velo Test Fibre — Gqeberha North";
const TEXT = "Thanks for the stars, north branch. (E2E fixture reply)";

test("a review on the second listing is replied to from the Reviews tab, at its own listing", async ({ page, request }) => {
  await seedConnectedListing({ extras: true });
  await setScenario(twoListingScenario());
  await runCron(request);
  const docs = await reviewDocs();
  expect(docs.filter((d) => d.locationName === LOC_A)).toHaveLength(7);
  expect(docs.filter((d) => d.locationName === LOC_B)).toHaveLength(2);

  await page.goto(`/sa/${primaryId()}/ai-agents/google-business`);
  const select = page.getByTestId("gbp-filter-listing");
  await expect(select).toHaveValue("", { timeout: 30_000 });

  // --- "All listings": both listings' reviews, each labelled with its own listing.
  await expect(page.getByTestId("gbp-review-listing-fake-b1")).toHaveText(B_TITLE);
  await expect(page.getByTestId("gbp-review-listing-fake-r6")).toHaveText(MAIN_TITLE);

  // --- Pick the second listing: only its reviews remain.
  const narrowed = page.waitForResponse((r) => r.url().includes("/gbp/reviews?listing=") && r.request().method() === "GET");
  await select.selectOption(LOC_B);
  expect((await narrowed).status()).toBe(200);
  await expect(page.getByTestId("gbp-review-fake-r6")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("gbp-review-fake-b2")).toBeVisible();

  // --- Reply to its rating-only review.
  await page.getByTestId("gbp-reply-open-fake-b1").click();
  await page.getByTestId("gbp-reply-text").fill(TEXT);
  await page.getByTestId("gbp-reply-submit").click();
  await expect(page.getByTestId("gbp-review-reply-fake-b1")).toContainText(TEXT, { timeout: 30_000 });
  expect(await replyCalls()).toEqual([{ op: "putReply", reviewName: `${ACCOUNT}/${LOC_B}/reviews/fake-b1` }]);
  const b1 = (await reviewDocs()).find((d) => d.reviewId === "fake-b1" && d.locationName === LOC_B)!;
  expect(b1.reply).toMatchObject({ comment: TEXT });
  // The dropdown kept the second listing.
  await expect(select).toHaveValue(LOC_B);
});
