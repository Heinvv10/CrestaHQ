import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import { proposals, runs, setupHeldEnrolmentTests } from "@/test/held-enrolment-harness";
import type { AgencyApiAuthContext } from "@/lib/api/auth";

/**
 * Ruling Q for an AGENCY key (AGENCY_AGENT_API_PLAN.md A3b): its write in a
 * reached sub-account holds the enrolment as an ordinary sub-account row
 * stamped `keyLevel: "agency"`, and every re-read of the proposing key —
 * the queue, the decide route, the replay's cap — goes to the agency's key
 * doc (`agentKeyRef`). A decoy `subAccounts/sa1/apiKeys/ak1` with other
 * values sits beside it, so a read of the wrong path changes the outcome.
 * Real dispatch, engine, services, queue and decide route.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);
vi.mock("@/lib/automations/qstash", async () => (await import("@/test/held-enrolment-harness")).qstashMock());

const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");
const { replayHeldEnrolment } = await import("@/lib/server/agent-enrolment-replay");
const { enrolmentHourKey } = await import("@/lib/api/enrolment-cap");

setupAgentProposalTests();
setupHeldEnrolmentTests();

const agencyKey: AgencyApiAuthContext = {
  ...auth, level: "agency", subAccountId: null, keyLevel: "agency", keyId: "ak1", enrolmentCapPerHour: 7,
};
const AGENCY_KEY = "agencies/ag1/apiKeys/ak1";
const DECOY_KEY = "subAccounts/sa1/apiKeys/ak1";

beforeEach(() => {
  mem.seed("agencies/ag1", { agentApiEnabled: true });
  mem.seed(AGENCY_KEY, { agencyId: "ag1", subAccountId: null, prefix: "abcd1234", revokedAt: null, enrolmentCapPerHour: 7 });
});

const createContact = () =>
  dispatchAgentTool(agencyKey, "create_contact", { subAccountId: "sa1", name: "Ann Agency", email: "ann@x.io" });
const heldRow = async () => {
  await createContact();
  const [p] = proposals();
  return p!;
};

describe("an agency key's write that matches an ACTIVE workflow", () => {
  it("holds exactly one workflow_enrolment row stamped keyLevel agency, no hold failure", async () => {
    const r = await createContact();
    expect(r).toMatchObject({ ok: true, scopedTo: "sa1", held: [{ workflowName: "Workflow wf1" }] });
    expect((r as { holdFailures?: unknown[] }).holdFailures).toEqual([]);
    expect(runs()).toEqual([]);
    expect(proposals()).toHaveLength(1);
    expect(proposals()[0]).toMatchObject({
      approval: "workflow_enrolment", capability: "create_contact", workflowId: "wf1",
      agencyId: "ag1", subAccountId: "sa1", keyId: "ak1", keyLevel: "agency", status: "pending",
    });
  });

  it("a revoked agency key holds nothing (hold_refused), even with a live decoy under the sub-account", async () => {
    mem.seed(AGENCY_KEY, { ...mem.read(AGENCY_KEY), revokedAt: new Date() });
    mem.seed(DECOY_KEY, { subAccountId: "sa1", revokedAt: null });
    const r = await createContact();
    expect(r).toMatchObject({ ok: true, held: [], holdFailures: [{ workflowId: "wf1", reason: "hold_refused" }] });
    expect(proposals()).toEqual([]);
  });
});

describe("approving it on the existing sub-account decide route", () => {
  it("executes once and reserves the enrolment under sa1 for the agency key", async () => {
    const p = await heldRow();
    expect((await decide(p.id, "approve")).status).toBe(200);
    expect(runs()).toEqual([expect.objectContaining({ workflowId: "wf1", status: "running" })]);
    expect(row(p.id)).toMatchObject({ status: "executed" });
    expect(replayHeldEnrolment).toHaveBeenCalledTimes(1);
    expect(mem.list("subAccounts/sa1/apiEnrolments")).toEqual([expect.objectContaining({ keyId: "ak1", count: 1 })]);
  });

  it("the cap is the AGENCY key doc's (7), not a sub-account doc's (1000)", async () => {
    const p = await heldRow();
    mem.seed(DECOY_KEY, { subAccountId: "sa1", revokedAt: null, enrolmentCapPerHour: 1000 });
    mem.seed(`subAccounts/sa1/apiEnrolments/ak1_${enrolmentHourKey()}`, { keyId: "ak1", count: 7 });
    const res = await decide(p.id, "approve");
    expect(await res.json()).toMatchObject({ status: "failed", error: expect.stringContaining("its 7 workflow enrolments") });
    expect(runs()).toEqual([]);
  });

  it("the key re-read is the agency key's: a revoked decoy does not kill the row", async () => {
    const p = await heldRow();
    mem.seed(DECOY_KEY, { subAccountId: "sa1", revokedAt: new Date() });
    expect((await decide(p.id, "approve")).status).toBe(200);
    expect(runs()).toHaveLength(1);
  });

  it("the agency key revoked since → 409 key_revoked, nobody enrolled", async () => {
    const p = await heldRow();
    mem.seed(AGENCY_KEY, { ...mem.read(AGENCY_KEY), revokedAt: new Date() });
    const res = await decide(p.id, "approve");
    expect([res.status, await res.json()]).toEqual([409, { error: "key_revoked" }]);
    expect(row(p.id)).toMatchObject({ status: "rejected", reason: "key_revoked" });
    expect(runs()).toEqual([]);
  });
});

describe("the agency's Agent API switch", () => {
  it("off → dispatch 403 agent_api_disabled, and approving the key's row 403, still pending", async () => {
    const p = await heldRow();
    mem.seed("agencies/ag1", { agentApiEnabled: false });
    expect(await createContact()).toMatchObject({ ok: false, code: "agent_api_disabled", httpStatus: 403 });
    const res = await decide(p.id, "approve");
    expect(res.status).toBe(403);
    expect(row(p.id)).toMatchObject({ status: "pending" });
    expect(runs()).toEqual([]);
    // Rejecting is always safe, switch or not.
    expect((await decide(p.id, "reject")).status).toBe(200);
  });

  it("does not gate a sub-account key's row", async () => {
    await dispatchAgentTool(auth, "create_contact", { name: "Ben Sub", email: "ben@x.io" });
    const [p] = proposals();
    expect(p).toMatchObject({ keyId: "key1", keyLevel: "sub-account" });
    mem.seed("agencies/ag1", { agentApiEnabled: false });
    expect((await decide(p!.id, "approve")).status).toBe(200);
  });
});

describe("the replay's cap read", () => {
  it("refuses when the proposing key's doc is gone, never charging the default cap", async () => {
    const p = await heldRow();
    await mem.db.doc(AGENCY_KEY).delete();
    await expect(replayHeldEnrolment(p, { uid: "u", email: "", displayName: "", agencyId: "ag1", subAccountId: "sa1" }))
      .rejects.toThrow("no longer exists");
    expect(mem.list("subAccounts/sa1/apiEnrolments")).toEqual([]);
    expect(runs()).toEqual([]);
  });
});
