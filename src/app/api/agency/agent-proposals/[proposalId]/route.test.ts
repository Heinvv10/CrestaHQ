import { beforeEach, describe, expect, it, vi } from "vitest";
import { execute, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import {
  decideAgency, owner, proposeGate, proposeScoped, seedAgency, underNullSubAccount,
} from "@/test/agency-approvals-harness";

/**
 * POST /api/agency/agent-proposals/[proposalId] (AGENCY_AGENT_API_PLAN.md D4,
 * A5): the agency owner decides an agency key's rows, agency-level
 * (`subAccountId: null`, acting on `targetSubAccountId`) or sub-account-scoped,
 * through the same pre-claim sequence as the sub-account route
 * (agent-proposals-decide.ts). Real dispatch, real route, real capability,
 * in-memory Firestore.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agency-approvals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
beforeEach(seedAgency);

const NOT_FOUND = { error: "Proposal not found" };
const gateAudits = () => mem.list("auditEvents").filter((e) => e.action === "feature_gates.updated");
const subDoc = (id: string) => mem.read(`subAccounts/${id}`)!;

describe("approve a gate_change row", () => {
  it("writes the gate, audited as the approving owner, and the row is executed", async () => {
    const id = await proposeGate("sa1", "broadcasts", true);
    const { getCapability } = await import("@/lib/ai-suite/capabilities");
    const preview = vi.spyOn(getCapability("set_sub_account_gate")!, "preview");
    const res = await decideAgency(id, "approve");
    // The rebuilt preview runs in the target, never in subAccounts/null.
    expect(preview.mock.calls.map(([ctx]) => ctx.subAccountId)).toEqual(["sa1"]);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "executed" });
    expect(subDoc("sa1").broadcastsEnabledByAgency).toBe(true);
    expect(gateAudits()).toEqual([
      expect.objectContaining({
        subAccountId: "sa1",
        actor: { type: "user", id: "owner1" },
        changes: [{ field: "broadcastsEnabledByAgency", before: false, after: true }],
      }),
    ]);
    expect(row(id)).toMatchObject({ status: "executed", decidedByUid: "owner1", subAccountId: null });
    expect(mem.list("aiSuiteActions")).toEqual([expect.objectContaining({ subAccountId: "sa1", agentProposalId: id })]);
    expect(underNullSubAccount()).toEqual([]);
  });

  it("the target's gate flipped since it was proposed → 409 preview_changed, nothing written; approvable once re-reviewed", async () => {
    const id = await proposeGate("sa1", "broadcasts", true);
    const rev = row(id).rev;
    mem.seed("subAccounts/sa1", { ...subDoc("sa1"), broadcastsEnabledByAgency: true });
    const res = await decideAgency(id, "approve");
    const body = await res.json();
    expect([res.status, body.error]).toEqual([409, "preview_changed"]);
    expect(body.rev).not.toBe(rev);
    expect(row(id)).toMatchObject({ status: "pending", rev: body.rev });
    expect(gateAudits()).toEqual([]);
    expect((await decideAgency(id, "approve", body.rev)).status).toBe(200);
  });

  it("the target's agent-api gate went off → 403, pending, nothing read or written under subAccounts/null", async () => {
    const id = await proposeGate("sa1", "broadcasts", true);
    mem.seed("subAccounts/sa1", { ...subDoc("sa1"), agentApiEnabledByAgency: false });
    const paths: string[] = [];
    const orig = mem.db.doc.bind(mem.db);
    vi.spyOn(mem.db, "doc").mockImplementation((p: string) => (paths.push(p), orig(p)));
    const res = await decideAgency(id, "approve");
    expect([res.status, await res.json()]).toEqual([403, { error: "Agent API access is disabled for this sub-account." }]);
    expect(row(id)).toMatchObject({ status: "pending", claimId: null });
    expect(subDoc("sa1").broadcastsEnabledByAgency).toBe(false);
    expect(paths.filter((p) => p.startsWith("subAccounts/null"))).toEqual([]);
    expect(underNullSubAccount()).toEqual([]);
  });

  it("a row with no target at all → 404, never reads subAccounts/null", async () => {
    const id = await proposeGate("sa1", "broadcasts", true);
    const { targetSubAccountId: _t, ...noTarget } = row(id);
    mem.seed(`agentProposals/${id}`, noTarget);
    const paths: string[] = [];
    const orig = mem.db.doc.bind(mem.db);
    vi.spyOn(mem.db, "doc").mockImplementation((p: string) => (paths.push(p), orig(p)));
    expect((await decideAgency(id, "approve")).status).toBe(404);
    expect(paths.filter((p) => p.startsWith("subAccounts/null"))).toEqual([]);
  });
});

describe("one identical 404", () => {
  it("another agency's owner, a sub-account key's row and an unknown id get the same body", async () => {
    const agencyRow = await proposeGate();
    const { proposeId } = await import("@/test/agent-proposals-harness");
    const subKeyRow = await proposeId({ body: "v1" });
    const bodies: unknown[] = [];
    for (const [id, agencyId] of [[agencyRow, "ag2"], [subKeyRow, "ag1"], ["p_unknown", "ag1"], ["a/b", "ag1"]] as const) {
      owner.agencyId = agencyId;
      const res = await decideAgency(id, "approve", mem.read(`agentProposals/${id}`)?.rev ?? "r1");
      expect(res.status, id).toBe(404);
      bodies.push(await res.json());
    }
    expect(bodies).toEqual([NOT_FOUND, NOT_FOUND, NOT_FOUND, NOT_FOUND]);
    owner.agencyId = "ag2";
    expect((await decideAgency(agencyRow, "reject")).status).toBe(404);
    expect(row(agencyRow).status).toBe("pending");
    expect(row(subKeyRow).status).toBe("pending");
  });

  it("not an agency owner → 403, nothing decided", async () => {
    const id = await proposeGate();
    owner.role = "member";
    expect((await decideAgency(id, "reject")).status).toBe(403);
    expect(row(id).status).toBe("pending");
  });
});

describe("refusals", () => {
  it("expired → 409, the row expired, nothing run", async () => {
    const id = await proposeGate();
    mem.seed(`agentProposals/${id}`, { ...row(id), expiresAt: new Date(Date.now() - 1000) });
    const res = await decideAgency(id, "approve");
    expect([res.status, await res.json()]).toEqual([409, { error: "expired" }]);
    expect(row(id).status).toBe("expired");
    expect(subDoc("sa1").broadcastsEnabledByAgency).toBe(false);
  });

  it("the agency's switch off → 403 on approve; reject still allowed", async () => {
    const id = await proposeGate();
    mem.seed("agencies/ag1", { agentApiEnabled: false });
    const res = await decideAgency(id, "approve");
    expect([res.status, await res.json()]).toEqual([403, { error: "The Agent API is switched off for this agency." }]);
    expect(row(id).status).toBe("pending");
    const rejected = await decideAgency(id, "reject", undefined);
    expect([rejected.status, await rejected.json()]).toEqual([200, { status: "rejected" }]);
    expect(row(id)).toMatchObject({ status: "rejected", reason: "rejected_by_approver", decidedByUid: "owner1" });
    expect(subDoc("sa1").broadcastsEnabledByAgency).toBe(false);
  });

  it("two concurrent approves → executed once: one 200, one 409", async () => {
    const id = await proposeScoped("sa1", "once");
    const rev = row(id).rev;
    const [a, b] = await Promise.all([decideAgency(id, "approve", rev), decideAgency(id, "approve", rev)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(row(id).status).toBe("executed");
  });

  it("two concurrent gate_change approves → one gate write, one audit row", async () => {
    const id = await proposeGate();
    const rev = row(id).rev;
    const [a, b] = await Promise.all([decideAgency(id, "approve", rev), decideAgency(id, "approve", rev)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(gateAudits()).toHaveLength(1);
  });
});

describe("a sub-account-scoped agency-key row decided here", () => {
  it("executes exactly as on /sa/[id]/approvals: the approver's ctx in the target, pinned values, audit under the target", async () => {
    const id = await proposeScoped("sa2", "hello");
    expect(row(id)).toMatchObject({ subAccountId: "sa2", keyLevel: "agency" });
    const res = await decideAgency(id, "approve");
    expect(res.status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
    const [ctx, args] = execute.mock.calls[0]!;
    expect(ctx).toMatchObject({
      uid: "owner1", agencyId: "ag1", subAccountId: "sa2", subAccountRole: "agencyOwner",
      approved: { pinned: { body: "hello" }, proposalId: id },
    });
    expect(args).toMatchObject({ body: "hello" });
    expect(mem.list("aiSuiteActions")).toEqual([expect.objectContaining({ subAccountId: "sa2", confirmedByUid: "owner1" })]);
  });

  it("an unknown decision or a missing rev is refused before anything is read", async () => {
    const id = await proposeScoped();
    expect((await decideAgency(id, "explode")).status).toBe(400);
    expect((await decideAgency(id, "approve", "")).status).toBe(400);
    expect(row(id).status).toBe("pending");
  });
});
