import { expect, test } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { FIXTURE_SECONDARY_NAME, readEnv } from "../lib/env";
import {
  ACCOUNT,
  LOC_A,
  gbpLifecycle,
  latestRun,
  pageFetch,
  patchScenario,
  primaryId,
  replyCalls,
  reviewDocs,
  runCron,
} from "../lib/gbp";
import { assertFixtureSubAccount } from "../lib/guard";

/**
 * E2E 5 — explicit owner reply. A synced fixture listing with unreplied
 * reviews; the agency-owner admin replies from the page. The fake provider
 * logs every reply call, so the spec counts calls "to Google": exactly one
 * for the submit, none for a replay of the same request (same idempotency
 * key), an honest failure that leaves the cached review unreplied, a 404 and
 * zero calls for the primary's review id POSTed on the SECONDARY fixture
 * sub-account, and no reply call from a cron sweep.
 *
 * Collaborator denial is proven in vitest (…/reply/route.test.ts) — the E2E
 * identity is an agency owner, which counts as an admin everywhere.
 */

test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "needs GBP_PROVIDER=fake, which a deployed target refuses by design");

gbpLifecycle(test);

const name = (id: string) => `${ACCOUNT}/${LOC_A}/reviews/${id}`;
const TEXT = "Sorry about the late arrival — we've spoken to the team. (E2E fixture reply)";
const puts = async () => (await replyCalls()).filter((c) => c.op === "putReply");
const doc = async (reviewId: string) => (await reviewDocs()).find((d) => d.reviewId === reviewId)!;

test("an explicit reply posts once; a replay is free; a failure is honest; a guessed id 404s", async ({ page, request }) => {
  await runCron(request);
  expect(await reviewDocs()).toHaveLength(7);

  // --- The admin replies to an unreplied review.
  await page.goto(`/sa/${primaryId()}/ai-agents/google-business`);
  await page.getByTestId("gbp-reply-open-fake-r6").click({ timeout: 30_000 });
  await expect(page.getByTestId("gbp-reply-composer")).toContainText("public on Google");
  await page.getByTestId("gbp-reply-text").fill(TEXT);
  const sent = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/reply"));
  await page.getByTestId("gbp-reply-submit").click();
  const req = await sent;
  await expect(page.getByTestId("gbp-review-reply-fake-r6")).toContainText(TEXT, { timeout: 30_000 });
  expect(await puts()).toEqual([{ op: "putReply", reviewName: name("fake-r6") }]);
  expect((await doc("fake-r6")).reply).toMatchObject({ comment: TEXT });

  // --- The same request again (same idempotency key): the stored result, no second call.
  const replay = await pageFetch(page, new URL(req.url()).pathname, "POST", req.postData() ?? "");
  expect(replay.status).toBe(200);
  expect(replay.body.reply).toMatchObject({ comment: TEXT });
  expect(await puts()).toHaveLength(1);

  // --- Google refuses the next reply: the page says so, the cache stays unreplied.
  await patchScenario({ failNext: { op: "putReply", kind: "transient" } });
  await page.getByTestId("gbp-reply-open-fake-r2").click();
  await page.getByTestId("gbp-reply-text").fill("A fixture reply Google refuses.");
  await page.getByTestId("gbp-reply-submit").click();
  await expect(page.getByTestId("gbp-reply-error")).toBeVisible({ timeout: 30_000 });
  expect((await doc("fake-r2")).reply).toBeNull();
  await expect(page.getByTestId("gbp-review-reply-fake-r2")).toHaveCount(0);
  const callsAfterFailure = (await replyCalls()).length;
  expect(callsAfterFailure).toBe(2);

  // --- The primary's review id on the SECONDARY fixture path: 404, zero calls.
  // Gate on for the secondary for this one call, so the refusal is the 404 and not gate_off.
  const secondary = readEnv().E2E_SUBACCOUNT_ID_SECONDARY;
  await assertFixtureSubAccount(secondary, FIXTURE_SECONDARY_NAME);
  const secondaryRef = adminDb().doc(`subAccounts/${secondary}`);
  const priorGate = (await secondaryRef.get()).data()?.googleEnabledByAgency;
  await secondaryRef.update({ googleEnabledByAgency: true });
  try {
    const guessed = await pageFetch(
      page,
      `/api/sub-accounts/${secondary}/gbp/reviews/${(await doc("fake-r6")).id}/reply`,
      "POST",
      JSON.stringify({ comment: "A guessed id.", idempotencyKey: "e2e-guessed-key-0001" }),
    );
    expect(guessed.status).toBe(404);
  } finally {
    await assertFixtureSubAccount(secondary, FIXTURE_SECONDARY_NAME);
    await secondaryRef.update({ googleEnabledByAgency: priorGate === undefined ? FieldValue.delete() : priorGate });
  }
  expect((await replyCalls()).length).toBe(callsAfterFailure);
  expect((await adminDb().doc(`subAccounts/${secondary}/private/gbpFakeScenario`).get()).exists).toBe(false);

  // --- A cron sweep afterwards: no reply call, and the posted reply reads as unchanged.
  await runCron(request);
  expect((await replyCalls()).length).toBe(callsAfterFailure);
  expect(await latestRun()).toMatchObject({ status: "success", created: 0, updated: 0, unchanged: 7 });
  expect((await doc("fake-r6")).reply).toMatchObject({ comment: TEXT });
});
