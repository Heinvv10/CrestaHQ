import { expect, test } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { readEnv } from "../lib/env";
import { deleteScoped } from "../lib/guard";

/**
 * Filter → save as smart list → deep-link → delete, asserted in the browser
 * AND in Firestore. The filter step is the seam: two seeded contacts with
 * distinct tags, and only the tagged one may survive `has_tag`. A filter
 * that returns its input unfiltered fails at the first row assertion.
 */

async function seedContact(
  env: ReturnType<typeof readEnv>,
  createdByUid: string,
  name: string,
  tag: string,
): Promise<string> {
  const ref = await adminDb().collection("contacts").add({
    name,
    email: "",
    phone: "",
    company: "",
    source: "other",
    tags: [tag],
    pipelineStage: null,
    attribution: null,
    emailOptedOut: false,
    smsOptedOut: false,
    territoryId: "global",
    mode: "live",
    agencyId: env.E2E_AGENCY_ID,
    subAccountId: env.E2E_SUBACCOUNT_ID,
    createdByUid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

test("filters by tag, saves a smart list, deep-links and deletes it", async ({
  page,
}) => {
  const env = readEnv();
  const stamp = Date.now();
  const tag = `e2e-smart-${stamp}`;
  const nameA = `E2E Smart Tagged ${stamp}`;
  const nameB = `E2E Smart Other ${stamp}`;
  const listName = `E2E List ${stamp}`;
  const listsCol = adminDb().collection(
    `subAccounts/${env.E2E_SUBACCOUNT_ID}/smartLists`,
  );

  const agency = await adminDb().doc(`agencies/${env.E2E_AGENCY_ID}`).get();
  const ownerUid = agency.data()?.ownerUid as string;
  expect(ownerUid, "fixture agency has no ownerUid").toBeTruthy();

  const idA = await seedContact(env, ownerUid, nameA, tag);
  const idB = await seedContact(env, ownerUid, nameB, `e2e-other-${stamp}`);
  let listId: string | null = null;

  try {
    await page.goto(`/sa/${env.E2E_SUBACCOUNT_ID}/contacts`);
    const rowA = page.locator("tr").filter({ hasText: nameA });
    const rowB = page.locator("tr").filter({ hasText: nameB });
    await expect(rowA).toBeVisible({ timeout: 30_000 });
    await expect(rowB).toBeVisible();

    // --- filter ----------------------------------------------------------
    await page.getByRole("button", { name: "Filters" }).click();
    const panel = page.getByTestId("contact-filters");
    await panel.getByRole("button", { name: "Add condition" }).click();
    await panel.getByPlaceholder("field").fill("tags");
    await panel.locator("select").last().selectOption("has_tag");
    await panel.getByPlaceholder("value").fill(tag);

    // The rows above came from the newest-page preview; a filter swaps it for
    // the full list, which has not been waited for until here.
    await expect(rowA).toBeVisible({ timeout: 30_000 });
    await expect(rowB).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Filters (1)" })).toBeVisible();

    // --- save ------------------------------------------------------------
    await page.getByRole("button", { name: "Save as smart list" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("#smart-list-name").fill(listName);
    await dialog.getByRole("button", { name: "Save" }).click();

    await page.waitForURL(/\?list=/, { timeout: 30_000 });
    listId = new URL(page.url()).searchParams.get("list");
    expect(listId).toBeTruthy();

    const saved = await listsCol.doc(listId!).get();
    expect(saved.exists, "smart list was not written to Firestore").toBe(true);
    expect(saved.data()).toMatchObject({
      name: listName,
      agencyId: env.E2E_AGENCY_ID,
      subAccountId: env.E2E_SUBACCOUNT_ID,
      createdByUid: ownerUid,
      filters: { all: [{ field: "tags", op: "has_tag", value: tag }] },
    });

    // --- deep link -------------------------------------------------------
    await page.goto(`/sa/${env.E2E_SUBACCOUNT_ID}/contacts?list=${listId}`);
    await expect(page.getByRole("tab", { name: listName })).toHaveAttribute(
      "aria-selected",
      "true",
      { timeout: 30_000 },
    );
    await expect(page.getByRole("button", { name: "Filters (1)" })).toBeVisible();
    await expect(rowA).toBeVisible({ timeout: 30_000 });
    await expect(rowB).toHaveCount(0);

    // --- delete ----------------------------------------------------------
    await page.getByRole("button", { name: "Delete list" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete list" })
      .click();

    await expect
      .poll(async () => (await listsCol.doc(listId!).get()).exists, {
        timeout: 30_000,
      })
      .toBe(false);
    await expect(page.getByRole("tab", { name: listName })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "All" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(rowB).toBeVisible({ timeout: 30_000 });
  } finally {
    await deleteScoped(adminDb().doc(`contacts/${idA}`));
    await deleteScoped(adminDb().doc(`contacts/${idB}`));
    if (listId) await deleteScoped(listsCol.doc(listId));
  }
});
