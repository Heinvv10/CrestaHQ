import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The other half of branching on a reply: the resume has to WRITE what the
 * contact said onto the run. Without this write, every if_else downstream
 * reads null and silently takes the false branch — the feature looks wired
 * and does nothing.
 */

let runDoc: Record<string, unknown>;
const updates: Record<string, unknown>[] = [];
const publishCallback = vi.fn();

vi.mock("@/lib/automations/qstash", () => ({
  publishCallback: (...a: unknown[]) => publishCallback(...a),
  qstashIsConfigured: () => false,
}));

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    collection: () => ({
      where: function () { return this; },
      get: async () => ({
        empty: false,
        docs: [{ id: "run_1", ref: { id: "run_1" }, data: () => runDoc }],
      }),
    }),
    doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        get: async () => ({ exists: true, data: () => runDoc }),
        update: (_ref: unknown, data: Record<string, unknown>) => {
          updates.push(data);
        },
      }),
  }),
}));

import { resumeWaitingRunsOnReply } from "./engine";

describe("resumeWaitingRunsOnReply", () => {
  beforeEach(() => {
    updates.length = 0;
    runDoc = {
      id: "run_1",
      subAccountId: "sa_1",
      contactId: "c1",
      status: "waiting",
      waiting: { kind: "reply", nodeId: "n_wait" },
      history: [],
      context: {},
    };
  });

  it("records what the contact actually said on the run", async () => {
    await resumeWaitingRunsOnReply({
      subAccountId: "sa_1",
      contactId: "c1",
      channel: "whatsapp",
      text: "Could be better",
    });
    const written = updates.find((u) => "context.lastReply" in u);
    expect(written).toBeDefined();
    const reply = written!["context.lastReply"] as { text: string; channel: string };
    expect(reply.text).toBe("Could be better");
    expect(reply.channel).toBe("whatsapp");
  });

  it("caps an oversized body rather than carrying it for the life of the run", async () => {
    await resumeWaitingRunsOnReply({
      subAccountId: "sa_1",
      contactId: "c1",
      channel: "whatsapp",
      text: "x".repeat(5000),
    });
    const written = updates.find((u) => "context.lastReply" in u)!;
    expect((written["context.lastReply"] as { text: string }).text).toHaveLength(500);
  });

  it("still resumes a run when no text is supplied", async () => {
    await resumeWaitingRunsOnReply({
      subAccountId: "sa_1",
      contactId: "c1",
      channel: "sms",
    });
    const written = updates.find((u) => "context.lastReply" in u)!;
    expect((written["context.lastReply"] as { text: string }).text).toBe("");
    expect(written.status).toBe("running");
    expect(written.waiting).toBeNull();
  });
});
