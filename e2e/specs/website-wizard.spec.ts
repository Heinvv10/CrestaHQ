import { expect, test, type Page } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import { blankWebsiteConfig } from "../../src/types/website";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { pageFetch } from "../lib/gbp";
import { assertFixtureSubAccount, deleteScoped } from "../lib/guard";
import { runId } from "../lib/run-id";

/**
 * Website Build v2, the wizard and card (WS-6), through the real server as
 * the signed-in owner: the website page renders a draft's saved step and a
 * live site's card without a Rebuild; the wizard's draft save (PATCH
 * `…/website/[siteId]`) stores the config and the step to resume on, and is
 * refused while the site is building (409), while a failed build can still
 * finish (409) and with the website gate off (403) — leaving the doc as it
 * was each time.
 *
 * Fixture tenant only. Site ids and names are scoped to this run; the sites
 * are deleted through the fixture guard; the website gate is put back.
 */

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "writes the fixture tenant's website gate, which only the PR's own build may do",
);
test.describe.configure({ mode: "serial" });

const DRAFT_ID = `e2e-ws6-draft-${runId()}`;
const LIVE_ID = `e2e-ws6-live-${runId()}`;
const DRAFT_NAME = `E2E wizard draft ${runId()}`;
const LIVE_NAME = `E2E wizard live ${runId()}`;

const primaryId = () => readEnv().E2E_SUBACCOUNT_ID;
const primaryRef = () => adminDb().doc(`subAccounts/${primaryId()}`);
const siteRef = (id: string) => primaryRef().collection("website").doc(id);
const draftPath = () => `/api/sub-accounts/${primaryId()}/website/${DRAFT_ID}`;
const stored = async () => (await siteRef(DRAFT_ID).get()).data() ?? {};

let priorGate: unknown;

const seed = (id: string, name: string, extra: Record<string, unknown>) =>
  siteRef(id).set({
    id,
    agencyId: readEnv().E2E_AGENCY_ID,
    subAccountId: primaryId(),
    name,
    status: "draft",
    gitpageJobId: null,
    liveUrl: null,
    customDomain: null,
    errorMessage: null,
    partialErrors: null,
    pollAttempts: 0,
    wizardStep: null,
    config: blankWebsiteConfig(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extra,
  });

test.beforeAll(async () => {
  await assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);
  priorGate = (await primaryRef().get()).data()?.websiteEnabledByAgency;
  await primaryRef().update({ websiteEnabledByAgency: true });
  await seed(DRAFT_ID, DRAFT_NAME, { wizardStep: "look" });
  await seed(LIVE_ID, LIVE_NAME, {
    status: "ready",
    gitpageJobId: `build_e2e_ws6_${runId()}`,
    liveUrl: `https://e2e-ws6-${runId()}.example.test/site`,
  });
});

test.afterAll(async () => {
  await assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);
  try {
    await deleteScoped(siteRef(DRAFT_ID));
    await deleteScoped(siteRef(LIVE_ID));
  } finally {
    await primaryRef().update({
      websiteEnabledByAgency: priorGate === undefined ? FieldValue.delete() : priorGate,
    });
  }
});

const card = (page: Page, name: string) =>
  page.locator("div.rounded-2xl.border").filter({ has: page.getByText(name, { exact: true }) });

test("the cards show the draft's saved step, and a live site has no Rebuild", async ({ page }) => {
  await page.goto(`/sa/${primaryId()}/website`);
  const draft = card(page, DRAFT_NAME);
  await expect(draft).toContainText("Draft — saved at step 4 of 6: Look & feel");
  const live = card(page, LIVE_NAME);
  await expect(live.getByRole("button", { name: "Edit site" })).toBeVisible();
  await expect(live.getByRole("button", { name: /Rebuild|Try again|setup/ })).toHaveCount(0);
});

test("the draft save stores the config and step, and is refused when it must be", async ({ page }) => {
  await page.goto(`/sa/${primaryId()}/website`);
  const body = (heading: string, wizardStep: string) =>
    JSON.stringify({ config: { ...blankWebsiteConfig(), heading }, wizardStep });

  const saved = await pageFetch(page, draftPath(), "PATCH", body("Saved by the wizard", "pages"));
  expect(saved.status).toBe(200);
  expect(await stored()).toMatchObject({ status: "draft", wizardStep: "pages", config: { heading: "Saved by the wizard" } });

  await siteRef(DRAFT_ID).update({ status: "building", gitpageJobId: `build_e2e_ws6b_${runId()}` });
  const building = await pageFetch(page, draftPath(), "PATCH", body("While building", "look"));
  expect(building.status).toBe(409);

  await siteRef(DRAFT_ID).update({ status: "failed" });
  const unsettled = await pageFetch(page, draftPath(), "PATCH", body("After a failure", "look"));
  expect(unsettled.status).toBe(409);
  expect(await stored()).toMatchObject({ wizardStep: "pages", config: { heading: "Saved by the wizard" } });

  await siteRef(DRAFT_ID).update({ status: "draft", gitpageJobId: null });
  await primaryRef().update({ websiteEnabledByAgency: false });
  try {
    const gated = await pageFetch(page, draftPath(), "PATCH", body("Gate off", "look"));
    expect(gated.status).toBe(403);
    expect(await stored()).toMatchObject({ wizardStep: "pages", config: { heading: "Saved by the wizard" } });
  } finally {
    await primaryRef().update({ websiteEnabledByAgency: true });
  }
});
