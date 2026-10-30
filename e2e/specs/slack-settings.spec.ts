import { expect, test } from "@playwright/test";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { assertFixtureSubAccount } from "../lib/guard";

/**
 * Slack notifications card (Settings → Admin) and its routes through the real
 * server, as the fixture owner on PRIMARY. Nothing here connects a hook: no
 * real Slack URL exists in CI, and every URL sent is one the server must
 * refuse before posting. So the run writes nothing, and the last step checks
 * that it didn't.
 */

const primaryId = () => readEnv().E2E_SUBACCOUNT_ID;
const privateSlack = () => adminDb().doc(`subAccounts/${primaryId()}/private/slack`);

test.beforeAll(async () => {
  await assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);
  // A connected fixture would mean someone pasted a real hook; leave it be.
  const meta = (await adminDb().doc(`subAccounts/${primaryId()}`).get()).data()?.slackMeta;
  expect(meta?.connected ?? false, "fixture PRIMARY must not have Slack connected").toBe(false);
  expect((await privateSlack().get()).exists).toBe(false);
});

test.afterAll(async () => {
  expect((await privateSlack().get()).exists, "a refused URL must never be stored").toBe(false);
});

test("the card renders, and a non-Slack URL is refused with nothing stored", async ({ page }) => {
  await page.goto(`/sa/${primaryId()}/dashboard/settings`);
  const heading = page.getByRole("heading", { name: "Slack notifications" });
  await expect(heading).toBeVisible({ timeout: 30_000 });

  await page.getByLabel("Incoming Webhook URL").fill("https://hooks.slack.com.evil.test/services/T1/B1/x1");
  await page.getByRole("button", { name: "Connect Slack" }).click();
  await expect(page.getByText(/doesn't look like a Slack Incoming Webhook URL/)).toBeVisible({ timeout: 30_000 });
  expect((await privateSlack().get()).exists).toBe(false);
});

test("GET carries no URL; POST refuses an http or lookalike URL", async ({ page }) => {
  await page.goto(`/sa/${primaryId()}/dashboard/settings`);
  await expect(page.getByRole("heading", { name: "Slack notifications" })).toBeVisible({ timeout: 30_000 });

  const results = await page.evaluate(async (sa) => {
    const get = await fetch(`/api/sub-accounts/${sa}/slack`);
    const posts = [];
    for (const webhookUrl of [
      "http://hooks.slack.com/services/T1/B1/x1",
      "https://evil.test/services/T1/B1/x1",
    ]) {
      const res = await fetch(`/api/sub-accounts/${sa}/slack`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ webhookUrl }),
      });
      posts.push(res.status);
    }
    return { getStatus: get.status, getBody: await get.text(), posts };
  }, primaryId());

  expect(results.getStatus, results.getBody.slice(0, 200)).toBe(200);
  expect(JSON.parse(results.getBody).config).toMatchObject({ connected: false });
  expect(results.getBody).not.toContain("hooks.slack.com");
  expect(results.posts).toEqual([400, 400]);
});
