import { createHash, randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { readEnv } from "../lib/env";
import { ownerUid } from "../lib/seed";
import { batchEligible, type AgencyApprovalRow } from "@/lib/approvals/agency-batch";

/**
 * `invite_member` and `assign_billing_plan` on an agency key
 * (AGENCY_AGENT_API_PLAN.md A4b) through the real server: the REST tools
 * route, both approvals pages and both decide routes. An agency key of the
 * E2E agency, minted here, proposes on a sub-account it "created" (seeded
 * with `createdByKeyId`, < 72 h, no contacts):
 *   - `set_workflow_status active` → `workflow_activate` (batch-eligible);
 *   - `invite_member` for a run-unique @example.com address → `outbound`,
 *     on /agency/approvals AND /sa/[target]/approvals;
 *   - `assign_billing_plan` with a plan seeded here → agency-level `spend`,
 *     its preview naming the gate going on and the one going off.
 * "Approve all" would take the activation and neither other row — checked on
 * THIS run's rows through the list route the button re-reads, never as a
 * count and never by clicking it (the agency is shared: another run's
 * leftover row may be on the page, and a click would approve it). Every
 * row is then REJECTED on the page: a billing row is never approved here
 * (CI has no payment provider, and nothing may be charged), and the invite
 * is not approved because nothing proves CI has no outbound mail path.
 *
 * Nothing touches a fixture or client sub-account: the target, workflow,
 * plan and key carry this run's id or marker, and the guarded teardown
 * deletes workflows first (a sub-account holding them is not deletable),
 * then proposals, invites, memberships, the plan, the sub-account, the key.
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const crock = (n: number) => [...randomBytes(n)].map((b) => CROCKFORD[b % 32]).join("");
const TOP_LEVEL = ["workflows", "products", "agentProposals", "invites", "auditEvents", "aiSuiteActions", "workflowRuns"];

test("agency invite + billing: outbound and spend rows, never in Approve all, rejected on the page", async ({ page, request }, testInfo) => {
  const env = readEnv();
  const agencyId = env.E2E_AGENCY_ID;
  const db = adminDb();
  const run = `e2e-a4b-${Date.now()}-${crock(4).toLowerCase()}`;
  const target = `${run}-kc`;
  const keyId = `${run}-key`;
  const planId = `${run}-plan`;
  const email = `${run}@example.com`;
  const workflowRef = db.collection("workflows").doc(`${run}-wf`);
  const agencyRef = db.doc(`agencies/${agencyId}`);
  const keyRef = db.doc(`agencies/${agencyId}/apiKeys/${keyId}`);
  const prefix = crock(8);
  const rawKey = `lsk_live_${prefix}_${crock(32)}`;
  const previousSwitch = (await agencyRef.get()).data()?.agentApiEnabled === true;

  try {
    const owner = await ownerUid(agencyId);
    const member = (await db.doc(`agencies/${agencyId}/agencyMembers/${owner}`).get()).data();
    if (member?.role !== "owner" || member?.status !== "active") {
      throw new Error(`agencies/${agencyId}/agencyMembers/${owner} is not an active owner; an agency key minted by it cannot act.`);
    }
    await agencyRef.update({ agentApiEnabled: true });
    await keyRef.set({
      agencyId, subAccountId: null, name: `E2E A4b ${run}`, mode: "live", prefix,
      hashedSecret: createHash("sha256").update(rawKey, "utf8").digest("hex"),
      scopes: ["agent"], createdByUid: owner, createdAt: new Date(), revokedAt: null, e2eRun: run,
    });
    await db.doc(`subAccounts/${target}`).set({
      agencyId, name: `E2E A4b key-created ${run}`, agentApiEnabledByAgency: true, apiAccessEnabledByAgency: true,
      broadcastsEnabledByAgency: false, createdByKeyId: keyId, createdAt: new Date(), e2eRun: run,
    });
    await workflowRef.set({
      subAccountId: target, agencyId, createdByUid: owner, name: `E2E A4b workflow ${run}`, status: "draft",
      // A form that does not exist: activating it can never enrol anyone.
      trigger: { type: "form.submitted", filters: { all: [], match: "all" }, formId: `${run}-no-form` },
      reentry: "every_time", startNodeId: "n1",
      nodes: { n1: { id: "n1", type: "add_tag", config: { tag: `${run}-tag` }, next: null } },
      stats: { enrolled: 0, completed: 0 }, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    // One gate on (broadcasts, off on the target) and one off (API access, on on the target).
    await db.doc(`agencies/${agencyId}/plans/${planId}`).set({
      id: planId, agencyId, name: `E2E A4b plan ${run}`, description: null, status: "active", currency: "zar",
      priceMonthlyCents: 9900, priceAnnualCents: null, stripeProductId: null, stripePriceId: null, stripeAnnualPriceId: null,
      gates: { broadcastsEnabledByAgency: true, apiAccessEnabledByAgency: false }, quotas: null, rates: null,
      createdAt: new Date(), updatedAt: new Date(), e2eRun: run,
    });

    const propose = async (tool: string, args: Record<string, unknown>) => {
      const res = await request.post(`/api/v1/tools/${tool}`, { headers: { authorization: `Bearer ${rawKey}` }, data: args });
      const body = (await res.json()) as { proposal?: { id: string }; error?: unknown };
      expect(res.status(), `${tool}: ${JSON.stringify(body)}`).toBe(202);
      return body.proposal!.id;
    };
    const ids = {
      activate: await propose("set_workflow_status", { subAccountId: target, workflowId: workflowRef.id, status: "active" }),
      invite: await propose("invite_member", { subAccountId: target, email, role: "collaborator" }),
      assign: await propose("assign_billing_plan", { subAccountId: target, subAccountName: "ignored", planId, planName: "ignored" }),
    };
    const status = async (id: string) => (await db.doc(`agentProposals/${id}`).get()).data()?.status;
    expect((await db.doc(`agentProposals/${ids.invite}`).get()).data()).toMatchObject({ approval: "outbound", subAccountId: target });
    expect((await db.doc(`agentProposals/${ids.assign}`).get()).data()).toMatchObject({ approval: "spend", subAccountId: null, targetSubAccountId: target });

    await page.goto("/agency/approvals");
    const card = (id: string) => page.getByTestId(`approval-${id}`);
    for (const id of Object.values(ids)) await expect(card(id)).toBeVisible({ timeout: 30_000 });
    await expect(card(ids.invite)).toContainText(email);
    await expect(card(ids.invite)).toContainText("Collaborator: works the data, no member management");
    await expect(card(ids.invite)).toContainText("New email: an invite with a signup link is created");
    await expect(card(ids.assign)).toContainText(`“E2E A4b plan ${run}”`);
    await expect(card(ids.assign)).toContainText("Email broadcasts");
    await expect(card(ids.assign)).toContainText("Public API access (changes reach: API and agent keys lose this sub-account)");
    await expect(page.getByTestId("approve-all-bar")).toContainText("that need their own click");
    await page.screenshot({ path: testInfo.outputPath("agency-invite-billing-before.png"), fullPage: true });

    // What Approve all would take, judged on this run's rows as the button
    // judges them (it re-reads this route): the activation is the control.
    const listed = await page.request.get("/api/agency/agent-proposals?status=open");
    expect(listed.ok()).toBe(true);
    const { proposals } = (await listed.json()) as { proposals: AgencyApprovalRow[] };
    const ours = (id: string) => proposals.find((p) => p.id === id);
    expect([ids.activate, ids.invite, ids.assign].map((id) => ours(id) && batchEligible(ours(id)!))).toEqual([true, false, false]);

    // Reject the activation and the billing row here; the invite on the sub-account's own page.
    for (const id of [ids.activate, ids.assign]) {
      await card(id).getByRole("button", { name: "Reject" }).click();
      await expect.poll(() => status(id), { timeout: 15_000 }).toBe("rejected");
    }
    await page.goto(`/sa/${target}/approvals`);
    await expect(card(ids.invite)).toBeVisible({ timeout: 30_000 });
    await expect(card(ids.invite)).toContainText(email);
    await card(ids.invite).getByRole("button", { name: "Reject" }).click();
    await expect.poll(() => status(ids.invite), { timeout: 15_000 }).toBe("rejected");
    await page.screenshot({ path: testInfo.outputPath("agency-invite-billing-after.png"), fullPage: true });

    // Nothing was invited, billed or activated.
    expect((await workflowRef.get()).data()?.status).toBe("draft");
    expect((await db.collection("invites").where("email", "==", email).get()).size).toBe(0);
    expect((await db.doc(`subAccounts/${target}`).get()).data()).toMatchObject({ broadcastsEnabledByAgency: false, apiAccessEnabledByAgency: true });
    expect((await db.doc(`subAccounts/${target}`).get()).data()?.billing).toBeUndefined();
  } finally {
    await agencyRef.update({ agentApiEnabled: previousSwitch });
    await teardown(agencyId, run, target, keyId, planId);
  }
});

/** Delete what this run made — and refuse, loudly, anything it did not. */
async function teardown(agencyId: string, run: string, target: string, keyId: string, planId: string) {
  const db = adminDb();
  const ours = (path: string, data: FirebaseFirestore.DocumentData | undefined) => {
    const sub = data?.subAccountId ?? data?.targetSubAccountId;
    if (data?.agencyId !== agencyId || sub !== target || !String(sub).startsWith(`${run}-`)) {
      throw new Error(`${path}: not this run's (${run}); refusing to delete it.`);
    }
  };
  // Workflows and products first: a sub-account holding them is not deletable.
  for (const coll of TOP_LEVEL) {
    for (const field of coll === "agentProposals" ? ["subAccountId", "targetSubAccountId"] : ["subAccountId"]) {
      for (const d of (await db.collection(coll).where(field, "==", target).get()).docs) {
        ours(d.ref.path, d.data());
        await db.recursiveDelete(d.ref);
      }
    }
  }
  for (const d of (await db.collection(`agencies/${agencyId}/agentCalls`).where("keyId", "==", keyId).get()).docs) {
    ours(d.ref.path, { ...d.data(), agencyId });
    await d.ref.delete();
  }
  const planRef = db.doc(`agencies/${agencyId}/plans/${planId}`);
  const plan = (await planRef.get()).data();
  if (plan) {
    if (plan.e2eRun !== run || plan.agencyId !== agencyId) throw new Error(`${planRef.path}: not this run's; refusing to delete it.`);
    await planRef.delete();
  }
  const subRef = db.doc(`subAccounts/${target}`);
  const sub = (await subRef.get()).data();
  if (sub) {
    if (sub.e2eRun !== run || sub.agencyId !== agencyId) throw new Error(`${subRef.path}: not this run's; refusing to delete it.`);
    for (const m of (await subRef.collection("subAccountMembers").get()).docs) {
      await db.doc(`userMemberships/${m.id}/subAccounts/${target}`).delete();
    }
    await db.recursiveDelete(subRef);
  }
  const keyRef = db.doc(`agencies/${agencyId}/apiKeys/${keyId}`);
  const key = (await keyRef.get()).data();
  if (key) {
    if (key.e2eRun !== run) throw new Error(`${keyRef.path}: not this run's; refusing to delete it.`);
    await db.recursiveDelete(keyRef);
  }
}
