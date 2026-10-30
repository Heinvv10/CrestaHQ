import { expect, test } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { FIXTURE_SECONDARY_NAME, readEnv } from "../lib/env";
import { pageFetch } from "../lib/gbp";
import { assertFixtureSubAccount } from "../lib/guard";
import { FAKE_NAME, FAKE_NUMBER, api, patchWaScenario, primaryId, settingsPath, waLifecycle, withPrimaryField } from "../lib/wa";

/**
 * SP15 rows 1, 2, 10, 12 — the Settings → WhatsApp header: flag, number,
 * verified name, Connected, and the quality badge read LIVE from the
 * phone-number node (so a change at "Meta" shows on the next load without a
 * cron). Plus the Templates pointer, the link from the Messaging tab, and
 * the empty / locked states. The SECONDARY fixture has no Cloud connection,
 * so its status route must answer 409 — never the primary's data.
 */

test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "needs WHATSAPP_SETTINGS_PROVIDER=fake, which a deployed target refuses by design");

waLifecycle(test);

test("header shows the live number, name, connection and quality; the badge follows Meta", async ({ page }) => {
  await page.goto(settingsPath());
  await expect(page.getByTestId("wa-settings-number")).toHaveText(FAKE_NUMBER, { timeout: 30_000 });
  await expect(page.getByTestId("wa-settings-flag")).toHaveText("🇿🇦");
  await expect(page.getByTestId("wa-settings-name")).toHaveText(FAKE_NAME);
  await expect(page.getByTestId("wa-settings-connected")).toHaveText("Connected");
  await expect(page.getByTestId("wa-quality-badge")).toHaveAttribute("data-rating", "GREEN");
  await expect(page.getByTestId("wa-quality-badge")).toHaveText("Quality: Green");
  if (process.env.SP15_EVIDENCE) await page.screenshot({ path: "docs/parity/evidence/sp15/header.png", fullPage: true });

  // Meta lowers the rating; the page reads the node live, no cron involved.
  await patchWaScenario({ "phone.qualityRating": "YELLOW" });
  await page.reload();
  await expect(page.getByTestId("wa-quality-badge")).toHaveAttribute("data-rating", "YELLOW", { timeout: 30_000 });
  await expect(page.getByTestId("wa-quality-badge")).toHaveText("Quality: Yellow");

  // Templates tab points at the existing template manager.
  await page.getByTestId("wa-tab-templates").click();
  await expect(page.getByTestId("wa-templates-link")).toHaveAttribute("href", new RegExp(`/sa/${primaryId()}/ai-agents/whatsapp/templates$`));
});

test("the Messaging tab's Cloud card links here", async ({ page }) => {
  await page.goto(`/sa/${primaryId()}/dashboard/settings`);
  await page.getByRole("tab", { name: "Messaging" }).click();
  await page.getByTestId("wa-settings-link").click({ timeout: 30_000 });
  await expect(page).toHaveURL(new RegExp(`${settingsPath()}$`));
  await expect(page.getByTestId("wa-sender-header")).toBeVisible({ timeout: 30_000 });
});

test("no connection → empty state; gate off → locked", async ({ page }) => {
  await withPrimaryField("whatsappCloudMeta", null, async () => {
    await page.goto(settingsPath());
    await expect(page.getByTestId("wa-settings-empty")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("wa-settings-empty").getByRole("link")).toHaveAttribute("href", `/sa/${primaryId()}/dashboard/settings`);
    await expect(page.getByTestId("wa-sender-header")).toHaveCount(0);
  });
  await withPrimaryField("whatsappEnabledByAgency", false, async () => {
    await page.goto(settingsPath());
    await expect(page.getByTestId("wa-settings-locked")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("wa-settings-locked")).toContainText("isn't enabled");
    await expect(page.getByTestId("wa-sender-header")).toHaveCount(0);
  });
});

test("the SECONDARY fixture's status route answers 409 not_connected, never the primary's data", async ({ page }) => {
  await page.goto(settingsPath());
  await expect(page.getByTestId("wa-sender-header")).toBeVisible({ timeout: 30_000 });
  const secondary = readEnv().E2E_SUBACCOUNT_ID_SECONDARY;
  await assertFixtureSubAccount(secondary, FIXTURE_SECONDARY_NAME);
  const secondaryRef = adminDb().doc(`subAccounts/${secondary}`);
  const before = (await secondaryRef.get()).data() ?? {};
  expect(before.whatsappCloudMeta?.phoneNumberId ?? null).toBeNull();
  // Gate on for the secondary for this one call, so the refusal is 409 and not 403.
  await secondaryRef.update({ whatsappEnabledByAgency: true });
  try {
    const res = await pageFetch(page, api("/status", secondary), "GET");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "not_connected" });
    expect(res.body).not.toHaveProperty("phone");
  } finally {
    await assertFixtureSubAccount(secondary, FIXTURE_SECONDARY_NAME);
    await secondaryRef.update({ whatsappEnabledByAgency: before.whatsappEnabledByAgency === undefined ? FieldValue.delete() : before.whatsappEnabledByAgency });
  }
});
