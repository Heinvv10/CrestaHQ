import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * An if_else that tells a clean "yes" from a "yes, but…": match ALL of
 * [reply.text starts_with_word "yes", reply.text not_contains "but"]. Driven
 * through the real engine step (runStep) against the run's recorded reply,
 * asserting which branch the engine scheduled next. Only Firestore (in
 * memory) and QStash (captured) are stubbed.
 */

const mem = createMemoryFirestore();
const published: Array<{ runId: string; nodeId: string; phase?: string }> = [];

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  publishCallback: async (input: { body: { runId: string; nodeId: string; phase?: string } }) => {
    published.push(input.body);
    return { messageId: `msg_${published.length}` };
  },
}));

const { runStep } = await import("./engine");

function seed(replyText: string) {
  mem.seed("agencies/ag1", { ownerUid: "u_owner", name: "Agency" });
  mem.seed("subAccounts/sa1", { name: "Velocity", agencyId: "ag1" });
  mem.seed("contacts/c1", {
    subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Thandi",
    phone: "+27821234567", tags: [], customFields: {},
  });
  mem.seed("workflows/wf1", {
    subAccountId: "sa1", agencyId: "ag1", status: "active", startNodeId: "n_if",
    trigger: { type: "contact.tag.added", filters: { all: [] } },
    nodes: {
      n_if: {
        id: "n_if", type: "if_else",
        config: {
          conditions: {
            match: "all",
            all: [
              { field: "reply.text", op: "starts_with_word", value: "yes" },
              { field: "reply.text", op: "not_contains", value: "but" },
            ],
          },
        },
        branches: { whenTrue: "n_done", whenFalse: "n_issue" },
      },
      n_done: { id: "n_done", type: "add_tag", config: { tag: "all-done" } },
      n_issue: { id: "n_issue", type: "add_tag", config: { tag: "has-issue" } },
    },
  });
  mem.seed("workflowRuns/run1", {
    id: "run1", subAccountId: "sa1", agencyId: "ag1", workflowId: "wf1",
    contactId: "c1", status: "running", currentNodeId: "n_if", history: [],
    context: { lastReply: { text: replyText, channel: "whatsapp" } },
  });
}

async function branchFor(replyText: string): Promise<string | undefined> {
  seed(replyText);
  await runStep("run1", "n_if");
  return published.filter((p) => p.runId === "run1" && !p.phase).at(-1)?.nodeId;
}

beforeEach(() => {
  mem.clear();
  published.length = 0;
});

describe("if_else on starts_with_word + not_contains", () => {
  it("a clean yes takes the true branch", async () => {
    expect(await branchFor("Yes i think everything is done")).toBe("n_done");
  });

  it("a yes with a 'but' takes the false branch", async () => {
    expect(await branchFor("Yes but the cable is hanging")).toBe("n_issue");
  });

  it("'Yesterday…' is not a yes", async () => {
    expect(await branchFor("Yesterday the tech never came")).toBe("n_issue");
  });
});
