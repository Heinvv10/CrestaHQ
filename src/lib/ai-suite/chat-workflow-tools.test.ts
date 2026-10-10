import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * STL-1 widened list_workflows, get_workflow, update_workflow and
 * set_workflow_status to the chat surface. Through the real chat and confirm
 * routes (auth, the model call and usage stubbed): an admin is offered them,
 * a lookup runs inline, a write becomes a confirm card and runs only on
 * confirm; a collaborator is offered none and the confirm route refuses.
 * update_workflow still refuses an ACTIVE workflow without an approval.
 */

const mem = createMemoryFirestore();
const role = vi.hoisted(() => ({ current: "admin" }));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async () => ({ uid: "u1", email: "a@example.com", agencyId: "ag1", subAccountRole: role.current }),
  requireAgencyOwnerAny: async () => ({ uid: "u1", email: "a@example.com", agencyId: "ag1" }),
}));
const runAiSuiteTurn = vi.fn();
vi.mock("@/lib/ai-suite/model", () => ({
  aiSuiteIsConfigured: () => true,
  aiSuiteModel: () => "test-model",
  normalizeAiSuiteModelChoice: () => "opus",
  runAiSuiteTurn: (input: unknown) => runAiSuiteTurn(input),
}));
vi.mock("@/lib/ai-suite/usage", () => ({ recordAiSuiteUsage: async () => undefined }));
vi.mock("@/lib/ai-suite/audit", () => ({ recordAiSuiteAction: async () => undefined }));

const { toolsForLevel } = await import("./capabilities");
const chat = await import("@/app/api/ai-suite/chat/route");
const confirm = await import("@/app/api/ai-suite/confirm/route");

const WIDENED = ["list_workflows", "get_workflow", "update_workflow", "set_workflow_status"];
const post = (body: unknown) => new Request("http://localhost/api/ai-suite", { method: "POST", body: JSON.stringify(body) });
const ask = (name: string, args: Record<string, unknown>) => {
  runAiSuiteTurn.mockResolvedValueOnce({ text: "", toolCall: { id: "call_1", name, args } });
  runAiSuiteTurn.mockResolvedValueOnce({ text: "done", toolCall: null });
  return chat.POST(post({ level: "sub-account", subAccountId: "sa1", messages: [{ role: "user", content: "go" }] }));
};
const doConfirm = (capability: string, args: Record<string, unknown>) =>
  confirm.POST(post({ level: "sub-account", subAccountId: "sa1", capability, args }));
const wf = (status: string) => ({
  name: "Speed to lead", subAccountId: "sa1", agencyId: "ag1", status, startNodeId: "n1",
  trigger: { type: "form.submitted", filters: { all: [] } },
  nodes: { n1: { id: "n1", type: "send_sms", config: { body: "Hi" }, next: null } },
});

beforeEach(() => {
  mem.clear();
  role.current = "admin";
  runAiSuiteTurn.mockReset();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", aiSuiteEnabledByAgency: true, name: "W" });
  mem.seed("workflows/wf_draft", wf("draft"));
  mem.seed("workflows/wf_active", wf("active"));
  mem.seed("workflows/wf_other", { ...wf("draft"), name: "Other tenant", subAccountId: "sa2" });
});

describe("an admin in chat", () => {
  it("is offered all four", () => {
    const tools = toolsForLevel("sub-account", { agencyRoleIsOwner: false, subAccountRole: "admin" }).map((t) => t.function.name);
    expect(tools).toEqual(expect.arrayContaining(WIDENED));
  });

  it("list_workflows runs inline and its result goes back to the model, this workspace only", async () => {
    const res = await ask("list_workflows", {});
    expect((await res.json()).type).toBe("message");
    expect(runAiSuiteTurn).toHaveBeenCalledTimes(2);
    const msgs = (runAiSuiteTurn.mock.calls[1]![0] as { messages: Array<{ role: string; content: string }> }).messages;
    const tool = msgs.find((m) => m.role === "tool")!;
    expect(tool.content).toContain("wf_draft");
    expect(tool.content).not.toContain("Other tenant");
  });

  it("update_workflow becomes a confirm card, and changes nothing until confirmed", async () => {
    const res = await ask("update_workflow", { workflowId: "wf_draft", name: "Renamed" });
    expect(await res.json()).toMatchObject({ type: "proposal", proposal: { capability: "update_workflow" } });
    expect(mem.read("workflows/wf_draft")!.name).toBe("Speed to lead");
    const ok = await doConfirm("update_workflow", { workflowId: "wf_draft", name: "Renamed" });
    expect(ok.status).toBe(200);
    expect(mem.read("workflows/wf_draft")!.name).toBe("Renamed");
  });

  it("set_workflow_status is a confirm card; confirming pauses", async () => {
    const res = await ask("set_workflow_status", { workflowId: "wf_active", status: "paused" });
    expect((await res.json()).type).toBe("proposal");
    expect(mem.read("workflows/wf_active")!.status).toBe("active");
    expect((await doConfirm("set_workflow_status", { workflowId: "wf_active", status: "paused" })).status).toBe(200);
    expect(mem.read("workflows/wf_active")!.status).toBe("paused");
  });

  it("update_workflow still refuses an active workflow (no approval in chat)", async () => {
    const res = await doConfirm("update_workflow", { workflowId: "wf_active", name: "Renamed" });
    expect(res.status).toBe(400);
    expect(mem.read("workflows/wf_active")!.name).toBe("Speed to lead");
  });

  it("another sub-account's workflow is refused", async () => {
    const res = await doConfirm("set_workflow_status", { workflowId: "wf_other", status: "paused" });
    expect(res.status).toBe(400);
    expect(mem.read("workflows/wf_other")!.status).toBe("draft");
  });
});

describe("a collaborator in chat", () => {
  beforeEach(() => {
    role.current = "collaborator";
  });

  it("is offered none of them", () => {
    const tools = toolsForLevel("sub-account", { agencyRoleIsOwner: false, subAccountRole: "collaborator" }).map((t) => t.function.name);
    for (const name of WIDENED) expect(tools).not.toContain(name);
  });

  it("a lookup the model names anyway does not run", async () => {
    runAiSuiteTurn.mockResolvedValueOnce({ text: "", toolCall: { id: "call_1", name: "list_workflows", args: {} } });
    const res = await chat.POST(post({ level: "sub-account", subAccountId: "sa1", messages: [{ role: "user", content: "go" }] }));
    expect((await res.json()).type).toBe("message");
    expect(runAiSuiteTurn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["update_workflow", { workflowId: "wf_draft", name: "Renamed" }],
    ["set_workflow_status", { workflowId: "wf_active", status: "paused" }],
  ])("the confirm route refuses %s with 403, nothing changed", async (capability, args) => {
    const before = JSON.stringify(mem.all());
    expect((await doConfirm(capability, args)).status).toBe(403);
    expect(JSON.stringify(mem.all())).toBe(before);
  });
});
