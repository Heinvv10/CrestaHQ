import { expect, test } from "@playwright/test";
import { adminDb } from "../lib/admin";
import { readEnv } from "../lib/env";
import { deleteScoped } from "../lib/guard";

/**
 * Company lifecycle through the UI, asserted in Firestore at every step:
 * create → link a contact via the form combobox → see it on the company
 * page → delete → the contact's link is cleared.
 */

test("creates a company, links a contact to it, and unlinks on delete", async ({
  page,
}) => {
  const env = readEnv();
  const stamp = Date.now();
  const companyName = `E2E Company ${stamp}`;
  const contactName = `E2E Employee ${stamp}`;
  const contactEmail = `e2e-employee-${stamp}@example.com`;
  let companyId: string | null = null;
  let contactId: string | null = null;

  try {
    // --- unknown id renders not-found (rules deny the read; onError path) --
    await page.goto(`/sa/${env.E2E_SUBACCOUNT_ID}/companies/does-not-exist`);
    await expect(page.getByText("Company not found")).toBeVisible({
      timeout: 30_000,
    });

    // --- create company --------------------------------------------------
    await page.goto(`/sa/${env.E2E_SUBACCOUNT_ID}/companies`);
    await page.getByRole("button", { name: "Add Company" }).first().click();
    const addSheet = page.getByRole("dialog");
    await addSheet.locator("#co-name").fill(companyName);
    await addSheet.locator("#co-website").fill("https://example.com");
    await addSheet.getByRole("button", { name: "Add Company" }).click();

    await expect(page.locator("tr").filter({ hasText: companyName })).toBeVisible({
      timeout: 30_000,
    });

    const created = await adminDb()
      .collection("companies")
      .where("subAccountId", "==", env.E2E_SUBACCOUNT_ID)
      .where("name", "==", companyName)
      .limit(1)
      .get();
    expect(created.empty, "company was not written to Firestore").toBe(false);
    companyId = created.docs[0].id;
    const companyDoc = created.docs[0].data();
    expect(companyDoc.agencyId, "company missing agencyId").toBeTruthy();
    expect(companyDoc.createdByUid, "company missing createdByUid").toBeTruthy();

    // --- create a contact linked via the combobox -----------------------
    await page.goto(`/sa/${env.E2E_SUBACCOUNT_ID}/contacts`);
    await page.getByRole("button", { name: "Add Contact" }).first().click();
    const contactSheet = page.getByRole("dialog");
    await contactSheet.locator("#c-name").fill(contactName);
    await contactSheet.locator("#c-email").fill(contactEmail);
    // Type a prefix so the match must come from the search, not the full name.
    await contactSheet.locator("#c-company").fill(`E2E Company ${String(stamp).slice(0, 4)}`);
    await contactSheet
      .getByRole("option", { name: companyName, exact: true })
      .click();
    await expect(contactSheet.locator("#c-company")).toHaveValue(companyName);
    await contactSheet.getByRole("button", { name: "Add Contact" }).click();

    await expect(page.locator("tr").filter({ hasText: contactName })).toBeVisible({
      timeout: 30_000,
    });
    const contactSnap = await adminDb()
      .collection("contacts")
      .where("subAccountId", "==", env.E2E_SUBACCOUNT_ID)
      .where("email", "==", contactEmail)
      .limit(1)
      .get();
    expect(contactSnap.empty, "contact was not written to Firestore").toBe(false);
    contactId = contactSnap.docs[0].id;
    expect(contactSnap.docs[0].data().companyId).toBe(companyId);
    expect(contactSnap.docs[0].data().company).toBe(companyName);

    // --- contact detail links to the company; company page lists it -----
    await page.goto(`/sa/${env.E2E_SUBACCOUNT_ID}/contacts/${contactId}`);
    await page.getByRole("link", { name: companyName }).click();
    await expect(page).toHaveURL(new RegExp(`/companies/${companyId}$`));
    await expect(page.locator("tr").filter({ hasText: contactName })).toBeVisible({
      timeout: 30_000,
    });

    // --- delete company; contact is unlinked but kept --------------------
    await page.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete company" }).click();

    await expect
      .poll(
        async () => (await adminDb().doc(`companies/${companyId}`).get()).exists,
        { timeout: 30_000 },
      )
      .toBe(false);
    const after = (await adminDb().doc(`contacts/${contactId}`).get()).data();
    expect(after, "contact was deleted with the company").toBeTruthy();
    expect(after?.companyId).toBeNull();
    expect(after?.company).toBe(companyName);
  } finally {
    if (contactId) await deleteScoped(adminDb().doc(`contacts/${contactId}`));
    if (companyId) await deleteScoped(adminDb().doc(`companies/${companyId}`));
  }
});
