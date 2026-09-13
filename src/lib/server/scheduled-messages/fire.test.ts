import { beforeEach, describe, expect, it, vi } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The scheduled-message worker, driven through the REAL send service over an
 * in-memory Firestore. Only the provider edges are replaced: Twilio's two
 * send functions (spies that must stay silent when a send is refused), the
 * conversation-index upsert, usage bookkeeping, and the caller's auth claims.
 * The WhatsApp window is decided by the real dispatcher (resolveWaSendMode)
 * from real whatsappMessages rows.
 */

const mem = createMemoryFirestore();
const m = vi.hoisted(() => ({
  sms: vi.fn(),
  wa: vi.fn(),
  upsert: vi.fn(),
  dispatch: vi.fn(),
  claims: { status: "active", agencyRole: "owner", agencyId: "ag1" } as Record<string, unknown>,
  userExists: true,
}));

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => mem.db,
  getAdminAuth: () => ({
    getUser: async (uid: string) => {
      if (!m.userExists) throw new Error("auth/user-not-found");
      return { uid, email: "op@example.com", customClaims: m.claims };
    },
  }),
}));
vi.mock("@/lib/comms/twilio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/comms/twilio")>()),
  sendSmsForSubAccount: m.sms,
  sendWhatsappForSubAccount: m.wa,
}));
// The real dispatcher, observed: the window decision stays real.
vi.mock("@/lib/comms/whatsapp/send-dispatch", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/comms/whatsapp/send-dispatch")>();
  return {
    ...real,
    dispatchWhatsappSend: (input: Parameters<typeof real.dispatchWhatsappSend>[0]) => {
      m.dispatch(input);
      return real.dispatchWhatsappSend(input);
    },
  };
});
vi.mock("@/lib/server/conversations-service", () => ({
  upsertConversationForMessage: m.upsert,
}));
vi.mock("@/lib/comms/usage", () => ({ recordSend: async () => {} }));
vi.mock("@/lib/comms/ai/agent", () => ({ getChannelConfig: async () => null }));

const { fireScheduledMessage } = await import("./fire");

const TWILIO = {
  enabled: true,
  accountSid: "AC1",
  authToken: "tok",
  fromNumber: "+15550001",
  whatsappFromNumber: "+15550002",
};
const PATH = "contacts/c1/scheduledMessages";

function seedScheduled(id: string, data: Record<string, unknown> = {}) {
  mem.seed(`${PATH}/${id}`, {
    agencyId: "ag1",
    subAccountId: "sa1",
    createdByUid: "u1",
    contactId: "c1",
    channel: "sms",
    body: "See you at 3",
    subject: null,
    inReplyTo: null,
    references: null,
    sendAt: Timestamp.fromMillis(Date.now()),
    status: "pending",
    failureReason: null,
    failureCode: null,
    qstashMessageId: "msg_1",
    sentMessageId: null,
    ...data,
  });
}
const doc = (id: string) => mem.read(`${PATH}/${id}`)!;

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  m.claims = { status: "active", agencyRole: "owner", agencyId: "ag1" };
  m.userExists = true;
  m.sms.mockResolvedValue({ sid: "SM1", mode: "dedicated", from: TWILIO.fromNumber });
  m.wa.mockResolvedValue({ sid: "WA1", from: `whatsapp:${TWILIO.whatsappFromNumber}` });
  mem.seed("subAccounts/sa1", {
    agencyId: "ag1",
    twilioConfig: TWILIO,
    whatsappEnabledByAgency: true,
    emailProvider: "smtp",
  });
  mem.seed("contacts/c1", {
    agencyId: "ag1",
    subAccountId: "sa1",
    name: "Ann",
    phone: "+27820000001",
    email: "ann@example.com",
  });
});

describe("fireScheduledMessage — idempotency", () => {
  it("sends once and records it: message row, conversation index, status sent", async () => {
    seedScheduled("s1");
    expect(await fireScheduledMessage("c1", "s1")).toEqual({ outcome: "sent", messageId: "SM1" });
    expect(m.sms).toHaveBeenCalledTimes(1);
    expect(m.sms).toHaveBeenCalledWith(
      expect.objectContaining({ subAccountId: "sa1", to: "+27820000001", body: "See you at 3" })
    );
    expect(mem.read("contacts/c1/messages/SM1")).toMatchObject({
      direction: "outbound",
      body: "See you at 3",
      sentByUid: "u1",
    });
    expect(m.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: "c1", channel: "sms", direction: "outbound" })
    );
    expect(doc("s1")).toMatchObject({ status: "sent", sentMessageId: "SM1" });
  });

  it("a second delivery is a no-op — sequential", async () => {
    seedScheduled("s1");
    await fireScheduledMessage("c1", "s1");
    expect(await fireScheduledMessage("c1", "s1")).toEqual({
      outcome: "skipped",
      reason: "status:sent",
    });
    expect(m.sms).toHaveBeenCalledTimes(1);
  });

  it("two concurrent deliveries send exactly once", async () => {
    seedScheduled("s1");
    const results = await Promise.all([
      fireScheduledMessage("c1", "s1"),
      fireScheduledMessage("c1", "s1"),
    ]);
    expect(m.sms).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.outcome).sort()).toEqual(["sent", "skipped"]);
  });

  it("a cancelled message never sends", async () => {
    seedScheduled("s1", { status: "cancelled" });
    expect(await fireScheduledMessage("c1", "s1")).toEqual({
      outcome: "skipped",
      reason: "status:cancelled",
    });
    expect(m.sms).not.toHaveBeenCalled();
    expect(doc("s1").status).toBe("cancelled");
  });

  it("a missing message is skipped", async () => {
    expect(await fireScheduledMessage("c1", "nope")).toEqual({
      outcome: "skipped",
      reason: "missing",
    });
    expect(m.sms).not.toHaveBeenCalled();
  });
});

describe("fireScheduledMessage — re-evaluated at fire time (ruling 6)", () => {
  it("WhatsApp window closed → failed with the reason, NO send, no template", async () => {
    seedScheduled("w1", { channel: "whatsapp", body: "Following up" });
    // Last inbound 25h ago: the 24h window has closed since the booking.
    mem.seed("contacts/c1/whatsappMessages/in1", {
      direction: "inbound",
      body: "hi",
      createdAt: Timestamp.fromMillis(Date.now() - 25 * 3600_000),
    });
    const result = await fireScheduledMessage("c1", "w1");
    expect(result.outcome).toBe("failed");
    expect(m.wa).not.toHaveBeenCalled();
    expect(doc("w1")).toMatchObject({
      status: "failed",
      failureCode: "session_window_closed",
      failureReason: expect.stringMatching(/window is closed/),
    });
    expect(mem.list("contacts/c1/whatsappMessages")).toHaveLength(1);
  });

  it("WhatsApp window still open → sends, without the human-reply quiet-hours exemption", async () => {
    seedScheduled("w2", { channel: "whatsapp", body: "Following up" });
    mem.seed("contacts/c1/whatsappMessages/in1", {
      direction: "inbound",
      body: "hi",
      createdAt: Timestamp.fromMillis(Date.now() - 3600_000),
    });
    expect((await fireScheduledMessage("c1", "w2")).outcome).toBe("sent");
    expect(m.wa).toHaveBeenCalledTimes(1);
    expect(m.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        humanReply: false,
        template: null,
        idempotencyKey: "scheduled_w2",
      })
    );
    expect(doc("w2").status).toBe("sent");
  });

  it("SMS opt-out since booking → failed, no send", async () => {
    seedScheduled("s1");
    await mem.db.doc("contacts/c1").update({ smsOptedOut: true });
    const result = await fireScheduledMessage("c1", "s1");
    expect(result).toMatchObject({ outcome: "failed", reason: expect.stringMatching(/opted out of SMS/) });
    expect(m.sms).not.toHaveBeenCalled();
    expect(doc("s1").status).toBe("failed");
  });

  it("WhatsApp opt-out since booking → failed, no send", async () => {
    seedScheduled("w1", { channel: "whatsapp" });
    await mem.db.doc("contacts/c1").update({ whatsappOptedOut: true });
    expect((await fireScheduledMessage("c1", "w1")).outcome).toBe("failed");
    expect(m.wa).not.toHaveBeenCalled();
  });

  it("email opt-out since booking → failed before anything is sent", async () => {
    seedScheduled("e1", { channel: "email", subject: "Hello" });
    await mem.db.doc("contacts/c1").update({ emailOptedOut: true });
    expect(await fireScheduledMessage("c1", "e1")).toMatchObject({
      outcome: "failed",
      reason: "This contact has opted out of email.",
    });
  });

  it("agency gate switched off since booking → failed, no send", async () => {
    seedScheduled("w1", { channel: "whatsapp" });
    await mem.db.doc("subAccounts/sa1").update({ whatsappEnabledByAgency: false });
    expect(await fireScheduledMessage("c1", "w1")).toMatchObject({
      outcome: "failed",
      reason: expect.stringMatching(/disabled .* by your agency/),
    });
    expect(m.wa).not.toHaveBeenCalled();
  });

  it("contact deleted since booking → failed, no send", async () => {
    seedScheduled("s1");
    await mem.db.doc("contacts/c1").delete();
    expect(await fireScheduledMessage("c1", "s1")).toMatchObject({
      outcome: "failed",
      reason: "The contact no longer exists.",
    });
    expect(m.sms).not.toHaveBeenCalled();
  });

  it("phone removed since booking → failed, no send", async () => {
    seedScheduled("s1");
    await mem.db.doc("contacts/c1").update({ phone: "" });
    expect((await fireScheduledMessage("c1", "s1")).outcome).toBe("failed");
    expect(m.sms).not.toHaveBeenCalled();
  });

  it("the booking user lost access since → failed, no send", async () => {
    seedScheduled("s1");
    m.claims = { status: "removed" };
    expect(await fireScheduledMessage("c1", "s1")).toMatchObject({
      outcome: "failed",
      reason: expect.stringMatching(/no longer has access/),
    });
    expect(m.sms).not.toHaveBeenCalled();
  });

  it("a send that throws after the claim is failed with 'outcome unknown', never retried", async () => {
    seedScheduled("s1");
    m.upsert.mockRejectedValueOnce(new Error("index write failed"));
    const result = await fireScheduledMessage("c1", "s1");
    expect(result).toMatchObject({ outcome: "failed", reason: expect.stringMatching(/may or may not have gone out/) });
    expect(await fireScheduledMessage("c1", "s1")).toMatchObject({ outcome: "skipped" });
    expect(m.sms).toHaveBeenCalledTimes(1);
  });
});
