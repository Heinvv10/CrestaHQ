import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, mem, setupAgentProposalTests } from "@/test/agent-proposals-harness";

/**
 * STL-1 workflow additions: create_workflow's optional formId (re-anchored
 * to the workspace, lands on trigger.formId) and test_workflow (chat-only,
 * wraps enrollForTest with the caller's sub-account).
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);
const enroll = vi.hoisted(() => ({ spy: null as unknown as ReturnType<typeof vi.fn> }));
vi.mock("@/lib/workflows/engine", async (orig) => {
  const real = (await orig()) as typeof import("@/lib/workflows/engine");
  enroll.spy = vi.fn(real.enrollForTest);
  return { ...real, enrollForTest: enroll.spy };
});

setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");
const { availableOn, getCapability, CapabilityUserError } = await import("@/lib/ai-suite/capabilities");
const { FORM_TRIGGERED_TEMPLATES } = await import("./workflows");
const { createWorkflowServerSide } = await import("@/lib/server/workflows-service");
const { WORKFLOW_TEMPLATES } = await import("./helpers");
const { workflowFingerprint } = await import("./workflow-support");
const { getWorkflow } = await import("@/lib/server/workflows-service");

const ctx = { uid: "u_admin", email: "admin@x.io", displayName: "", agencyId: "ag1", subAccountId: "sa1", subAccountRole: "admin" };
const run = async (name: string, args: Record<string, unknown>) => {
  const cap = getCapability(name)!;
  const v = cap.validate(args);
  if (!v.ok) throw new Error(v.error);
  return cap.execute(ctx, v.args);
};

beforeEach(() => {
  enroll.spy.mockClear();
  mem.seed("forms/f_mine", { name: "Contact us", subAccountId: "sa1", agencyId: "ag1" });
  mem.seed("forms/f_theirs", { name: "Theirs", subAccountId: "sa2", agencyId: "ag1" });
  mem.seed("contacts/c1", { name: "Me", subAccountId: "sa1", agencyId: "ag1" });
  mem.seed("contacts/c_theirs", { name: "Other", subAccountId: "sa2", agencyId: "ag1" });
  mem.seed("workflows/wf1", { name: "STL", subAccountId: "sa1", agencyId: "ag1", status: "draft", startNodeId: "n1", trigger: { type: "form.submitted", filters: { all: [] } }, nodes: {} });
  mem.seed("workflows/wf_theirs", { name: "Theirs", subAccountId: "sa2", agencyId: "ag1", status: "draft", startNodeId: "n1", trigger: { type: "form.submitted", filters: { all: [] } }, nodes: {} });
});

describe("create_workflow formId", () => {
  it("pins the new draft's trigger to this workspace's form", async () => {
    const r = await run("create_workflow", { template: "speed-to-lead", formId: "f_mine", formName: "Contact us" });
    expect(mem.read(`workflows/${r.ref!.id}`)).toMatchObject({
      subAccountId: "sa1", status: "draft", trigger: { type: "form.submitted", formId: "f_mine" },
    });
    expect(r.resultText).toContain("“Contact us” form");
  });

  it("refuses another sub-account's form and creates nothing", async () => {
    const before = mem.list("workflows").length;
    await expect(run("create_workflow", { template: "speed-to-lead", formId: "f_theirs" })).rejects.toBeInstanceOf(CapabilityUserError);
    await expect(run("create_workflow", { template: "blank", formId: "missing" })).rejects.toThrow(/wasn't found in this workspace/);
    expect(mem.list("workflows")).toHaveLength(before);
  });

  it("refuses it on the agent surface too", async () => {
    const before = mem.list("workflows").length;
    const r = await dispatchAgentTool(auth, "create_workflow", { template: "speed-to-lead", formId: "f_theirs" });
    expect(r).toMatchObject({ ok: false, httpStatus: 400 });
    expect(mem.list("workflows")).toHaveLength(before);
  });

  it("without a formId, fires for every form as before", async () => {
    const r = await run("create_workflow", { template: "speed-to-lead" });
    expect((mem.read(`workflows/${r.ref!.id}`)!.trigger as Record<string, unknown>).formId).toBeUndefined();
  });

  it("validate: a formId only on a form-triggered starter, and only a doc id", () => {
    const v = getCapability("create_workflow")!.validate;
    expect(v({ template: "appointment-confirmation", formId: "f_mine" }).ok).toBe(false);
    expect(v({ template: "speed-to-lead", formId: "forms/f_mine" }).ok).toBe(false);
    expect(v({ template: "lead-nurture", formId: "f_mine" }).ok).toBe(true);
  });

  it("FORM_TRIGGERED_TEMPLATES is exactly the starters seeded with form.submitted", async () => {
    const formTriggered: string[] = [];
    for (const template of Object.keys(WORKFLOW_TEMPLATES) as Array<keyof typeof WORKFLOW_TEMPLATES>) {
      const id = await createWorkflowServerSide({ subAccountId: "sa1", createdByUid: "u1", name: "x", template });
      if ((mem.read(`workflows/${id}`)!.trigger as { type: string }).type === "form.submitted") formTriggered.push(template);
    }
    expect([...formTriggered].sort()).toEqual([...FORM_TRIGGERED_TEMPLATES].sort());
  });
});

describe("test_workflow", () => {
  it("is chat-only: never on the agent surface", async () => {
    const cap = getCapability("test_workflow")!;
    expect(availableOn(cap, "chat")).toBe(true);
    expect(availableOn(cap, "agent")).toBe(false);
    const r = await dispatchAgentTool(auth, "test_workflow", { workflowId: "wf1", workflowName: "STL", contactId: "c1", contactName: "Me" });
    expect(r).toMatchObject({ ok: false, httpStatus: 404 });
    expect(enroll.spy).not.toHaveBeenCalled();
  });

  it("is confirm-gated and admin-only", () => {
    const cap = getCapability("test_workflow")!;
    expect(cap.readonly).toBeFalsy();
    expect(cap.requiredRole).toBe("subAccountAdmin");
  });

  it("calls enrollForTest with the caller's sub-account", async () => {
    enroll.spy.mockResolvedValueOnce({ ok: true });
    const r = await run("test_workflow", { workflowId: "wf1", workflowName: "STL", contactId: "c1", contactName: "Me" });
    expect(enroll.spy).toHaveBeenCalledWith({ subAccountId: "sa1", workflowId: "wf1", contactId: "c1" });
    expect(r.ref).toEqual({ kind: "workflow", id: "wf1" });
  });

  it("another sub-account's workflow or contact is refused, nothing enrolled", async () => {
    await expect(run("test_workflow", { workflowId: "wf_theirs", contactId: "c1" })).rejects.toThrow("Workflow not found");
    await expect(run("test_workflow", { workflowId: "wf1", contactId: "c_theirs" })).rejects.toThrow("Contact not found");
    expect(mem.list("workflowRuns")).toEqual([]);
  });

  it("validate refuses a missing or path-shaped id", () => {
    const v = getCapability("test_workflow")!.validate;
    expect(v({ workflowId: "wf1" }).ok).toBe(false);
    expect(v({ workflowId: "wf1", contactId: "c1/scheduledMessages/s1" }).ok).toBe(false);
  });
});

describe("set_workflow_status active on the agent surface is unchanged", () => {
  it("queues an approval proposal and writes nothing to the workflow", async () => {
    const r = await dispatchAgentTool(auth, "set_workflow_status", { workflowId: "wf1", status: "active" });
    expect(r).toMatchObject({ ok: true, proposal: { status: "pending" } });
    expect(mem.list("agentProposals")).toHaveLength(1);
    expect(mem.read("workflows/wf1")!.status).toBe("draft");
  });

  it("the approved execute (pinned fingerprint) still activates", async () => {
    const wf = (await getWorkflow("sa1", "wf1"))!;
    const approvedCtx = { ...ctx, approved: { pinned: { workflowId: "wf1", fingerprint: workflowFingerprint(wf) } } };
    await getCapability("set_workflow_status")!.execute(approvedCtx, { workflowId: "wf1", status: "active" });
    expect(mem.read("workflows/wf1")!.status).toBe("active");
  });
});
