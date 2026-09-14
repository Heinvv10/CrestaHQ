import { beforeEach, describe, expect, it, vi } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * SP5 d2 — what the dispatcher sends and logs, with reminders OFF (nothing
 * may change: characterization) and ON (a tracked /rr/ link on the channels
 * whose body we write, a reminder scheduled). Real dispatcher on an in-memory
 * Firestore; only Twilio, the inbox upsert and the QStash publish are doubles.
 */

const mem = createMemoryFirestore();
const sendSms = vi.fn();
const sendWa = vi.fn();
const publish = vi.fn();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/comms/twilio", () => ({
  smsIsConfigured: () => true,
  subAccountTwilioIsConfigured: () => true,
  sendSmsForSubAccount: (...a: unknown[]) => sendSms(...a),
  sendWhatsappForSubAccount: (...a: unknown[]) => sendWa(...a),
  sendWhatsappTemplateForSubAccount: vi.fn(),
}));
vi.mock("@/lib/comms/whatsapp/readiness", () => ({ checkWhatsappReadiness: async () => ({ ready: true, provider: "twilio" }) }));
vi.mock("@/lib/comms/whatsapp/send-dispatch", () => ({
  sendWhatsappFreeFormForSubAccount: async (i: { body: string }) => sendWa(i),
}));
vi.mock("@/lib/server/conversations-service", () => ({ upsertConversationForMessage: async () => undefined }));
vi.mock("@/lib/automations/qstash", () => ({ publishCallback: (...a: unknown[]) => publish(...a) }));

const { maybeSendReviewRequest } = await import("./request");

const REVIEW_URL = "https://g.page/r/acme/review";
const DEFAULT_BODY = `Hi Jane, thanks for choosing Acme Plumbing! If you have a moment, a quick Google review would mean a lot: ${REVIEW_URL}`;
const rows = () => mem.list("subAccounts/sa1/reviewRequests");
const smsBody = () => (sendSms.mock.calls[0] as [{ body: string }])[0].body;
const send = () => maybeSendReviewRequest({ subAccountId: "sa1", agencyId: "ag1", contactId: "c1", trigger: "manual", actorUid: "u1" });

function setConfig(over: Record<string, unknown> = {}) {
  mem.seed("subAccounts/sa1", {
    name: "Acme Plumbing", agencyId: "ag1", twilioConfig: { enabled: true }, whatsappEnabledByAgency: true,
    googleReviewConfig: {
      enabled: false, reviewUrl: REVIEW_URL, channel: "sms", messageTemplate: "", whatsappTemplateId: null,
      cooldownDays: 90, triggerOnQuotePaid: false, triggerOnDealCompleted: false, ...over,
    },
  });
}

beforeEach(() => {
  mem.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-for-click-tokens";
  process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
  sendSms.mockReset().mockResolvedValue({ sid: "SM1", from: "+15550001", mode: "dedicated" });
  sendWa.mockReset().mockResolvedValue({ sid: "WA1", from: "+15550002" });
  publish.mockReset().mockResolvedValue({ messageId: "q1" });
  setConfig();
  mem.seed("contacts/c1", { name: "Jane Doe", phone: "+61412345678", agencyId: "ag1", subAccountId: "sa1" });
});

describe("reminders OFF — nothing changes (characterization)", () => {
  it.each([
    ["no reminder field", {}],
    ["reminder null", { reminder: null }],
    ["everyDays null (Don't repeat)", { reminder: { everyDays: null, maxRetries: 3 } }],
    ["a malformed reminder", { reminder: { everyDays: 99, maxRetries: 3 } }],
  ])("%s: the body is byte-identical, the row has no new fields, nothing is scheduled", async (_l, over) => {
    setConfig(over);
    expect(await send()).toEqual({ sent: true });
    expect(smsBody()).toBe(DEFAULT_BODY);
    expect(rows()).toHaveLength(1);
    expect(Object.keys(rows()[0]).sort()).toEqual([
      "agencyId", "channel", "clickedAt", "contactId", "createdByUid", "failureKind", "feedbackAt", "id", "messageSid",
      "sentAt", "source", "status", "subAccountId", "trigger",
    ]);
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("reminders ON", () => {
  beforeEach(() => setConfig({ reminder: { everyDays: 3, maxRetries: 2 } }));

  it("SMS: the body carries the tracked /rr/ link for THIS request, and a reminder is scheduled", async () => {
    expect(await send()).toEqual({ sent: true });
    const [row] = rows();
    const link = `http://127.0.0.1:3100/rr/sa1.${row.id}.`;
    expect(smsBody().startsWith(DEFAULT_BODY.replace(REVIEW_URL, link))).toBe(true);
    expect(smsBody()).not.toContain(REVIEW_URL);
    expect(row).toMatchObject({
      source: "dispatcher", status: "sent", tracked: true,
      reminder: { everyDays: 3, maxRetries: 2, attempts: 0, state: "scheduled", stopReason: null, lastAttemptAt: null },
    });
    expect((row.reminder as { nextAt: Date }).nextAt).toBeInstanceOf(Date);
    expect(publish).toHaveBeenCalledWith({
      pathname: "/api/cron/review-reminder",
      body: { subAccountId: "sa1", requestId: row.id, attempt: 1 },
      delaySeconds: 3 * 86400,
      deduplicationId: `rr_${row.id}_1`,
    });
  });

  it("the tracked link resolves to this request (the /rr/ route can find it)", async () => {
    const { verifyReviewClickToken } = await import("./click-token");
    await send();
    const token = smsBody().split("/rr/")[1];
    expect(verifyReviewClickToken(token)).toEqual({ subAccountId: "sa1", requestId: rows()[0].id });
  });

  it("free-form WhatsApp is tracked too", async () => {
    setConfig({ channel: "whatsapp_manual", reminder: { everyDays: 1, maxRetries: 1 } });
    mem.seed("contacts/c1/whatsappMessages/in1", { direction: "inbound", createdAt: Timestamp.fromMillis(Date.now() - 3600_000) });
    expect(await send()).toEqual({ sent: true });
    expect((sendWa.mock.calls[0] as [{ body: string }])[0].body).toContain("/rr/sa1.");
    expect(rows()[0]).toMatchObject({ channel: "whatsapp", tracked: true, reminder: { state: "scheduled" } });
  });

  it("without an app URL the plain link is sent and the request is untracked (reminders still run)", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    await send();
    expect(smsBody()).toBe(DEFAULT_BODY);
    expect(rows()[0]).toMatchObject({ tracked: false, reminder: { state: "scheduled" } });
  });

  it("a scheduling failure never fails the send: the reminder is stopped, schedule_failed", async () => {
    publish.mockResolvedValueOnce(null);
    expect(await send()).toEqual({ sent: true });
    expect(rows()[0]).toMatchObject({ status: "sent", reminder: { state: "stopped", stopReason: "schedule_failed", nextAt: null } });
  });

  it("a refused send writes no row and schedules nothing", async () => {
    mem.seed("contacts/c1", { ...mem.read("contacts/c1"), smsOptedOut: true });
    expect(await send()).toEqual({ sent: false, reason: "opted_out" });
    expect(rows()).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("planReviewLink — which channels can be tracked", () => {
  it("an approved WhatsApp template's link is fixed: untracked, the plain review URL, reminders still planned", async () => {
    const { planReviewLink } = await import("./reminder");
    const plan = planReviewLink({
      config: { reminder: { everyDays: 2, maxRetries: 1 } }, channel: "whatsapp_template", subAccountId: "sa1",
      reviewUrl: REVIEW_URL, newRequestId: () => "req9",
    });
    expect(plan).toMatchObject({ requestId: "req9", bodyUrl: REVIEW_URL, tracked: false, reminder: { state: "scheduled" } });
  });
});
