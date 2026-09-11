import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * A workflow run leaves its lifecycle on the contact's timeline —
 * `automation_started` at enrolment, `automation_completed` when the last
 * step ends, `automation_failed` when a step cannot be scheduled — each
 * keyed by run + type so a QStash redelivery cannot duplicate it. Driven
 * through the real engine on an in-memory Firestore.
 */

const mem = createMemoryFirestore();
let qstashUp = true;
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  publishCallback: async () => (qstashUp ? { messageId: "q1" } : null),
}));

const { enrollForTest, runStep } = await import("./engine");

beforeEach(() => {
  mem.clear();
  qstashUp = true;
  mem.seed("agencies/ag1", { ownerUid: "u_owner", name: "Agency" });
  mem.seed("users/u_owner", { displayName: "Owner", email: "owner@example.com" });
  mem.seed("subAccounts/sa1", { name: "Velocity", agencyId: "ag1" });
  mem.seed("contacts/c1", {
    subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Thandi",
    phone: "+27821234567", tags: [], customFields: {},
  });
  mem.seed("workflows/wf1", {
    name: "Welcome sequence",
    subAccountId: "sa1", agencyId: "ag1", status: "active", startNodeId: "n1",
    createdByUid: "u_owner",
    trigger: { type: "contact.tag.added", filters: { all: [] } },
    nodes: { n1: { id: "n1", type: "add_tag", config: { tag: "welcomed" }, next: null } },
  });
});

const activities = () =>
  mem.list("contacts/c1/activities").map((a) => [a.id, a.type, a.content, a.meta]);

describe("workflow run lifecycle on the contact timeline", () => {
  it("started at enrolment, completed after the last step, both linked to the run", async () => {
    expect((await enrollForTest({ subAccountId: "sa1", workflowId: "wf1", contactId: "c1" })).ok).toBe(true);
    const [run] = mem.list("workflowRuns");
    expect(activities()).toEqual([
      [
        `run_${run.id}_automation_started`,
        "automation_started",
        'Workflow "Welcome sequence" started',
        { workflowId: "wf1", runId: run.id },
      ],
    ]);

    await runStep(run.id, "n1");
    expect(mem.read(`workflowRuns/${run.id}`)?.status).toBe("completed");
    expect(activities().map((a) => a[1])).toEqual(["automation_started", "automation_completed"]);
    expect(mem.read(`contacts/c1/activities/run_${run.id}_automation_completed`)).toMatchObject({
      content: 'Workflow "Welcome sequence" completed',
      createdBy: "workflow",
      agencyId: "ag1",
      subAccountId: "sa1",
      meta: { workflowId: "wf1", runId: run.id },
    });
  });

  it("a QStash retry of the completing step does not duplicate the row", async () => {
    await enrollForTest({ subAccountId: "sa1", workflowId: "wf1", contactId: "c1" });
    const [run] = mem.list("workflowRuns");
    await runStep(run.id, "n1");
    await runStep(run.id, "n1");
    expect(activities()).toHaveLength(2);
  });

  it("failed when the first step cannot be scheduled", async () => {
    qstashUp = false;
    await enrollForTest({ subAccountId: "sa1", workflowId: "wf1", contactId: "c1" });
    const [run] = mem.list("workflowRuns");
    expect(run.status).toBe("failed");
    expect(activities().map((a) => [a[1], a[2]])).toEqual([
      ["automation_started", 'Workflow "Welcome sequence" started'],
      [
        "automation_failed",
        'Workflow "Welcome sequence" failed — the next step could not be scheduled',
      ],
    ]);
  });
});
