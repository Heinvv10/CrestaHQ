import { beforeEach, describe, expect, it, vi } from "vitest";
import { mem, proposeId, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import { listAgency, owner, proposeGate, proposeScoped, seedAgency } from "@/test/agency-approvals-harness";

/**
 * GET /api/agency/agent-proposals (A5): the agency owner's queue — every row
 * an agency key of THEIR agency queued (`agencyId == mine ∧ keyLevel ==
 * "agency"`), agency-level or sub-account-scoped, each with its target's name
 * and whether that target is one the proposing key created (the batch rule).
 * Never a sub-account key's row, never another agency's, never `pinned`.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agency-approvals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
beforeEach(seedAgency);

type View = Record<string, unknown> & { id: string };
const list = async (status: string | null = "open") => {
  const res = await listAgency(status);
  return { status: res.status, body: (await res.json()) as { proposals?: View[]; error?: string } };
};

describe("what the owner sees", () => {
  it("their agency key's rows of both kinds, with target and key-created flag; not a v1 key's, not another agency's", async () => {
    const gate = await proposeGate("sa1");
    const scoped = await proposeScoped("sa2", "scoped");
    await proposeId({ body: "v1 key" });
    mem.seed("agentProposals/p_other", {
      agencyId: "ag2", subAccountId: null, targetSubAccountId: "sb1", keyLevel: "agency", status: "pending",
      createdAt: new Date(), summary: "theirs", preview: [],
    });
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(body.proposals!.map((p) => p.id).sort()).toEqual([gate, scoped].sort());
    const byId = Object.fromEntries(body.proposals!.map((p) => [p.id, p]));
    expect(byId[gate]).toMatchObject({ targetSubAccountId: "sa1", targetName: "Client One", keyCreated: false, approval: "gate_change" });
    expect(byId[scoped]).toMatchObject({ targetSubAccountId: "sa2", targetName: "Client Two", keyCreated: false });
    for (const p of body.proposals!) expect(p).not.toHaveProperty("pinned");
  });

  it("keyCreated: the row's own key made the target < 72 h ago and it has no contacts", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, createdByKeyId: "ak1", createdAt: new Date() });
    const id = await proposeScoped("sa1", "kc");
    const first = await list();
    expect(first.body.proposals!.find((p) => p.id === id)).toMatchObject({ keyCreated: true });
    mem.seed("contacts/c1", { agencyId: "ag1", subAccountId: "sa1", name: "Ann" });
    const second = await list();
    expect(second.body.proposals!.find((p) => p.id === id)).toMatchObject({ keyCreated: false });
  });

  it("a row whose target sits in another agency is left out (its name never leaves)", async () => {
    const id = await proposeGate("sa1");
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, agencyId: "ag2" });
    expect((await list()).body.proposals!.map((p) => p.id)).not.toContain(id);
  });

  it("recent = the decided rows", async () => {
    const id = await proposeGate("sa1");
    mem.seed(`agentProposals/${id}`, { ...mem.read(`agentProposals/${id}`)!, status: "rejected" });
    expect((await list("open")).body.proposals).toEqual([]);
    expect((await list("recent")).body.proposals!.map((p) => p.id)).toEqual([id]);
  });
});

describe("refusals", () => {
  it("not an agency owner → 403", async () => {
    owner.role = "member";
    expect((await list()).status).toBe(403);
  });

  it.each([null, "bogus"])("status %s → 400", async (s) => {
    expect((await list(s)).status).toBe(400);
  });
});
