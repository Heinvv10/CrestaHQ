import { FieldValue } from "firebase-admin/firestore";
import { expect, test } from "@playwright/test";
import { adminDb } from "../lib/admin";
import { readEnv } from "../lib/env";

/**
 * Folders for custom fields, end to end: create a folder in settings, move a
 * seeded field into it, see the field under that folder heading on a
 * contact, delete the folder, and see the field back under General — with
 * Firestore checked at each step so a UI that only re-renders locally fails.
 */

test("groups custom fields by folder and returns them to General on delete", async ({
  page,
}) => {
  const env = readEnv();
  const stamp = Date.now();
  const folderName = `E2E Folder ${stamp}`;
  const fieldLabel = `E2E Field ${stamp}`;
  const sa = env.E2E_SUBACCOUNT_ID;
  const db = adminDb();
  const owner = (await db.doc(`agencies/${env.E2E_AGENCY_ID}`).get()).data()
    ?.ownerUid as string;
  const tenant = {
    agencyId: env.E2E_AGENCY_ID,
    subAccountId: sa,
    createdByUid: owner,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  const fieldRef = await db.collection(`subAccounts/${sa}/customFields`).add({
    entity: "contact",
    key: `e2e_field_${stamp}`,
    label: fieldLabel,
    type: "text",
    options: [],
    required: false,
    order: 0,
    folderId: null,
    ...tenant,
  });
  const contactRef = await db.collection("contacts").add({
    name: `E2E Folder Contact ${stamp}`,
    email: "",
    phone: "",
    company: "",
    address: "",
    source: "e2e-fixture",
    tags: ["e2e-folders"],
    pipelineStage: null,
    attribution: null,
    emailOptedOut: false,
    smsOptedOut: false,
    territoryId: "global",
    customFields: { [`e2e_field_${stamp}`]: "hello" },
    ...tenant,
  });
  page.on("dialog", (d) => d.accept());

  try {
    // --- create a folder, move the field into it ------------------------
    await page.goto(`/sa/${sa}/dashboard/settings`);
    await page.getByRole("tab", { name: "Custom Fields" }).click();
    await page.getByLabel("New folder name").fill(folderName);
    await page.getByRole("button", { name: "Add folder" }).click();
    const folderRow = page
      .getByRole("list", { name: "Custom field folders" })
      .getByRole("listitem")
      .filter({ hasText: folderName });
    await expect(folderRow).toBeVisible({ timeout: 30_000 });

    const folders = await db
      .collection(`subAccounts/${sa}/customFieldFolders`)
      .where("name", "==", folderName)
      .get();
    expect(folders.size, "folder was not written to Firestore").toBe(1);
    const folderId = folders.docs[0].id;

    await page
      .getByLabel(`Move ${fieldLabel} to folder`)
      .selectOption({ label: folderName });
    await expect
      .poll(async () => (await fieldRef.get()).data()?.folderId, {
        timeout: 15_000,
      })
      .toBe(folderId);
    await expect(
      page.getByRole("region", { name: folderName }).getByText(fieldLabel),
    ).toBeVisible();

    // --- the contact's Details card groups it under the folder ----------
    await page.goto(`/sa/${sa}/contacts/${contactRef.id}`);
    const folderGroup = page
      .locator("details")
      .filter({ has: page.locator("summary", { hasText: folderName }) });
    await expect(folderGroup.getByText(fieldLabel)).toBeVisible({
      timeout: 30_000,
    });

    // --- delete the folder: field returns to General --------------------
    await page.goto(`/sa/${sa}/dashboard/settings`);
    await page.getByRole("tab", { name: "Custom Fields" }).click();
    await expect(folderRow).toBeVisible({ timeout: 30_000 });
    await folderRow.getByTitle("Delete folder").click();
    await expect
      .poll(async () => (await fieldRef.get()).data()?.folderId, {
        timeout: 15_000,
      })
      .toBeNull();
    expect(
      (await db.doc(`subAccounts/${sa}/customFieldFolders/${folderId}`).get())
        .exists,
    ).toBe(false);

    await page.goto(`/sa/${sa}/contacts/${contactRef.id}`);
    const general = page
      .locator("details")
      .filter({ has: page.locator("summary", { hasText: "General" }) });
    await expect(general.getByText(fieldLabel)).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    // Teardown purges contacts, not custom-field defs or folders — remove
    // ours here (the folder only survives a mid-run failure).
    await fieldRef.delete();
    const leftover = await db
      .collection(`subAccounts/${sa}/customFieldFolders`)
      .where("name", "==", folderName)
      .get();
    for (const d of leftover.docs) await d.ref.delete();
  }
});
