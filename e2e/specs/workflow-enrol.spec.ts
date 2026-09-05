import { expect, test } from "@playwright/test";
import { adminDb } from "../lib/admin";
import { baseURL, readEnv } from "../lib/env";
import { signQStashBody } from "../lib/qstash";
import { FIXTURE_TAG, ensureSeed } from "../lib/seed";

/**
 * Enrolment is only half the feature. QStash cannot deliver to 127.0.0.1, so
 * a spec that stopped at "a workflowRuns document exists" would pass against
 * an engine whose every action was a no-op. This one plays QStash: it signs a
 * {runId,nodeId} body the way Upstash does and POSTs it to the step worker,
 * then asserts the EFFECT — the tag on the contact and the run's history.
 */

test("a form submission enrols the contact and the step worker runs the action", async ({
  request,
}) => {
  const env = readEnv();
  const { formId, addTagNodeId, workflowId } = await ensureSeed();
  const stamp = Date.now();
  const email = `e2e-enrol-${stamp}@example.com`;

  const submit = await request.post(`/api/forms/${formId}/submit`, {
    data: {
      values: { name: `E2E Enrol ${stamp}`, email },
      // Above the spam guard's MIN_ELAPSED_MS floor.
      elapsedMs: 5_000,
      hp: "",
    },
  });
  expect(submit.ok(), await submit.text()).toBe(true);
  const contactId = ((await submit.json()) as { contactId: string }).contactId;
  expect(contactId).toBeTruthy();

  // fireWorkflowTrigger is fire-and-forget, so the run appears shortly after
  // the response.
  const runsQuery = () =>
    adminDb()
      .collection("workflowRuns")
      .where("subAccountId", "==", env.E2E_SUBACCOUNT_ID)
      .where("contactId", "==", contactId)
      .limit(1)
      .get();

  await expect
    .poll(async () => (await runsQuery()).empty, { timeout: 30_000 })
    .toBe(false);

  const runDoc = (await runsQuery()).docs[0];

  // Enrolment really happened: the trigger matched this form and bound the run
  // to the right workflow, contact and tenant. Asserted before anything below
  // touches the document.
  expect(runDoc.data().workflowId).toBe(workflowId);
  expect(runDoc.data().subAccountId).toBe(env.E2E_SUBACCOUNT_ID);

  // Stand in for QStash's delivery, and ONLY that.
  //
  // scheduleNode publishes the first step to QStash, which cannot reach
  // 127.0.0.1 — so in CI the publish fails and the run is parked as "failed"
  // before any worker could run. Handing it back to "running" is exactly what a
  // successful delivery would have left behind; it is not a shortcut past an
  // assertion. What this spec proves is the trigger fired, the run document is
  // correctly shaped, the SIGNED step worker authenticates, and `add_tag`
  // actually lands on the contact.
  //
  // What it does NOT prove is that scheduleNode's publish to QStash succeeds.
  // That link is unprovable from CI at all while the app is on loopback, and
  // pointing a real QStash token at 127.0.0.1 would only accrue undeliverable
  // retries against the production quota while proving no more than this does.
  // The e2e-smoke job against crm.crestahq.com is where the publish becomes
  // provable — once that deployment has QStash configured, which today it does
  // not.
  await adminDb()
    .doc(`workflowRuns/${runDoc.id}`)
    .update({ status: "running" });

  const stepUrl = new URL("/api/workflows/step", baseURL()).toString();
  const body = JSON.stringify({ runId: runDoc.id, nodeId: addTagNodeId });
  const step = await request.post("/api/workflows/step", {
    headers: {
      "content-type": "application/json",
      "upstash-signature": signQStashBody(stepUrl, body),
    },
    data: body,
  });
  expect(step.status(), await step.text()).toBe(200);

  // The effects are the assertion. `runStep` early-returns unless the run is
  // running/waiting and still answers 200, so a dead engine reaches this line
  // and dies here rather than passing.
  const contact = await adminDb().doc(`contacts/${contactId}`).get();
  expect(contact.data()?.tags).toContain(FIXTURE_TAG);

  const run = await adminDb().doc(`workflowRuns/${runDoc.id}`).get();
  const history = (run.data()?.history ?? []) as { nodeId: string }[];
  expect(history.map((h) => h.nodeId)).toContain(addTagNodeId);
});
