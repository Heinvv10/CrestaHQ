import { expect, test } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { readEnv } from "../lib/env";
import { MARKER_PRIMARY_NAME, ensureSeed } from "../lib/seed";

/**
 * Multiple pipelines, end to end through the UI:
 *
 *   settings → create a second pipeline with two stages
 *   board    → switch to it, create a deal, move the deal to stage 2
 *
 * Every step is asserted in Firestore too, and the stage move is asserted
 * on its EFFECT: a workflow triggered on `pipeline.stage.changed`, pinned to
 * this pipeline + stage, enrolled the contact. A board that silently used
 * the default pipeline's stages, or a trigger that ignored the pipeline,
 * both fail here.
 */

const STAGE_ONE = "E2E Stage One";
const STAGE_TWO = "E2E Stage Two";

async function firstEnrolment(subAccountId: string, workflowId: string) {
  const snap = await adminDb()
    .collection("workflowRuns")
    .where("subAccountId", "==", subAccountId)
    .where("workflowId", "==", workflowId)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0];
}

test("a second pipeline, a deal in it, and a pinned stage-change trigger", async ({
  page,
}) => {
  const env = readEnv();
  const sa = env.E2E_SUBACCOUNT_ID;
  await ensureSeed();
  const stamp = Date.now();
  const pipelineName = `E2E Pipeline ${stamp}`;
  const dealTitle = `E2E Pipeline Deal ${stamp}`;
  const tag = `e2e-pipeline-${stamp}`;
  const db = adminDb();

  let pipelineId: string | null = null;
  let workflowId: string | null = null;
  let dealId: string | null = null;
  let contactId: string | null = null;

  try {
    // --- settings: create the pipeline ------------------------------------
    await page.goto(`/sa/${sa}/dashboard/settings`);
    const section = page.locator("section", { hasText: "Pipelines" }).first();
    await section.getByRole("button", { name: "New pipeline" }).click();
    await section.locator("#pipeline-name").fill(pipelineName);
    await section.getByLabel("Stage 1 label").fill(STAGE_ONE);
    await section.getByRole("button", { name: "Add stage" }).click();
    await section.getByLabel("Stage 2 label").fill(STAGE_TWO);
    await section.getByRole("button", { name: "Create pipeline" }).click();

    await expect
      .poll(
        async () => {
          const snap = await db
            .collection(`subAccounts/${sa}/pipelines`)
            .where("name", "==", pipelineName)
            .limit(1)
            .get();
          if (snap.empty) return null;
          pipelineId = snap.docs[0].id;
          return snap.docs[0].data();
        },
        { timeout: 30_000 },
      )
      .toMatchObject({
        isDefault: false,
        subAccountId: sa,
        agencyId: env.E2E_AGENCY_ID,
        stages: [
          { id: "e2e_stage_one", label: STAGE_ONE },
          { id: "e2e_stage_two", label: STAGE_TWO },
        ],
      });
    expect(pipelineId).toBeTruthy();

    // --- workflow pinned to this pipeline + stage 2 -----------------------
    const owner = (await db.doc(`agencies/${env.E2E_AGENCY_ID}`).get()).data()!
      .ownerUid as string;
    const wfRef = await db.collection("workflows").add({
      subAccountId: sa,
      agencyId: env.E2E_AGENCY_ID,
      createdByUid: owner,
      name: `E2E pipeline trigger ${stamp}`,
      status: "active",
      trigger: {
        type: "pipeline.stage.changed",
        filters: { all: [], match: "all" },
        pipelineId,
        toStage: "e2e_stage_two",
      },
      reentry: "every_time",
      startNodeId: "n1",
      nodes: { n1: { id: "n1", type: "add_tag", config: { tag }, next: null } },
      stats: { enrolled: 0, completed: 0 },
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    workflowId = wfRef.id;

    // --- board: create the deal in the new pipeline -----------------------
    await page.goto(`/sa/${sa}/pipeline`);
    await page.getByLabel("Pipeline").selectOption({ label: pipelineName });
    await page.getByRole("button", { name: "New Deal" }).first().click();
    const sheet = page.getByRole("dialog");
    await sheet.locator("#deal-title").fill(dealTitle);
    // The dialog inherits the board's pipeline; its stage list is that
    // pipeline's, so the first option is stage 1 of the NEW pipeline.
    await expect(sheet.locator("#deal-pipeline")).toHaveValue(pipelineId!);
    await expect(sheet.locator("#deal-stage option")).toHaveText([STAGE_ONE, STAGE_TWO]);
    await sheet.locator("#deal-contact").click();
    await page.getByRole("combobox").fill(MARKER_PRIMARY_NAME);
    await page.getByRole("option", { name: MARKER_PRIMARY_NAME }).first().click();
    await sheet.getByRole("button", { name: "Create Deal" }).click();

    await expect
      .poll(
        async () => {
          const snap = await db
            .collection("deals")
            .where("subAccountId", "==", sa)
            .where("title", "==", dealTitle)
            .limit(1)
            .get();
          if (snap.empty) return null;
          dealId = snap.docs[0].id;
          contactId = snap.docs[0].data().contactId as string;
          return snap.docs[0].data();
        },
        { timeout: 30_000 },
      )
      .toMatchObject({ pipelineId, stageId: "e2e_stage_one" });

    // --- board: move it to stage 2 ---------------------------------------
    // The card renders in the new pipeline's first column.
    const card = page.locator("[data-deal-card]", { hasText: dealTitle });
    await expect(card).toBeVisible({ timeout: 30_000 });
    // Phone width exposes the tap-to-move sheet, which is deterministic where
    // a synthetic cross-column drag is not.
    await page.setViewportSize({ width: 420, height: 900 });
    await card.getByRole("button", { name: "Move stage" }).click();
    await page.getByRole("dialog").getByRole("button", { name: STAGE_TWO }).click();

    await expect
      .poll(async () => (await db.doc(`deals/${dealId}`).get()).data()?.stageId, {
        timeout: 30_000,
      })
      .toBe("e2e_stage_two");

    // --- the effect: the pinned workflow enrolled the contact --------------
    // Wait for enroll() to settle its publish outcome (failed on loopback, or
    // a message id) so the cleanup below doesn't race the engine's own
    // status write on the run doc.
    await expect
      .poll(
        async () => {
          const run = (await firstEnrolment(sa, workflowId!))?.data();
          if (!run || (run.status !== "failed" && run.qstashMessageId === null)) return null;
          return run.contactId;
        },
        { timeout: 30_000 },
      )
      .toBe(contactId);
  } finally {
    if (workflowId) {
      const runs = await db
        .collection("workflowRuns")
        .where("workflowId", "==", workflowId)
        .get();
      await Promise.all(runs.docs.map((d) => d.ref.delete()));
      await db.doc(`workflows/${workflowId}`).delete();
    }
    if (dealId) await db.doc(`deals/${dealId}`).delete();
    if (contactId) {
      // The marker contact is shared fixture state; global teardown may have
      // purged it already, so only untag it while it still exists.
      const ref = db.doc(`contacts/${contactId}`);
      if ((await ref.get()).exists) {
        await ref.update({ tags: FieldValue.arrayRemove(tag) });
      }
    }
    if (pipelineId) await db.doc(`subAccounts/${sa}/pipelines/${pipelineId}`).delete();
  }
});
