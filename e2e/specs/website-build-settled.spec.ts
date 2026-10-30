import { createHash, createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import { blankWebsiteConfig } from "../../src/types/website";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, FIXTURE_SECONDARY_NAME, readEnv, requireGitpageApiKey } from "../lib/env";
import { assertFixtureSubAccount, deleteScoped, fixtureSubAccountIds } from "../lib/guard";
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
 *  2. A valid signature is not enough to reach a site: the callback settles
 *     only the site that owns the job id INSIDE the sub-account it names. A
 *     signed callback carrying the primary's job id but the secondary's
 *     tenant, the secondary's job id but the primary's tenant, or an unknown
 *     job id settles nothing.
 *  3. A correctly signed callback settles the seeded fixture site
 *     (building → ready, with the live URL and gitpage's page id) and leaves
 *     the other fixture site as it was.
 *  4. A second delivery of the same callback is acknowledged and changes
 *     nothing — the settle is once-only.
 *  5. The website page still renders the settled site (the card is the
 *     pre-v2 builder; it must cope with the v2 fields the settle writes).
 *
 * gitpage itself is never called: the callback path only reads and writes
 * the site doc. Two site docs, one per fixture sub-account, ids and job ids
 * scoped to this run, deleted through the fixture guard afterwards. Every
 * body this spec signs names a fixture sub-account — `signed()` refuses to
 * sign anything else, so a bug here cannot aim a valid callback at a client.
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

// The other fixture tenant's site: a build in flight that no callback in
// this spec is addressed to.
const OTHER_JOB_ID = `build_e2e_other_${runId()}`;
/** gitpage page ids are ObjectIds (24 hex); a run-scoped one, so the settle keeps it. */
const PAGE_ID = createHash("sha256").update(`page_${runId()}`).digest("hex").slice(0, 24);

const primaryId = () => readEnv().E2E_SUBACCOUNT_ID;
const secondaryId = () => readEnv().E2E_SUBACCOUNT_ID_SECONDARY;
const siteRef = () => adminDb().doc(`subAccounts/${primaryId()}/website/${SITE_ID}`);
const otherRef = () => adminDb().doc(`subAccounts/${secondaryId()}/website/${SITE_ID}`);
const guard = async () => {
  await assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);
  await assertFixtureSubAccount(secondaryId(), FIXTURE_SECONDARY_NAME);
};
const site = async () => (await siteRef().get()).data() ?? null;
const other = async () => (await otherRef().get()).data() ?? null;

const BUILDING = { status: "building", liveUrl: null, pollAttempts: 2 };

const seed = (subAccountId: string, gitpageJobId: string, name: string) => ({
  id: SITE_ID,
  agencyId: readEnv().E2E_AGENCY_ID,
  subAccountId,
  name,
  status: "building",
  gitpageJobId,
  liveUrl: null,
  errorMessage: null,
  partialErrors: null,
  pollAttempts: 2,
  lastBuildAt: null,
  lastBuildByUid: null,
  quality: "premium",
  estimatedDurationSeconds: 1200,
  config: { ...blankWebsiteConfig(), heading: name },
  createdAt: new Date(),
  updatedAt: new Date(),
});

const callbackBody = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    event: "build.settled",
    formResponseId: JOB_ID,
    subAccountId: primaryId(),
    status: "Published",
    statusPhase: "completed",
    pagesUrl: LIVE_URL,
    quality: "premium",
    pageId: PAGE_ID,
    ...patch,
  });

const sign = (body: string, key: string) =>
  `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;

const headers = (signature?: string) => ({
  "content-type": "application/json",
  ...(signature === undefined ? {} : { "x-gitpage-signature": signature }),
});

/**
 * Headers + body for a callback carrying a VALID signature. Throws unless
 * the body names a fixture sub-account: a correctly signed callback is the
 * one request here that can change a site, so it is never minted for any
 * other tenant.
 */
function signed(patch: Record<string, unknown> = {}) {
  const data = callbackBody(patch);
  const named = (JSON.parse(data) as { subAccountId?: unknown }).subAccountId;
  if (typeof named !== "string" || !fixtureSubAccountIds().includes(named)) {
    throw new Error(`refusing to sign a callback for non-fixture sub-account ${String(named)}`);
  }
  return { headers: headers(sign(data, requireGitpageApiKey())), data, maxRedirects: 0 };
}

test.beforeAll(async () => {
  await guard();
  await siteRef().set(seed(primaryId(), JOB_ID, SITE_NAME));
  await otherRef().set(seed(secondaryId(), OTHER_JOB_ID, `${SITE_NAME} (other tenant)`));
});

test.afterAll(async () => {
  await guard();
  // deleteScoped re-reads each doc and refuses unless it is stamped with a
  // fixture sub-account AND the E2E agency.
  try {
    await deleteScoped(siteRef());
  } finally {
    await deleteScoped(otherRef());
  }
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

    expect(await site()).toMatchObject(BUILDING);
    expect(await other()).toMatchObject(BUILDING);
  });

  test("a valid signature settles nothing unless the job id belongs to a site in the tenant it names", async ({ request }) => {
    // This site's job id, the other tenant's sub-account.
    const wrongTenant = await request.post(PATH, signed({ subAccountId: secondaryId() }));
    expect(wrongTenant.status()).toBe(200);
    expect(await wrongTenant.json()).toEqual({ ok: true, ignored: "site-not-found" });

    // The other tenant's job id, this sub-account.
    const wrongJob = await request.post(PATH, signed({ formResponseId: OTHER_JOB_ID }));
    expect(wrongJob.status()).toBe(200);
    expect(await wrongJob.json()).toEqual({ ok: true, ignored: "site-not-found" });

    // A job id no site holds.
    const unknownJob = await request.post(PATH, signed({ formResponseId: `build_e2e_nobody_${runId()}` }));
    expect(unknownJob.status()).toBe(200);
    expect(await unknownJob.json()).toEqual({ ok: true, ignored: "site-not-found" });

    expect(await site()).toMatchObject(BUILDING);
    expect(await other()).toMatchObject(BUILDING);
  });

  test("a signed callback settles the site once; a second delivery changes nothing", async ({ request }) => {
    const otherBefore = await other();

    const first = await request.post(PATH, signed());
    expect(first.status()).toBe(200);
    expect(await first.json()).toEqual({ ok: true, settled: "ready" });

    const settled = await site();
    expect(settled).toMatchObject({
      status: "ready",
      liveUrl: LIVE_URL,
      errorMessage: null,
      statusPhase: "completed",
      gitpagePageId: PAGE_ID,
      gitpageJobId: JOB_ID,
    });

    // gitpage retries, or the poll loop's copy arrives late: same job, a
    // different URL this time so an applied duplicate would be visible.
    const replay = await request.post(PATH, signed({ pagesUrl: "https://replayed.example.test/" }));
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toEqual({ ok: true, ignored: "already-settled" });
    expect(await site()).toEqual(settled);

    // The settle reached this site and no other: the other tenant's build
    // is byte-for-byte what it was.
    expect(await other()).toEqual(otherBefore);
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
