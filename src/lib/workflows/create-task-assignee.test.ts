import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * create_task's "Assign to" is honoured only while the uid is an ACTIVE
 * member of the run's sub-account, checked when the step runs. Real
 * `runStep` + real tasks service on an in-memory Firestore.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  publishCallback: async () => ({ messageId: "q1" }),
}));

const { runStep } = await import("./engine");

function seedRun(config: Record<string, unknown>) {
  mem.seed("workflows/wf1", {
    name: "Assign", subAccountId: "sa1", agencyId: "ag1", status: "active",
    startNodeId: "n1", createdByUid: "u_owner",
    trigger: { type: "contact.tag.added", filters: { all: [] } },
    nodes: { n1: { id: "n1", type: "create_task", next: null, config } },
  });
  mem.seed("workflowRuns/run1", {
    id: "run1", subAccountId: "sa1", agencyId: "ag1", workflowId: "wf1",
    contactId: "c1", status: "running", currentNodeId: "n1", history: [], context: {},
  });
}

const onlyTask = () => {
  const tasks = mem.list("tasks");
  expect(tasks).toHaveLength(1);
  return tasks[0];
};
const stepLog = () =>
  (mem.read("workflowRuns/run1")?.history as Array<{ result: string }>)[0]?.result;

beforeEach(() => {
  mem.clear();
  mem.seed("agencies/ag1", { ownerUid: "u_owner", name: "Agency" });
  mem.seed("users/u_owner", { displayName: "Owner", email: "owner@example.com" });
  mem.seed("subAccounts/sa1", { name: "Velocity", agencyId: "ag1" });
  mem.seed("contacts/c1", {
    subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Thandi", tags: [],
  });
  mem.seed("subAccounts/sa1/subAccountMembers/u_active", { status: "active" });
  mem.seed("subAccounts/sa1/subAccountMembers/u_removed", { status: "removed" });
  mem.seed("subAccounts/sa2/subAccountMembers/u_elsewhere", { status: "active" });
});

describe("create_task assignee", () => {
  it("an active member gets the task", async () => {
    seedRun({ title: "Call back", assignedToUid: "u_active" });
    await runStep("run1", "n1");
    expect(onlyTask().assignedToUid).toBe("u_active");
    expect(stepLog()).toBe("task_created");
  });

  it("a removed member does not — the task is created unassigned and the log says why", async () => {
    seedRun({ title: "Call back", assignedToUid: "u_removed" });
    await runStep("run1", "n1");
    expect(onlyTask().assignedToUid).toBeNull();
    expect(stepLog()).toBe("task_created:unassigned_not_member");
  });

  it("an active member of ANOTHER sub-account does not", async () => {
    seedRun({ title: "Call back", assignedToUid: "u_elsewhere" });
    await runStep("run1", "n1");
    expect(onlyTask().assignedToUid).toBeNull();
    expect(stepLog()).toBe("task_created:unassigned_not_member");
  });

  it("a uid with no member row does not", async () => {
    seedRun({ title: "Call back", assignedToUid: "u_ghost" });
    await runStep("run1", "n1");
    expect(onlyTask().assignedToUid).toBeNull();
    expect(stepLog()).toBe("task_created:unassigned_not_member");
  });

  it("no assignee configured ⇒ unassigned, plain log (every existing workflow)", async () => {
    seedRun({ title: "Call back" });
    await runStep("run1", "n1");
    expect(onlyTask().assignedToUid).toBeNull();
    expect(stepLog()).toBe("task_created");
  });
});
