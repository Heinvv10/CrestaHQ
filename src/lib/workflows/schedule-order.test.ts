import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * A delay-0 step can be delivered — and finish — before the publish that
 * scheduled it returns. The run's state must therefore be written BEFORE the
 * publish: written after, it drags a run the next step already parked
 * ("waiting" on a reply) or finished ("completed") back to "running". The
 * fake QStash here delivers every immediate step inline, inside the publish,
 * which is that race made deterministic. Timeouts are not delivered.
 */

const mem = createMemoryFirestore();
const publishes: Array<{ retries?: number; body: { phase?: string } }> = [];
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  publishCallback: async (input: { retries?: number; body: { runId: string; nodeId: string; phase?: string } }) => {
    publishes.push(input);
    if (!input.body.phase) await runStep(input.body.runId, input.body.nodeId);
    return { messageId: `q_${input.body.nodeId}` };
  },
}));

const { enrollForTest, runStep, resumeWaitingRunsOnReply, WORKFLOW_STEP_RETRIES } =
  await import("./engine");

function seed(nodes: Record<string, unknown>) {
  mem.seed("agencies/ag1", { ownerUid: "u_owner", name: "Agency" });
  mem.seed("subAccounts/sa1", { name: "Velocity", agencyId: "ag1" });
  mem.seed("contacts/c1", {
    subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Thandi",
    phone: "+27821234567", tags: [], customFields: {},
  });
  mem.seed("workflows/wf1", {
    name: "Flow", subAccountId: "sa1", agencyId: "ag1", status: "active",
    startNodeId: "n1", createdByUid: "u_owner",
    trigger: { type: "contact.created", filters: { all: [] } }, nodes,
  });
}

beforeEach(() => {
  mem.clear();
  publishes.length = 0;
});

const run = () =>
  mem.list("workflowRuns")[0] as unknown as {
    status: string;
    currentNodeId: string | null;
    history: Array<{ nodeId: string }>;
  };

describe("run state vs. an immediately delivered next step", () => {
  it("a run that finished stays completed", async () => {
    seed({
      n1: { id: "n1", type: "add_tag", config: { tag: "a" }, next: "n2" },
      n2: { id: "n2", type: "add_tag", config: { tag: "b" }, next: null },
    });
    await enrollForTest({ subAccountId: "sa1", workflowId: "wf1", contactId: "c1" });
    expect(run().history.map((h) => h.nodeId)).toEqual(["n1", "n2"]);
    expect(run().status).toBe("completed");
  });

  it("a run parked on wait_for_reply stays waiting, and a reply takes the Replied branch", async () => {
    seed({
      n1: { id: "n1", type: "add_tag", config: { tag: "a" }, next: "n2" },
      n2: {
        id: "n2", type: "wait_for_reply", config: { seconds: 3600 },
        branches: { whenTrue: "yes", whenFalse: "no" },
      },
      yes: { id: "yes", type: "add_tag", config: { tag: "replied" }, next: null },
      no: { id: "no", type: "add_tag", config: { tag: "silent" }, next: null },
    });
    await enrollForTest({ subAccountId: "sa1", workflowId: "wf1", contactId: "c1" });
    expect(run().status).toBe("waiting");
    expect(run().currentNodeId).toBe("n2");
    // Every step publish — the reply timeout included — carries the retry
    // budget the step route's final-delivery check is measured against.
    expect(publishes.map((p) => [p.body.phase ?? "step", p.retries])).toEqual([
      ["step", WORKFLOW_STEP_RETRIES],
      ["step", WORKFLOW_STEP_RETRIES],
      ["timeout", WORKFLOW_STEP_RETRIES],
    ]);

    const resumed = await resumeWaitingRunsOnReply({
      subAccountId: "sa1", contactId: "c1", channel: "whatsapp", text: "hi",
    });
    expect(resumed).toBe(1);
    expect(mem.read("contacts/c1")?.tags).toEqual(["a", "replied"]);
    expect(run().status).toBe("completed");
  });
});
