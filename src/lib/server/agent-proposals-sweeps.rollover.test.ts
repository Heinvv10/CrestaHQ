import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, beforeNextTransaction, history, later, mem, proposeId, row, setupAgentProposalTests, sweep } from "@/test/agent-proposals-harness";
import { proposeScoped, seedAgency } from "@/test/agency-approvals-harness";

/**
 * The sweeps against a rollover (A5): each sweep queries its rows, then moves
 * them one transaction at a time. A different key re-proposing in between
 * rolls the row over to a fresh pending generation (superseded or expired
 * into history); the sweep must leave that generation alone, so its move is
 * guarded by the `rev` it queried.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agency-approvals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
beforeEach(seedAgency);

describe("the revoke sweep", () => {
  it("a supersede landing between its query and its transition leaves the new key's generation pending", async () => {
    const id = await proposeScoped("sa1", "hi"); // agency key ak1's row in sa1
    const ak1 = "agencies/ag1/apiKeys/ak1";
    mem.seed(ak1, { ...mem.read(ak1)!, revokedAt: new Date() }); // revokeApiKey's write, before its hook
    // sa1's own live key re-proposes the identical action while the sweep is mid-loop.
    beforeNextTransaction(() => proposeId({ body: "hi" }, auth));
    const { sweepRevokedKeyProposals } = await import("@/lib/server/agent-proposals-sweeps");
    expect(await sweepRevokedKeyProposals({ keyRef: mem.db.doc(ak1) })).toBe(0);
    expect(history(id)).toEqual([expect.objectContaining({ status: "superseded", keyId: "ak1" })]);
    expect(row(id)).toMatchObject({ keyId: "key1", status: "pending" });
  });

  it("with no rollover it still rejects the revoked key's row", async () => {
    const id = await proposeScoped("sa1", "hi");
    const ak1 = "agencies/ag1/apiKeys/ak1";
    mem.seed(ak1, { ...mem.read(ak1)!, revokedAt: new Date() });
    const { sweepRevokedKeyProposals } = await import("@/lib/server/agent-proposals-sweeps");
    expect(await sweepRevokedKeyProposals({ keyRef: mem.db.doc(ak1) })).toBe(1);
    expect(row(id)).toMatchObject({ status: "rejected", reason: "key_revoked" });
  });
});

describe("the expiry sweep", () => {
  it("an expired-row rollover landing between its query and its transition leaves the fresh generation pending", async () => {
    const id = await proposeId({ body: "hi" }, auth);
    mem.seed(`agentProposals/${id}`, { ...row(id), expiresAt: new Date(Date.now() - 1000) });
    const oldRev = row(id).rev;
    beforeNextTransaction(() => proposeId({ body: "hi" }, auth));
    await sweep(later(0));
    expect(history(id)).toEqual([expect.objectContaining({ status: "expired", rev: oldRev })]);
    expect(row(id).status).toBe("pending");
    expect(row(id).rev).not.toBe(oldRev);
  });

  it("with no rollover it still expires the row", async () => {
    const id = await proposeId({ body: "hi" }, auth);
    mem.seed(`agentProposals/${id}`, { ...row(id), expiresAt: new Date(Date.now() - 1000) });
    await sweep(later(0));
    expect(row(id).status).toBe("expired");
  });
});
