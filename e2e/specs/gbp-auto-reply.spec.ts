import { expect, test, type Page } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import { FIXTURE_PRIMARY_NAME } from "../lib/env";
import {
  ACCOUNT, LOC_A, defaultScenario, gbpLifecycle, primaryId, primaryRef, replyCalls, resetManualCooldown, reviewDocs, setScenario,
  type Scenario,
} from "../lib/gbp";
import { assertFixtureSubAccount } from "../lib/guard";

/**
 * Review auto-reply (AUTO_REPLY_V1_PLAN.md, PR 3) end to end, on the fixture
 * PRIMARY with the fenced GBP fake (every reply call logged in the scenario)
 * and the fenced Reviews AI fake (every draft logged). CI's E2E job sets the
 * kill switch (REVIEWS_AUTO_REPLY_ENABLED=1); in fake mode the engine serves
 * the fixture agency only (run.ts), and both of its providers are fenced to it.
 *
 * The admin switches auto-reply on in Reputation → Settings (backlog on — the
 * fixture reviews predate the switch), then Sync now: the rating-only 5★ is
 * posted without a click and tagged "Auto-replied"; the rating-only 3★
 * (Approval) and the texted 5★ (text always waits) land under "Needs
 * approval" with drafts. One is posted from the pre-filled composer through
 * the normal reply route; the other is Discarded — the count drops and the
 * row is gone. A second Sync now posts nothing.
 */

test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "needs GBP_PROVIDER=fake, REVIEWS_AI_PROVIDER=fake and the auto-reply kill switch, which a deployed target refuses by design");

gbpLifecycle(test);

const MIN = 60_000;
const guard = () => assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);
const privateDoc = (id: string) => primaryRef().collection("private").doc(id);
const restore = (v: unknown) => (v === undefined ? FieldValue.delete() : v);
const PRIVATE = ["reviewsAiFakeLog", "sentimentLease", "sentimentUsage", "autoReplyLease", "autoReplyUsage"];
const name = (id: string) => `${ACCOUNT}/${LOC_A}/reviews/${id}`;
const puts = async () => (await replyCalls()).filter((c) => c.op === "putReply").map((c) => c.reviewName);
const doc = async (id: string) => (await reviewDocs()).find((d) => d.reviewId === id);
const drafts = async () => (((await privateDoc("reviewsAiFakeLog").get()).data()?.drafts ?? []) as unknown[]).length;

/** Click Sync now and wait for the sync route's answer (the engine runs after it). */
async function syncNow(page: Page) {
  const answered = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/gbp/sync"), { timeout: 60_000 });
  await page.getByTestId("gbp-sync-now").click({ timeout: 30_000 });
  expect((await answered).status()).toBe(200);
}

/** Three unreplied reviews from the last hour: a rating-only 5★, a rating-only 3★, a texted 5★. */
function autoReplyScenario(now: number): Scenario {
  const s = defaultScenario();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * MIN).toISOString();
  const review = (id: string, star: number, comment: string | null, minutesAgo: number) => ({
    name: name(id), reviewId: id, reviewer: { displayName: `Fixture Reviewer ${id}`, profilePhotoUrl: null, isAnonymous: false },
    starRating: star, comment, createTime: at(minutesAgo), updateTime: at(minutesAgo), reply: null,
  });
  s.reviews[LOC_A] = {
    averageRating: 4.3,
    totalReviewCount: 3,
    reviews: [
      review("fake-ar-5", 5, null, 10),
      review("fake-ar-3", 3, null, 20),
      review("fake-ar-5t", 5, "Fixture review: great install, but please call me about the router.", 30),
    ],
  };
  return s;
}

/** What setup read BEFORE writing — set only once it has (teardown runs even when setup throws). */
let prior: { ai: unknown; auto: unknown; settings: unknown } | null = null;

test.beforeAll(async () => {
  await guard();
  const data = (await primaryRef().get()).data() ?? {};
  prior = { ai: data.reviewsAiEnabledByAgency, auto: data.reviewsAutoReplyEnabledByAgency, settings: data.reviewsAutoReply };
  for (const id of PRIVATE) await privateDoc(id).delete();
  await primaryRef().update({
    reviewsAiEnabledByAgency: true, reviewsAutoReplyEnabledByAgency: true, reviewsAutoReply: FieldValue.delete(),
  });
  await setScenario(autoReplyScenario(Date.now()));
});

test.afterAll(async () => {
  const errors: unknown[] = [];
  const step = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      errors.push(err);
    }
  };
  await step(guard);
  if (errors.length) throw errors[0]; // never touch a doc the guard did not clear
  for (const id of PRIVATE) await step(() => privateDoc(id).delete());
  const p = prior;
  if (p) {
    await step(() => primaryRef().update({
      reviewsAiEnabledByAgency: restore(p.ai), reviewsAutoReplyEnabledByAgency: restore(p.auto), reviewsAutoReply: restore(p.settings),
    }));
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "gbp-auto-reply teardown: several steps failed");
});

test("enable → Sync now: rating-only 5★ auto-replied; 3★ and texted 5★ held; approve one, discard one; rerun posts nothing", async ({ page }) => {
  // --- Reputation → Settings: the card is unlocked, the engine runs here; switch it on with the backlog.
  await page.goto(`/sa/${primaryId()}/reputation/settings`);
  await page.getByTestId("rep-settings-autoreply-enabled").check({ timeout: 30_000 });
  await expect(page.getByTestId("rep-settings-autoreply-not-running")).toHaveCount(0);
  await expect(page.getByTestId("rep-settings-autoreply-locked")).toHaveCount(0);
  await page.getByTestId("rep-settings-autoreply-backlog").check();
  await page.getByTestId("rep-settings-autoreply-save").click();
  await expect(page.getByTestId("rep-settings-autoreply-saved")).toBeVisible({ timeout: 30_000 });
  expect((await primaryRef().get()).data()?.reviewsAutoReply).toMatchObject({ enabled: true, includeBacklog: true, listingLocationName: LOC_A });

  // --- Reviews: Sync now. The engine runs after the response.
  await page.goto(`/sa/${primaryId()}/reputation/reviews`);
  await syncNow(page);
  await expect.poll(async () => !!(await doc("fake-ar-5"))?.autoReplied, { timeout: 60_000 }).toBe(true);
  await expect.poll(async () => {
    const held = await Promise.all(["fake-ar-3", "fake-ar-5t"].map(doc));
    return held.map((d) => typeof (d?.pendingReply as { text?: unknown } | null | undefined)?.text === "string");
  }, { timeout: 60_000 }).toEqual([true, true]);
  expect(await puts()).toEqual([name("fake-ar-5")]);

  // --- The page: the auto-posted reply is tagged; two rows need approval, each with its reason.
  await page.reload();
  await expect(page.getByTestId("gbp-review-auto-replied-fake-ar-5")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("gbp-filter-needs-approval-count")).toHaveText("(2)");
  await page.getByTestId("gbp-filter-needs-approval").click();
  await expect(page.getByTestId("gbp-review-fake-ar-5")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("gbp-review-approval-fake-ar-3")).toHaveText("Held for approval");
  await expect(page.getByTestId("gbp-review-approval-fake-ar-5t")).toHaveText("Held for approval");

  // --- Approve the 3★: the composer opens with the stored draft; Post goes through the reply route.
  await page.getByTestId("gbp-reply-open-fake-ar-3").click();
  const box = page.getByTestId("gbp-reply-text");
  await expect(box).toHaveValue(/3-star review of Velo Test Fibre — Gqeberha/);
  const sent = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith(`/reply`));
  await page.getByTestId("gbp-reply-submit").click();
  await sent;
  await expect(page.getByTestId("gbp-filter-needs-approval-count")).toHaveText("(1)", { timeout: 30_000 });
  await expect(page.getByTestId("gbp-review-fake-ar-3")).toHaveCount(0);
  expect(await puts()).toEqual([name("fake-ar-5"), name("fake-ar-3")]);

  // --- Discard the texted 5★: nothing is posted, the count drops, the row is gone.
  await page.getByTestId("gbp-reply-discard-fake-ar-5t").click();
  await expect(page.getByTestId("gbp-filter-needs-approval-count")).toHaveText("(0)", { timeout: 30_000 });
  await expect(page.getByTestId("gbp-review-fake-ar-5t")).toHaveCount(0);
  expect((await doc("fake-ar-5t"))?.pendingReply).toMatchObject({ reason: "dismissed", text: null });
  expect(await puts()).toHaveLength(2);

  // --- Sync now again: nothing new is drafted or posted.
  const draftsBefore = await drafts();
  await resetManualCooldown();
  await page.getByTestId("gbp-filter-needs-approval").click();
  await syncNow(page);
  await page.waitForTimeout(5000); // the after-response engine run has finished by now (the fakes answer at once)
  expect(await puts()).toHaveLength(2);
  expect(await drafts()).toBe(draftsBefore);
  expect((await doc("fake-ar-5t"))?.pendingReply).toMatchObject({ reason: "dismissed" });
});
