import { expect, test, type Page } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import { FIXTURE_PRIMARY_NAME } from "../lib/env";
import {
  ACCOUNT, LOC_A, LOC_B, gbpLifecycle, primaryId, primaryRef, replyCalls, reviewDocs, seedConnectedListing, setScenario,
  twoListingScenario, type Scenario,
} from "../lib/gbp";
import { assertFixtureSubAccount } from "../lib/guard";

/**
 * Review auto-reply per listing (MULTI_LISTING_V1_PLAN.md PR 6) end to end,
 * on the fixture PRIMARY with the fenced GBP fake (every reply call logged in
 * the scenario) and the fenced Reviews AI fake, as gbp-auto-reply.spec.ts.
 * CI's E2E job sets the kill switch (REVIEWS_AUTO_REPLY_ENABLED=1).
 *
 * Two listings: main LOC_A and the extra LOC_B, each with a fresh rating-only
 * 5★. The admin switches auto-reply on for LOC_B ONLY in Reputation →
 * Settings (backlog on — the reviews predate the switch), then Sync now: B's
 * review is posted at B's own review name; main's reviews are not touched.
 */

test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "needs GBP_PROVIDER=fake, REVIEWS_AI_PROVIDER=fake and the auto-reply kill switch, which a deployed target refuses by design");

gbpLifecycle(test);

const MIN = 60_000;
const B_TITLE = "Velo Test Fibre — Gqeberha North";
const guard = () => assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);
const privateDoc = (id: string) => primaryRef().collection("private").doc(id);
const restore = (v: unknown) => (v === undefined ? FieldValue.delete() : v);
const PRIVATE = ["reviewsAiFakeLog", "sentimentLease", "sentimentUsage", "autoReplyLease", "autoReplyUsage"];
const nameOn = (loc: string, id: string) => `${ACCOUNT}/${loc}/reviews/${id}`;
const puts = async () => (await replyCalls()).filter((c) => c.op === "putReply").map((c) => c.reviewName);
const docOn = async (loc: string, id: string) => (await reviewDocs()).find((d) => d.locationName === loc && d.reviewId === id);

async function syncNow(page: Page) {
  const answered = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/gbp/sync"), { timeout: 60_000 });
  await page.getByTestId("gbp-sync-now").click({ timeout: 30_000 });
  expect((await answered).status()).toBe(200);
}

/** The two-listing scenario plus a rating-only 5★ from 10 minutes ago on EACH listing. */
function scenario(now: number): Scenario {
  const s = twoListingScenario();
  const at = new Date(now - 10 * MIN).toISOString();
  const fresh = (loc: string, id: string) => ({
    name: nameOn(loc, id), reviewId: id, reviewer: { displayName: `Fixture Reviewer ${id}`, profilePhotoUrl: null, isAnonymous: false },
    starRating: 5, comment: null, createTime: at, updateTime: at, reply: null,
  });
  s.reviews[LOC_A].reviews.unshift(fresh(LOC_A, "fake-la-5"));
  s.reviews[LOC_B] = { averageRating: 5, totalReviewCount: 1, reviews: [fresh(LOC_B, "fake-lb-5")] };
  return s;
}

/** What setup read BEFORE writing — set only once it has (teardown runs even when setup throws). */
let prior: { ai: unknown; auto: unknown } | null = null;

test.beforeAll(async () => {
  await guard();
  const data = (await primaryRef().get()).data() ?? {};
  prior = { ai: data.reviewsAiEnabledByAgency, auto: data.reviewsAutoReplyEnabledByAgency };
  for (const id of PRIVATE) await privateDoc(id).delete();
  await primaryRef().update({
    reviewsAiEnabledByAgency: true, reviewsAutoReplyEnabledByAgency: true, reviewsAutoReply: FieldValue.delete(),
  });
  await seedConnectedListing({ extras: true });
  await setScenario(scenario(Date.now()));
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
  // The extra listing and every auto-reply switch (main's and extraListings) go, whatever setup reached.
  await step(() => primaryRef().update({
    reviewsAutoReply: FieldValue.delete(), googleExtraListings: FieldValue.delete(), googleLocationNames: FieldValue.delete(),
  }));
  const p = prior;
  if (p) {
    await step(() => primaryRef().update({ reviewsAiEnabledByAgency: restore(p.ai), reviewsAutoReplyEnabledByAgency: restore(p.auto) }));
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "gbp-auto-reply-listing teardown: several steps failed");
});

test("switch on the extra listing only → Sync now: its rating-only 5★ is auto-replied; main's reviews are untouched", async ({ page }) => {
  // --- Reputation → Settings: one switch per listing; switch on B only, with the backlog.
  await page.goto(`/sa/${primaryId()}/reputation/settings`);
  const row = page.locator(`[data-testid="rep-settings-autoreply-listing"][data-location="${LOC_B}"]`);
  await expect(row).toHaveText(B_TITLE, { timeout: 30_000 });
  await expect(page.getByTestId("rep-settings-autoreply-not-running")).toHaveCount(0);
  await row.getByTestId("rep-settings-autoreply-listing-enabled").check();
  await page.getByTestId("rep-settings-autoreply-backlog").check();
  await page.getByTestId("rep-settings-autoreply-save").click();
  await expect(page.getByTestId("rep-settings-autoreply-saved")).toBeVisible({ timeout: 30_000 });
  const stored = (await primaryRef().get()).data()?.reviewsAutoReply as Record<string, unknown>;
  expect(stored).toMatchObject({ enabled: false, includeBacklog: true });
  expect(Object.keys(stored.extraListings as object)).toEqual([LOC_B.slice("locations/".length)]);

  // After a reload the card still shows B on (by its title) and main off.
  await page.reload();
  await expect(row).toHaveText(B_TITLE, { timeout: 30_000 });
  await expect(row.getByTestId("rep-settings-autoreply-listing-enabled")).toBeChecked();
  await expect(page.getByTestId("rep-settings-autoreply-enabled")).not.toBeChecked();

  // --- Reviews: Sync now. The engine runs after the response; its lease
  // (deleted in setup) is released (runId null) only by a run that reached the reviews.
  await page.goto(`/sa/${primaryId()}/reputation/reviews`);
  await syncNow(page);
  await expect.poll(async () => {
    const lease = await privateDoc("autoReplyLease").get();
    return lease.exists ? lease.data()?.runId ?? null : "absent";
  }, { timeout: 60_000 }).toBeNull();

  expect(await puts()).toEqual([nameOn(LOC_B, "fake-lb-5")]);
  expect((await docOn(LOC_B, "fake-lb-5"))?.autoReplied).toBeTruthy();
  const main = (await reviewDocs()).filter((d) => d.locationName === LOC_A);
  expect(main.length).toBeGreaterThan(0);
  for (const d of main) {
    expect(d.pendingReply ?? null).toBeNull();
    expect(d.autoReplied ?? null).toBeNull();
  }
});
