import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, beforeNextTransaction, caller, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import { proposals, runs, seedWorkflow, setupHeldEnrolmentTests } from "@/test/held-enrolment-harness";
import type { AgencyApiAuthContext } from "@/lib/api/auth";

/**
 * The approve path's checks (both sub-account gates, the proposing key, an
 * agency key's standing) run before the claim; the claim transaction
 * re-reads them all (`approvalRefusal` via `tx.get`). Each race here
 * commits its change between the checks and the claim. Also the A3b
 * re-break's workflow.status_changed keyLevel checks.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);
vi.mock("@/lib/automations/qstash", async () => (await import("@/test/held-enrolment-harness")).qstashMock());

const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");
const { getCapability } = await import("@/lib/ai-suite/capabilities");

await setupAgentProposalTests();
setupHeldEnrolmentTests();

const agencyKey: AgencyApiAuthContext = { ...auth, level: "agency", subAccountId: null, keyLevel: "agency", keyId: "ak1" };
const AGENCY_KEY = "agencies/ag1/apiKeys/ak1";
const SUB_KEY = "subAccounts/sa1/apiKeys/key1";

beforeEach(() => {
  mem.seed("agencies/ag1", { agentApiEnabled: true });
  mem.seed("agencies/ag1/agencyMembers/owner1", { role: "owner", status: "active" });
  mem.seed(AGENCY_KEY, { agencyId: "ag1", subAccountId: null, prefix: "abcd1234", createdByUid: "owner1", revokedAt: null });
});

const statusRows = () => mem.list("auditEvents").filter((r) => r.action === "workflow.status_changed");
const revokeDoc = (path: string) => (): void => mem.seed(path, { ...mem.read(path), revokedAt: new Date() });
/** Commit `flip` inside the next transaction, after its reads, before its commit. */
function duringNextTransaction(flip: () => unknown) {
  const original = mem.db.runTransaction.bind(mem.db);
  let flipped = false;
  vi.spyOn(mem.db, "runTransaction").mockImplementationOnce(async (fn) =>
    original(async (tx) => {
      const result = await (fn as (t: typeof tx) => Promise<unknown>)(tx);
      if (!flipped) {
        flipped = true;
        await flip();
      }
      return result;
    })
  );
}
const gateOff = (): void => mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), agentApiEnabledByAgency: false });

describe("workflow.status_changed keyLevel never reaches the person or chat paths", () => {
  it("chat ctx (no apiKey) pausing a workflow → status only, actor user", async () => {
    const chat = { uid: "u_chat", email: "c@x.io", displayName: "C", agencyId: "ag1", subAccountId: "sa1", subAccountRole: "admin" as const };
    await getCapability("set_workflow_status")!.execute(chat, { workflowId: "wf1", status: "paused" });
    expect(statusRows()).toEqual([expect.objectContaining({ actor: { type: "user", id: "u_chat" } })]);
    expect(statusRows()[0]!.changes).toEqual([{ field: "status", before: "active", after: "paused" }]);
  });

  it("an agency key's activation, approved by a person → actor the approver, no keyLevel carried over", async () => {
    seedWorkflow("wf2", { type: "contact.created" }, { status: "paused" });
    const r = await dispatchAgentTool(agencyKey, "set_workflow_status", { subAccountId: "sa1", workflowId: "wf2", status: "active" });
    expect(r).toMatchObject({ ok: true, proposal: { status: "pending" } });
    const p = proposals().find((x) => x.capability === "set_workflow_status")!;
    expect(p).toMatchObject({ keyLevel: "agency", approval: "workflow_activate" });
    expect((await decide(p.id, "approve")).status).toBe(200);
    expect(statusRows()).toEqual([expect.objectContaining({ actor: { type: "user", id: caller.uid } })]);
    expect(statusRows()[0]!.changes).toEqual([{ field: "status", before: "paused", after: "active" }]);
  });
});

const agencyRow = async () => {
  await dispatchAgentTool(agencyKey, "create_contact", { subAccountId: "sa1", name: "Ann", email: "ann@x.io" });
  return proposals().find((x) => x.approval === "workflow_enrolment")!;
};
const subRow = async () => {
  await dispatchAgentTool(auth, "create_contact", { name: "Ben", email: "ben@x.io" });
  return proposals().find((x) => x.approval === "workflow_enrolment")!;
};

describe.each([
  ["an AGENCY key's row", agencyRow, AGENCY_KEY],
  ["a SUB-ACCOUNT key's row", subRow, SUB_KEY],
])("approving %s while a change commits between the checks and the claim", (_label, heldRow, keyPath) => {
  it("an unrelated write meanwhile → still executes (the hook itself stops nothing)", async () => {
    const p = await heldRow();
    beforeNextTransaction(async () => mem.seed("agencies/ag1/other/x", { n: 1 }));
    expect((await decide(p.id, "approve")).status).toBe(200);
    expect(runs()).toHaveLength(1);
    expect(row(p.id).status).toBe("executed");
  });

  it("the key revoked → 409 key_revoked, the row rejected key_revoked, nobody enrolled", async () => {
    const p = await heldRow();
    beforeNextTransaction(async () => revokeDoc(keyPath)());
    const res = await decide(p.id, "approve");
    expect([res.status, await res.json()]).toEqual([409, { error: "key_revoked" }]);
    expect(row(p.id)).toMatchObject({ status: "rejected", reason: "key_revoked", claimId: null });
    expect(runs()).toEqual([]);
  });

  it("the sub-account's Agent API gate switched off → 403, row still pending, nobody enrolled", async () => {
    const p = await heldRow();
    beforeNextTransaction(async () => gateOff());
    const res = await decide(p.id, "approve");
    expect([res.status, await res.json()]).toEqual([403, { error: "Agent API access is disabled for this sub-account." }]);
    expect(row(p.id)).toMatchObject({ status: "pending", claimId: null });
    expect(runs()).toEqual([]);
  });
});

describe("approving an agency key's row while its standing fails between the checks and the claim", () => {
  it.each([
    ["switch flipped off", () => mem.seed("agencies/ag1", { agentApiEnabled: false }), "switched off for this agency"],
    ["minter demoted", () => mem.seed("agencies/ag1/agencyMembers/owner1", { role: "staff", status: "active" }), "no longer an active owner"],
    ["agency deleted", () => mem.db.doc("agencies/ag1").delete(), "no longer exists"],
  ])("%s → 403, row still pending, nobody enrolled", async (_label, flip, message) => {
    const p = await agencyRow();
    beforeNextTransaction(async () => flip());
    const res = await decide(p.id, "approve");
    expect([res.status, await res.json()]).toEqual([403, { error: expect.stringContaining(message) }]);
    expect(row(p.id)).toMatchObject({ status: "pending", claimId: null });
    expect(runs()).toEqual([]);
  });

  it("the sub-account moved to another agency → 404, row still pending, nobody enrolled", async () => {
    const p = await agencyRow();
    beforeNextTransaction(async () => mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), agencyId: "ag2" }));
    expect((await decide(p.id, "approve")).status).toBe(404);
    expect(row(p.id)).toMatchObject({ status: "pending", claimId: null });
    expect(runs()).toEqual([]);
  });

  it("a sub-account key's row is not gated by the agency switch flipped meanwhile", async () => {
    const p = await subRow();
    beforeNextTransaction(async () => mem.seed("agencies/ag1", { agentApiEnabled: false }));
    expect((await decide(p.id, "approve")).status).toBe(200);
    expect(runs()).toHaveLength(1);
  });
});

describe("a change committing INSIDE the claim transaction (its reads are transactional)", () => {
  it.each([
    ["an agency key revoked", agencyRow, revokeDoc(AGENCY_KEY), 409, "rejected"],
    ["a sub-account key revoked", subRow, revokeDoc(SUB_KEY), 409, "rejected"],
    ["the sub-account gate off (agency row)", agencyRow, gateOff, 403, "pending"],
    ["the sub-account gate off (sub-account row)", subRow, gateOff, 403, "pending"],
    ["the agency switch off", agencyRow, (): void => mem.seed("agencies/ag1", { agentApiEnabled: false }), 403, "pending"],
    ["the minter demoted", agencyRow, (): void => mem.seed("agencies/ag1/agencyMembers/owner1", { role: "staff", status: "active" }), 403, "pending"],
  ] as const)("%s → the claim retries and refuses, nobody enrolled", async (_label, heldRow, flip, status, rowStatus) => {
    const p = await heldRow();
    duringNextTransaction(flip);
    expect((await decide(p.id, "approve")).status).toBe(status);
    expect(row(p.id)).toMatchObject({ status: rowStatus, claimId: null });
    expect(runs()).toEqual([]);
  });
});
