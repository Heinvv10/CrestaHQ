import { describe, expect, it, vi } from "vitest";
import {
  auth, decide, mem, row, setupAgentProposalTests,
} from "@/test/agent-proposals-harness";
import { proposals, runs, seedWorkflow, setupHeldEnrolmentTests } from "@/test/held-enrolment-harness";

/**
 * Ruling Q end to end: an API agent's write that would enrol a contact in an
 * ACTIVE workflow holds the enrolment as a `workflow_enrolment` proposal
 * instead; approving it replays the trigger for that one workflow, charging
 * the key's hourly enrolment cap. Real dispatch, engine, services, queue and
 * decide route over the in-memory Firestore; only QStash is stubbed.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);
vi.mock("@/lib/automations/qstash", async () => (await import("@/test/held-enrolment-harness")).qstashMock());

const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");
const { agentHold } = await import("./agent-hold");

setupAgentProposalTests();

const createContact = () => dispatchAgentTool(auth, "create_contact", { name: "Ann Agent", email: "ann@x.io" });

setupHeldEnrolmentTests();

describe("held-enrolment: agent create_contact with a matching ACTIVE workflow", () => {
  it("creates the contact, starts 0 runs and writes 1 workflow_enrolment proposal", async () => {
    const r = await createContact();
    expect(r).toMatchObject({ ok: true, held: [{ workflowName: "Workflow wf1" }] });
    const [contact] = mem.list("contacts");
    expect(contact).toMatchObject({ name: "Ann Agent" });
    expect(runs()).toEqual([]);
    expect(proposals()).toHaveLength(1);
    expect(proposals()[0]).toMatchObject({
      approval: "workflow_enrolment",
      capability: "create_contact",
      workflowId: "wf1",
      contactId: contact!.id,
      targetScoped: true,
      territoryId: "global",
      pinned: { workflowId: "wf1", contactId: contact!.id },
      args: { type: "contact.created", contactId: contact!.id, context: {} },
      status: "pending",
    });
  });

  it("approve → exactly 1 run, of that workflow, charged to the key's hourly cap", async () => {
    await createContact();
    const [p] = proposals();
    expect((await decide(p!.id, "approve")).status).toBe(200);
    expect(runs()).toEqual([expect.objectContaining({ workflowId: "wf1", status: "running" })]);
    expect(row(p!.id)).toMatchObject({ status: "executed" });
    const [bucket] = mem.list("subAccounts/sa1/apiEnrolments");
    expect(bucket).toMatchObject({ keyId: "key1", count: 1 });
  });

  it("MUTATION PROOF: with the hold stubbed to fall through, the same write starts a run", async () => {
    vi.spyOn(agentHold, "shouldHold").mockReturnValue(false);
    await createContact();
    expect(runs()).toHaveLength(1);
    expect(proposals()).toEqual([]);
  });

  it("two matching workflows → two proposals; approving one enrols only that workflow (onlyWorkflowId)", async () => {
    seedWorkflow("wf2", { type: "contact.created" });
    const r = await createContact();
    expect((r as { held: unknown[] }).held).toHaveLength(2);
    const target = proposals().find((p) => p.workflowId === "wf2")!;
    await decide(target.id, "approve");
    expect(runs().map((x) => x.workflowId)).toEqual(["wf2"]);
  });

  it("a workflow paused since the proposal → approve fails, nobody enrolled, cap released", async () => {
    await createContact();
    mem.seed("workflows/wf1", { ...mem.read("workflows/wf1"), status: "paused" });
    const [p] = proposals();
    const res = await decide(p!.id, "approve");
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("no longer active") });
    expect(runs()).toEqual([]);
    expect(mem.list("subAccounts/sa1/apiEnrolments")[0]).toMatchObject({ count: 0 });
  });

  it("a key at its hourly enrolment cap → approve fails, nobody enrolled", async () => {
    await createContact();
    const { enrolmentHourKey } = await import("@/lib/api/enrolment-cap");
    mem.seed(`subAccounts/sa1/apiEnrolments/key1_${enrolmentHourKey()}`, { keyId: "key1", count: 50 });
    const [p] = proposals();
    const res = await decide(p!.id, "approve");
    expect(await res.json()).toMatchObject({ status: "failed", error: expect.stringContaining("enrolments for this hour") });
    expect(runs()).toEqual([]);
  });

  it("a workflow whose re-entry policy already blocks the contact produces no proposal", async () => {
    mem.seed("workflows/wf1", { ...mem.read("workflows/wf1"), trigger: { type: "deal.created", filters: { all: [] } }, reentry: "once_ever" });
    mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Ben", tags: [], customFields: {}, territoryId: "global" });
    mem.seed("workflowEnrolmentLocks/wf1_c1", { workflowId: "wf1", contactId: "c1", lastRunId: "r0" });
    const r = await dispatchAgentTool(auth, "create_deal", {
      title: "Fibre", value: 500, currency: "ZAR", contactId: "c1", contactName: "Ben", stage: "new",
    });
    expect(r).toMatchObject({ ok: true, held: [] });
    expect(proposals()).toEqual([]);
    expect(runs()).toEqual([]);
  });

});

describe("hold failures are reported to the agent, and fail closed", () => {
  it("hold_refused: the queue refuses the proposal (key revoked meanwhile) → holdFailures, no run, no proposal", async () => {
    mem.seed("subAccounts/sa1/apiKeys/key1", { ...mem.read("subAccounts/sa1/apiKeys/key1"), revokedAt: new Date() });
    const r = await createContact();
    expect(r).toMatchObject({ ok: true, held: [], holdFailures: [{ workflowId: "wf1", reason: "hold_refused" }] });
    expect(mem.list("contacts")).toHaveLength(1);
    expect(runs()).toEqual([]);
    expect(proposals()).toEqual([]);
  });

  it("hold_error: the proposal write throws → holdFailures, no run", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(mem.db, "runTransaction").mockRejectedValueOnce(new Error("firestore unavailable"));
    const r = await createContact();
    expect(r).toMatchObject({ ok: true, held: [], holdFailures: [{ workflowId: "wf1", reason: "hold_error" }] });
    expect(runs()).toEqual([]);
  });

  it("reentry_check_failed: the re-entry probe throws → holdFailures, no run", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mem.seed("workflows/wf1", { ...mem.read("workflows/wf1"), reentry: "unless_active" });
    const collection = mem.db.collection.bind(mem.db);
    vi.spyOn(mem.db, "collection").mockImplementation((name: string) => {
      if (name === "workflowRuns") throw new Error("index missing");
      return collection(name);
    });
    const r = await createContact();
    expect(r).toMatchObject({ ok: true, held: [], holdFailures: [{ workflowId: "wf1", reason: "reentry_check_failed" }] });
    expect(runs()).toEqual([]);
    expect(proposals()).toEqual([]);
  });

  it("deals report hold failures too (move_deal_stage with the key revoked)", async () => {
    mem.seed("workflows/wf1", { ...mem.read("workflows/wf1"), trigger: { type: "pipeline.stage.changed", filters: { all: [] } } });
    mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Ben", tags: [], customFields: {}, territoryId: "global" });
    mem.seed("deals/d1", { subAccountId: "sa1", agencyId: "ag1", mode: "live", title: "Fibre", stageId: "new", contactId: "c1", value: 1, currency: "ZAR" });
    mem.seed("subAccounts/sa1/apiKeys/key1", { ...mem.read("subAccounts/sa1/apiKeys/key1"), revokedAt: new Date() });
    const r = await dispatchAgentTool(auth, "move_deal_stage", { dealId: "d1", dealTitle: "Fibre", stage: "contacted" });
    expect(r).toMatchObject({ ok: true, held: [], holdFailures: [{ workflowId: "wf1", reason: "hold_refused" }] });
    expect(runs()).toEqual([]);
  });

  it("a whole-trigger failure is reported as trigger_error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const collection = mem.db.collection.bind(mem.db);
    vi.spyOn(mem.db, "collection").mockImplementation((name: string) => {
      if (name === "workflows") throw new Error("down");
      return collection(name);
    });
    expect(await createContact()).toMatchObject({ ok: true, held: [], holdFailures: [{ workflowId: null, reason: "trigger_error" }] });
  });
});

describe("a forged enrolment", () => {
  it("dispatch refuses a capability claiming workflow_enrolment (500, logged, nothing queued)", async () => {
    const { AI_SUITE_CAPABILITIES } = await import("@/lib/ai-suite/capabilities");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const forged = {
      name: "__forged_enrolment", level: "sub-account" as const, requiredRole: "subAccountMember" as const,
      approval: "workflow_enrolment" as const, menuLabel: "x", description: "x",
      parameters: { type: "object", properties: {} },
      validate: (raw: unknown) => ({ ok: true as const, args: (raw ?? {}) as Record<string, unknown> }),
      summarize: () => "x",
      preview: async () => [{ label: "x", value: "x" }],
      approvalTarget: async () => ({ contactId: null, territoryId: null, scoped: false }),
      execute: vi.fn(async () => ({ resultText: "ran" })),
    };
    AI_SUITE_CAPABILITIES.push(forged);
    try {
      expect(await dispatchAgentTool(auth, "__forged_enrolment", {})).toMatchObject({ code: "internal_error", httpStatus: 500 });
      expect(logged).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: expect.stringContaining("only the engine") }));
      expect(proposals()).toEqual([]);
      expect(forged.execute).not.toHaveBeenCalled();
    } finally {
      AI_SUITE_CAPABILITIES.splice(AI_SUITE_CAPABILITIES.indexOf(forged), 1);
    }
  });
});
