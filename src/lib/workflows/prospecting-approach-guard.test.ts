import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The prospecting approach guard (Prospecting PR 4) through the REAL runStep
 * on an in-memory Firestore: one campaign (workflow) per prospect, stamped
 * before the send is dispatched, and a daily cap on first touches. The
 * provider is a mock, so nothing is ever sent.
 */

const mem = createMemoryFirestore();
const dispatchWhatsappSend = vi.fn();
const publishCallback = vi.fn();
// Transaction number (counted from `txCount = 0`) that throws — the guard's
// transaction is the second in a runStep, after the step claim.
let failTxAt = 0;
let txCount = 0;
const db = {
  ...mem.db,
  runTransaction: (fn: Parameters<typeof mem.db.runTransaction>[0]) => {
    txCount++;
    if (failTxAt && txCount === failTxAt) {
      return Promise.reject(new Error("14 UNAVAILABLE: guard transaction failed"));
    }
    return mem.db.runTransaction(fn);
  },
};

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  publishCallback: (...a: unknown[]) => publishCallback(...a),
}));
vi.mock("@/lib/comms/whatsapp/send-dispatch", () => ({
  dispatchWhatsappSend: (...a: unknown[]) => dispatchWhatsappSend(...a),
}));
vi.mock("@/lib/comms/whatsapp/readiness", () => ({
  checkWhatsappReadiness: async () => ({
    ready: true,
    provider: "bridge",
    sender: { phoneNumber: "+27110000000" },
  }),
}));
vi.mock("@/lib/comms/ai/agent", () => ({ getChannelConfig: async () => null }));
vi.mock("@/lib/server/conversations-service", () => ({
  upsertConversationForMessage: async () => undefined,
}));

const { enrollForTest, runStep } = await import("./engine");
const { APPROACH_REFUSED_LOG } = await import("@/lib/prospecting/approach-guard");

const COUNTERS = "subAccounts/sa1/prospectingFirstTouch";
const counter = () => mem.list(COUNTERS).reduce((n, d) => n + (d.count as number), 0);
const prospecting = (id: string) => mem.read(`contacts/${id}`)?.prospecting as Record<string, unknown> | undefined;

function seedProspect(id: string, extra: Record<string, unknown> = {}) {
  mem.seed(`contacts/${id}`, {
    subAccountId: "sa1", agencyId: "ag1", mode: "live", name: `Prospect ${id}`,
    phone: `+2782${id.padStart(7, "0").slice(-7)}`, tags: ["prospecting"], customFields: {},
    source: "prospecting", prospecting: { listId: "l1", approachedAt: null }, ...extra,
  });
}

function seedWorkflow(id: string, nodes: Record<string, unknown>) {
  mem.seed(`workflows/${id}`, {
    name: `Campaign ${id}`, subAccountId: "sa1", agencyId: "ag1", status: "active",
    startNodeId: "n1", createdByUid: "u_owner",
    trigger: { type: "prospecting.report.ready", filters: { all: [] } }, nodes,
  });
}

const send = (id: string, next: string | null = null) => ({ id, type: "send_whatsapp", config: { body: "Hi" }, next });

/** Enrol `contactId` in `workflowId` and run its first step; returns the run id. */
async function runFirst(workflowId: string, contactId: string): Promise<string> {
  const before = new Set(mem.list("workflowRuns").map((r) => r.id));
  await enrollForTest({ subAccountId: "sa1", workflowId, contactId });
  const runId = mem.list("workflowRuns").find((r) => !before.has(r.id))!.id;
  txCount = 0;
  await runStep(runId, "n1");
  return runId;
}

const dispatchedTo = () => dispatchWhatsappSend.mock.calls.map((c) => (c[0] as { contactId: string }).contactId);

beforeEach(() => {
  mem.clear();
  failTxAt = 0;
  publishCallback.mockReset().mockResolvedValue({ messageId: "q1" });
  dispatchWhatsappSend.mockReset().mockResolvedValue({ ok: true, messageId: "wamid1", sentAs: "text" });
  mem.seed("agencies/ag1", { ownerUid: "u_owner", name: "Agency" });
  mem.seed("users/u_owner", { displayName: "Owner", email: "owner@example.com" });
  mem.seed("subAccounts/sa1", { name: "Cresta", agencyId: "ag1", whatsappEnabledByAgency: true });
  seedWorkflow("wfA", { n1: send("n1") });
  seedWorkflow("wfB", { n1: send("n1") });
  seedProspect("p1");
});

describe("one campaign per prospect", () => {
  it("stamps approachedAt + approachedWorkflowId BEFORE the send is dispatched", async () => {
    let seenAtDispatch: Record<string, unknown> | undefined;
    dispatchWhatsappSend.mockImplementationOnce(async () => {
      seenAtDispatch = prospecting("p1");
      return { ok: true, messageId: "wamid1", sentAs: "text" };
    });
    await runFirst("wfA", "p1");
    expect(dispatchWhatsappSend).toHaveBeenCalledTimes(1);
    expect(seenAtDispatch?.approachedWorkflowId).toBe("wfA");
    expect(seenAtDispatch?.approachedAt).toBeInstanceOf(Date);
    expect(counter()).toBe(1);
  });

  it("a second workflow is refused: no dispatch, the run ends, the refusal is on the contact", async () => {
    await runFirst("wfA", "p1");
    const runB = await runFirst("wfB", "p1");
    expect(dispatchedTo()).toEqual(["p1"]);
    const run = mem.read(`workflowRuns/${runB}`);
    expect(run?.status).toBe("completed");
    expect(run?.history).toEqual([expect.objectContaining({ nodeId: "n1", result: APPROACH_REFUSED_LOG })]);
    expect(run?.stepClaim ?? null).toBeNull();
    expect(mem.read(`contacts/p1/activities/run_${runB}_n1_approach_guard`)).toMatchObject({
      type: "automation_step_skipped",
      meta: { kind: "approach_guard", approachedWorkflowId: "wfA", workflowId: "wfB" },
    });
    expect(prospecting("p1")?.approachedWorkflowId).toBe("wfA");
    expect(counter()).toBe(1);
  });

  it("the same workflow's later send goes out and is not counted again", async () => {
    seedWorkflow("wfA", { n1: send("n1", "n2"), n2: send("n2") });
    const runId = await runFirst("wfA", "p1");
    await runStep(runId, "n2");
    expect(dispatchedTo()).toEqual(["p1", "p1"]);
    expect(counter()).toBe(1);
    expect(mem.read(`workflowRuns/${runId}`)?.status).toBe("completed");
  });
});

describe("daily first-touch cap", () => {
  async function sendToMany(n: number): Promise<string[]> {
    const runs: string[] = [];
    for (let i = 1; i <= n; i++) {
      seedProspect(`q${i}`);
      runs.push(await runFirst("wfA", `q${i}`));
    }
    return runs;
  }

  it("20 first touches go out; the 21st is held to 08:00 tomorrow, not sent, not counted", async () => {
    const runs = await sendToMany(21);
    expect(dispatchWhatsappSend).toHaveBeenCalledTimes(20);
    expect(dispatchedTo()).not.toContain("q21");
    expect(counter()).toBe(20);
    const held = mem.read(`workflowRuns/${runs[20]}`);
    expect(held?.history ?? []).toEqual([]);
    expect(held?.stepClaim ?? null).toBeNull();
    expect(prospecting("q21")?.approachedAt ?? null).toBeNull();
    const rescheduled = publishCallback.mock.calls.at(-1)![0] as { body: { runId: string; nodeId: string }; delaySeconds: number };
    expect(rescheduled.body).toEqual({ runId: runs[20], nodeId: "n1" });
    expect(rescheduled.delaySeconds).toBeGreaterThan(8 * 3600);
    expect(rescheduled.delaySeconds).toBeLessThanOrEqual(32 * 3600);
    const hold = mem.list("contacts/q21/activities").find((a) => a.id.includes("_cap_"));
    expect(hold?.content).toMatch(/first-touch cap/);
  });

  it("honours the sub-account's own cap: 2 → the 3rd is held", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), prospectingDailyFirstTouchCap: 2 });
    await sendToMany(3);
    expect(dispatchedTo()).toEqual(["q1", "q2"]);
    expect(counter()).toBe(2);
  });
});

describe("what the guard leaves alone", () => {
  it("a non-prospect is sent to, never stamped or counted", async () => {
    mem.seed("contacts/c1", {
      subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Customer", phone: "+27821111111", tags: [], customFields: {},
    });
    await runFirst("wfA", "c1");
    await runFirst("wfB", "c1");
    expect(dispatchedTo()).toEqual(["c1", "c1"]);
    expect(mem.read("contacts/c1")?.prospecting).toBeUndefined();
    expect(counter()).toBe(0);
  });

  it("an opted-out prospect is skipped as before — not stamped, not counted", async () => {
    seedProspect("p2", { whatsappOptedOut: true });
    const runId = await runFirst("wfA", "p2");
    expect(dispatchWhatsappSend).not.toHaveBeenCalled();
    expect(mem.read(`workflowRuns/${runId}`)?.history).toEqual([expect.objectContaining({ result: "skipped:opt_out" })]);
    expect(prospecting("p2")?.approachedAt ?? null).toBeNull();
    expect(prospecting("p2")?.approachedWorkflowId).toBeUndefined();
    expect(counter()).toBe(0);
  });

  it("a guard transaction that fails throws, releases the claim and sends nothing", async () => {
    await enrollForTest({ subAccountId: "sa1", workflowId: "wfA", contactId: "p1" });
    const runId = mem.list("workflowRuns")[0].id;
    txCount = 0;
    failTxAt = 2;
    await expect(runStep(runId, "n1")).rejects.toThrow(/guard transaction failed/);
    expect(dispatchWhatsappSend).not.toHaveBeenCalled();
    expect(mem.read(`workflowRuns/${runId}`)?.stepClaim ?? null).toBeNull();
    expect(prospecting("p1")?.approachedAt ?? null).toBeNull();
    expect(counter()).toBe(0);
  });

  it("a person's WhatsApp from the conversation composer still reaches an approached prospect", async () => {
    await runFirst("wfA", "p1");
    const { sendConversationWhatsapp } = await import("@/lib/server/conversation-send/whatsapp");
    const contact = { id: "p1", ...mem.read("contacts/p1") } as never;
    const out = await sendConversationWhatsapp({
      contactId: "p1", contact, body: "Hi, following up", actor: { uid: "u_owner", email: "owner@example.com" }, humanReply: true,
    });
    expect(out.ok).toBe(true);
    expect(dispatchedTo()).toEqual(["p1", "p1"]);
  });
});
