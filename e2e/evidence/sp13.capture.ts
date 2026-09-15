import { expect, test } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { assertFixtureSubAccount } from "../lib/guard";
import { ownerUid as readOwnerUid } from "../lib/seed";
import { ONE_PX_PNG } from "../lib/wa";
import {
  activeBilling, assertNothingLeft, MEDIA_FILE, PLAN_ID, purge, seedDraftWorkflow, seedPlan, seedSnapshot,
  shot, SNAPSHOT_ID, TITLE,
} from "./sp13.helpers";

/**
 * SP13 browser evidence (not a gate): drives the E2E fixture PRIMARY
 * sub-account and the E2E agency, saves 1440×900 PNGs under
 * docs/parity/evidence/sp13/, then deletes everything it created (prefix
 * "e2e-evd13-" / "E2E Evidence"), restores the sub-account's `billing`, and
 * checks nothing is left. Gates and googleConnectionMeta are only read.
 */

test.use({ viewport: { width: 1440, height: 900 }, timezoneId: "UTC", locale: "en-US" });
test.describe.configure({ mode: "serial" });

const env = readEnv();
const sa = env.E2E_SUBACCOUNT_ID;
const subRef = () => adminDb().doc(`subAccounts/${sa}`);
let ownerUid = "";
/** What setup read BEFORE any write — restored in afterAll, never a guessed value. */
let priorBilling: unknown;
let priorBillingRead = false;

test.beforeAll(async () => {
  await assertFixtureSubAccount(sa, FIXTURE_PRIMARY_NAME);
  ownerUid = await readOwnerUid(env.E2E_AGENCY_ID);
  priorBilling = (await subRef().get()).data()?.billing;
  priorBillingRead = true;
  await purge();
});

test.afterAll(async () => {
  try {
    await purge();
  } finally {
    if (priorBillingRead) {
      await assertFixtureSubAccount(sa, FIXTURE_PRIMARY_NAME);
      await subRef().update({ billing: priorBilling === undefined ? FieldValue.delete() : priorBilling });
    }
  }
  // Nothing this script made may outlive it.
  await assertNothingLeft();
  if (priorBillingRead) expect((await subRef().get()).data()?.billing).toEqual(priorBilling);
});

test("x1 manage dialog gates", async ({ page }) => {
  await page.goto("/agency/sub-accounts");
  await page
    .getByRole("row", { name: new RegExp(FIXTURE_PRIMARY_NAME) })
    .getByRole("button", { name: "Manage" })
    .click({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: `Manage ${FIXTURE_PRIMARY_NAME}` })).toBeVisible({ timeout: 15_000 });

  // The frame must show what Firestore holds, so assert it before capturing.
  const doc = (await subRef().get()).data() ?? {};
  const gates: Array<[RegExp, string]> = [
    [/Google Business Profile/, "googleEnabledByAgency"],
    [/Google Calendar sync/, "googleCalendarEnabledByAgency"],
    [/Reviews AI/, "reviewsAiEnabledByAgency"],
  ];
  for (const [name, field] of gates) {
    const box = page.getByRole("checkbox", { name });
    if (doc[field] === true) await expect(box).toBeChecked();
    else await expect(box).not.toBeChecked();
  }
  await page
    .getByRole("checkbox", { name: /Google Business Profile/ })
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  await shot(page, "x1-manage-dialog-gates.png");
  await page.keyboard.press("Escape");
});

test("m1 media library", async ({ page }) => {
  const folderName = `${TITLE} Brand assets`;
  await assertFixtureSubAccount(sa, FIXTURE_PRIMARY_NAME);
  await page.goto(`/sa/${sa}/media`);
  await expect(page.getByTestId("media-breadcrumb")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("media-new-folder").click();
  await page.getByLabel("Folder name").fill(folderName);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator(`[data-testid=media-folder-tile][data-name="${folderName}"]`)).toBeVisible({
    timeout: 15_000,
  });

  await page.setInputFiles("[data-testid=media-upload-input]", {
    name: MEDIA_FILE,
    mimeType: "image/png",
    buffer: ONE_PX_PNG,
  });
  const tile = page.locator(`[data-testid=media-tile][data-name="${MEDIA_FILE}"]`);
  await expect(tile).toBeVisible({ timeout: 30_000 });
  // The tile must be backed by a real doc, not a local optimistic render.
  await expect
    .poll(async () => (await subRef().collection("media").where("name", "==", MEDIA_FILE).get()).size, {
      timeout: 15_000,
    })
    .toBe(1);
  await expect(page.getByTestId("media-upload-progress")).toBeHidden({ timeout: 15_000 });
  await shot(page, "m1-media-library.png");

  await page.getByRole("button", { name: `Actions for ${MEDIA_FILE}`, exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Move to folder" })).toBeVisible();
  await shot(page, "m4-media-file-menu.png");
  await page.keyboard.press("Escape");
});

test("n3 snapshot share", async ({ page, browser }) => {
  await assertFixtureSubAccount(sa, FIXTURE_PRIMARY_NAME);
  await seedSnapshot(ownerUid);
  await page.goto("/agency/sub-accounts");
  await page
    .locator(`[data-snapshot-id="${SNAPSHOT_ID}"]`)
    .getByTestId("snapshot-share-button")
    .click({ timeout: 30_000 });
  await page.getByRole("button", { name: "Create link" }).click();
  const urlBox = page.getByTestId("snapshot-share-url");
  await expect(urlBox).toBeVisible({ timeout: 15_000 });
  const url = await urlBox.inputValue();
  await page.getByRole("button", { name: "Done" }).click();

  const shares = adminDb().collection(`agencies/${env.E2E_AGENCY_ID}/snapshots/${SNAPSHOT_ID}/shares`);
  await expect.poll(async () => (await shares.get()).size, { timeout: 15_000 }).toBe(1);
  const shareId = (await shares.get()).docs[0].id;
  await page.getByTestId("snapshot-tab-shared").click();
  const row = page.locator(`[data-testid="snapshot-share-row"][data-share-id="${shareId}"]`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await shot(page, "n3-snapshot-shared-tab.png");

  const anon = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: { width: 1440, height: 900 },
    timezoneId: "UTC",
    locale: "en-US",
  });
  try {
    const visitor = await anon.newPage();
    await visitor.goto(url);
    await expect(visitor.getByTestId("snapshot-share-name")).toHaveText(`${TITLE} starter snapshot`, {
      timeout: 30_000,
    });
    await expect(visitor.getByTestId("snapshot-download-button")).toBeVisible();
    await shot(visitor, "n4-public-share-page.png");
  } finally {
    await anon.close();
  }
});

test("t1 template library", async ({ page }) => {
  const name = `${TITLE} new-lead welcome`;
  await assertFixtureSubAccount(sa, FIXTURE_PRIMARY_NAME);
  await seedDraftWorkflow(ownerUid);
  await page.goto(`/sa/${sa}/workflows`);
  const workflowRow = page.locator(`[data-testid="workflow-row"][data-name="${name}"]`);
  await expect(workflowRow).toBeVisible({ timeout: 30_000 });
  await workflowRow.getByTestId("save-to-library").click();
  await page.getByTestId("save-to-library-submit").click();
  await expect(page.getByText("Saved to library")).toBeVisible({ timeout: 30_000 });

  await page.goto("/agency/templates");
  const card = page.locator(`[data-testid="template-card"][data-name="${name}"]`);
  await expect(card).toHaveAttribute("data-kind", "workflow", { timeout: 30_000 });
  await expect(page.getByText("Saved to library")).toBeHidden({ timeout: 15_000 });
  await card.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await shot(page, "t1-template-library.png");

  // Open the push dialog only — never submit it.
  await card.getByTestId("template-push-button").click();
  await expect(
    page.locator(`[data-testid="template-push-target"][data-sub-account-id="${env.E2E_SUBACCOUNT_ID_SECONDARY}"]`),
  ).toBeVisible({ timeout: 30_000 });
  await shot(page, "t2-template-push-dialog.png");
  await page.keyboard.press("Escape");
});

test("l1 launchpad", async ({ page }) => {
  await page.goto(`/sa/${sa}/launchpad`);
  await expect(page.getByTestId("launchpad-progress")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("launchpad-item").first()).toBeVisible();
  await shot(page, "l1-launchpad.png");
});

test("r1 reselling overview", async ({ page }) => {
  await assertFixtureSubAccount(sa, FIXTURE_PRIMARY_NAME);
  expect(priorBillingRead).toBe(true);
  await seedPlan();
  await subRef().update({ billing: activeBilling() });

  await page.goto("/agency/billing");
  const table = page.getByTestId("reselling-table");
  await expect(table).toBeVisible({ timeout: 30_000 });
  const row = page.locator(`[data-testid="reselling-row"][data-plan-id="${PLAN_ID}"]`);
  await expect(row.getByTestId("reselling-subscribers")).toHaveAttribute("data-active", "1", { timeout: 15_000 });
  await expect(row.getByTestId("reselling-mrr")).toContainText("499");
  await table.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await shot(page, "r1-reselling-overview.png");
});
