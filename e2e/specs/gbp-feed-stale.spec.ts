import { expect, test } from "@playwright/test";
import {
  ageLastSuccess,
  defaultScenario,
  feedPath,
  gbpLifecycle,
  latestRun,
  primaryId,
  putWidget,
  runCron,
  setScenario,
} from "../lib/gbp";

/**
 * E2E 6 (feed half) — a revoked grant with a good public cache. After a
 * successful sync the grant is revoked at "Google" and the next sync ends
 * reconnect_required: the public feed keeps serving the cached reviews,
 * explicitly labelled stale — never live. Once the last success is more than
 * 7 days old the feed says unavailable and serves nothing.
 */

test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "needs GBP_PROVIDER=fake, which a deployed target refuses by design");

gbpLifecycle(test);

test("a revoked grant serves the cache labelled stale, then unavailable after 7 days", async ({ page, request }) => {
  await runCron(request);
  await page.goto(`/sa/${primaryId()}/ai-agents/google-business`);
  await expect(page.getByTestId("gbp-widget-card")).toBeVisible({ timeout: 30_000 });
  const publicId = await putWidget(page, { enabled: true, allowedOrigins: [] });
  const good = await (await request.get(feedPath(publicId))).json();
  expect(good).toMatchObject({ status: "ok", freshness: { stale: false }, rating: { average: 3.6, count: 7 } });

  await setScenario({ ...defaultScenario(), revoked: true });
  await runCron(request);
  expect(await latestRun()).toMatchObject({ status: "reconnect_required" });

  const stale = await (await request.get(feedPath(publicId))).json();
  expect(stale).toMatchObject({
    status: "stale",
    freshness: { stale: true, lastSuccessfulSyncAt: good.freshness.lastSuccessfulSyncAt },
    rating: { average: 3.6, count: 7 },
  });
  expect(stale.reviews).toEqual(good.reviews);

  await ageLastSuccess(8 * 24);
  const expired = await (await request.get(feedPath(publicId))).json();
  expect(expired).toMatchObject({ status: "unavailable", rating: null, reviews: [], freshness: { stale: true } });
});
