import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * A workflow SMS/WhatsApp step inside the workspace's quiet hours is deferred,
 * not dropped: the SAME step is rescheduled for the window's end, and when it
 * runs again it re-reads the contact, so an opt-out in between stops it. Real
 * engine, real readiness, real dispatcher and SMS seam, in-memory Firestore;
 * the Twilio senders are spies, so nothing is sent. 21:00Z = 23:00 SAST.
 */

const mem = createMemoryFirestore();
const publishCallback = vi.fn();
const sendWhatsappForSubAccount = vi.fn(async () => ({ sid: "SMtext", from: "+27110000000" }));

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  publishCallback: (...a: unknown[]) => publishCallback(...a),
}));
vi.mock("@/lib/server/conversations-service", () => ({
  upsertConversationForMessage: async () => undefined,
}));
vi.mock("@/lib/comms/twilio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/comms/twilio")>()),
  subAccountWhatsappIsConfigured: () => true,
  sendWhatsappForSubAccount: (...a: unknown[]) => sendWhatsappForSubAccount(...(a as [])),
}));

const { enrollForTest, runStep } = await import("./engine");

const NIGHT = new Date("2026-09-24T21:00:00Z");
const OPEN = new Date("2026-09-25T06:00:00Z");

function seedWorkflow(type: string, trigger = "message.received") {
  mem.seed("workflows/wf1", {
    name: "Follow up", subAccountId: "sa1", agencyId: "ag1", status: "active",
    startNodeId: "n1", createdByUid: "u_owner",
    trigger: { type: trigger, filters: { all: [] } },
    nodes: { n1: { id: "n1", type, config: { body: "Hi there" }, next: null } },
  });
}

/** enrollForTest carries no trigger context, and the in-memory store's server
 *  timestamp is a plain Date; a booking run is given both as production has
 *  them — the booking's context and a Firestore Timestamp. */
async function enrolled(context?: Record<string, unknown>): Promise<string> {
  await enrollForTest({ subAccountId: "sa1", workflowId: "wf1", contactId: "c1" });
  const runId = mem.list("workflowRuns")[0].id;
  if (context) {
    await mem.db.doc(`workflowRuns/${runId}`).update({ context, enrolledAt: Timestamp.fromDate(new Date()) });
  }
  return runId;
}

const stepPublishes = () =>
  publishCallback.mock.calls.map((c) => c[0] as { body: { nodeId: string }; delaySeconds: number; deduplicationId: string });

beforeEach(() => {
  mem.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NIGHT);
  publishCallback.mockReset().mockResolvedValue({ messageId: "q1" });
  sendWhatsappForSubAccount.mockClear();
  mem.seed("agencies/ag1", { ownerUid: "u_owner", name: "Agency" });
  mem.seed("users/u_owner", { displayName: "Owner", email: "owner@example.com" });
  mem.seed("subAccounts/sa1", {
    name: "Velocity", agencyId: "ag1", whatsappEnabledByAgency: true, whatsappProvider: "twilio",
    twilioConfig: { enabled: true, accountSid: "AC1", authTokenSet: true, fromNumber: "+27110000000", whatsappFromNumber: "+27110000000" },
    sendWindow: { startHour: 8, endHour: 20, timezone: "Africa/Johannesburg" },
  });
  mem.seed("contacts/c1", {
    subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Thandi",
    phone: "+27821234567", tags: [], customFields: {},
  });
  // An open WhatsApp window, so a free-form send is legal once released.
  mem.seed("contacts/c1/whatsappMessages/in1", { direction: "inbound", createdAt: Timestamp.fromDate(new Date(NIGHT.getTime() - 3600_000)) });
});
afterEach(() => vi.useRealTimers());

describe("workflow steps in quiet hours", () => {
  it("defers a WhatsApp step at 23:00 SAST to 08:00, same step, nothing sent", async () => {
    seedWorkflow("send_whatsapp");
    const runId = await enrolled();
    publishCallback.mockClear();
    await runStep(runId, "n1");

    expect(sendWhatsappForSubAccount).not.toHaveBeenCalled();
    const [p] = stepPublishes();
    expect(p.body.nodeId).toBe("n1");
    expect(p.delaySeconds).toBe(9 * 3600);
    // A fresh deduplication id: the step's original one would swallow it.
    expect(p.deduplicationId).toBe(`wf_${runId}_n1_qh_${OPEN.getTime()}`);
    const run = mem.read(`workflowRuns/${runId}`);
    expect(run?.history).toEqual([]);
    expect(run?.stepClaim ?? null).toBeNull();
    expect(run?.status).toBe("waiting");
  });

  it("sends when the deferred step runs after the window opens", async () => {
    seedWorkflow("send_whatsapp");
    const runId = await enrolled();
    await runStep(runId, "n1");
    vi.setSystemTime(OPEN);
    await runStep(runId, "n1");
    expect(sendWhatsappForSubAccount).toHaveBeenCalledOnce();
    expect(mem.read(`workflowRuns/${runId}`)?.history).toMatchObject([{ nodeId: "n1", result: "ok" }]);
  });

  it("re-checks opt-out when the deferred step runs", async () => {
    seedWorkflow("send_whatsapp");
    const runId = await enrolled();
    await runStep(runId, "n1");
    await mem.db.doc("contacts/c1").update({ whatsappOptedOut: true });
    vi.setSystemTime(OPEN);
    await runStep(runId, "n1");
    expect(sendWhatsappForSubAccount).not.toHaveBeenCalled();
    expect(mem.read(`workflowRuns/${runId}`)?.history).toMatchObject([{ nodeId: "n1", result: "skipped:opt_out" }]);
  });

  it("defers an SMS step at 23:00 too", async () => {
    seedWorkflow("send_sms");
    const runId = await enrolled();
    publishCallback.mockClear();
    await runStep(runId, "n1");
    const [p] = stepPublishes();
    expect(p).toMatchObject({ body: { nodeId: "n1" }, delaySeconds: 9 * 3600 });
    expect(mem.read(`workflowRuns/${runId}`)?.history).toEqual([]);
  });

  it("lets a confirmation of the customer's own booking-page booking through at 23:00", async () => {
    seedWorkflow("send_whatsapp", "booking.created");
    const runId = await enrolled({ bookingPageSlug: "consult" });
    await runStep(runId, "n1");
    expect(sendWhatsappForSubAccount).toHaveBeenCalledOnce();
  });

  it("holds a booking confirmation for a booking an operator entered (no booking page)", async () => {
    seedWorkflow("send_whatsapp", "booking.created");
    const runId = await enrolled({ bookingPageSlug: null });
    await runStep(runId, "n1");
    expect(sendWhatsappForSubAccount).not.toHaveBeenCalled();
  });
});
