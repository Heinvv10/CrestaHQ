import { expect, test } from "@playwright/test";
import { readSetupSnapshotDismissed, setSetupSnapshotDismissed } from "../lib/seed";

/**
 * Owner setup-snapshot dialog, through the real server. Global setup seeds the
 * fixture owner as dismissed so no other spec ever sees the modal; this spec
 * clears that, watches the dialog open (10s after the session resolves), ticks
 * "Don't show this again", and checks the flag landed at
 * users/{uid}/settings/setupSnapshot. The seeded state is restored in `finally`.
 *
 * Only an owner fixture exists (E2E_EMAIL), so "staff never see it" is covered
 * by the unit tests of the show rule, not here.
 */

test("owner sees the setup snapshot once and can dismiss it for good", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const dialog = page.getByRole("dialog", { name: "Your setup at a glance" });

  try {
    await setSetupSnapshotDismissed(false);
    await page.goto("/agency");

    // Opens ~10s after the session resolves.
    await expect(dialog).toBeVisible({ timeout: 45_000 });
    for (const label of [
      "Email",
      "WhatsApp",
      "Client billing (Paystack)",
      "Google reviews & calendar",
    ]) {
      await expect(dialog.getByText(label, { exact: true })).toBeVisible();
    }

    await dialog.getByRole("checkbox", { name: "Don't show this again" }).click();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect.poll(readSetupSnapshotDismissed, { timeout: 15_000 }).toBe(true);

    // A fresh tab is a fresh browser session (sessionStorage is per tab), so
    // only the stored flag can be what keeps the dialog away.
    const fresh = await context.newPage();
    await fresh.goto("/agency");
    await fresh.waitForURL(/\/agency$/, { timeout: 30_000 });
    await fresh.waitForTimeout(15_000);
    await expect(
      fresh.getByRole("dialog", { name: "Your setup at a glance" }),
    ).toHaveCount(0);
  } finally {
    await setSetupSnapshotDismissed(true);
  }
});
