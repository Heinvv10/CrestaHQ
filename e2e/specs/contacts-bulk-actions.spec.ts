import { expect, test } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { readEnv } from "../lib/env";
import { deleteScoped } from "../lib/guard";

/**
 * Selection + bulk actions, asserted in the browser AND in Firestore. Three
 * contacts, a tag filter that leaves two visible, select-all — the third
 * contact is the control: it must be untouched by every action. A select-all
 * that ignores the filter, or a bulk route that writes past the selection,
 * fails on that third document.
 */

async function seedContact(
  env: ReturnType<typeof readEnv>,
  createdByUid: string,
  name: string,
  tags: string[],
): Promise<string> {
  const ref = await adminDb().collection("contacts").add({
    name,
    email: "",
    phone: "",
    company: "",
    source: "other",
    tags,
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

test("select-all on a filtered list, bulk tag, assign and delete", async ({
  page,
}) => {
  const env = readEnv();
  const stamp = Date.now();
  const filterTag = `e2e-bulk-${stamp}`;
  const addedTag = `e2e-added-${stamp}`;
  const names = [1, 2, 3].map((n) => `E2E Bulk ${n} ${stamp}`);

  const agency = await adminDb().doc(`agencies/${env.E2E_AGENCY_ID}`).get();
  const ownerUid = agency.data()?.ownerUid as string;
  expect(ownerUid, "fixture agency has no ownerUid").toBeTruthy();
  const member = await adminDb()
    .doc(`subAccounts/${env.E2E_SUBACCOUNT_ID}/subAccountMembers/${ownerUid}`)
    .get();
  expect(member.exists, "fixture owner has no member row to assign to").toBe(true);
  const ownerName = member.data()?.displayName as string;

  const [idA, idB, idC] = await Promise.all([
    seedContact(env, ownerUid, names[0], [filterTag]),
    seedContact(env, ownerUid, names[1], [filterTag]),
    seedContact(env, ownerUid, names[2], []),
  ]);
  const doc = (id: string) => adminDb().doc(`contacts/${id}`);

  try {
    await page.goto(`/sa/${env.E2E_SUBACCOUNT_ID}/contacts`);
    const row = (name: string) => page.locator("tr").filter({ hasText: name });
    await expect(row(names[0])).toBeVisible({ timeout: 30_000 });
    await expect(row(names[2])).toBeVisible();

    // --- filter to two, select all -------------------------------------
    await page.getByRole("button", { name: "Filters" }).click();
    const panel = page.getByTestId("contact-filters");
    await panel.getByRole("button", { name: "Add condition" }).click();
    await panel.getByPlaceholder("field").fill("tags");
    await panel.locator("select").last().selectOption("has_tag");
    await panel.getByPlaceholder("value").fill(filterTag);
    await expect(row(names[2])).toHaveCount(0);

    await page.getByRole("checkbox", { name: "Select all" }).click();
    const bar = page.getByTestId("bulk-actions-bar");
    await expect(bar).toContainText("2 selected");

    // --- bulk add tag ----------------------------------------------------
    await bar.getByRole("button", { name: "Add tag" }).click();
    await page.getByRole("dialog").locator("#bulk-tags").fill(addedTag);
    await page.getByRole("dialog").getByRole("button", { name: "Apply" }).click();
    await expect(bar).toHaveCount(0);
    for (const id of [idA, idB]) {
      await expect
        .poll(async () => (await doc(id).get()).data()?.tags, { timeout: 15_000 })
        .toContain(addedTag);
    }
    expect((await doc(idC).get()).data()?.tags).not.toContain(addedTag);

    // --- bulk assign -----------------------------------------------------
    await page.getByRole("checkbox", { name: "Select all" }).click();
    await expect(bar).toContainText("2 selected");
    await bar.getByRole("button", { name: "Assign to" }).click();
    await page.getByRole("dialog").locator("#bulk-assignee").selectOption(ownerUid);
    await page.getByRole("dialog").getByRole("button", { name: "Apply" }).click();
    await expect(bar).toHaveCount(0);
    for (const id of [idA, idB]) {
      await expect
        .poll(async () => (await doc(id).get()).data()?.assignedToUid, {
          timeout: 15_000,
        })
        .toBe(ownerUid);
    }
    expect((await doc(idC).get()).data()?.assignedToUid ?? null).toBeNull();

    // The owner shows on the profile header (D1).
    await page.goto(`/sa/${env.E2E_SUBACCOUNT_ID}/contacts/${idA}`);
    await expect(page.getByTestId("contact-assignee")).toHaveText(ownerName, {
      timeout: 30_000,
    });

    // --- bulk delete -----------------------------------------------------
    await page.goto(`/sa/${env.E2E_SUBACCOUNT_ID}/contacts`);
    await expect(row(names[0])).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Filters" }).click();
    await panel.getByRole("button", { name: "Add condition" }).click();
    await panel.getByPlaceholder("field").fill("tags");
    await panel.locator("select").last().selectOption("has_tag");
    await panel.getByPlaceholder("value").fill(filterTag);
    await expect(row(names[2])).toHaveCount(0);
    await page.getByRole("checkbox", { name: "Select all" }).click();
    await expect(bar).toContainText("2 selected");
    await bar.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete 2" }).click();

    for (const id of [idA, idB]) {
      await expect
        .poll(async () => (await doc(id).get()).exists, { timeout: 30_000 })
        .toBe(false);
    }
    expect((await doc(idC).get()).exists).toBe(true);
    await expect(row(names[0])).toHaveCount(0);
  } finally {
    for (const id of [idA, idB, idC]) await deleteScoped(doc(id));
  }
});
