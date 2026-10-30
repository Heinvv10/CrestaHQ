import { beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilityUserError } from "@/lib/ai-suite/capabilities";
import {
  auth, beforeNextTransaction, decide, execute, mem, outbound, propose, proposeId, revoke, row,
  setupAgentProposalTests,
} from "@/test/agent-proposals-harness";

/**
 * Row generations (rev), revoked keys and what the approver reviewed: a
 * decision acts on the generation the approver saw, never on a newer one,
 * and execute acts on the reviewed target, never on one nobody saw.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

await setupAgentProposalTests();
const post = async (id: string, body: Record<string, unknown>) => {
  const { POST } = await import("./route");
  return POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: "sa1", proposalId: id }),
  });
};

describe("R1: row generations", () => {
  it("approve with the rev from before a reject + re-propose → 409 stale_proposal, execute 0", async () => {
    const id = await proposeId();
    const oldRev = row(id).rev;
    await decide(id, "reject");
    await proposeId();
    expect(row(id).rev).not.toBe(oldRev);
    const res = await decide(id, "approve", "sa1", oldRev);
    expect(await res.json()).toEqual({ error: "stale_proposal" });
    expect(row(id).status).toBe("pending");
    expect(execute).not.toHaveBeenCalled();
  });

  it("a double-click after executed + a re-propose does not run the new generation", async () => {
    const id = await proposeId();
    const rev1 = row(id).rev;
    expect((await decide(id, "approve", "sa1", rev1)).status).toBe(200);
    await proposeId();
    expect((await decide(id, "approve", "sa1", rev1)).status).toBe(409);
    expect(row(id).status).toBe("pending");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("approve and mark_* require a rev; reject does not (refusing is always safe)", async () => {
    const id = await proposeId();
    for (const decision of ["approve", "mark_sent", "mark_not_sent"]) {
      expect((await post(id, { decision })).status).toBe(400);
    }
    expect(row(id).status).toBe("pending");
    expect((await post(id, { decision: "reject" })).status).toBe(200);
    expect(row(id).status).toBe("rejected");
  });
});

describe("H1: one action, one row — across keys", () => {
  const key2 = { ...auth, keyId: "key2", keyPrefix: "efgh5678" };

  it("key2 proposing an action key1 left unsettled → outcome_unknown; execute stays 1", async () => {
    const id = await proposeId();
    await decide(id, "approve");
    expect(execute).toHaveBeenCalledTimes(1);
    mem.seed(`agentProposals/${id}`, { ...row(id), status: "unsettled" });
    expect(await propose({ body: "hi" }, key2)).toMatchObject({ ok: false, code: "outcome_unknown" });
    expect(row(id).status).toBe("unsettled");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("a pending row from key1 re-proposed by key2 is the same row, still stamped key1", async () => {
    const id = await proposeId();
    expect(await proposeId({ body: "hi" }, key2)).toBe(id);
    expect(row(id)).toMatchObject({ keyId: "key1", keyPrefix: "abcd1234", status: "pending" });
    expect(mem.list("agentProposals")).toHaveLength(1);
  });

  it("key1 revoked → its pending row is rejected; key2's re-propose is a fresh generation stamped key2 that keeps priorAttemptSent", async () => {
    const id = await proposeId();
    mem.seed(`agentProposals/${id}`, { ...row(id), priorAttemptSent: { claimId: "c0" } });
    await revoke("key1");
    expect(row(id)).toMatchObject({ status: "rejected", reason: "key_revoked" });
    expect(await proposeId({ body: "hi" }, key2)).toBe(id);
    expect(row(id)).toMatchObject({ status: "pending", keyId: "key2", keyPrefix: "efgh5678", priorAttemptSent: { claimId: "c0" } });
    expect((await decide(id, "approve")).status).toBe(409);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("R2: revoked keys", () => {
  it("a key revoked after the row was written (sweep missed it) → approve rejects the row, 409", async () => {
    const id = await proposeId();
    mem.seed("subAccounts/sa1/apiKeys/key1", { ...mem.read("subAccounts/sa1/apiKeys/key1"), revokedAt: new Date() });
    expect(await (await decide(id, "approve")).json()).toEqual({ error: "key_revoked" });
    expect(row(id)).toMatchObject({ status: "rejected", reason: "key_revoked" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("a revoke whose sweep throws still returns 200 and logs; the row stays unapprovable", async () => {
    const id = await proposeId();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const collection = mem.db.collection.bind(mem.db);
    vi.spyOn(mem.db, "collection").mockImplementation((name: string) => {
      if (name === "agentProposals") throw new Error("index missing");
      return collection(name);
    });
    const res = await revoke();
    vi.mocked(mem.db.collection).mockRestore();
    expect(res.status).toBe(200);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("revoke hook failed"));
    expect(row(id).status).toBe("pending");
    expect((await decide(id, "approve")).status).toBe(409);
    expect(execute).not.toHaveBeenCalled();
  });

  it("a proposal attempted after the key was revoked is refused and queues nothing", async () => {
    await revoke();
    expect(await propose()).toMatchObject({ ok: false, code: "key_revoked" });
    expect(mem.list("agentProposals")).toEqual([]);
  });
});

describe("what the approver reviewed", () => {
  const phone = () => String(mem.read("contacts/c1")?.phone);
  const setPhone = (p: string) => mem.seed("contacts/c1", { ...mem.read("contacts/c1"), phone: p });
  beforeEach(() => {
    mem.seed("contacts/c1", { agencyId: "ag1", subAccountId: "sa1", name: "Ann", phone: "+27 11 111 1111" });
    outbound.preview = async () => ({ rows: [{ label: "To", value: phone() }], pinned: { to: phone() } });
    execute.mockImplementation(async () => ({ resultText: `sent to ${phone()}`, ref: { kind: "message", id: "m1" } }));
  });

  it("R4: a changed preview → 409 preview_changed with the new rev; approving that sends to what it shows", async () => {
    const id = await proposeId();
    const oldRev = row(id).rev;
    setPhone("+27 22 222 2222");
    const res = await decide(id, "approve", "sa1", oldRev);
    const body = (await res.json()) as { error: string; rev: string };
    expect(res.status).toBe(409);
    expect(body.error).toBe("preview_changed");
    expect(execute).not.toHaveBeenCalled();
    expect(row(id)).toMatchObject({ status: "pending", rev: body.rev, preview: [{ label: "To", value: "+27 22 222 2222" }] });
    expect(body.rev).not.toBe(oldRev);
    expect(await (await decide(id, "approve", "sa1", body.rev)).json()).toEqual({
      status: "executed",
      resultText: "sent to +27 22 222 2222",
    });
  });

  it("F4: re-proposing never bumps rev, and a reject from a page the agent outran still lands", async () => {
    const id = await proposeId();
    const pageRev = row(id).rev;
    setPhone("+27 33 333 3333");
    for (let i = 0; i < 3; i++) await proposeId();
    expect(row(id).rev).toBe(pageRev);
    const refreshed = (await (await decide(id, "approve", "sa1", pageRev)).json()) as { rev: string };
    expect(refreshed.rev).not.toBe(pageRev);
    expect((await decide(id, "reject", "sa1", pageRev)).status).toBe(200);
    expect(row(id).status).toBe("rejected");
    expect(execute).not.toHaveBeenCalled();
  });

  it("F2/F3: preview runs under the same neutral ctx at propose and approve, so the approver cannot change it", async () => {
    outbound.preview = async (ctx) => ({
      rows: [{ label: "Seen by", value: `${ctx.uid}|${ctx.email}|${ctx.subAccountRole ?? "-"}` }],
      pinned: { to: "x" },
    });
    const id = await proposeId();
    expect(row(id).preview).toEqual([{ label: "Seen by", value: "preview||admin" }]);
    expect((await decide(id, "approve")).status).toBe(200);
  });

  it("a preview that can no longer be built → 409 preview_unavailable, row pending; anything else → 500 logged", async () => {
    const id = await proposeId();
    outbound.preview = async () => {
      throw new CapabilityUserError("That contact no longer exists.");
    };
    const res = await decide(id, "approve");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "preview_unavailable", message: "That contact no longer exists." });
    expect(row(id).status).toBe("pending");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    outbound.preview = async () => {
      throw new Error("firestore down: secret detail");
    };
    const crash = await decide(id, "approve");
    expect(crash.status).toBe(500);
    expect(JSON.stringify(await crash.json())).not.toContain("secret detail");
    expect(logged).toHaveBeenCalled();
    expect(row(id).status).toBe("pending");
    expect(execute).not.toHaveBeenCalled();
  });

  it("G6: an outbound preview that stops pinning at approve → 500 logged, row pending, execute 0", async () => {
    const id = await proposeId();
    outbound.preview = async () => [{ label: "To", value: phone() }];
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await decide(id, "approve")).status).toBe(500);
    expect(logged).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: expect.stringContaining("pins nothing") }));
    expect(row(id).status).toBe("pending");
    expect(execute).not.toHaveBeenCalled();
  });

  describe("F1: pinned targets", () => {
    const sentTo: string[] = [];
    beforeEach(() => {
      sentTo.length = 0;
      outbound.preview = async () => ({ rows: [{ label: "To", value: phone() }], pinned: { to: phone() } });
      execute.mockImplementation(async (ctx) => {
        const to = ctx.approved?.pinned?.to;
        if (to !== phone()) throw new CapabilityUserError("The recipient changed since it was approved.");
        sentTo.push(String(to));
        return { resultText: `sent to ${String(to)}`, ref: { kind: "message", id: "m1" } };
      });
    });

    it("pinned values are stored and handed to execute", async () => {
      const id = await proposeId();
      expect(row(id).pinned).toEqual({ to: "+27 11 111 1111" });
      expect((await decide(id, "approve")).status).toBe(200);
      expect(execute.mock.calls[0]![0].approved).toEqual({
        pinned: { to: "+27 11 111 1111" }, keyPrefix: "abcd1234", proposalId: id, claimId: row(id).claimId,
      });
      expect(sentTo).toEqual(["+27 11 111 1111"]);
    });

    it("M1: only the pinned value changed (rows identical) → 409 preview_changed, execute 0", async () => {
      // Rows show a masked number; pinned carries the full one.
      outbound.preview = async () => ({ rows: [{ label: "To", value: `Ann (…${phone().slice(-4)})` }], pinned: { to: phone() } });
      const id = await proposeId();
      setPhone("+27 55 555 1111"); // same last four digits → same rows
      const res = await decide(id, "approve");
      expect(await res.json()).toMatchObject({ error: "preview_changed" });
      expect(row(id)).toMatchObject({ status: "pending", pinned: { to: "+27 55 555 1111" } });
      expect(execute).not.toHaveBeenCalled();
    });

    it("the recipient changing between the recheck and execute never reaches the unreviewed number", async () => {
      const id = await proposeId();
      // The claim is the first transaction after the recheck.
      beforeNextTransaction(async () => setPhone("+27 99 999 9999"));
      const res = await decide(id, "approve");
      expect(res.status).toBe(422);
      expect(sentTo).not.toContain("+27 99 999 9999");
      expect(row(id)).toMatchObject({ status: "failed", error: "The recipient changed since it was approved." });
    });
  });
});
