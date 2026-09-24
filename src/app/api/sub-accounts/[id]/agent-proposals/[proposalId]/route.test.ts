import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { createMemoryFirestore } from "@/test/memory-firestore";
import type { ApiAuthContext } from "@/lib/api/auth";
import type { AiSuiteCapability } from "@/lib/ai-suite/capabilities";

/**
 * The agent approval queue end to end: proposals come from the real
 * dispatchAgentTool, decisions go through this real route, sweeps are the
 * real ones, all over an in-memory Firestore. `__test_outbound` is a
 * test-only capability (approval "outbound") whose execute is a spy.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
const caller = { uid: "u_admin", email: "admin@x.io", role: "admin" as string };
vi.mock("@/lib/auth/require-tenancy", () => {
  const member = async (_req: Request, subAccountId: string) =>
    subAccountId === "sa1" || subAccountId === "sa2"
      ? { uid: caller.uid, email: caller.email, agencyId: "ag1", subAccountId, subAccountRole: caller.role }
      : NextResponse.json({ error: "Not a member" }, { status: 403 });
  return { requireSubAccountMember: member, requireSubAccountAdmin: member };
});
vi.mock("@/lib/server/agent-enrolment-replay", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/server/agent-enrolment-replay")>();
  return { replayHeldEnrolment: vi.fn(real.replayHeldEnrolment) };
});

const { POST } = await import("./route");
const { DELETE } = await import("../../api-keys/[keyId]/route");
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");
const { claimProposal, sweepAgentProposals } = await import("@/lib/server/agent-proposals");
const { replayHeldEnrolment } = await import("@/lib/server/agent-enrolment-replay");
const { AI_SUITE_CAPABILITIES } = await import("@/lib/ai-suite/capabilities");

const auth: ApiAuthContext = {
  agencyId: "ag1",
  subAccountId: "sa1",
  keyId: "key1",
  keyPrefix: "abcd1234",
  keyName: "Agent key",
  mode: "live",
  scopes: ["agent"],
  enrolmentCapPerHour: 50,
  requestId: "req_1",
  apiVersion: "2026-01-01",
};

const execute = vi.fn(async () => ({ resultText: "sent", ref: { kind: "message", id: "m1" } }));
const outbound: AiSuiteCapability = {
  name: "__test_outbound",
  level: "sub-account",
  requiredRole: "subAccountMember",
  approval: "outbound",
  menuLabel: "fixture",
  description: "fixture",
  parameters: { type: "object", properties: {} },
  validate: (raw) => ({ ok: true, args: (raw ?? {}) as Record<string, unknown> }),
  summarize: (args) => `Send “${args.body}”`,
  preview: async (_ctx, args) => [{ label: "Body", value: String(args.body) }],
  execute,
};

async function propose(args: Record<string, unknown> = { body: "hi" }, key = auth) {
  return dispatchAgentTool(key, "__test_outbound", args);
}
async function proposeId(args?: Record<string, unknown>, key = auth): Promise<string> {
  const r = await propose(args, key);
  if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return r.proposal.id;
}
function decide(id: string, decision: string, subAccountId = "sa1") {
  return POST(
    new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ decision }) }),
    { params: Promise.resolve({ id: subAccountId, proposalId: id }) }
  );
}
const row = (id: string) => mem.read(`agentProposals/${id}`)!;
const history = (id: string) => mem.list(`agentProposals/${id}/history`);
const later = (ms: number) => new Date(Date.now() + ms);

/** Run `during` between a caller's read and its first transaction. */
function beforeNextTransaction(during: () => Promise<unknown>) {
  const original = mem.db.runTransaction.bind(mem.db);
  vi.spyOn(mem.db, "runTransaction").mockImplementationOnce(async (fn) => {
    await during();
    return original(fn as Parameters<typeof original>[0]);
  });
}

beforeEach(() => {
  mem.clear();
  const gates = { agentApiEnabledByAgency: true, apiAccessEnabledByAgency: true };
  mem.seed("subAccounts/sa1", { agencyId: "ag1", ...gates });
  mem.seed("subAccounts/sa2", { agencyId: "ag1", ...gates });
  caller.role = "admin";
  execute.mockClear();
  vi.mocked(replayHeldEnrolment).mockClear();
  outbound.requiredRole = "subAccountMember";
  outbound.approval = "outbound";
  AI_SUITE_CAPABILITIES.push(outbound);
});

afterEach(() => {
  AI_SUITE_CAPABILITIES.splice(AI_SUITE_CAPABILITIES.indexOf(outbound), 1);
  vi.restoreAllMocks();
});

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
    const res = await decide(id, "approve", "sa2");
    expect(res.status).toBe(404);
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
    mem.seed("agentProposals/p_enrol", {
      agencyId: "ag1",
      subAccountId: "sa1",
      capability: "__test_outbound",
      approval: "workflow_enrolment",
      args: { workflowId: "wf1", contactId: "c1", triggerType: "contact.created" },
      summary: "Enrol Ann in Welcome",
      status: "pending",
    });
    mem.seed("contacts/c1", { agencyId: "ag1", subAccountId: "sa1", name: "Ann" });
    const res = await decide("p_enrol", "approve");
    expect(execute).not.toHaveBeenCalled();
    expect(replayHeldEnrolment).toHaveBeenCalledTimes(1);
    // PR3's seam refuses until PR3b implements the replay.
    expect(res.status).toBe(422);
    expect(row("p_enrol")).toMatchObject({ status: "failed", error: expect.stringContaining("not available yet") });
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
    beforeNextTransaction(() => claimProposal(id, { uid: "u_other", email: "" }));
    expect((await decide(id, "reject")).status).toBe(409);
    expect(row(id)).toMatchObject({ status: "executing", decidedByUid: "u_other" });
  });

  it("the expiry sweep leaves a just-claimed executing row untouched", async () => {
    const id = await proposeId();
    mem.seed(`agentProposals/${id}`, { ...row(id), expiresAt: new Date(Date.now() - 1000) });
    beforeNextTransaction(() => claimProposal(id, { uid: "u_other", email: "" }));
    await sweepAgentProposals(new Date());
    expect(row(id).status).toBe("executing");
  });

  it("the expiry sweep expires a pending row past expiresAt", async () => {
    const id = await proposeId();
    await sweepAgentProposals(later(8 * 24 * 3600_000));
    expect(row(id).status).toBe("expired");
  });
});

describe("key revoke (through DELETE /api-keys/[keyId])", () => {
  const revoke = () =>
    DELETE(new Request("http://localhost/x", { method: "DELETE" }), {
      params: Promise.resolve({ id: "sa1", keyId: "key1" }),
    });

  beforeEach(() => {
    mem.seed("subAccounts/sa1/apiKeys/key1", { subAccountId: "sa1", agencyId: "ag1", name: "Agent key", mode: "live", prefix: "abcd1234", scopes: ["agent"], revokedAt: null });
  });

  it("rejects the key's pending rows; another key's and a claimed row are untouched", async () => {
    const pending = await proposeId({ body: "a" });
    const claimed = await proposeId({ body: "b" });
    await claimProposal(claimed, { uid: "u_other", email: "" });
    const otherKey = await proposeId({ body: "a" }, { ...auth, keyId: "key2" });
    expect((await revoke()).status).toBe(200);
    expect(row(pending)).toMatchObject({ status: "rejected", reason: "key_revoked" });
    expect(row(claimed).status).toBe("executing");
    expect(row(otherKey).status).toBe("pending");
  });

  it("a claim landing between the sweep's query and its write wins", async () => {
    const id = await proposeId();
    // The revoke write itself is not a transaction, so the first one is the sweep's.
    beforeNextTransaction(() => claimProposal(id, { uid: "u_other", email: "" }));
    await revoke();
    expect(row(id).status).toBe("executing");
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
    await claimProposal(id, { uid: "u_admin", email: "" });
    await sweepAgentProposals(later(11 * 60_000));
    expect(row(id).status).toBe("unsettled");
    expect(await propose()).toMatchObject({ ok: false, code: "outcome_unknown", httpStatus: 409 });
    expect(row(id).status).toBe("unsettled");
    expect(history(id)).toEqual([]);
  });

  it("mark_not_sent on an unsettled row → rejected, and the next re-propose is a fresh pending", async () => {
    const id = await proposeId();
    await claimProposal(id, { uid: "u_admin", email: "" });
    await sweepAgentProposals(later(11 * 60_000));
    expect((await decide(id, "mark_not_sent")).status).toBe(200);
    expect(row(id)).toMatchObject({ status: "rejected", reason: "not_sent_confirmed" });
    await proposeId();
    expect(row(id).status).toBe("pending");
  });

  it("mark_sent is refused on a pending row (409) and settles an unsettled one", async () => {
    const id = await proposeId();
    expect((await decide(id, "mark_sent")).status).toBe(409);
    expect(row(id).status).toBe("pending");
    await claimProposal(id, { uid: "u_admin", email: "" });
    await sweepAgentProposals(later(11 * 60_000));
    expect((await decide(id, "mark_sent")).status).toBe(200);
    expect(row(id)).toMatchObject({ status: "executed", settledBy: "human" });
  });

  it("a settle arriving after the sweep lands in history; the row stays unsettled", async () => {
    const id = await proposeId();
    let finish!: () => void;
    execute.mockImplementationOnce(
      () => new Promise((resolve) => (finish = () => resolve({ resultText: "sent", ref: { kind: "message", id: "m1" } })))
    );
    const approving = decide(id, "approve");
    await vi.waitFor(() => expect(execute).toHaveBeenCalled());
    await sweepAgentProposals(later(11 * 60_000));
    finish();
    await approving;
    expect(row(id).status).toBe("unsettled");
    expect(history(id)).toEqual([expect.objectContaining({ lateSettle: true, status: "executed" })]);
    expect(mem.list("aiSuiteActions")).toHaveLength(1);
  });
});
