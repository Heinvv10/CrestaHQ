import { expect, test } from "@playwright/test";
import {
  FIXTURE_PRIMARY_NAME,
  FIXTURE_SECONDARY_NAME,
  readEnv,
} from "../lib/env";
import {
  MARKER_PRIMARY_NAME,
  MARKER_SECONDARY_NAME,
  ensureSeed,
} from "../lib/seed";

/**
 * Two fixture sub-accounts exist so this spec has something to switch
 * BETWEEN. Landing on a page is not the assertion — seeing that sub-account's
 * own marker contact, and not the other's, is.
 */

test.beforeAll(async () => {
  await ensureSeed();
});

const cases = [
  {
    label: "primary",
    name: FIXTURE_PRIMARY_NAME,
    marker: MARKER_PRIMARY_NAME,
    otherMarker: MARKER_SECONDARY_NAME,
  },
  {
    label: "secondary",
    name: FIXTURE_SECONDARY_NAME,
    marker: MARKER_SECONDARY_NAME,
    otherMarker: MARKER_PRIMARY_NAME,
  },
] as const;

for (const c of cases) {
  test(`opening the ${c.label} sub-account scopes the app to it`, async ({
    page,
  }) => {
    const env = readEnv();
    const expectedId =
      c.label === "primary"
        ? env.E2E_SUBACCOUNT_ID
        : env.E2E_SUBACCOUNT_ID_SECONDARY;

    await page.goto("/agency/sub-accounts");
    const row = page.locator("tr").filter({ hasText: c.name });
    await expect(row).toHaveCount(1);
    await row.getByRole("link", { name: /Open/ }).click();

    await page.waitForURL(new RegExp(`/sa/${expectedId}/dashboard`), {
      timeout: 30_000,
    });

    await page.goto(`/sa/${expectedId}/contacts`);
    await expect(
      page.locator("tr").filter({ hasText: c.marker }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(c.otherMarker)).toHaveCount(0);
  });
}
