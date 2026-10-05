import { describe, expect, it, vi } from "vitest";
import {
  auth, beforeNextTransaction, caller, claim, contactTarget, decide, execute, mem, outbound, proposeId, row,
  setupAgentProposalTests,
} from "@/test/agent-proposals-harness";
import type { AgencyApiAuthContext } from "@/lib/api/auth";

/**
 * The approve checks (agent-approval-checks.ts), early and in the claim
 * (A3b follow-ups breaker round): the claim re-checks territory and expiry
 * as well as `approvalRefusal`; the early `approvalRefusal` answers before
 * any preview refresh writes the row; the check order (key before args
 * validation) is pinned; and the breaker's controls hold.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();

const KEY1 = "subAccounts/sa1/apiKeys/key1";
const revokeKey1 = () => mem.seed(KEY1, { ...mem.read(KEY1)!, revokedAt: new Date() });
const agencyKey: AgencyApiAuthContext = { ...auth, level: "agency", subAccountId: null, keyLevel: "agency", keyId: "ak1" };
const seedAgency = () => {
  mem.seed("agencies/ag1", { agentApiEnabled: true });
  mem.seed("agencies/ag1/agencyMembers/owner1", { role: "owner", status: "active" });
  mem.seed("agencies/ag1/apiKeys/ak1", { agencyId: "ag1", subAccountId: null, prefix: "abcd1234", createdByUid: "owner1", revokedAt: null });
};

describe("F1: the claim re-checks territory and expiry", () => {
  it("territory: the target contact moves out of the approver's scope between the checks and the claim → 403, pending, not executed", async () => {
    outbound.approvalTarget = contactTarget("recipientId");
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), territoryScopingEnabled: true });
    mem.seed("subAccounts/sa1/subAccountMembers/u_admin", { role: "collaborator", assignedTerritoryIds: ["north"] });
    mem.seed("contacts/c1", { agencyId: "ag1", subAccountId: "sa1", territoryId: "north" });
    const id = await proposeId({ body: "x", recipientId: "c1" });
    caller.role = "collaborator";
    // What the territory route's cascade does: contact + row territoryId, no rev bump.
    beforeNextTransaction(async () => {
      mem.seed("contacts/c1", { ...mem.read("contacts/c1")!, territoryId: "south" });
      mem.seed(`agentProposals/${id}`, { ...row(id), territoryId: "south" });
    });
    const res = await decide(id, "approve");
    expect([res.status, await res.json()]).toEqual([403, { error: "That record isn't in one of your assigned territories." }]);
    expect(row(id)).toMatchObject({ status: "pending", claimId: null });
    expect(execute).not.toHaveBeenCalled();
  });

  it("expiry: the row expires between the checks and the claim → 409 expired, the row expired, not executed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const id = await proposeId();
    const exp = Date.now() + 1000;
    mem.seed(`agentProposals/${id}`, { ...row(id), expiresAt: new Date(exp) });
    beforeNextTransaction(async () => vi.setSystemTime(exp + 1000));
    const res = await decide(id, "approve");
    expect([res.status, await res.json()]).toEqual([409, { error: "expired" }]);
    expect(row(id)).toMatchObject({ status: "expired", claimId: null });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("the early approvalRefusal answers before a changed preview is stored", () => {
  const changePreview = () => {
    outbound.preview = async (_ctx, args) => ({
      rows: [{ label: "Body", value: "changed since" }],
      pinned: { body: String(args.body) },
    });
  };

  it("gate off + preview changed → 403, the row not rewritten", async () => {
    const id = await proposeId();
    const before = row(id);
    changePreview();
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, agentApiEnabledByAgency: false });
    const res = await decide(id, "approve");
    expect([res.status, await res.json()]).toEqual([403, { error: "Agent API access is disabled for this sub-account." }]);
    expect(row(id)).toEqual(before);
  });

  it("key revoked + preview changed → 409 key_revoked, the row rejected, never refreshed", async () => {
    const id = await proposeId();
    const rev = row(id).rev;
    changePreview();
    revokeKey1();
    const res = await decide(id, "approve");
    expect([res.status, await res.json()]).toEqual([409, { error: "key_revoked" }]);
    expect(row(id)).toMatchObject({ status: "rejected", reason: "key_revoked", rev });
  });
});

describe("F2: check order — the key is checked before the capability's args (since 3e4841f1)", () => {
  it("revoked key + args that no longer validate → 409 key_revoked, the row rejected (68f0bd01 answered 400, pending)", async () => {
    const id = await proposeId();
    outbound.validate = () => ({ ok: false, error: "nope" });
    revokeKey1();
    const res = await decide(id, "approve");
    expect([res.status, await res.json()]).toEqual([409, { error: "key_revoked" }]);
    expect(row(id)).toMatchObject({ status: "rejected", reason: "key_revoked" });
  });
});

describe("controls", () => {
  it("two approvers: A claims, key revoked, B's claim → conflict, row stays A's", async () => {
    const id = await proposeId();
    const a = await claim(id, "u_a");
    expect(a).toHaveProperty("claimId");
    revokeKey1();
    expect(await claim(id, "u_b")).toBe("conflict");
    expect(row(id)).toMatchObject({ status: "executing", decidedByUid: "u_a" });
  });

  it("approve racing reject: reject lands before the claim → 409 already_decided, reason kept", async () => {
    const id = await proposeId();
    beforeNextTransaction(async () => decide(id, "reject"));
    const res = await decide(id, "approve");
    expect([res.status, await res.json()]).toEqual([409, { error: "already_decided" }]);
    expect(row(id)).toMatchObject({ status: "rejected", reason: "rejected_by_approver" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("revoke races claim with a stale rev: stale wins, row NOT rejected by the claim", async () => {
    const id = await proposeId();
    const oldRev = row(id).rev as string;
    mem.seed(`agentProposals/${id}`, { ...row(id), rev: "newer" });
    revokeKey1();
    const { claimProposal } = await import("@/lib/server/agent-proposals");
    expect(await claimProposal(id, { uid: "u", email: "" }, oldRev, { enforce: false, ids: null })).toBe("stale");
    expect(row(id).status).toBe("pending");
  });

  it("legacy row with no keyLevel: treated as a sub-account key; revoke still refuses the claim", async () => {
    const id = await proposeId();
    const { keyLevel: _k, ...legacy } = row(id);
    mem.seed(`agentProposals/${id}`, legacy);
    beforeNextTransaction(async () => revokeKey1());
    expect((await decide(id, "approve")).status).toBe(409);
    expect(row(id)).toMatchObject({ status: "rejected", reason: "key_revoked" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("refused claim (gate off) mutates nothing on the row", async () => {
    const id = await proposeId();
    const before = row(id);
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, apiAccessEnabledByAgency: false });
    expect(await claim(id)).toBe("gate_off");
    expect(row(id)).toEqual(before);
  });

  it("agency row in a moved sub-account: never reads the other agency's key (404 before any key read)", async () => {
    seedAgency();
    const r = await (await import("@/lib/api/agent-dispatch")).dispatchAgentTool(agencyKey, "__test_outbound", { subAccountId: "sa1", body: "hi" });
    if (!("proposal" in r)) throw new Error(JSON.stringify(r));
    const id = r.proposal.id;
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, agencyId: "ag2" });
    const paths: string[] = [];
    const orig = mem.db.doc.bind(mem.db);
    vi.spyOn(mem.db, "doc").mockImplementation((p: string) => (paths.push(p), orig(p)));
    expect((await decide(id, "approve")).status).toBe(404);
    expect(paths.filter((p) => p.startsWith("agencies/"))).toEqual([]);
  });
});
