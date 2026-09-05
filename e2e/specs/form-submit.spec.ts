import { expect, test } from "@playwright/test";
import { adminDb } from "../lib/admin";
import { readEnv } from "../lib/env";
import { ensureSeed } from "../lib/seed";

/**
 * A real visitor's path: the public /f/{formId} page, no session at all. The
 * assertion is the contact the submission mints, not the thank-you copy — a
 * route that renders the copy without writing must fail here.
 */

test.use({ storageState: { cookies: [], origins: [] } });

test("an anonymous form submission creates a contact", async ({ page }) => {
  const env = readEnv();
  const { formId } = await ensureSeed();
  const stamp = Date.now();
  const name = `E2E Form ${stamp}`;
  const email = `e2e-form-${stamp}@example.com`;

  const query = () =>
    adminDb()
      .collection("contacts")
      .where("subAccountId", "==", env.E2E_SUBACCOUNT_ID)
      .where("email", "==", email)
      .limit(1)
      .get();

  await page.goto(`/f/${formId}`);
  await page.locator("#name").fill(name);
  await page.locator("#email").fill(email);

  // The always-on spam guard rejects anything submitted under
  // MIN_ELAPSED_MS (1.5s) with a SILENT fake success — no contact, no error.
  // Waiting is the product's requirement, not test flake insurance.
  await page.waitForTimeout(2_000);
  await page.getByRole("button", { name: "Submit" }).click();

  await expect(page.getByText(/we'll be in touch/i)).toBeVisible({
    timeout: 30_000,
  });

  await expect
    .poll(async () => (await query()).empty, { timeout: 30_000 })
    .toBe(false);

  const contact = (await query()).docs[0].data();
  expect(contact.name).toBe(name);
  expect(contact.tags).toContain("e2e");
});
