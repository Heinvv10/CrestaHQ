import { expect, test } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import { blankWebsiteConfig } from "../../src/types/website";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, FIXTURE_SECONDARY_NAME, readEnv } from "../lib/env";
import { pageFetch } from "../lib/gbp";
import { assertFixtureSubAccount, deleteScoped } from "../lib/guard";
import { runId } from "../lib/run-id";

/**
 * Website Build v2, after publish (WS-4) — the custom-domain route
 * (`PUT/DELETE …/website/[siteId]/domain`) through the real server, as the
 * signed-in owner: a gitpage host is refused; a domain on a live site is
 * recorded and its www/apex pair lands in THIS sub-account's Web Chat
 * allow-list and in no other; DELETE takes the pair back off. The other
 * fixture tenant has no such site, so a call against it is 404.
 *
 * Fixture tenants only. Site ids, job ids and domains are scoped to this run;
 * the sites are deleted through the fixture guard; the allow-list loses only
 * this run's hosts; the website gate is put back as it was.
 */

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "writes the fixture tenant's website gate and Web Chat allow-list, which only the PR's own build may do",
);
test.describe.configure({ mode: "serial" });

const SITE_ID = `e2e-ws4-${runId()}`;
const JOB_ID = `build_e2e_ws4_${runId()}`;
const LIVE_URL = `https://e2e-ws4-${runId()}.example.test/site`;
// A single label under `.test`, which is not on the Public Suffix List, so
// the registrable domain is `e2e-ws4-<id>.test` and the www/apex pair holds.
// (Under `example.test` the apex would be `example.test` and no twin added.)
const DOMAIN = `www.e2e-ws4-${runId()}.test`;
const APEX = DOMAIN.slice(4);

const primaryId = () => readEnv().E2E_SUBACCOUNT_ID;
const secondaryId = () => readEnv().E2E_SUBACCOUNT_ID_SECONDARY;
const primaryRef = () => adminDb().doc(`subAccounts/${primaryId()}`);
const siteRef = () => primaryRef().collection("website").doc(SITE_ID);
const chatRef = (sa: string) => adminDb().doc(`subAccounts/${sa}/aiAgent/web-chat`);
const profileRef = () => adminDb().doc(`subAccounts/${primaryId()}/aiAgent/profile`);
const allowList = async (sa: string) =>
  ((await chatRef(sa).get()).data()?.webChat?.allowedDomains ?? []) as string[];

const guard = async () => {
  await assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);
  await assertFixtureSubAccount(secondaryId(), FIXTURE_SECONDARY_NAME);
};

let priorGate: unknown;
const chatExisted: Record<string, boolean> = {};

const domainPath = (sa: string) => `/api/sub-accounts/${sa}/website/${SITE_ID}/domain`;

test.beforeAll(async () => {
  await guard();
  priorGate = (await primaryRef().get()).data()?.websiteEnabledByAgency;
  for (const sa of [primaryId(), secondaryId()]) chatExisted[sa] = (await chatRef(sa).get()).exists;
  await primaryRef().update({ websiteEnabledByAgency: true });
  await siteRef().set({
    id: SITE_ID,
    agencyId: readEnv().E2E_AGENCY_ID,
    subAccountId: primaryId(),
    name: `E2E after-publish ${runId()}`,
    status: "ready",
    gitpageJobId: JOB_ID,
    liveUrl: LIVE_URL,
    customDomain: null,
    errorMessage: null,
    partialErrors: null,
    pollAttempts: 0,
    lastBuildAt: null,
    lastBuildByUid: null,
    config: blankWebsiteConfig(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

test.afterAll(async () => {
  await guard();
  try {
    await deleteScoped(siteRef());
  } finally {
    // Only this run's hosts come off; a doc this run created goes if empty.
    for (const sa of [primaryId(), secondaryId()]) {
      const ref = chatRef(sa);
      if (!(await ref.get()).exists) continue;
      await ref.update({ "webChat.allowedDomains": FieldValue.arrayRemove(DOMAIN, APEX) });
      if (!chatExisted[sa] && (await allowList(sa)).length === 0) await ref.delete();
    }
    await primaryRef().update({
      websiteEnabledByAgency: priorGate === undefined ? FieldValue.delete() : priorGate,
    });
  }
});

test.describe("the custom domain, as the owner", () => {
  test("records the domain, allow-lists exactly its www/apex pair for this tenant only, and DELETE takes it back", async ({ page }) => {
    const before = await allowList(primaryId());
    const otherBefore = await allowList(secondaryId());
    const profileBefore = (await profileRef().get()).data()?.websiteUrl ?? null;
    await page.goto(`/sa/${primaryId()}/website`);

    const gitlab = await pageFetch(page, domainPath(primaryId()), "PUT", JSON.stringify({ domain: "acme.gitlab.io" }));
    expect(gitlab.status).toBe(400);
    expect(await allowList(primaryId())).toEqual(before);

    // The other fixture tenant has no site with this id. (DELETE, which is
    // not gated: a PUT there would stop at that tenant's website gate first.)
    const elsewhere = await pageFetch(page, domainPath(secondaryId()), "DELETE");
    expect(elsewhere.status).toBe(404);

    const saved = await pageFetch(page, domainPath(primaryId()), "PUT", JSON.stringify({ domain: `https://${DOMAIN.toUpperCase()}/x` }));
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ ok: true, customDomain: DOMAIN });
    expect((await siteRef().get()).data()?.customDomain).toBe(DOMAIN);
    const after = await allowList(primaryId());
    expect(after.filter((d) => !before.includes(d)).sort()).toEqual([APEX, DOMAIN].sort());
    expect(after.filter((d) => before.includes(d))).toEqual(before);
    expect(await allowList(secondaryId())).toEqual(otherBefore);
    // The chat bot pointed at neither this site nor its domain: untouched.
    expect((await profileRef().get()).data()?.websiteUrl ?? null).toBe(profileBefore);

    const removed = await pageFetch(page, domainPath(primaryId()), "DELETE");
    expect(removed.status).toBe(200);
    expect((await siteRef().get()).data()?.customDomain).toBeNull();
    expect(await allowList(primaryId())).toEqual(before);
  });
});
