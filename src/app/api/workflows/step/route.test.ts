import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * A step that throws on every delivery must not leave its run "running"
 * forever: the final QStash delivery (`Upstash-Retried` = the retry budget)
 * fails the run and records why on the contact. Route → real engine on an
 * in-memory Firestore; signature verification and the publish are stubbed.
 */

const mem = createMemoryFirestore();
const createTask = vi.fn();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  verifyQStashSignature: async () => true,
  publishCallback: async () => ({ messageId: "q1" }),
}));
vi.mock("@/lib/server/tasks-service", () => ({
  createTaskServerSide: (...a: unknown[]) => createTask(...a),
}));

const { POST } = await import("./route");
const { enrollForTest, WORKFLOW_STEP_RETRIES } = await import("@/lib/workflows/engine");

function seed(node: Record<string, unknown>) {
  mem.seed("agencies/ag1", { ownerUid: "u_owner", name: "Agency" });
  mem.seed("subAccounts/sa1", { name: "Velocity", agencyId: "ag1" });
  mem.seed("contacts/c1", {
    subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Thandi",
    phone: "+27821234567", tags: [], customFields: {},
  });
  mem.seed("workflows/wf1", {
    name: "Flow", subAccountId: "sa1", agencyId: "ag1", status: "active",
    startNodeId: "n1", createdByUid: "u_owner",
    trigger: { type: "contact.created", filters: { all: [] } },
    nodes: { n1: { id: "n1", next: null, ...node } },
  });
}

async function runId(): Promise<string> {
  await enrollForTest({ subAccountId: "sa1", workflowId: "wf1", contactId: "c1" });
  return mem.list("workflowRuns")[0].id;
}

const deliver = (id: string, retried: number) =>
  POST(
    new Request("http://app/api/workflows/step", {
      method: "POST",
      headers: { "upstash-signature": "sig", "upstash-retried": String(retried) },
      body: JSON.stringify({ runId: id, nodeId: "n1" }),
    })
  );

beforeEach(() => {
  mem.clear();
  createTask.mockReset().mockRejectedValue(new Error("tasks backend down"));
});

describe("POST /api/workflows/step — a step that keeps throwing", () => {
  it("5xx while retries remain; the final delivery fails the run with the reason", async () => {
    seed({ type: "create_task", config: { title: "Call back" } });
    const id = await runId();

    for (let r = 0; r < WORKFLOW_STEP_RETRIES; r++) {
      expect((await deliver(id, r)).status).toBe(500);
      expect(mem.read(`workflowRuns/${id}`)?.status).toBe("running");
    }
    const last = await deliver(id, WORKFLOW_STEP_RETRIES);
    expect(last.status).toBe(200);
    expect(mem.read(`workflowRuns/${id}`)?.status).toBe("failed");
    expect(mem.read(`contacts/c1/activities/run_${id}_automation_failed`)?.content).toBe(
      'Workflow "Flow" failed — the create_task step failed after every retry (tasks backend down)'
    );
  });

  it("update_field with an empty custom-field key is skipped, not a throw", async () => {
    seed({ type: "update_field", config: { field: "customFields.", value: "x" } });
    const id = await runId();
    expect((await deliver(id, 0)).status).toBe(200);
    const run = mem.read(`workflowRuns/${id}`) as { status: string; history: Array<{ result: string }> };
    expect(run.status).toBe("completed");
    expect(run.history[0].result).toBe("skipped:field_not_writable");
  });

  it("update_field still writes a valid custom field", async () => {
    seed({ type: "update_field", config: { field: "customFields.install_date", value: "2026-09-23" } });
    const id = await runId();
    expect((await deliver(id, 0)).status).toBe(200);
    expect(mem.read("contacts/c1")?.customFields).toEqual({ install_date: "2026-09-23" });
  });
});
