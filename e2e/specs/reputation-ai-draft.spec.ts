import { expect, test } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import { FIXTURE_PRIMARY_NAME } from "../lib/env";
import { ACCOUNT, LOC_A, gbpLifecycle, primaryId, primaryRef, replyCalls, reviewDocs, runCron } from "../lib/gbp";
import { assertFixtureSubAccount } from "../lib/guard";

/**
 * SP5 (c) — AI reply drafts (ledger R5, R6, S1). On the fixture PRIMARY with
 * the fenced GBP fake (every reply call logged in the scenario) and the
 * fenced Reviews AI fake (every draft logged, never its text): reply
 * guidelines saved on Reputation → Settings reach the draft; "Draft with AI"
 * only fills the box — ZERO putReply calls until the admin clicks "Post reply
 * to Google" — and what is posted is exactly the EDITED text, once; with the
 * Reviews AI gate off there is no Draft button at all.
 */

test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "needs GBP_PROVIDER=fake and REVIEWS_AI_PROVIDER=fake, which a deployed target refuses by design");

gbpLifecycle(test);

const MARK = "MARK-7Q2";
const GUIDELINES = `${MARK} Sign off as The Fixture Team.`;
const guard = () => assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);
const privateDoc = (id: string) => primaryRef().collection("private").doc(id);
const puts = async () => (await replyCalls()).filter((c) => c.op === "putReply");
const restore = (v: unknown) => (v === undefined ? FieldValue.delete() : v);

/** What setup read BEFORE writing — set only once it has (teardown runs even when setup throws). */
let prior: { gate: unknown; config: unknown } | null = null;

test.beforeAll(async () => {
  await guard();
  const data = (await primaryRef().get()).data() ?? {};
  for (const id of ["reviewsAiFakeLog", "sentimentLease", "sentimentUsage"]) await privateDoc(id).delete();
  prior = { gate: data.reviewsAiEnabledByAgency, config: data.reviewsAiConfig };
  await primaryRef().update({ reviewsAiEnabledByAgency: true, reviewsAiConfig: FieldValue.delete() });
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
  for (const id of ["reviewsAiFakeLog", "sentimentLease", "sentimentUsage"]) await step(() => privateDoc(id).delete());
  const p = prior;
  if (p) await step(() => primaryRef().update({ reviewsAiEnabledByAgency: restore(p.gate), reviewsAiConfig: restore(p.config) }));
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "reputation-ai-draft teardown: several steps failed");
});

test("guidelines reach the draft; a draft posts nothing; the click posts the edited text once; gate off hides it", async ({ page, request }) => {
  await runCron(request);
  expect(await reviewDocs()).toHaveLength(7);

  // --- Reputation → Settings: save the reply guidelines.
  await page.goto(`/sa/${primaryId()}/reputation/settings`);
  await expect(page.getByTestId("rep-tab-settings")).toHaveAttribute("aria-current", "page", { timeout: 30_000 });
  await page.getByTestId("rep-settings-guidelines").fill(GUIDELINES);
  await page.getByTestId("rep-settings-guidelines-save").click();
  await expect(page.getByTestId("rep-settings-guidelines-saved")).toBeVisible({ timeout: 30_000 });
  expect((await primaryRef().get()).data()?.reviewsAiConfig).toMatchObject({ replyGuidelines: GUIDELINES });

  // --- Reviews: Draft with AI on an unreplied 2-star review fills the box and posts NOTHING.
  await page.goto(`/sa/${primaryId()}/reputation/reviews`);
  await page.getByTestId("gbp-reply-open-fake-r6").click({ timeout: 30_000 });
  await page.getByTestId("gbp-reply-draft").click();
  const box = page.getByTestId("gbp-reply-text");
  await expect(box).toHaveValue(/2-star review of Velo Test Fibre — Gqeberha/, { timeout: 30_000 });
  await expect(box).toHaveValue(new RegExp(MARK));
  await expect(page.getByTestId("gbp-reply-draft-note")).toHaveText(
    "AI draft — edit before posting. Nothing is sent until you click Post reply to Google.",
  );
  await page.waitForTimeout(1500); // anything posted in the background would have landed by now
  expect(await puts()).toEqual([]);
  expect((await reviewDocs()).find((d) => d.reviewId === "fake-r6")?.reply).toBeNull();
  const drafts = ((await privateDoc("reviewsAiFakeLog").get()).data()?.drafts ?? []) as Array<{ kind: string; stars: number }>;
  expect(drafts).toEqual([expect.objectContaining({ kind: "draft", stars: 2 })]);

  // --- The human edits, then clicks: exactly the EDITED text is posted, once.
  const edited = `${await box.inputValue()}\nEdited by the E2E human.`;
  await box.fill(edited);
  await page.getByTestId("gbp-reply-submit").click();
  await expect(page.getByTestId("gbp-review-reply-fake-r6")).toContainText("Edited by the E2E human.", { timeout: 30_000 });
  expect(await puts()).toEqual([{ op: "putReply", reviewName: `${ACCOUNT}/${LOC_A}/reviews/fake-r6` }]);
  expect((await reviewDocs()).find((d) => d.reviewId === "fake-r6")?.reply).toMatchObject({ comment: edited });

  // --- Reviews AI gate off: no Draft button at all.
  await guard();
  await primaryRef().update({ reviewsAiEnabledByAgency: false });
  await page.reload();
  await page.getByTestId("gbp-reply-open-fake-r2").click({ timeout: 30_000 });
  await expect(page.getByTestId("gbp-reply-composer")).toBeVisible();
  await expect(page.getByTestId("gbp-reply-draft")).toHaveCount(0);
  expect(await puts()).toHaveLength(1);
});
