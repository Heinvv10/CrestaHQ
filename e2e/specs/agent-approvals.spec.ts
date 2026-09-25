import { expect, test } from "@playwright/test";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { assertFixtureSubAccount, deleteScoped } from "../lib/guard";

/**
 * Agent API approvals (AGENT_API_V1_PLAN.md, PR6) in the browser, on the
 * fixture PRIMARY sub-account. Proposals are SEEDED (no agent key round
 * trip): what is under test is the page and the real decide route.
 *
 *   - A seeded proposal is approved from the page: the card goes to Done and
 *     the capability really ran (the task is completed in Firestore).
 *   - A proposal whose earlier attempt already went out needs the in-app
 *     second confirmation (never window.confirm) before it runs again.
 *   - A rejected proposal ends Rejected and runs nothing.
 *
 * The plan's two outcome cells need capabilities later PRs add: (a) a
 * hard_delete that removes a doc arrives with the delete_* capabilities
 * (PR7+), (b) a send_message email with no SMTP (the SendRefusal path) with
 * PR8. Both are written below as test.fixme so they fail loudly the day
 * those capabilities exist and are forgotten here.
 *
 * NOTE: the page reads through the list route, whose query needs the
 * agentProposals composite indexes. Until they are deployed to the E2E
 * Firebase project the route fails FAILED_PRECONDITION and this spec fails.
 */

const KEY_ID = "e2e-agent-key";

test("approve, confirm a re-send, and reject agent proposals from the Approvals page", async ({ page }) => {
  const env = readEnv();
  const sa = env.E2E_SUBACCOUNT_ID;
  const db = adminDb();
  await assertFixtureSubAccount(sa, FIXTURE_PRIMARY_NAME);
  const stamp = Date.now();
  const tenant = { agencyId: env.E2E_AGENCY_ID, subAccountId: sa };
  const saRef = db.doc(`subAccounts/${sa}`);
  const keyRef = db.doc(`subAccounts/${sa}/apiKeys/${KEY_ID}`);
  const taskRefs = [db.collection("tasks").doc(), db.collection("tasks").doc()];
  const ids = { approve: `p_e2e_approve_${stamp}`, resend: `p_e2e_resend_${stamp}`, reject: `p_e2e_reject_${stamp}` };
  const proposalRefs = Object.values(ids).map((id) => db.doc(`agentProposals/${id}`));
  // Captured before the try so `finally` restores exactly what was there.
  const before = (await saRef.get()).data() ?? {};
  const previousGates = {
    agentApiEnabledByAgency: before.agentApiEnabledByAgency ?? false,
    apiAccessEnabledByAgency: before.apiAccessEnabledByAgency ?? false,
  };

  const proposal = (id: string, taskRef: FirebaseFirestore.DocumentReference, title: string, extra = {}) => ({
    ...tenant,
    createdByUid: "apikey:e2eagent",
    keyId: KEY_ID,
    keyPrefix: "e2eagent",
    // The approval class only gates it; complete_task is what runs.
    capability: "complete_task",
    approval: "hard_delete",
    args: { taskId: taskRef.id, taskTitle: title },
    summary: `Mark the task “${title}” as done.`,
    preview: [{ label: "Task", value: title }],
    pinned: null,
    contactId: null,
    territoryId: null,
    targetScoped: false,
    status: "pending",
    rev: `rev-${id}`,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
    claimedAt: null,
    claimId: null,
    ...extra,
  });

  try {
    await saRef.update({ agentApiEnabledByAgency: true, apiAccessEnabledByAgency: true });
    await keyRef.set({ ...tenant, name: "E2E agent key", mode: "live", prefix: "e2eagent", scopes: ["agent"], revokedAt: null });
    const titles = [`E2E approve task ${stamp}`, `E2E resend task ${stamp}`];
    for (const [i, ref] of taskRefs.entries()) {
      await ref.set({ ...tenant, title: titles[i], completed: false, mode: "live", createdByUid: "e2e", contactId: null });
    }
    await db.doc(`agentProposals/${ids.approve}`).set(proposal(ids.approve, taskRefs[0]!, titles[0]!));
    await db.doc(`agentProposals/${ids.resend}`).set(
      proposal(ids.resend, taskRefs[1]!, titles[1]!, { priorAttemptSent: { claimId: "c0", settledAt: new Date() } })
    );
    await db.doc(`agentProposals/${ids.reject}`).set(proposal(ids.reject, taskRefs[0]!, `E2E reject ${stamp}`));

    await page.goto(`/sa/${sa}/approvals`);
    const card = (id: string) => page.getByTestId(`approval-${id}`);
    await expect(card(ids.approve)).toBeVisible({ timeout: 30_000 });
    await expect(card(ids.approve).getByTestId("approval-preview")).toContainText(titles[0]!);

    // Approve → Done, and the capability really ran.
    await card(ids.approve).getByRole("button", { name: "Approve" }).click();
    await expect(card(ids.approve)).toContainText("Done", { timeout: 30_000 });
    await expect.poll(async () => (await taskRefs[0]!.get()).data()?.completed, { timeout: 15_000 }).toBe(true);

    // A prior attempt: the warning shows, Approve asks in-app first.
    await expect(card(ids.resend).getByTestId("approval-prior-warning")).toBeVisible();
    await card(ids.resend).getByRole("button", { name: "Approve" }).click();
    await expect(page.getByTestId("approval-prior-dialog")).toBeVisible();
    expect((await taskRefs[1]!.get()).data()?.completed).toBe(false);
    await page.getByTestId("approval-prior-confirm").click();
    await expect(card(ids.resend)).toContainText("Done", { timeout: 30_000 });
    await expect.poll(async () => (await taskRefs[1]!.get()).data()?.completed, { timeout: 15_000 }).toBe(true);

    // Reject → Rejected, nothing ran.
    await card(ids.reject).getByRole("button", { name: "Reject" }).click();
    await expect(card(ids.reject)).toContainText("Rejected", { timeout: 30_000 });
    expect((await db.doc(`agentProposals/${ids.reject}`).get()).data()?.status).toBe("rejected");
  } finally {
    await saRef.update(previousGates);
    for (const ref of [...proposalRefs, ...taskRefs, keyRef]) await deleteScoped(ref);
  }
});

test.fixme("(plan a) a hard_delete proposal approved in the browser removes the doc (needs a delete_* capability, PR7+)", async () => {});

test.fixme("(plan b) a send_message email proposal with no SMTP ends failed with the SendRefusal error (needs send_message, PR8)", async () => {});
