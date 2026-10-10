import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import { blankWebsiteConfig } from "../../src/types/website";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv, requireGitpageApiKey } from "../lib/env";
import { assertFixtureSubAccount, deleteScoped } from "../lib/guard";
import { runId } from "../lib/run-id";

/**
 * Website Build v2 — gitpage's `build.settled` callback, through the real
 * server. The route is public (no session); its only credential is the
 * HMAC-SHA256 of the raw body under GITPAGE_API_KEY. This drives:
 *
 *  1. The refusals: no signature, a signature under another key, and a body
 *     changed after signing are each answered 401 with the site untouched —
 *     by the ROUTE, which proves middleware lets the path through without a
 *     session rather than bouncing it to /login.
 *  2. A correctly signed callback settles the seeded fixture site
 *     (building → ready, with the live URL and gitpage's page id).
 *  3. A second delivery of the same callback is acknowledged and changes
 *     nothing — the settle is once-only.
 *  4. The website page still renders the settled site (the card is the
 *     pre-v2 builder; it must cope with the v2 fields the settle writes).
 *
 * gitpage itself is never called: the callback path only reads and writes
 * the site doc. One site doc on the fixture PRIMARY, id and job id scoped to
 * this run, deleted through the fixture guard afterwards.
 */

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "signs with the E2E job's own GITPAGE_API_KEY, which a deployed target does not hold",
);
test.describe.configure({ mode: "serial" });

const PATH = "/api/webhooks/gitpage/build-settled";
const SITE_ID = `e2e-ws2-${runId()}`;
const JOB_ID = `build_e2e_${runId()}`;
const SITE_NAME = `E2E build-settled ${runId()}`;
const LIVE_URL = `https://e2e-${runId()}.example.test/site`;

const primaryId = () => readEnv().E2E_SUBACCOUNT_ID;
const siteRef = () => adminDb().doc(`subAccounts/${primaryId()}/website/${SITE_ID}`);
const guard = () => assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);
const site = async () => (await siteRef().get()).data() ?? null;

const callbackBody = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    event: "build.settled",
    formResponseId: JOB_ID,
    subAccountId: primaryId(),
    status: "Published",
    statusPhase: "completed",
    pagesUrl: LIVE_URL,
    quality: "premium",
    pageId: `page_${runId()}`,
    ...patch,
  });

const sign = (body: string, key: string) =>
  `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;

const headers = (signature?: string) => ({
  "content-type": "application/json",
  ...(signature === undefined ? {} : { "x-gitpage-signature": signature }),
});

test.beforeAll(async () => {
  await guard();
  await siteRef().set({
    id: SITE_ID,
    agencyId: readEnv().E2E_AGENCY_ID,
    subAccountId: primaryId(),
    name: SITE_NAME,
    status: "building",
    gitpageJobId: JOB_ID,
    liveUrl: null,
    errorMessage: null,
    partialErrors: null,
    pollAttempts: 2,
    lastBuildAt: null,
    lastBuildByUid: null,
    quality: "premium",
    estimatedDurationSeconds: 1200,
    config: { ...blankWebsiteConfig(), heading: SITE_NAME },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

test.afterAll(async () => {
  await guard();
  // Re-reads the doc and refuses unless it is stamped with the fixture
  // sub-account AND the E2E agency.
  await deleteScoped(siteRef());
});

test.describe("the callback, with no session", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("an unsigned, wrongly signed or tampered callback is refused and settles nothing", async ({ request }) => {
    const key = requireGitpageApiKey();
    const body = callbackBody();

    const unsigned = await request.post(PATH, { headers: headers(), data: body, maxRedirects: 0 });
    expect(unsigned.status()).toBe(401);

    const wrongKey = await request.post(PATH, {
      headers: headers(sign(body, `${key}-not-the-key`)),
      data: body,
      maxRedirects: 0,
    });
    expect(wrongKey.status()).toBe(401);

    // Signed for a failure report, delivered as a success.
    const tampered = await request.post(PATH, {
      headers: headers(sign(callbackBody({ status: "failed", error: "boom" }), key)),
      data: body,
      maxRedirects: 0,
    });
    expect(tampered.status()).toBe(401);

    expect(await site()).toMatchObject({ status: "building", liveUrl: null, pollAttempts: 2 });
  });

  test("a signed callback settles the site once; a second delivery changes nothing", async ({ request }) => {
    const key = requireGitpageApiKey();
    const body = callbackBody();

    const first = await request.post(PATH, { headers: headers(sign(body, key)), data: body, maxRedirects: 0 });
    expect(first.status()).toBe(200);
    expect(await first.json()).toEqual({ ok: true, settled: "ready" });

    const settled = await site();
    expect(settled).toMatchObject({
      status: "ready",
      liveUrl: LIVE_URL,
      errorMessage: null,
      statusPhase: "completed",
      gitpagePageId: `page_${runId()}`,
      gitpageJobId: JOB_ID,
    });

    // gitpage retries, or the poll loop's copy arrives late: same job, a
    // different URL this time so an applied duplicate would be visible.
    const replayBody = callbackBody({ pagesUrl: "https://replayed.example.test/" });
    const replay = await request.post(PATH, {
      headers: headers(sign(replayBody, key)),
      data: replayBody,
      maxRedirects: 0,
    });
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toEqual({ ok: true, ignored: "already-settled" });
    expect(await site()).toEqual(settled);
  });
});

test("the website page shows the settled site with its live URL", async ({ page }) => {
  // The page re-checks the deployment's gitpage status when the tab gains
  // focus: an agency-owner call that sends the deployment heartbeat. This
  // server shares the production Firestore, so that call must never leave
  // the browser — it is answered here instead.
  await page.route("**/api/agency/refresh-gitpage-status", (route) =>
    route.fulfill({ status: 200, json: { ok: true, sent: false, agency: null, backfilled: false } }),
  );

  await page.goto(`/sa/${primaryId()}/website`);
  await expect(page.getByText(SITE_NAME)).toBeVisible({ timeout: 30_000 });
  // The live URL is unique to this run, so this is this site's own button.
  await expect(page.locator(`a[href="${LIVE_URL}"]`).filter({ hasText: "Visit" })).toBeVisible();
});
