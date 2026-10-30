import { FieldValue } from "firebase-admin/firestore";
import { expect, test, type Page } from "@playwright/test";
import { adminDb } from "../lib/admin";
import { readEnv } from "../lib/env";
import { deleteScoped } from "../lib/guard";
import { ownerUid } from "../lib/seed";

/**
 * W1 1a Workflow folders, end to end on the PRIMARY fixture sub-account:
 * create a folder from the list, move a seeded workflow into it through the
 * row menu, rename the folder, then delete it — and check Firestore at each
 * step, ending with the workflow still there and Unfiled.
 *
 * Screenshots are attached to the Playwright report (uploaded by CI) for
 * docs/programme/evidence/folders/.
 */

const stamp = Date.now();
const WORKFLOW_NAME = `E2E folders workflow ${stamp}`;
const FOLDER_NAME = `E2E folder ${stamp}`;
const RENAMED = `E2E renamed ${stamp}`;

const group = (page: Page, name: string) =>
  page.locator(`[data-testid="workflow-folder"][data-name="${name}"]`);
const rowIn = (page: Page, groupName: string) =>
  group(page, groupName).locator(
    `[data-testid="workflow-row"][data-name="${WORKFLOW_NAME}"]`,
  );

test("creates a folder, moves a workflow into it, renames it, and deletes it without losing the workflow", async ({
  page,
}, testInfo) => {
  const env = readEnv();
  const primary = env.E2E_SUBACCOUNT_ID;
  const db = adminDb();
  const owner = await ownerUid(env.E2E_AGENCY_ID);
  const foldersCol = db.collection(`subAccounts/${primary}/workflowFolders`);
  const shot = async (name: string) =>
    testInfo.attach(name, { body: await page.screenshot(), contentType: "image/png" });

  const workflowRef = db.collection("workflows").doc();
  await workflowRef.set({
    id: workflowRef.id,
    name: WORKFLOW_NAME,
    status: "draft",
    trigger: { type: "contact.created", filters: { all: [], match: "all" } },
    reentry: "every_time",
    startNodeId: null,
    nodes: {},
    stats: { enrolled: 0, completed: 0 },
    agencyId: env.E2E_AGENCY_ID,
    subAccountId: primary,
    createdByUid: owner,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  try {
    // --- a doc with no folderId renders under Unfiled ----------------------
    await page.goto(`/sa/${primary}/workflows`);
    await expect(rowIn(page, "Unfiled")).toBeVisible({ timeout: 30_000 });

    // --- create a folder ---------------------------------------------------
    await page.getByTestId("folder-new").click();
    await page.getByTestId("folder-new-input").fill(FOLDER_NAME);
    await page.getByTestId("folder-new-save").click();
    await expect(group(page, FOLDER_NAME)).toHaveAttribute("data-count", "0", {
      timeout: 30_000,
    });
    const created = await foldersCol.where("name", "==", FOLDER_NAME).get();
    expect(created.size, "exactly one folder doc").toBe(1);
    const folderId = created.docs[0].id;
    expect(created.docs[0].data()).toMatchObject({
      agencyId: env.E2E_AGENCY_ID,
      subAccountId: primary,
      createdByUid: owner,
    });

    // --- move the workflow into it through the row menu ---------------------
    await rowIn(page, "Unfiled").getByTestId("workflow-move").click();
    await page
      .locator(`[data-testid="workflow-move-target"][data-name="${FOLDER_NAME}"]`)
      .click();
    await expect(rowIn(page, FOLDER_NAME)).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(async () => (await workflowRef.get()).data()?.folderId, { timeout: 15_000 })
      .toBe(folderId);
    // Survives a reload — the list reads it back from the server.
    await page.reload();
    await expect(rowIn(page, FOLDER_NAME)).toBeVisible({ timeout: 30_000 });
    await expect(group(page, FOLDER_NAME)).toHaveAttribute("data-count", "1");
    await shot("folders-1-moved");

    // --- rename ------------------------------------------------------------
    await group(page, FOLDER_NAME).getByTestId("folder-rename").click();
    await page.getByTestId("folder-rename-input").fill(RENAMED);
    await page.getByTestId("folder-rename-save").click();
    await expect(rowIn(page, RENAMED)).toBeVisible({ timeout: 30_000 });
    expect((await foldersCol.doc(folderId).get()).data()?.name).toBe(RENAMED);
    await shot("folders-2-renamed");

    // --- delete the folder: the workflow is kept, Unfiled ------------------
    await group(page, RENAMED).getByTestId("folder-delete").click();
    await expect(group(page, RENAMED)).toHaveCount(0, { timeout: 30_000 });
    await expect(rowIn(page, "Unfiled")).toBeVisible();
    expect((await foldersCol.doc(folderId).get()).exists).toBe(false);
    const after = await workflowRef.get();
    expect(after.exists, "the workflow survives its folder").toBe(true);
    expect(after.data()?.folderId).toBeNull();
    await shot("folders-3-deleted");
  } finally {
    await deleteScoped(workflowRef);
    const leftover = await foldersCol.where("name", "in", [FOLDER_NAME, RENAMED]).get();
    for (const d of leftover.docs) await deleteScoped(d.ref);
  }
});
