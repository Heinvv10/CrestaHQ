import { createHash, randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { adminDb } from "../lib/admin";
import { readEnv } from "../lib/env";
import { ownerUid } from "../lib/seed";

/**
 * `list_snapshots` / `apply_snapshot` on agency keys (AGENCY_AGENT_API_PLAN.md
 * A4a-2) through the real server: the REST tools route, the agency approvals
 * page and the agency decide route. Two agency keys of the E2E agency, A and
 * B, minted here; two snapshot docs seeded in the agency, one captured (a
 * workflow, a product, a custom field, no persona) and one imported.
 *   - Key A creates T1 and applies the captured snapshot: direct, the copies
 *     land in T1, the workflow `draft`.
 *   - Key B creates T2; key A applying there is a proposal (A did not create
 *     T2), and so is key A applying the IMPORTED snapshot onto T1.
 *   - Key A proposes activating T1's copied workflow (`workflow_activate` on
 *     a key-created target: batch-eligible). "Approve all" takes it and
 *     leaves both snapshot rows pending; approving T2's row on its own
 *     applies it.
 *
 * Nothing here touches a fixture or client sub-account: T1 and T2 are made
 * by this run's keys and deleted by it, every doc it deletes must belong to
 * them (or carry this run's marker), and their workflows and products go
 * before the sub-accounts themselves.
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const crock = (n: number) => [...randomBytes(n)].map((b) => CROCKFORD[b % 32]).join("");
const TOP_LEVEL = ["agentProposals", "workflows", "products", "forms", "message_templates", "auditEvents", "aiSuiteActions", "workflowRuns"];

type Key = { id: string; raw: string };

test("agency snapshots: direct on a key-created target; proposals elsewhere and for an imported one, never in Approve all", async ({ page, request }, testInfo) => {
  const env = readEnv();
  const agencyId = env.E2E_AGENCY_ID;
  const db = adminDb();
  const run = `e2e-a4a2-${Date.now()}-${crock(4).toLowerCase()}`;
  const agencyRef = db.doc(`agencies/${agencyId}`);
  const previousSwitch = (await agencyRef.get()).data()?.agentApiEnabled === true;
  const keys: Key[] = [];
  const captured = `${run}-captured`;
  const imported = `${run}-imported`;

  try {
    const owner = await ownerUid(agencyId);
    const member = (await db.doc(`agencies/${agencyId}/agencyMembers/${owner}`).get()).data();
    if (member?.role !== "owner" || member?.status !== "active") {
      throw new Error(`agencies/${agencyId}/agencyMembers/${owner} is not an active owner; an agency key minted by it cannot act.`);
    }
    await agencyRef.update({ agentApiEnabled: true });
    for (const label of ["A", "B"]) {
      const prefix = crock(8);
      const key = { id: `${run}-key-${label.toLowerCase()}`, raw: `lsk_live_${prefix}_${crock(32)}` };
      keys.push(key);
      await db.doc(`agencies/${agencyId}/apiKeys/${key.id}`).set({
        agencyId, subAccountId: null, name: `E2E A4a-2 ${label} ${run}`, mode: "live", prefix,
        hashedSecret: createHash("sha256").update(key.raw, "utf8").digest("hex"),
        scopes: ["agent"], createdByUid: owner, createdAt: new Date(), revokedAt: null, e2eRun: run,
      });
    }
    const [keyA, keyB] = keys as [Key, Key];
    const payload = {
      forms: [],
      messageTemplates: [],
      products: [{ sourceId: "p1", name: `E2E A4a-2 product ${run}`, description: "", unitPriceCents: 100, currency: "ZAR", active: true }],
      workflows: [{
        sourceId: "w1", name: `E2E A4a-2 workflow ${run}`, status: "active", reentry: "every_time", startNodeId: "n1",
        // A form the snapshot does not carry: apply nulls it, and T1 has no forms.
        trigger: { type: "form.submitted", filters: { all: [], match: "all" }, formId: `${run}-no-form` },
        nodes: { n1: { id: "n1", type: "add_tag", config: { tag: `${run}-tag` }, next: null } },
      }],
      customFields: [{ sourceId: "cf1", entity: "contact", key: `e2e_a4a2_${crock(6).toLowerCase()}`, label: "E2E A4a-2", type: "text", options: [], required: false, order: 0 }],
    };
    const snapshotDoc = { agencyId, description: "", version: 1, createdByUid: owner, payload, e2eRun: run };
    await db.doc(`agencies/${agencyId}/snapshots/${captured}`).set({
      ...snapshotDoc, id: captured, name: `E2E A4a-2 captured ${run}`, sourceSubAccountId: `${run}-source`, createdAt: new Date(),
    });
    await db.doc(`agencies/${agencyId}/snapshots/${imported}`).set({
      ...snapshotDoc, id: imported, name: `E2E A4a-2 imported ${run}`, sourceSubAccountId: null, createdAt: new Date(),
      importedFrom: { importedAt: new Date(), via: "file" },
    });

    const call = (key: Key, tool: string, args: Record<string, unknown>) => callTool(request, key, tool, args);
    const t1 = (await call(keyA, "create_sub_account", { name: `E2E A4a-2 T1 ${run}` })).expect200().ref!.id;
    const t2 = (await call(keyB, "create_sub_account", { name: `E2E A4a-2 T2 ${run}` })).expect200().ref!.id;

    const listed = (await call(keyA, "list_snapshots", {})).expect200().result;
    expect(listed).toContain(`id: ${captured} | `);
    expect(listed).toMatch(new RegExp(`id: ${imported} \\| [^\\n]*imported: true`));
    expect(listed).toContain("0 forms, 0 message templates, 1 product, 1 workflow, 1 custom field, persona: no");

    // Direct: the copies land in T1, as the minter, the workflow a draft.
    const direct = (await call(keyA, "apply_snapshot", { subAccountId: t1, snapshotId: captured })).expect200();
    expect(direct.result).toContain("created 0 forms, 0 message templates, 1 product, 1 workflow (draft), 1 custom field");
    const t1Workflows = (await db.collection("workflows").where("subAccountId", "==", t1).get()).docs;
    expect(t1Workflows.map((d) => [d.data().status, d.data().createdByUid])).toEqual([["draft", owner]]);
    expect((await db.collection("products").where("subAccountId", "==", t1).get()).size).toBe(1);
    expect((await db.collection(`subAccounts/${t1}/customFields`).get()).size).toBe(1);

    const ids = {
      t2: (await call(keyA, "apply_snapshot", { subAccountId: t2, snapshotId: captured })).expect202(),
      imported: (await call(keyA, "apply_snapshot", { subAccountId: t1, snapshotId: imported })).expect202(),
      activate: (await call(keyA, "set_workflow_status", { subAccountId: t1, workflowId: t1Workflows[0]!.id, status: "active" })).expect202(),
    };
    const status = async (id: string) => (await db.doc(`agentProposals/${id}`).get()).data()?.status;
    expect((await db.collection("workflows").where("subAccountId", "==", t2).get()).size).toBe(0);

    await page.goto("/agency/approvals");
    const card = (id: string) => page.getByTestId(`approval-${id}`);
    for (const id of Object.values(ids)) await expect(card(id)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId(`approval-group-${t2}`)).toContainText(`E2E A4a-2 T2 ${run}`);
    await expect(card(ids.t2)).toContainText("Arrive as drafts");
    await expect(card(ids.imported)).toContainText("written outside this agency");
    await page.screenshot({ path: testInfo.outputPath("agency-snapshots-before.png"), fullPage: true });

    // Approve all: the activation; neither snapshot row.
    await page.getByTestId("approve-all").click();
    await expect(card(ids.activate)).toContainText("Done", { timeout: 30_000 });
    expect(await status(ids.activate)).toBe("executed");
    expect(await status(ids.t2)).toBe("pending");
    expect(await status(ids.imported)).toBe("pending");
    expect((await db.collection("workflows").where("subAccountId", "==", t2).get()).size).toBe(0);

    // Its own click applies it.
    await card(ids.t2).getByRole("button", { name: "Approve" }).click();
    await expect(card(ids.t2)).toContainText("Done", { timeout: 30_000 });
    expect(await status(ids.t2)).toBe("executed");
    const t2Workflows = (await db.collection("workflows").where("subAccountId", "==", t2).get()).docs;
    expect(t2Workflows.map((d) => [d.data().status, d.data().createdByUid])).toEqual([["draft", owner]]);
    expect((await db.collection("products").where("subAccountId", "==", t2).get()).size).toBe(1);
    expect(await status(ids.imported)).toBe("pending");
    await page.screenshot({ path: testInfo.outputPath("agency-snapshots-after.png"), fullPage: true });
  } finally {
    await agencyRef.update({ agentApiEnabled: previousSwitch });
    await teardown(agencyId, run, keys.map((k) => k.id), [captured, imported]);
  }
});

async function callTool(request: APIRequestContext, key: Key, tool: string, args: Record<string, unknown>) {
  const res = await request.post(`/api/v1/tools/${tool}`, { headers: { authorization: `Bearer ${key.raw}` }, data: args });
  const body = (await res.json()) as { result?: string; ref?: { id: string }; proposal?: { id: string } };
  const where = `${tool}: ${JSON.stringify(body)}`;
  return {
    expect200: () => (expect(res.status(), where).toBe(200), body as { result: string; ref?: { id: string } }),
    expect202: () => (expect(res.status(), where).toBe(202), body.proposal!.id),
  };
}

/** Delete what this run made — and refuse, loudly, anything it did not. */
async function teardown(agencyId: string, run: string, keyIds: string[], snapshotIds: string[]) {
  const db = adminDb();
  // This run's sub-accounts: made by one of its keys, named for it.
  const subs: string[] = [];
  if (keyIds.length > 0) {
    for (const d of (await db.collection("subAccounts").where("createdByKeyId", "in", keyIds).get()).docs) {
      const data = d.data();
      if (data.agencyId !== agencyId || !String(data.name).startsWith("E2E A4a-2 ") || !String(data.name).endsWith(run)) {
        throw new Error(`${d.ref.path}: not this run's (${run}); refusing to delete it.`);
      }
      subs.push(d.id);
    }
  }
  const ours = (path: string, data: FirebaseFirestore.DocumentData | undefined) => {
    const target = data?.subAccountId ?? data?.targetSubAccountId;
    if (data?.agencyId !== agencyId || !subs.includes(target)) throw new Error(`${path}: not this run's (${run}); refusing to delete it.`);
  };
  // Workflows, products and the rest first: a sub-account holding them is not deleted.
  if (subs.length > 0) {
    for (const coll of TOP_LEVEL) {
      for (const field of coll === "agentProposals" ? ["subAccountId", "targetSubAccountId"] : ["subAccountId"]) {
        for (const d of (await db.collection(coll).where(field, "in", subs).get()).docs) {
          ours(d.ref.path, d.data());
          await db.recursiveDelete(d.ref);
        }
      }
    }
  }
  for (const keyId of keyIds) {
    for (const d of (await db.collection(`agencies/${agencyId}/agentCalls`).where("keyId", "==", keyId).get()).docs) {
      ours(d.ref.path, { ...d.data(), agencyId });
      await d.ref.delete();
    }
  }
  for (const id of subs) {
    const ref = db.doc(`subAccounts/${id}`);
    for (const m of (await ref.collection("subAccountMembers").get()).docs) {
      await db.doc(`userMemberships/${m.id}/subAccounts/${id}`).delete();
    }
    await db.recursiveDelete(ref);
  }
  for (const keyId of keyIds) {
    const ref = db.doc(`agencies/${agencyId}/apiKeys/${keyId}`);
    const key = (await ref.get()).data();
    if (!key) continue;
    if (key.e2eRun !== run) throw new Error(`${ref.path}: not this run's; refusing to delete it.`);
    await db.recursiveDelete(ref);
  }
  for (const id of snapshotIds) {
    const ref = db.doc(`agencies/${agencyId}/snapshots/${id}`);
    const snap = (await ref.get()).data();
    if (!snap) continue;
    if (snap.e2eRun !== run || snap.agencyId !== agencyId) throw new Error(`${ref.path}: not this run's; refusing to delete it.`);
    await db.recursiveDelete(ref);
  }
}
