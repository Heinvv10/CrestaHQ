import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, beforeNextTransaction, decide, execute, mem, outbound, proposeId, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import { agencyKey, decideAgency, listAgency, proposeScoped, seedAgency } from "@/test/agency-approvals-harness";

/**
 * A row's generation (`gen`, A5): set by createProposal for each new pending
 * generation (first proposal, or a rollover of a terminal, expired or
 * superseded row) and never changed by a preview refresh, which only bumps
 * `rev`. A card sends the `gen` it shows; a decision naming a different one
 * is 409 `stale_proposal`, so a stale card cannot reject a different key's
 * generation it never saw. Reject still ignores `rev` (F4), and a decision
 * without `gen` behaves as before.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agency-approvals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
beforeEach(seedAgency);

const ak1 = "agencies/ag1/apiKeys/ak1";
const revokeAk1 = () => mem.seed(ak1, { ...mem.read(ak1)!, revokedAt: new Date() });
const gate = { subAccountId: "sa1", gate: "broadcasts", enabled: true };

describe("a stale card cannot reject a different key's generation", () => {
  it("agency route: the owner's ak1 card, after another owner's ak2 superseded it → 409, ak2's row stays pending", async () => {
    mem.seed("agencies/ag1/agencyMembers/owner2", { role: "owner", status: "active" });
    mem.seed("agencies/ag1/apiKeys/ak2", { agencyId: "ag1", subAccountId: null, prefix: "agcy5678", createdByUid: "owner2", revokedAt: null });
    const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");
    const first = await dispatchAgentTool(agencyKey, "set_sub_account_gate", gate);
    const id = (first as { proposal: { id: string } }).proposal.id;
    const seen = row(id);
    // ak1's minter is no longer an owner: its row is frozen.
    mem.seed("agencies/ag1/agencyMembers/owner1", { role: "member", status: "active" });
    await dispatchAgentTool({ ...agencyKey, keyId: "ak2", keyPrefix: "agcy5678" }, "set_sub_account_gate", gate);
    expect(row(id)).toMatchObject({ keyId: "ak2", status: "pending" });
    expect(row(id).gen).not.toBe(seen.gen);
    const res = await decideAgency(id, "reject", seen.rev, { gen: seen.gen });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "stale_proposal" });
    expect(row(id)).toMatchObject({ keyId: "ak2", status: "pending" });
  });

  it("sub-account route: an ak1 card after sa1's own key superseded it → 409, key1's row stays pending", async () => {
    const id = await proposeScoped("sa1", "hi");
    const seen = row(id);
    revokeAk1();
    await proposeId({ body: "hi" }, auth);
    expect(row(id)).toMatchObject({ keyId: "key1", status: "pending" });
    expect((await decide(id, "reject", "sa1", seen.rev, { gen: seen.gen })).status).toBe(409);
    expect(row(id)).toMatchObject({ keyId: "key1", status: "pending" });
  });

  it("a supersede landing between the route's read and the reject's transition → 409", async () => {
    const id = await proposeScoped("sa1", "hi");
    const seen = row(id);
    revokeAk1();
    beforeNextTransaction(() => proposeId({ body: "hi" }, auth));
    expect((await decide(id, "reject", "sa1", seen.rev, { gen: seen.gen })).status).toBe(409);
    expect(row(id)).toMatchObject({ keyId: "key1", status: "pending" });
  });

  it("approve naming another generation → 409 even with the current rev; nothing runs", async () => {
    const id = await proposeId({ body: "hi" }, auth);
    const res = await decide(id, "approve", "sa1", row(id).rev, { gen: "someone-elses" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "stale_proposal" });
    expect(row(id).status).toBe("pending");
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("one generation across a preview refresh", () => {
  it("refresh bumps rev but not gen, and a reject naming that gen and the old rev lands", async () => {
    let suffix = "";
    outbound.preview = async (_ctx, args) => ({
      rows: [{ label: "Body", value: `${String(args.body)}${suffix}` }],
      pinned: { body: `${String(args.body)}${suffix}` },
    });
    const id = await proposeId({ body: "hi" }, auth);
    const seen = row(id);
    expect(typeof seen.gen).toBe("string");
    suffix = "!";
    expect((await decide(id, "approve", "sa1", seen.rev, { gen: seen.gen })).status).toBe(409);
    expect(row(id).rev).not.toBe(seen.rev);
    expect(row(id).gen).toBe(seen.gen);
    expect((await decide(id, "reject", "sa1", seen.rev, { gen: seen.gen })).status).toBe(200);
    expect(row(id).status).toBe("rejected");
  });

  it("a terminal row re-proposed is a new generation", async () => {
    const id = await proposeId({ body: "hi" }, auth);
    const first = row(id).gen;
    expect((await decide(id, "reject")).status).toBe(200);
    await proposeId({ body: "hi" }, auth);
    expect(row(id)).toMatchObject({ status: "pending" });
    expect(row(id).gen).not.toBe(first);
  });
});

describe("the wire", () => {
  it("gen that is not a non-empty string → 400", async () => {
    const id = await proposeId({ body: "hi" }, auth);
    for (const gen of [42, ""]) {
      expect((await decide(id, "reject", "sa1", row(id).rev, { gen })).status).toBe(400);
    }
    expect(row(id).status).toBe("pending");
  });

  it("the agency list route sends each row's gen", async () => {
    const id = await proposeScoped("sa1", "hi");
    const { proposals } = (await (await listAgency("open")).json()) as { proposals: Array<{ id: string; gen?: string }> };
    expect(typeof row(id).gen).toBe("string");
    expect(proposals.find((p) => p.id === id)?.gen).toBe(row(id).gen);
  });
});
