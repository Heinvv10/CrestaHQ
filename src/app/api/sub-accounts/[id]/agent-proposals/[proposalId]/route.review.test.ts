import { describe, expect, it, vi } from "vitest";
import { millis } from "@/lib/server/agent-proposals-encoding";
import {
  beforeNextTransaction, caller, claim, contactTarget, decide, execute, history, later, mem, outbound, proposeId,
  revoke, row, setupAgentProposalTests, sweep,
} from "@/test/agent-proposals-harness";

/**
 * General-review findings on PR #259: the territory gate, explicit contact
 * targets, key re-checks, the stale-claim race, re-validation, the revoke
 * sweep's tenant skip, and expiry at approve.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();

describe("general review — PR #259", () => {
  it("M2 + L4: a scoped collaborator cannot approve or reject a proposal targeting another territory's contact", async () => {
    // The fixture names its target `recipientId`; approvalTarget says so.
    outbound.approvalTarget = contactTarget("recipientId");
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), territoryScopingEnabled: true });
    mem.seed("subAccounts/sa1/subAccountMembers/u_admin", { role: "collaborator", assignedTerritoryIds: ["north"] });
    mem.seed("contacts/c_south", { agencyId: "ag1", subAccountId: "sa1", territoryId: "south" });
    mem.seed("contacts/c_north", { agencyId: "ag1", subAccountId: "sa1", territoryId: "north" });
    const south = await proposeId({ body: "x", recipientId: "c_south" });
    const north = await proposeId({ body: "y", recipientId: "c_north" });
    expect(row(south).contactId).toBe("c_south");
    caller.role = "collaborator";
    expect((await decide(south, "approve")).status).toBe(403);
    expect((await decide(south, "reject")).status).toBe(403);
    expect(row(south).status).toBe("pending");
    expect((await decide(north, "approve")).status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("M3: a key already revoked before the proposal row existed is caught at approve (breaker 2b)", async () => {
    // Row written, then the key revoked with no sweep having run for it.
    const id = await proposeId();
    mem.seed("subAccounts/sa1/apiKeys/key1", { ...mem.read("subAccounts/sa1/apiKeys/key1"), revokedAt: new Date() });
    const again = await revoke();
    expect(await again.json()).toEqual({ ok: true, alreadyRevoked: true });
    expect(row(id).status).toBe("pending");
    expect((await decide(id, "approve")).status).toBe(409);
    expect(row(id)).toMatchObject({ status: "rejected", reason: "key_revoked" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("L1: a claim that replaced the stale one between the sweep's query and its write is not flipped", async () => {
    const id = await proposeId();
    await claim(id, "u_a");
    beforeNextTransaction(async () => {
      mem.seed(`agentProposals/${id}`, { ...row(id), claimId: "fresh_claim", claimedAt: new Date() });
    });
    await sweep(later(11 * 60_000));
    expect(row(id)).toMatchObject({ status: "executing", claimId: "fresh_claim" });
  });

  it("L2: stored args that no longer validate → 400 before the claim; execute 0, row stays pending", async () => {
    const id = await proposeId();
    outbound.validate = () => ({ ok: false, error: "body is too long" });
    const res = await decide(id, "approve");
    expect(res.status).toBe(400);
    expect(row(id).status).toBe("pending");
    expect(execute).not.toHaveBeenCalled();
  });

  it("L3: the revoke sweep skips a row with the same keyId in another sub-account", async () => {
    await proposeId();
    mem.seed("agentProposals/p_other_sa", { subAccountId: "sa2", keyId: "key1", status: "pending", rev: "r" });
    await revoke();
    expect(row("p_other_sa").status).toBe("pending");
  });

  it("L5: approving an expired pending row flips it to expired → 409 expired, execute 0", async () => {
    const id = await proposeId();
    mem.seed(`agentProposals/${id}`, { ...row(id), expiresAt: new Date(Date.now() - 1000) });
    const res = await decide(id, "approve");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "expired" });
    expect(row(id).status).toBe("expired");
    expect(execute).not.toHaveBeenCalled();
  });

  it("L5: re-proposing an expired pending row rolls it to history as expired and starts a fresh pending", async () => {
    const id = await proposeId();
    const oldRev = row(id).rev;
    mem.seed(`agentProposals/${id}`, { ...row(id), expiresAt: new Date(Date.now() - 1000) });
    await proposeId();
    expect(row(id).status).toBe("pending");
    expect(row(id).rev).not.toBe(oldRev);
    expect(millis(row(id).expiresAt)!).toBeGreaterThan(Date.now());
    expect(history(id)).toEqual([expect.objectContaining({ status: "expired", rev: oldRev })]);
  });

  it("a contact with no territory is outside every scoped collaborator's territories (matches the rules)", async () => {
    outbound.approvalTarget = contactTarget("recipientId");
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), territoryScopingEnabled: true });
    mem.seed("subAccounts/sa1/subAccountMembers/u_admin", { role: "collaborator", assignedTerritoryIds: ["north"] });
    mem.seed("contacts/c_untagged", { agencyId: "ag1", subAccountId: "sa1" });
    const id = await proposeId({ body: "x", recipientId: "c_untagged" });
    expect(row(id).territoryId).toBeNull();
    caller.role = "collaborator";
    expect((await decide(id, "approve")).status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });

  it("G4: a preview that uses the territory helpers works in a scoped sub-account", async () => {
    const { canSeeTerritory, territoryScopeFor } = await import("@/lib/ai-suite/territory-scope");
    const { CapabilityUserError } = await import("@/lib/ai-suite/capabilities");
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), territoryScopingEnabled: true });
    mem.seed("contacts/c_south", { agencyId: "ag1", subAccountId: "sa1", territoryId: "south", phone: "+27 1" });
    outbound.approvalTarget = contactTarget("recipientId");
    outbound.preview = async (ctx, args) => {
      const contact = mem.read(`contacts/${String(args.recipientId)}`);
      if (!canSeeTerritory(await territoryScopeFor(ctx), contact?.territoryId)) {
        throw new CapabilityUserError("That contact isn't in one of your assigned territories.");
      }
      return { rows: [{ label: "To", value: String(contact?.phone) }], pinned: { to: contact?.phone } };
    };
    const id = await proposeId({ body: "x", recipientId: "c_south" });
    expect((await decide(id, "approve")).status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("F10/H4: the row stores what approvalTarget resolved (under the neutral preview ctx)", async () => {
    const seen: string[] = [];
    outbound.approvalTarget = async (ctx, args) => {
      seen.push(`${ctx.uid}|${ctx.subAccountRole}`);
      return contactTarget("recipientId")(ctx, args);
    };
    mem.seed("contacts/c_south", { agencyId: "ag1", subAccountId: "sa1", territoryId: "south" });
    mem.seed("contacts/c_none", { agencyId: "ag1", subAccountId: "sa1" });
    expect(row(await proposeId({ body: "a", recipientId: "c_south" }))).toMatchObject({ contactId: "c_south", territoryId: "south", targetScoped: true });
    expect(row(await proposeId({ body: "b", recipientId: "c_none" }))).toMatchObject({ contactId: "c_none", territoryId: null, targetScoped: true });
    expect(seen).toEqual(["preview|admin", "preview|admin"]);
  });

  it("H4: a proposal targeting a deal (no contact) is scoped by the deal's territory — list excludes it, decide 403", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), territoryScopingEnabled: true });
    mem.seed("subAccounts/sa1/subAccountMembers/u_admin", { role: "collaborator", assignedTerritoryIds: ["north"] });
    mem.seed("deals/d_south", { agencyId: "ag1", subAccountId: "sa1", territoryId: "south" });
    outbound.approvalTarget = async (_ctx, args) => ({
      contactId: null,
      territoryId: (mem.read(`deals/${String(args.dealId)}`)?.territoryId as string) ?? null,
      scoped: true,
    });
    const id = await proposeId({ body: "x", dealId: "d_south" });
    expect(row(id)).toMatchObject({ contactId: null, territoryId: "south", targetScoped: true });
    caller.role = "collaborator";
    const { GET } = await import("../route");
    const listed = (await (await GET(new Request("http://localhost/x"), { params: Promise.resolve({ id: "sa1" }) })).json()) as {
      proposals: { id: string }[];
    };
    expect(listed.proposals.map((p) => p.id)).not.toContain(id);
    expect((await decide(id, "approve")).status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });
});
