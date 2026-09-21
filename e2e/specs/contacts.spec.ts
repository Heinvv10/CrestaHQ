import { expect, test } from "@playwright/test";
import { adminDb } from "../lib/admin";
import { readEnv } from "../lib/env";

/**
 * Create → edit → delete, all through the UI, all three asserted twice: once
 * in the browser and once in Firestore. A route that returns 200 without
 * writing passes the first assertion and fails the second.
 */

test("creates, edits and deletes a contact", async ({ page }) => {
  const env = readEnv();
  const stamp = Date.now();
  const name = `E2E Contact ${stamp}`;
  const email = `e2e-contact-${stamp}@example.com`;
  const company = `E2E Co ${stamp}`;

  await page.goto(`/sa/${env.E2E_SUBACCOUNT_ID}/contacts`);

  // --- create -----------------------------------------------------------
  await page.getByRole("button", { name: "Add Contact" }).first().click();
  const addSheet = page.getByRole("dialog");
  await addSheet.locator("#c-name").fill(name);
  await addSheet.locator("#c-email").fill(email);
  await addSheet.getByRole("button", { name: "Add Contact" }).click();

  // The list renders twice — a desktop table and a `md:hidden` card list
  // (src/components/contacts/contacts-table.tsx) — so a bare text match is
  // ambiguous. Assert the visible table row.
  await expect(page.locator("tr").filter({ hasText: name })).toBeVisible({
    timeout: 30_000,
  });

  const created = await adminDb()
    .collection("contacts")
    .where("subAccountId", "==", env.E2E_SUBACCOUNT_ID)
    .where("email", "==", email)
    .limit(1)
    .get();
  expect(created.empty, "contact was not written to Firestore").toBe(false);
  const contactId = created.docs[0].id;

  // --- edit -------------------------------------------------------------
  await page.goto(`/sa/${env.E2E_SUBACCOUNT_ID}/contacts/${contactId}`);
  await page.getByRole("button", { name: "Edit" }).click();
  const editSheet = page.getByRole("dialog");
  await editSheet.locator("#c-company").fill(company);
  await editSheet.getByRole("button", { name: "Save Changes" }).click();

  await expect(page.getByText(company)).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      async () =>
        (await adminDb().doc(`contacts/${contactId}`).get()).data()?.company,
      { timeout: 15_000 },
    )
    .toBe(company);

  // --- delete -----------------------------------------------------------
  await page.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete contact" }).click();

  await expect
    .poll(
      async () => (await adminDb().doc(`contacts/${contactId}`).get()).exists,
      { timeout: 30_000 },
    )
    .toBe(false);

  await page.goto(`/sa/${env.E2E_SUBACCOUNT_ID}/contacts`);
  await expect(page.getByText(name)).toHaveCount(0);
});
