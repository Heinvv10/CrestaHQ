import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, beforeNextTransaction, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";

/**
 * The PR9 workflow capabilities through the real dispatch and decide route:
 * a draft or paused workflow is edited at once, an active one only through
 * an approval; `status` never changes through update_workflow; activating
 * runs exactly the reviewed trigger and steps; deleting is approved.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");

const STEPS = { n1: { id: "n1", type: "send_sms", config: { body: "Hi {{contact.firstName}}" }, next: null } };
const WF = {
  id: "wf1", subAccountId: "sa1", agencyId: "ag1", name: "Welcome", status: "draft", startNodeId: "n1",
  trigger: { type: "contact.created", filters: { all: [] } }, nodes: STEPS,
};
const NEW_STEPS = { n2: { id: "n2", type: "send_sms", config: { body: "New text" }, next: null } };
const seed = (patch: Record<string, unknown> = {}) => mem.seed("workflows/wf1", { ...WF, ...patch });
const wf = () => mem.read("workflows/wf1")!;
const call = (name: string, args: Record<string, unknown>) => dispatchAgentTool(auth, name, args);
async function proposeId(name: string, args: Record<string, unknown>): Promise<string> {
  const r = await call(name, args);
  if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return r.proposal.id;
}
const audit = () => mem.list("auditEvents").filter((e) => e.action === "workflow.status_changed");

beforeEach(() => seed());

describe("update_workflow", () => {
  it.each(["draft", "paused"])("a %s workflow is edited at once; `status` in the args is ignored; the write is stamped", async (status) => {
    seed({ status });
    const r = await call("update_workflow", { workflowId: "wf1", name: "Renamed", nodes: NEW_STEPS, startNodeId: "n2", status: "active" });
    expect(r).toMatchObject({ ok: true, resultText: "Updated the workflow." });
    expect(wf()).toMatchObject({ name: "Renamed", nodes: NEW_STEPS, startNodeId: "n2", status, lastAgentEditKey: "abcd1234" });
    expect(mem.list("agentProposals")).toEqual([]);
  });

  it("an active workflow → a proposal showing the new steps exactly, nothing written; approve applies it, still active", async () => {
    seed({ status: "active" });
    const id = await proposeId("update_workflow", { workflowId: "wf1", nodes: { ...NEW_STEPS, n2: { ...NEW_STEPS.n2, config: { body: "Hi\u200bthere" } } }, startNodeId: "n2" });
    expect(row(id).approval).toBe("workflow_activate");
    const steps = (row(id).preview as Array<{ label: string; value: string }>).find((r) => r.label === "New steps (replace all)")!;
    expect(steps.value).toContain('"body": "Hi\\u200bthere"');
    expect(wf().nodes).toEqual(STEPS);
    expect((await decide(id, "approve")).status).toBe(200);
    expect(wf()).toMatchObject({ status: "active", startNodeId: "n2", nodes: { n2: { config: { body: "Hi\u200bthere" } } } });
  });

  it("an active workflow changed since the proposal → preview_changed, nothing written", async () => {
    seed({ status: "active" });
    const id = await proposeId("update_workflow", { workflowId: "wf1", name: "Renamed" });
    seed({ status: "active", nodes: NEW_STEPS });
    const res = await decide(id, "approve");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "preview_changed" });
    expect(wf().name).toBe("Welcome");
  });

  it("changed between the approve-time re-check and the write → failed, nothing written", async () => {
    seed({ status: "active" });
    const id = await proposeId("update_workflow", { workflowId: "wf1", name: "Renamed" });
    beforeNextTransaction(async () => seed({ status: "active", nodes: NEW_STEPS }));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(row(id)).toMatchObject({ status: "failed", error: "The workflow changed since this was reviewed; nothing was changed." });
    expect(wf().name).toBe("Welcome");
  });

  it("a draft activated between the check and the direct write → refused, nothing written", async () => {
    beforeNextTransaction(async () => seed({ status: "active" }));
    const r = await call("update_workflow", { workflowId: "wf1", name: "Renamed" });
    expect(r).toMatchObject({ ok: false, message: "The workflow is active now, so editing it needs approval: send the edit again." });
    expect(wf().name).toBe("Welcome");
  });

  it.each([
    ["an unknown trigger type", { trigger: { type: "toString" } }],
    ["trigger filters that aren't an object", { trigger: { type: "contact.created", filters: "all" } }],
    ["an unknown step type", { nodes: { n1: { type: "launch_rocket", config: {} } } }],
    ["too many steps", { nodes: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`n${i}`, { type: "send_sms", config: {} }])) }],
    ["a start step that isn't one of the steps", { nodes: NEW_STEPS, startNodeId: "n9" }],
    ["an inherited-property start step", { nodes: NEW_STEPS, startNodeId: "toString" }],
    ["an invisible character in the name", { name: "We\u200blcome" }],
    ["an unknown re-entry", { reentry: "sometimes" }],
    ["nothing to change", { status: "active" }],
  ])("%s → refused, nothing written", async (_label, patch) => {
    expect(await call("update_workflow", { workflowId: "wf1", ...patch })).toMatchObject({ ok: false, code: "invalid_args" });
    expect(wf()).toEqual(WF);
  });
});

describe("set_workflow_status", () => {
  it("pausing an active workflow is a direct write, audited as the key", async () => {
    seed({ status: "active" });
    expect(await call("set_workflow_status", { workflowId: "wf1", status: "paused" })).toMatchObject({ ok: true });
    expect(wf().status).toBe("paused");
    expect(audit()).toEqual([
      expect.objectContaining({ action: "workflow.status_changed", actor: { type: "api_key", id: "key1" }, changes: [{ field: "status", before: "active", after: "paused" }] }),
    ]);
  });

  it("activating → a proposal showing the exact trigger and steps; approve activates, audited as the approver", async () => {
    const id = await proposeId("set_workflow_status", { workflowId: "wf1", status: "active" });
    expect(wf().status).toBe("draft");
    expect(row(id).preview).toContainEqual({ label: "Steps (exact)", value: expect.stringContaining('"body": "Hi {{contact.firstName}}"'), multiline: true });
    expect((await decide(id, "approve")).status).toBe(200);
    expect(wf().status).toBe("active");
    expect(audit()).toEqual([expect.objectContaining({ actor: { type: "user", id: "u_admin" }, changes: [{ field: "status", before: "draft", after: "active" }] })]);
  });

  it("steps changed between the approve-time re-check and the write → not activated", async () => {
    const id = await proposeId("set_workflow_status", { workflowId: "wf1", status: "active" });
    beforeNextTransaction(async () => seed({ nodes: NEW_STEPS }));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(row(id)).toMatchObject({ status: "failed", error: "The workflow changed since this was reviewed; it was not activated." });
    expect(wf().status).toBe("draft");
  });

  it("an already active workflow → refused at propose", async () => {
    seed({ status: "active" });
    expect(await call("set_workflow_status", { workflowId: "wf1", status: "active" })).toMatchObject({ ok: false, message: "That workflow is already active." });
  });
});

describe("delete_workflow", () => {
  it("→ a proposal, nothing deleted; the preview warns when an agent last renamed it; approve deletes", async () => {
    await call("update_workflow", { workflowId: "wf1", name: "Old onboarding" });
    const id = await proposeId("delete_workflow", { workflowId: "wf1" });
    expect(row(id).preview).toContainEqual({ label: "Delete workflow", value: "Old onboarding" });
    expect(row(id).preview).toContainEqual({ label: "Warning", value: expect.stringContaining("Last edited by API agent abcd1234") });
    expect(mem.read("workflows/wf1")).toBeDefined();
    expect((await decide(id, "approve")).status).toBe(200);
    expect(mem.read("workflows/wf1")).toBeUndefined();
  });
});

it("create_workflow by an agent is stamped as the agent's", async () => {
  const r = await call("create_workflow", { template: "blank", name: "Mine" });
  expect(mem.read(`workflows/${(r as { ref: { id: string } }).ref.id}`)).toMatchObject({ name: "Mine", status: "draft", lastAgentEditKey: "abcd1234" });
});

describe("tenancy and reads", () => {
  it.each([
    ["get_workflow", {}],
    ["update_workflow", { name: "X" }],
    ["set_workflow_status", { status: "paused" }],
    ["set_workflow_status", { status: "active" }],
    ["delete_workflow", {}],
  ])("%s on another sub-account's workflow → refused, nothing written", async (name, args) => {
    mem.seed("workflows/wf2", { ...WF, id: "wf2", subAccountId: "sa2", status: "active" });
    const before = JSON.stringify(mem.all());
    expect(await call(name, { workflowId: "wf2", ...args })).toMatchObject({ ok: false, httpStatus: 400 });
    expect(JSON.stringify(mem.all())).toBe(before);
  });

  it.each([
    ["get_workflow", {}],
    ["update_workflow", { name: "X" }],
    ["set_workflow_status", { status: "paused" }],
    ["delete_workflow", {}],
  ])("%s with an id that is a path → refused as invalid args", async (name, args) => {
    expect(await call(name, { workflowId: "wf1/sub/y", ...args })).toMatchObject({ ok: false, code: "invalid_args" });
  });

  it("list_workflows lists only this sub-account's; get_workflow shows every step", async () => {
    mem.seed("workflows/wf2", { ...WF, id: "wf2", name: "Theirs", subAccountId: "sa2" });
    const list = await call("list_workflows", {});
    expect(list).toMatchObject({ ok: true, resultText: expect.stringContaining("Welcome — id: wf1, status: draft, trigger: contact.created") });
    expect(JSON.stringify(list)).not.toContain("Theirs");
    expect(await call("get_workflow", { workflowId: "wf1" })).toMatchObject({ resultText: expect.stringContaining('"body": "Hi {{contact.firstName}}"') });
  });
});
