import { expect, test } from "@playwright/test";
import { readEnv } from "../lib/env";
import { FAKE_PHONE_ID, alertDocs, patchWaScenario, primaryId, runQualityCron, settingsPath, storedQuality, waLifecycle } from "../lib/wa";

/**
 * SP15 row 11 — the hourly quality poll, both directions: the first reading
 * only stores; a drop from GREEN writes ONE alert and the page shows the
 * banner; polling again at the same rating adds nothing; recovery to GREEN
 * resolves the alert quietly (no "recovered" doc, banner gone); a later drop
 * to RED is a second alert. An unsigned cron call is refused outright.
 */

test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "needs WHATSAPP_SETTINGS_PROVIDER=fake, which a deployed target refuses by design");

waLifecycle(test);

test("first reading stores; drop alerts once; recovery resolves quietly; a new drop alerts again", async ({ page, request }) => {
  // An unsigned POST is refused and writes nothing.
  const unsigned = await request.post("/api/cron/whatsapp-quality", { data: "{}", headers: { "content-type": "application/json" } });
  expect(unsigned.status()).toBe(401);
  expect(await storedQuality()).toBeNull();

  // First reading: GREEN stored, nothing to have dropped from.
  expect(await runQualityCron(request)).toMatchObject({ alerted: 0, recovered: 0 });
  expect(await storedQuality()).toMatchObject({ rating: "GREEN", nameStatus: "APPROVED" });
  expect(await alertDocs()).toEqual([]);

  // Meta lowers the rating → one tenant-anchored alert.
  await patchWaScenario({ "phone.qualityRating": "YELLOW" });
  expect(await runQualityCron(request)).toMatchObject({ alerted: 1, recovered: 0 });
  expect(await storedQuality()).toMatchObject({ rating: "YELLOW" });
  let alerts = await alertDocs();
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toMatchObject({
    agencyId: readEnv().E2E_AGENCY_ID,
    subAccountId: primaryId(),
    createdByUid: "system",
    from: "GREEN",
    to: "YELLOW",
    phoneNumberId: FAKE_PHONE_ID,
    resolvedAt: null,
  });

  await page.goto(settingsPath());
  await expect(page.getByTestId("wa-quality-alert-banner")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("wa-quality-alert-banner")).toContainText("from Green to Yellow");
  await expect(page.getByTestId("wa-quality-badge")).toHaveAttribute("data-rating", "YELLOW");
  if (process.env.SP15_EVIDENCE) await page.screenshot({ path: "docs/parity/evidence/sp15/quality-banner.png", fullPage: true });

  // Still YELLOW an hour later: no duplicate.
  expect(await runQualityCron(request)).toMatchObject({ alerted: 0, recovered: 0 });
  expect(await alertDocs()).toHaveLength(1);

  // Back to GREEN: the alert is resolved, nothing new is written, the banner goes.
  await patchWaScenario({ "phone.qualityRating": "GREEN" });
  expect(await runQualityCron(request)).toMatchObject({ alerted: 0, recovered: 1 });
  alerts = await alertDocs();
  expect(alerts).toHaveLength(1);
  expect(alerts[0].resolvedAt).not.toBeNull();
  expect(await storedQuality()).toMatchObject({ rating: "GREEN" });
  await page.reload();
  await expect(page.getByTestId("wa-quality-badge")).toHaveAttribute("data-rating", "GREEN", { timeout: 30_000 });
  await expect(page.getByTestId("wa-quality-alert-banner")).toHaveCount(0);

  // A later drop to RED is a fresh alert.
  await patchWaScenario({ "phone.qualityRating": "RED" });
  expect(await runQualityCron(request)).toMatchObject({ alerted: 1 });
  alerts = await alertDocs();
  expect(alerts).toHaveLength(2);
  expect(alerts.filter((a) => a.resolvedAt === null)).toEqual([expect.objectContaining({ from: "GREEN", to: "RED" })]);
});
