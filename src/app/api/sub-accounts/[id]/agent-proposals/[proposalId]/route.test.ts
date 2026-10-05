import { describe, expect, it, vi } from "vitest";
import {
  ageClaim, auth, beforeNextTransaction, caller, claim, decide, execute, history, later, mem,
  outbound, propose, proposeId, revoke, row, setupAgentProposalTests, sweep,
} from "@/test/agent-proposals-harness";

/**
 * The agent approval queue's core paths: approve, reject, the pending-only
 * precondition, key revoke, re-proposing. Breaker / review rounds live in the
 * sibling route.*.test.ts files; all share src/test/agent-proposals-harness.ts.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
const STALE = later(11 * 60_000);

describe("approve", () => {
  it("runs the capability once, as the approver, and settles executed with an aiSuiteActions row", async () => {
    const id = await proposeId();
    const res = await decide(id, "approve");
    expect(res.status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ uid: "u_admin", email: "admin@x.io", subAccountId: "sa1" }),
      { body: "hi" }
    );
    expect(row(id)).toMatchObject({ status: "executed", decidedByUid: "u_admin", result: { resultText: "sent" } });
    expect(mem.list("aiSuiteActions")).toEqual([
      expect.objectContaining({ agentProposalId: id, status: "executed", confirmedByUid: "u_admin", subAccountId: "sa1" }),
    ]);
  });

  it("two concurrent approves → execute runs exactly once: one 200, one 409", async () => {
    const id = await proposeId();
    const statuses = (await Promise.all([decide(id, "approve"), decide(id, "approve")])).map((r) => r.status);
    expect(statuses.sort()).toEqual([200, 409]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("a proposal from another sub-account → 404, nothing runs", async () => {
    const id = await proposeId();
    expect((await decide(id, "approve", "sa2")).status).toBe(404);
    expect(row(id).status).toBe("pending");
    expect(execute).not.toHaveBeenCalled();
  });

  it("a caller whose role fails the capability's requiredRole → 403", async () => {
    outbound.requiredRole = "subAccountAdmin";
    const id = await proposeId();
    caller.role = "collaborator";
    expect((await decide(id, "approve")).status).toBe(403);
    expect((await decide(id, "reject")).status).toBe(403);
    expect(row(id).status).toBe("pending");
    expect(execute).not.toHaveBeenCalled();
  });

  it("hard_delete needs a sub-account admin even when the capability allows members", async () => {
    outbound.approval = "hard_delete";
    const id = await proposeId();
    caller.role = "collaborator";
    expect((await decide(id, "approve")).status).toBe(403);
    caller.role = "admin";
    expect((await decide(id, "approve")).status).toBe(200);
  });

  it.each(["agentApiEnabledByAgency", "apiAccessEnabledByAgency"])(
    "%s switched off since proposal → 403, row stays pending",
    async (gate) => {
      const id = await proposeId();
      mem.seed("subAccounts/sa1", { agencyId: "ag1", agentApiEnabledByAgency: true, apiAccessEnabledByAgency: true, [gate]: false });
      expect((await decide(id, "approve")).status).toBe(403);
      expect(row(id).status).toBe("pending");
      expect(execute).not.toHaveBeenCalled();
    }
  );

  it("a workflow_enrolment row replays the held trigger and never calls execute", async () => {
    const { replayHeldEnrolment } = await import("@/lib/server/agent-enrolment-replay");
    mem.seed("agentProposals/p_enrol", {
      agencyId: "ag1",
      subAccountId: "sa1",
      capability: "__test_outbound",
      approval: "workflow_enrolment",
      args: { workflowId: "wf1", contactId: "c1", triggerType: "contact.created" },
      summary: "Enrol Ann in Welcome",
      keyId: "key1",
      status: "pending",
      rev: "r1",
    });
    const res = await decide("p_enrol", "approve");
    expect(execute).not.toHaveBeenCalled();
    expect(replayHeldEnrolment).toHaveBeenCalledTimes(1);
    // No workflow wf1 exists here, so the real replay enrols nobody
    // (the happy path is src/lib/workflows/held-enrolment.test.ts).
    expect(res.status).toBe(422);
    expect(row("p_enrol")).toMatchObject({ status: "failed", error: expect.stringContaining("no longer active") });
  });
});

describe("reject and the pending-only precondition", () => {
  it("reject never executes, and a later approve is 409", async () => {
    const id = await proposeId();
    expect((await decide(id, "reject")).status).toBe(200);
    expect(row(id)).toMatchObject({ status: "rejected", reason: "rejected_by_approver" });
    expect((await decide(id, "approve")).status).toBe(409);
    expect(execute).not.toHaveBeenCalled();
  });

  it("a reject landing after a concurrent claim → 409, the claim stands", async () => {
    const id = await proposeId();
    beforeNextTransaction(() => claim(id, "u_other"));
    expect((await decide(id, "reject")).status).toBe(409);
    expect(row(id)).toMatchObject({ status: "executing", decidedByUid: "u_other" });
  });

  it("the expiry sweep leaves a just-claimed executing row untouched", async () => {
    const id = await proposeId();
    mem.seed(`agentProposals/${id}`, { ...row(id), expiresAt: new Date(Date.now() - 1000) });
    // A real claim of a row already past expiresAt expires it (next test),
    // so the row is moved directly: only the sweep's precondition is under test.
    beforeNextTransaction(async () => mem.seed(`agentProposals/${id}`, { ...row(id), status: "executing" }));
    await sweep(new Date());
    expect(row(id).status).toBe("executing");
  });

  it("a claim of a row already past expiresAt expires it instead", async () => {
    const id = await proposeId();
    mem.seed(`agentProposals/${id}`, { ...row(id), expiresAt: new Date(Date.now() - 1000) });
    expect(await claim(id, "u_other")).toBe("expired");
    expect(row(id)).toMatchObject({ status: "expired", claimId: null });
  });

  it("the expiry sweep expires a pending row past expiresAt", async () => {
    const id = await proposeId();
    await sweep(later(8 * 24 * 3600_000));
    expect(row(id).status).toBe("expired");
  });
});

describe("key revoke (through DELETE /api-keys/[keyId])", () => {
  it("rejects the key's pending rows; another key's and a claimed row are untouched", async () => {
    const pending = await proposeId({ body: "a" });
    const claimed = await proposeId({ body: "b" });
    await claim(claimed, "u_other");
    const otherKey = await proposeId({ body: "c" }, { ...auth, keyId: "key2" });
    expect((await revoke()).status).toBe(200);
    expect(row(pending)).toMatchObject({ status: "rejected", reason: "key_revoked" });
    expect(row(claimed).status).toBe("executing");
    expect(row(otherKey).status).toBe("pending");
  });

  it("a row claimed between the sweep's query and its write stays claimed", async () => {
    const id = await proposeId();
    // The revoke write itself is not a transaction, so the first one is the
    // sweep's. A real claim this late re-reads the revoked key and is refused
    // (next test), so the row is moved directly: only the sweep's own
    // precondition is under test here.
    beforeNextTransaction(async () => mem.seed(`agentProposals/${id}`, { ...row(id), status: "executing" }));
    await revoke();
    expect(row(id).status).toBe("executing");
  });

  it("a claim landing after the revoke's key write is refused: the row dies with the key", async () => {
    const id = await proposeId();
    beforeNextTransaction(async () => expect(await claim(id, "u_other")).toBe("key_revoked"));
    await revoke();
    expect(row(id)).toMatchObject({ status: "rejected", reason: "key_revoked", claimId: null });
  });
});

describe("re-proposing", () => {
  it("after a terminal row → a fresh pending row, the old one in history", async () => {
    const id = await proposeId();
    await decide(id, "reject");
    expect(await proposeId()).toBe(id);
    expect(row(id).status).toBe("pending");
    expect(history(id)).toEqual([expect.objectContaining({ status: "rejected" })]);
  });

  it("a stale claim is swept to unsettled; re-proposing it → outcome_unknown, no new pending", async () => {
    const id = await proposeId();
    await claim(id, "u_admin");
    await sweep(STALE);
    expect(row(id).status).toBe("unsettled");
    expect(await propose()).toMatchObject({ ok: false, code: "outcome_unknown", httpStatus: 409 });
    expect(row(id).status).toBe("unsettled");
    expect(history(id)).toEqual([]);
  });

  it("mark_not_sent on an unsettled row → rejected, and the next re-propose is a fresh pending", async () => {
    const id = await proposeId();
    await claim(id, "u_admin");
    await sweep(STALE);
    await ageClaim(id);
    expect((await decide(id, "mark_not_sent")).status).toBe(200);
    expect(row(id)).toMatchObject({ status: "rejected", reason: "not_sent_confirmed" });
    await proposeId();
    expect(row(id).status).toBe("pending");
  });

  it("mark_sent is refused on a pending row (409) and settles an unsettled one", async () => {
    const id = await proposeId();
    expect((await decide(id, "mark_sent")).status).toBe(409);
    expect(row(id).status).toBe("pending");
    await claim(id, "u_admin");
    await sweep(STALE);
    await ageClaim(id);
    expect((await decide(id, "mark_sent")).status).toBe(200);
    expect(row(id)).toMatchObject({ status: "executed", settledBy: "human" });
  });
});
