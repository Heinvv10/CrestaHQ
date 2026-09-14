import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * SP5 d1 — every review ask is logged ONCE, by the code that initiated the
 * send. Real `runStep` and the real dispatcher on an in-memory Firestore;
 * only the providers are doubles. One dispatcher send = one row (source
 * dispatcher), one workflow send = one row (source workflow): detection lives
 * at the send-initiating level, never in the transport both of them share.
 */

const mem = createMemoryFirestore();
const sendSms = vi.fn();
const sendEmail = vi.fn();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  publishCallback: async () => ({ messageId: "q1" }),
}));
vi.mock("@/lib/comms/resend", () => ({
  emailIsConfigured: () => true,
  tenantFrom: () => "sender@tenant.test",
  sendEmail: (...a: unknown[]) => sendEmail(...a),
}));
vi.mock("@/lib/comms/twilio", () => ({
  smsIsConfigured: () => true,
  subAccountTwilioIsConfigured: () => true,
  sendSmsForSubAccount: (...a: unknown[]) => sendSms(...a),
  sendWhatsappForSubAccount: async () => ({}),
  sendWhatsappTemplateForSubAccount: async () => ({}),
  SmsRecipientUnsubscribedError: class extends Error {},
}));
vi.mock("@/lib/server/conversations-service", () => ({ upsertConversationForMessage: async () => undefined }));
vi.mock("@/lib/agency/policy", () => ({ agencyAllowsSharedSms: async () => true }));
vi.mock("@/lib/server/usage-meter", () => ({
  checkQuota: async () => ({ allowed: true }),
  UsageQuotaExceededError: class extends Error {},
}));
vi.mock("@/lib/automations/unsubscribe-token", () => ({ buildUnsubscribeUrl: () => "https://app.test/u/x" }));

const { runStep } = await import("@/lib/workflows/engine");
const { maybeSendReviewRequest } = await import("./request");

const REVIEW_URL = "https://g.page/r/velocity/review";
const rows = () => mem.list("subAccounts/sa1/reviewRequests");

function seedRun(node: Record<string, unknown>) {
  mem.seed("workflows/wf1", {
    name: "Nudge", subAccountId: "sa1", agencyId: "ag1", status: "active",
    startNodeId: "n1", createdByUid: "u_owner",
    trigger: { type: "contact.tag.added", filters: { all: [] } },
    nodes: { n1: { id: "n1", next: null, ...node } },
  });
  mem.seed("workflowRuns/run1", {
    id: "run1", subAccountId: "sa1", agencyId: "ag1", workflowId: "wf1",
    contactId: "c1", status: "running", currentNodeId: "n1", history: [], context: {},
  });
}

beforeEach(() => {
  mem.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  sendSms.mockReset().mockResolvedValue({ sid: "SM_1", from: "+15550001", mode: "dedicated" });
  sendEmail.mockReset().mockResolvedValue({ id: "email_1" });
  mem.seed("agencies/ag1", { ownerUid: "u_owner", name: "Agency" });
  mem.seed("users/u_owner", { displayName: "Owner", email: "owner@example.com" });
  mem.seed("subAccounts/sa1", {
    name: "Velocity", agencyId: "ag1", twilioConfig: { enabled: true },
    googleReviewConfig: {
      enabled: false, reviewUrl: REVIEW_URL, channel: "sms", messageTemplate: "", whatsappTemplateId: null,
      cooldownDays: 90, triggerOnQuotePaid: false, triggerOnDealCompleted: false,
    },
  });
  mem.seed("contacts/c1", {
    subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Thandi",
    email: "thandi@example.com", phone: "+27821234567", tags: [], customFields: {},
  });
});

describe("one send, one row", () => {
  it("a dispatcher send writes exactly one row, source dispatcher", async () => {
    expect(await maybeSendReviewRequest({ subAccountId: "sa1", agencyId: "ag1", contactId: "c1", trigger: "manual", actorUid: "u_admin" }))
      .toEqual({ sent: true });
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ source: "dispatcher", channel: "sms", trigger: "manual", createdByUid: "u_admin" });
  });

  it("a workflow SMS carrying the review link writes exactly one row, source workflow", async () => {
    seedRun({ type: "send_sms", config: { body: `Hi {{contact.firstName}}, a review would help: ${REVIEW_URL}` } });
    await runStep("run1", "n1");
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(1);
    const { sentAt, ...row } = rows()[0];
    expect(row).toEqual({
      id: expect.any(String), agencyId: "ag1", subAccountId: "sa1", createdByUid: "workflow", contactId: "c1",
      channel: "sms", source: "workflow", trigger: null, status: "sent", failureKind: null, messageSid: "SM_1",
      clickedAt: null, feedbackAt: null,
    });
    expect(sentAt).toBeInstanceOf(Date);
    // Never the body or the number.
    expect(JSON.stringify(rows())).not.toMatch(/Thandi|\+2782|g\.page/);
  });

  it("a workflow SMS without the link writes nothing", async () => {
    seedRun({ type: "send_sms", config: { body: "Your install is booked for Tuesday." } });
    await runStep("run1", "n1");
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(rows()).toEqual([]);
  });

  it("a workflow email carrying the link is logged as email", async () => {
    seedRun({ type: "send_email", config: { subject: "Thanks!", body: `Review us: ${REVIEW_URL}` } });
    await runStep("run1", "n1");
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ channel: "email", source: "workflow", status: "sent", messageSid: "email_1" });
  });

  it("a workflow review ask whose send failed is logged failed with a kind, never the provider text", async () => {
    sendSms.mockRejectedValueOnce(new Error("The 'To' number +27821234567 is not a valid phone number."));
    seedRun({ type: "send_sms", config: { body: `Review us: ${REVIEW_URL}` } });
    await runStep("run1", "n1");
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ source: "workflow", status: "failed", failureKind: "send_failed", messageSid: null });
  });

  it("a skipped step is not a request (opted out)", async () => {
    mem.seed("contacts/c1", { ...mem.read("contacts/c1"), smsOptedOut: true });
    seedRun({ type: "send_sms", config: { body: `Review us: ${REVIEW_URL}` } });
    await runStep("run1", "n1");
    expect(sendSms).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });

  it("with no review link configured, nothing is a review ask", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), googleReviewConfig: null });
    seedRun({ type: "send_sms", config: { body: `Review us: ${REVIEW_URL}` } });
    await runStep("run1", "n1");
    expect(rows()).toEqual([]);
  });
});
