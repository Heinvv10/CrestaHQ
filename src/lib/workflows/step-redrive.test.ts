import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * A step's history entry is written before its successor is scheduled. If
 * the delivery dies in between — the pre-publish state write throws, or the
 * process stops before the publish — QStash redelivers the SAME step, which
 * finds itself in history. It must re-drive the successor, or the run sits
 * "running" forever and blocks `unless_active` re-entry. The QStash publish
 * is a recorder; no step is delivered unless the test calls runStep.
 */

const mem = createMemoryFirestore();
let failScheduleOf: string | null = null;
let throwPublishOf: string | null = null;
type Publish = { body: { nodeId: string }; delaySeconds: number };
const published: Publish[] = [];

// The pre-publish write for a named node can be made to fail once.
const db = {
  ...mem.db,
  runTransaction: <T>(fn: (tx: Record<string, (...a: never[]) => unknown>) => Promise<T>) =>
    mem.db.runTransaction((tx) =>
      fn({
        ...tx,
        update: ((ref: never, patch: Record<string, unknown>) => {
          if (failScheduleOf && patch.currentNodeId === failScheduleOf) {
            failScheduleOf = null;
            throw new Error("14 UNAVAILABLE: simulated write failure");
          }
          return tx.update(ref, patch as never);
        }) as never,
      } as never)
    ),
};

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  publishCallback: async (input: Publish) => {
    if (throwPublishOf === input.body.nodeId) {
      throwPublishOf = null;
      throw new Error("process died before the publish");
    }
    published.push(input);
    return { messageId: `q_${input.body.nodeId}` };
  },
}));

const { enrollForTest, runStep } = await import("./engine");

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

const twoTags = {
  n1: { id: "n1", type: "add_tag", config: { tag: "a" }, next: "n2" },
  n2: { id: "n2", type: "add_tag", config: { tag: "b" }, next: null },
};

async function runId(): Promise<string> {
  await enrollForTest({ subAccountId: "sa1", workflowId: "wf1", contactId: "c1" });
  return mem.list("workflowRuns")[0].id;
}
const run = (id: string) =>
  mem.read(`workflowRuns/${id}`) as { status: string; currentNodeId: string | null };
const nodesPublished = () => published.map((p) => p.body.nodeId);

beforeEach(() => {
  mem.clear();
  published.length = 0;
  failScheduleOf = null;
  throwPublishOf = null;
});

describe("re-driving a successor that was never scheduled", () => {
  it("the pre-publish write for n2 throws once → the retry of n1 publishes n2 and the run finishes", async () => {
    seed(twoTags);
    const id = await runId();
    failScheduleOf = "n2";
    await expect(runStep(id, "n1")).rejects.toThrow(/simulated/);
    expect(nodesPublished()).toEqual(["n1"]);
    expect(run(id)).toMatchObject({ status: "running", currentNodeId: "n1" });

    await runStep(id, "n1");
    expect(nodesPublished()).toEqual(["n1", "n2"]);
    expect(run(id).currentNodeId).toBe("n2");
    await runStep(id, "n2");
    expect(run(id).status).toBe("completed");
  });

  it("a crash after the state write but before the publish is re-driven too", async () => {
    seed(twoTags);
    const id = await runId();
    throwPublishOf = "n2";
    await expect(runStep(id, "n1")).rejects.toThrow(/process died/);
    expect(run(id).currentNodeId).toBe("n2");

    await runStep(id, "n1");
    expect(nodesPublished()).toEqual(["n1", "n2"]);
  });

  it("a re-driven wait keeps what is left of its delay", async () => {
    seed({
      n1: { id: "n1", type: "wait", config: { seconds: 3600 }, next: "n2" },
      n2: { id: "n2", type: "add_tag", config: { tag: "b" }, next: null },
    });
    const id = await runId();
    throwPublishOf = "n2";
    await expect(runStep(id, "n1")).rejects.toThrow();
    await runStep(id, "n1");
    const redriven = published.find((p) => p.body.nodeId === "n2")!;
    expect(redriven.delaySeconds).toBeGreaterThan(3590);
    expect(redriven.delaySeconds).toBeLessThanOrEqual(3600);
  });

  it("a redelivery of a step whose successor already ran re-drives nothing", async () => {
    seed(twoTags);
    const id = await runId();
    await runStep(id, "n1");
    await runStep(id, "n2");
    await runStep(id, "n1");
    expect(nodesPublished()).toEqual(["n1", "n2"]);
    expect(run(id).status).toBe("completed");
  });
});
