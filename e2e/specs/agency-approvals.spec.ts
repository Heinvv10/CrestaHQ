import { createHash, randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { readEnv } from "../lib/env";
import { ownerUid } from "../lib/seed";

/**
 * /agency/approvals (AGENCY_AGENT_API_PLAN.md D4, A5) through the real
 * server. An agency key of the E2E agency, minted here, proposes through
 * the real REST tools route, so every preview is the server's own:
 *   - `set_workflow_status active` on a sub-account the key created
 *     (`createdByKeyId`, < 72 h, no contacts) → a `workflow_activate` row;
 *   - `set_sub_account_gate broadcasts true` on that same target → an
 *     agency-level `gate_change` row;
 *   - `send_message` by email in a second sub-account whose email provider
 *     is SMTP with nothing configured → an `outbound` row whose send the
 *     seam refuses before any provider is called.
 * "Approve all" must approve the activation only and leave the other two
 * pending; approving those one by one ends `executed` (the gate really
 * flips) and `failed` (the seam's refusal).
 *
 * Nothing here touches a fixture or client sub-account: the two targets are
 * created by this spec under a run-unique id prefix and deleted by it. The
 * delete path is guarded on its own (teardown runs even when setup throws):
 * every doc it deletes must carry this run's marker or one of this run's
 * two sub-account ids and the E2E agency.
 *
 * NOTE: the page reads through the agency list route, whose query needs the
 * `agentProposals (agencyId, keyLevel, status, createdAt DESC)` index. Until
 * it is deployed to the project the route fails FAILED_PRECONDITION and this
 * spec fails.
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const crock = (n: number) => [...randomBytes(n)].map((b) => CROCKFORD[b % 32]).join("");
const TOP_LEVEL = ["agentProposals", "workflows", "contacts", "conversations", "auditEvents", "aiSuiteActions", "workflowRuns"];

test("agency approvals: Approve all takes the activation only; gate and send one by one", async ({ page, request }, testInfo) => {
  const env = readEnv();
  const agencyId = env.E2E_AGENCY_ID;
  const db = adminDb();
  const run = `e2e-a5-${Date.now()}-${crock(4).toLowerCase()}`;
  const subA = `${run}-kc`;
  const subB = `${run}-old`;
  const keyId = `${run}-key`;
  const contactId = `${run}-contact`;
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
      agencyId, subAccountId: null, name: `E2E A5 ${run}`, mode: "live", prefix,
      hashedSecret: createHash("sha256").update(rawKey, "utf8").digest("hex"),
      scopes: ["agent"], createdByUid: owner, createdAt: new Date(), revokedAt: null, e2eRun: run,
    });
    const gates = { agentApiEnabledByAgency: true, apiAccessEnabledByAgency: true, broadcastsEnabledByAgency: false };
    await db.doc(`subAccounts/${subA}`).set({
      agencyId, name: `E2E A5 key-created ${run}`, ...gates, createdByKeyId: keyId, createdAt: new Date(), e2eRun: run,
    });
    await db.doc(`subAccounts/${subB}`).set({
      agencyId, name: `E2E A5 existing ${run}`, ...gates, emailProvider: "smtp",
      createdAt: new Date(Date.now() - 400 * 24 * 3600_000), e2eRun: run,
    });
    await workflowRef.set({
      subAccountId: subA, agencyId, createdByUid: owner, name: `E2E A5 workflow ${run}`, status: "draft",
      // A form that does not exist: activating it can never enrol anyone.
      trigger: { type: "form.submitted", filters: { all: [], match: "all" }, formId: `${run}-no-form` },
      reentry: "every_time", startNodeId: "n1",
      nodes: { n1: { id: "n1", type: "add_tag", config: { tag: `${run}-tag` }, next: null } },
      stats: { enrolled: 0, completed: 0 }, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    await db.doc(`contacts/${contactId}`).set({
      subAccountId: subB, agencyId, name: "E2E A5 Recipient", firstName: "E2E", lastName: "Recipient",
      email: "e2e-a5@example.invalid", tags: [], createdByUid: owner, createdAt: new Date(),
    });
    await db.doc(`conversations/${contactId}`).set({ subAccountId: subB, agencyId, contactId, lastMessageAt: new Date() });

    const propose = async (tool: string, args: Record<string, unknown>) => {
      const res = await request.post(`/api/v1/tools/${tool}`, { headers: { authorization: `Bearer ${rawKey}` }, data: args });
      const body = (await res.json()) as { proposal?: { id: string }; error?: unknown };
      expect(res.status(), `${tool}: ${JSON.stringify(body)}`).toBe(202);
      return body.proposal!.id;
    };
    const ids = {
      activate: await propose("set_workflow_status", { subAccountId: subA, workflowId: workflowRef.id, status: "active" }),
      gate: await propose("set_sub_account_gate", { subAccountId: subA, gate: "broadcasts", enabled: true }),
      send: await propose("send_message", {
        subAccountId: subB, conversationId: contactId, channel: "email", subject: "E2E A5", body: "Never sent.",
      }),
    };
    const status = async (id: string) => (await db.doc(`agentProposals/${id}`).get()).data()?.status;

    await page.goto("/agency/approvals");
    const card = (id: string) => page.getByTestId(`approval-${id}`);
    for (const id of Object.values(ids)) await expect(card(id)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId(`approval-group-${subA}`)).toContainText(`E2E A5 key-created ${run}`);
    await expect(card(ids.gate).getByTestId("approval-meta")).toContainText(`key ${prefix}`);
    const all = page.getByTestId("approve-all");
    await expect(all).toHaveText(/Approve all \(1\)/);
    // Unrelated agency-wide pending rows may coexist with this run's proposals.
    await expect.poll(async () => {
      const text = await page.getByTestId("approve-all-bar").textContent();
      return Number(text?.match(/skips (\d+)/)?.[1] ?? 0);
    }).toBeGreaterThanOrEqual(2);
    await page.screenshot({ path: testInfo.outputPath("agency-approvals-before.png"), fullPage: true });

    // Approve all: the activation only.
    await all.click();
    await expect(card(ids.activate)).toContainText("Done", { timeout: 30_000 });
    await expect.poll(async () => (await workflowRef.get()).data()?.status, { timeout: 15_000 }).toBe("active");
    expect(await status(ids.gate)).toBe("pending");
    expect(await status(ids.send)).toBe("pending");
    expect((await db.doc(`subAccounts/${subA}`).get()).data()?.broadcastsEnabledByAgency).toBe(false);

    // One by one: the gate really flips; the send is refused by the seam.
    await card(ids.gate).getByRole("button", { name: "Approve" }).click();
    await expect(card(ids.gate)).toContainText("Done", { timeout: 30_000 });
    expect((await db.doc(`subAccounts/${subA}`).get()).data()?.broadcastsEnabledByAgency).toBe(true);
    expect(await status(ids.gate)).toBe("executed");
    await card(ids.send).getByRole("button", { name: "Approve" }).click();
    await expect(card(ids.send)).toContainText("Failed", { timeout: 30_000 });
    await expect(card(ids.send).getByTestId("approval-error")).toContainText("Email is not configured for this sub-account.");
    expect(await status(ids.send)).toBe("failed");
    await page.screenshot({ path: testInfo.outputPath("agency-approvals-after.png"), fullPage: true });
  } finally {
    await agencyRef.update({ agentApiEnabled: previousSwitch });
    await teardown(agencyId, run, [subA, subB], keyId);
  }
});

/** Delete what this run made — and refuse, loudly, anything it did not. */
async function teardown(agencyId: string, run: string, subs: string[], keyId: string) {
  const db = adminDb();
  const ours = (path: string, data: FirebaseFirestore.DocumentData | undefined) => {
    const target = data?.subAccountId ?? data?.targetSubAccountId;
    if (data?.agencyId !== agencyId || !subs.includes(target) || !String(target).startsWith(`${run}-`)) {
      throw new Error(`${path}: not this run's (${run}); refusing to delete it.`);
    }
  };
  for (const coll of TOP_LEVEL) {
    for (const field of coll === "agentProposals" ? ["subAccountId", "targetSubAccountId"] : ["subAccountId"]) {
      const snap = await db.collection(coll).where(field, "in", subs).get();
      for (const d of snap.docs) {
        ours(d.ref.path, d.data());
        await db.recursiveDelete(d.ref);
      }
    }
  }
  const calls = await db.collection(`agencies/${agencyId}/agentCalls`).where("keyId", "==", keyId).get();
  for (const d of calls.docs) {
    ours(d.ref.path, { ...d.data(), agencyId });
    await d.ref.delete();
  }
  for (const id of subs) {
    const ref = db.doc(`subAccounts/${id}`);
    const data = (await ref.get()).data();
    if (!data) continue;
    if (data.e2eRun !== run || data.agencyId !== agencyId) throw new Error(`${ref.path}: not this run's; refusing to delete it.`);
    await db.recursiveDelete(ref);
  }
  const keyRef = db.doc(`agencies/${agencyId}/apiKeys/${keyId}`);
  const key = (await keyRef.get()).data();
  if (key) {
    if (key.e2eRun !== run) throw new Error(`${keyRef.path}: not this run's; refusing to delete it.`);
    await db.recursiveDelete(keyRef);
  }
}
