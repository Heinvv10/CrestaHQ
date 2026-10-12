import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, mem, setupAgentProposalTests } from "@/test/agent-proposals-harness";

/**
 * STL-1 workflow additions: create_workflow's optional formId (re-anchored
 * to the workspace, lands on trigger.formId), and set_workflow_status active
 * still going through approval on the agent surface.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

await setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");
const { getCapability, CapabilityUserError } = await import("@/lib/ai-suite/capabilities");
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
  mem.seed("forms/f_mine", { name: "Contact us", subAccountId: "sa1", agencyId: "ag1" });
  mem.seed("forms/f_theirs", { name: "Theirs", subAccountId: "sa2", agencyId: "ag1" });
  mem.seed("workflows/wf1", { name: "STL", subAccountId: "sa1", agencyId: "ag1", status: "draft", startNodeId: "n1", trigger: { type: "form.submitted", filters: { all: [] } }, nodes: {} });
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
