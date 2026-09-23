import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * A customer-message step is claimed on the run doc, in a transaction,
 * BEFORE the provider is called — so a QStash redelivery (concurrent, or
 * after the history write failed / the process died mid-step) can never
 * message the contact a second time. At-most-once: a claim that never got
 * its history entry holds the step, and the delivery's final retry fails the
 * run visibly instead of re-sending. Real engine on an in-memory Firestore;
 * the provider is a counter, so nothing is ever sent.
 */

const mem = createMemoryFirestore();
let failNextRunUpdate = false;
let readinessThrows = false;
const dispatchWhatsappSend = vi.fn();
const publishCallback = vi.fn();
const providerAttempted = vi.fn();

// The run doc's `update` can be made to fail once — the "history write failed
// after the send" case. Everything else is the plain in-memory store.
const db = {
  ...mem.db,
  collection: (path: string) => {
    const coll = mem.db.collection(path);
    if (path !== "workflowRuns") return coll;
    return {
      ...coll,
      doc: (id?: string) => {
        const ref = coll.doc(id);
        return {
          ...ref,
          update: async (patch: Record<string, unknown>) => {
            if (failNextRunUpdate && "history" in patch) {
              failNextRunUpdate = false;
              throw new Error("14 UNAVAILABLE: simulated write failure");
            }
            return ref.update(patch);
          },
        };
      },
    };
  },
};

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  publishCallback: (...a: unknown[]) => publishCallback(...a),
}));
vi.mock("@/lib/comms/provider-attempt", () => ({
  providerAttempted: (...a: unknown[]) => providerAttempted(...a),
}));
vi.mock("@/lib/comms/whatsapp/send-dispatch", () => ({
  dispatchWhatsappSend: (...a: unknown[]) => dispatchWhatsappSend(...a),
}));
vi.mock("@/lib/comms/whatsapp/readiness", () => ({
  checkWhatsappReadiness: async () => {
    if (readinessThrows) {
      readinessThrows = false;
      throw new Error("14 UNAVAILABLE: readiness read failed");
    }
    return {
    ready: true,
    provider: "bridge",
    sender: { phoneNumber: "+27110000000" },
    };
  },
}));
vi.mock("@/lib/server/conversations-service", () => ({
  upsertConversationForMessage: async () => undefined,
}));

const { enrollForTest, runStep, failRunAfterFinalRetry } = await import("./engine");

beforeEach(() => {
  mem.clear();
  failNextRunUpdate = false;
  readinessThrows = false;
  publishCallback.mockReset().mockResolvedValue({ messageId: "q1" });
  providerAttempted.mockReset().mockReturnValue(true);
  dispatchWhatsappSend.mockReset().mockResolvedValue({ ok: true, messageId: "wamid1", sentAs: "text" });
  mem.seed("agencies/ag1", { ownerUid: "u_owner", name: "Agency" });
  mem.seed("users/u_owner", { displayName: "Owner", email: "owner@example.com" });
  mem.seed("subAccounts/sa1", { name: "Velocity", agencyId: "ag1", whatsappEnabledByAgency: true });
  mem.seed("contacts/c1", {
    subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Thandi",
    phone: "+27821234567", tags: [], customFields: {},
  });
  mem.seed("workflows/wf1", {
    name: "Auto reply", subAccountId: "sa1", agencyId: "ag1", status: "active",
    startNodeId: "n1", createdByUid: "u_owner",
    trigger: { type: "message.received", filters: { all: [] } },
    nodes: { n1: { id: "n1", type: "send_whatsapp", config: { body: "Hi {{contact.first_name}}" }, next: null } },
  });
});

async function enrolled(): Promise<string> {
  await enrollForTest({ subAccountId: "sa1", workflowId: "wf1", contactId: "c1" });
  return mem.list("workflowRuns")[0].id;
}

describe("send step claim", () => {
  it("two concurrent deliveries of the same step send once", async () => {
    const runId = await enrolled();
    await Promise.allSettled([runStep(runId, "n1"), runStep(runId, "n1")]);
    expect(dispatchWhatsappSend).toHaveBeenCalledTimes(1);
  });

  it("a redelivery after the history write failed does not send again", async () => {
    const runId = await enrolled();
    failNextRunUpdate = true;
    await expect(runStep(runId, "n1")).rejects.toThrow();
    expect(dispatchWhatsappSend).toHaveBeenCalledTimes(1);
    // The claim is on the run for anyone looking.
    expect(mem.read(`workflowRuns/${runId}`)?.stepClaim).toMatchObject({ nodeId: "n1", state: "sending" });

    await expect(runStep(runId, "n1")).rejects.toThrow(/claimed/);
    expect(dispatchWhatsappSend).toHaveBeenCalledTimes(1);
  });

  it("the final retry of a stuck claim fails the run visibly, never re-sends", async () => {
    const runId = await enrolled();
    failNextRunUpdate = true;
    await expect(runStep(runId, "n1")).rejects.toThrow();

    await failRunAfterFinalRetry(runId, "n1", new Error("step n1 is already claimed"));
    expect(dispatchWhatsappSend).toHaveBeenCalledTimes(1);
    const run = mem.read(`workflowRuns/${runId}`);
    expect(run?.status).toBe("failed");
    expect(mem.read(`contacts/c1/activities/run_${runId}_automation_failed`)?.content).toMatch(
      /send_whatsapp step .*already claimed/
    );
  });

  it("a completed step clears its claim, and the bridge gets a key stable across deliveries", async () => {
    const runId = await enrolled();
    await runStep(runId, "n1");
    await runStep(runId, "n1");
    expect(dispatchWhatsappSend).toHaveBeenCalledTimes(1);
    expect(dispatchWhatsappSend.mock.calls[0][0].idempotencyKey).toBe(`wf_${runId}_n1`);
    const run = mem.read(`workflowRuns/${runId}`);
    expect(run?.status).toBe("completed");
    expect(run?.stepClaim ?? null).toBeNull();
  });

  it("a throw BEFORE any provider call releases the claim, so the retry sends", async () => {
    const runId = await enrolled();
    readinessThrows = true;
    await expect(runStep(runId, "n1")).rejects.toThrow(/readiness/);
    expect(dispatchWhatsappSend).not.toHaveBeenCalled();
    expect(mem.read(`workflowRuns/${runId}`)?.stepClaim ?? null).toBeNull();

    await runStep(runId, "n1");
    expect(dispatchWhatsappSend).toHaveBeenCalledTimes(1);
    expect(mem.read(`workflowRuns/${runId}`)?.status).toBe("completed");
  });

  it("a throw AFTER the provider call started keeps the claim — never re-sent", async () => {
    const runId = await enrolled();
    dispatchWhatsappSend.mockRejectedValueOnce(new Error("socket hang up"));
    providerAttempted.mockImplementationOnce(() => {
      throw new Error("classifier blew up");
    });
    await expect(runStep(runId, "n1")).rejects.toThrow(/classifier/);
    expect(mem.read(`workflowRuns/${runId}`)?.stepClaim).toMatchObject({ nodeId: "n1", state: "sending" });

    await expect(runStep(runId, "n1")).rejects.toThrow(/claimed/);
    expect(dispatchWhatsappSend).toHaveBeenCalledTimes(1);
  });

  it("a run failed mid-send by the final retry is not resurrected by the finishing delivery", async () => {
    mem.seed("workflows/wf1", {
      ...mem.read("workflows/wf1"),
      nodes: {
        n1: { id: "n1", type: "send_whatsapp", config: { body: "Hi" }, next: "n2" },
        n2: { id: "n2", type: "add_tag", config: { tag: "x" }, next: null },
      },
    });
    const runId = await enrolled();
    dispatchWhatsappSend.mockImplementationOnce(async () => {
      await failRunAfterFinalRetry(runId, "n1", new Error("step n1 is already claimed"));
      return { ok: true, messageId: "wamid1", sentAs: "text" };
    });
    await runStep(runId, "n1");
    expect(mem.read(`workflowRuns/${runId}`)?.status).toBe("failed");
    const published = publishCallback.mock.calls.map((c) => (c[0] as { body: { nodeId: string } }).body.nodeId);
    expect(published).toEqual(["n1"]);
  });
});
