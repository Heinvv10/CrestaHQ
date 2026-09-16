import { FieldValue } from "firebase-admin/firestore";
import { expect, test, type Page } from "@playwright/test";
import { adminDb } from "../lib/admin";
import { readEnv } from "../lib/env";
import { deleteScoped } from "../lib/guard";
import { ownerUid } from "../lib/seed";

/**
 * SP13(c) Template library, end to end: save a seeded workflow and a seeded
 * email template from the PRIMARY sub-account's own UI, see them as cards on
 * /agency/templates, push each into SECONDARY, and check Firestore for a
 * fresh copy there — different id, SECONDARY's tenancy, workflow as a draft.
 * Then delete the library entries and confirm card + doc are gone.
 *
 * Library docs live under agencies/{E2E_AGENCY_ID}/templates and carry no
 * subAccountId, so they are outside `deleteScoped`'s fence; teardown deletes
 * them by the ids captured from the list route, guarded by agencyId.
 */

const stamp = Date.now();
const WORKFLOW_NAME = `E2E lib workflow ${stamp}`;
const EMAIL_NAME = `E2E lib email ${stamp}`;

async function pushToSecondary(page: Page, name: string, secondary: string) {
  const card = page.locator(`[data-testid="template-card"][data-name="${name}"]`);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByTestId("template-push-button").click();
  await page
    .locator(`[data-testid="template-push-target"][data-sub-account-id="${secondary}"]`)
    .click();
  await page.getByTestId("template-push-submit").click();
  const result = page.locator(
    `[data-testid="template-push-result"][data-sub-account-id="${secondary}"]`,
  );
  await expect(result).toBeVisible({ timeout: 30_000 });
  await expect(result).toHaveAttribute("data-ok", "true");
  await page.getByRole("button", { name: "Done" }).click();
}

async function deleteFromLibrary(page: Page, name: string) {
  const card = page.locator(`[data-testid="template-card"][data-name="${name}"]`);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByTestId("template-delete-button").click();
  await expect(card).toHaveCount(0, { timeout: 30_000 });
}

test("saves a workflow and an email template to the library, pushes both to the secondary sub-account, then deletes them", async ({
  page,
}) => {
  const env = readEnv();
  const primary = env.E2E_SUBACCOUNT_ID;
  const secondary = env.E2E_SUBACCOUNT_ID_SECONDARY;
  const db = adminDb();
  const owner = await ownerUid(env.E2E_AGENCY_ID);
  const tenant = (subAccountId: string) => ({
    agencyId: env.E2E_AGENCY_ID,
    subAccountId,
    createdByUid: owner,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  const libraryCol = db.collection(`agencies/${env.E2E_AGENCY_ID}/templates`);

  const workflowRef = db.collection("workflows").doc();
  await workflowRef.set({
    id: workflowRef.id,
    name: WORKFLOW_NAME,
    status: "draft",
    trigger: { type: "contact.created", filters: { all: [], match: "all" } },
    reentry: "every_time",
    startNodeId: "e2e-lib-tag",
    nodes: {
      "e2e-lib-tag": {
        id: "e2e-lib-tag",
        type: "add_tag",
        config: { tag: `e2e-lib-${stamp}` },
        next: null,
      },
    },
    stats: { enrolled: 0, completed: 0 },
    ...tenant(primary),
  });
  const emailRef = db.collection("message_templates").doc();
  await emailRef.set({
    id: emailRef.id,
    type: "email",
    name: EMAIL_NAME,
    subject: "E2E library subject",
    body: "Hello {{contact.firstName}}",
    ...tenant(primary),
  });
  page.on("dialog", (d) => d.accept());

  try {
    // --- save the workflow from the sub-account's workflow list ---------
    await page.goto(`/sa/${primary}/workflows`);
    const workflowRow = page.locator(
      `[data-testid="workflow-row"][data-name="${WORKFLOW_NAME}"]`,
    );
    await expect(workflowRow).toBeVisible({ timeout: 30_000 });
    await workflowRow.getByTestId("save-to-library").click();
    await page.getByTestId("save-to-library-submit").click();
    await expect(page.getByText("Saved to library")).toBeVisible({ timeout: 30_000 });

    // --- library shows the card; push to SECONDARY -----------------------
    await page.goto("/agency/templates");
    const wfCard = page.locator(`[data-testid="template-card"][data-name="${WORKFLOW_NAME}"]`);
    await expect(wfCard).toHaveAttribute("data-kind", "workflow", { timeout: 30_000 });
    await pushToSecondary(page, WORKFLOW_NAME, secondary);

    const pushedWorkflows = await db
      .collection("workflows")
      .where("subAccountId", "==", secondary)
      .where("name", "==", WORKFLOW_NAME)
      .get();
    expect(pushedWorkflows.size, "exactly one pushed workflow").toBe(1);
    const pushedWf = pushedWorkflows.docs[0];
    expect(pushedWf.id).not.toBe(workflowRef.id);
    expect(pushedWf.data()).toMatchObject({
      status: "draft",
      agencyId: env.E2E_AGENCY_ID,
      subAccountId: secondary,
      createdByUid: owner,
      stats: { enrolled: 0, completed: 0 },
    });
    // Source untouched.
    expect((await workflowRef.get()).data()?.subAccountId).toBe(primary);

    // --- save the email template from /sa/[id]/templates ------------------
    await page.goto(`/sa/${primary}/templates`);
    const emailRow = page.getByRole("listitem").filter({ hasText: EMAIL_NAME });
    await expect(emailRow).toBeVisible({ timeout: 30_000 });
    await emailRow.getByTestId("save-to-library").click();
    await page.getByTestId("save-to-library-submit").click();
    await expect(page.getByText("Saved to library")).toBeVisible({ timeout: 30_000 });

    await page.goto("/agency/templates");
    const emailCard = page.locator(`[data-testid="template-card"][data-name="${EMAIL_NAME}"]`);
    await expect(emailCard).toHaveAttribute("data-kind", "email", { timeout: 30_000 });
    await pushToSecondary(page, EMAIL_NAME, secondary);

    const pushedEmails = await db
      .collection("message_templates")
      .where("subAccountId", "==", secondary)
      .where("name", "==", EMAIL_NAME)
      .get();
    expect(pushedEmails.size, "exactly one pushed email template").toBe(1);
    expect(pushedEmails.docs[0].id).not.toBe(emailRef.id);
    expect(pushedEmails.docs[0].data()).toMatchObject({
      type: "email",
      subject: "E2E library subject",
      agencyId: env.E2E_AGENCY_ID,
      subAccountId: secondary,
    });

    // --- delete both library entries: card gone, doc gone -----------------
    const before = await libraryCol.where("name", "in", [WORKFLOW_NAME, EMAIL_NAME]).get();
    expect(before.size, "both library docs exist before delete").toBe(2);
    await deleteFromLibrary(page, WORKFLOW_NAME);
    await deleteFromLibrary(page, EMAIL_NAME);
    await expect
      .poll(
        async () =>
          (await libraryCol.where("name", "in", [WORKFLOW_NAME, EMAIL_NAME]).get()).size,
        { timeout: 15_000 },
      )
      .toBe(0);
  } finally {
    // Seeded sources + pushed copies carry subAccountId, so the fence applies.
    await deleteScoped(workflowRef);
    await deleteScoped(emailRef);
    for (const col of ["workflows", "message_templates"]) {
      const copies = await db
        .collection(col)
        .where("subAccountId", "==", secondary)
        .where("name", "in", [WORKFLOW_NAME, EMAIL_NAME])
        .get();
      for (const d of copies.docs) await deleteScoped(d.ref);
    }
    // Library docs have no subAccountId; assert the agency by hand instead.
    const leftover = await libraryCol.where("name", "in", [WORKFLOW_NAME, EMAIL_NAME]).get();
    for (const d of leftover.docs) {
      if (d.data().agencyId !== env.E2E_AGENCY_ID) {
        throw new Error(`${d.ref.path}: agencyId is not the E2E agency. Refusing to delete.`);
      }
      await d.ref.delete();
    }
  }
});
