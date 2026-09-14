import { beforeEach, describe, expect, it, vi } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * SP5 d2, review round 1 — the reminder worker's per-contact and master
 * stops, over the REAL dispatcher and an in-memory Firestore. One chain per
 * contact; a reply, a click on any of their requests, a newer request, a
 * changed number, an archived / paused sub-account, auto-send switched off for
 * an auto-triggered request, or lost link tracking all stop it without a send.
 */

const mem = createMemoryFirestore();
const sendSms = vi.fn();
const publish = vi.fn();
const dedicated = vi.hoisted(() => ({ on: true }));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/comms/twilio", () => ({
  smsIsConfigured: () => true,
  subAccountTwilioIsConfigured: () => dedicated.on,
  sendSmsForSubAccount: (...a: unknown[]) => sendSms(...a),
  sendWhatsappForSubAccount: vi.fn(),
  sendWhatsappTemplateForSubAccount: vi.fn(),
}));
vi.mock("@/lib/server/conversations-service", () => ({ upsertConversationForMessage: async () => undefined }));
vi.mock("@/lib/automations/qstash", () => ({ publishCallback: (...a: unknown[]) => publish(...a) }));

const { runReviewReminder } = await import("./reminder-run");
const { phoneHash, templateHash } = await import("./reminder-checks");
const { DEFAULT_REVIEW_SMS_TEMPLATE } = await import("./constants");

const PHONE = "+61412345678";
const SENT_AT = Date.now() - 2 * 86_400_000;
const REQ = "subAccounts/sa1/reviewRequests/req1";
const req = () => mem.read(REQ) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const run = () => runReviewReminder({ subAccountId: "sa1", requestId: "req1", attempt: 1 });

function setSub(cfg: Record<string, unknown> = {}, sub: Record<string, unknown> = {}) {
  mem.seed("subAccounts/sa1", {
    name: "Acme Plumbing", agencyId: "ag1", status: "active", twilioConfig: { enabled: true, inboundWebhookConfigured: true }, ...sub,
    googleReviewConfig: {
      enabled: false, reviewUrl: "https://g.page/r/acme/review", channel: "sms", messageTemplate: "", whatsappTemplateId: null,
      cooldownDays: 90, triggerOnQuotePaid: false, triggerOnDealCompleted: false, reminder: { everyDays: 2, maxRetries: 3 }, ...cfg,
    },
  });
}

function seedReq(id: string, more: Record<string, unknown> = {}) {
  mem.seed(`subAccounts/sa1/reviewRequests/${id}`, {
    agencyId: "ag1", subAccountId: "sa1", createdByUid: "u1", contactId: "c1", channel: "sms", source: "dispatcher",
    trigger: "manual", status: "sent", sentAt: new Date(SENT_AT), clickedAt: null, feedbackAt: null, tracked: true,
    toHash: phoneHash(PHONE),
    templateHash: templateHash(DEFAULT_REVIEW_SMS_TEMPLATE),
    reminder: { everyDays: 2, maxRetries: 3, attempts: 0, nextAt: new Date(), state: "scheduled", stopReason: null, lastAttemptAt: null },
    ...more,
  });
}

beforeEach(() => {
  mem.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-for-click-tokens";
  process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
  sendSms.mockReset().mockResolvedValue({ sid: "SM1", from: "+15550001", mode: "dedicated" });
  publish.mockReset().mockResolvedValue({ messageId: "q2" });
  dedicated.on = true;
  setSub();
  mem.seed("contacts/c1", { name: "Jane Doe", phone: PHONE, agencyId: "ag1", subAccountId: "sa1" });
  seedReq("req1");
});

async function expectStop(reason: string) {
  expect(await run()).toEqual({ outcome: "stopped", reason });
  expect(sendSms).not.toHaveBeenCalled();
  expect(req().reminder).toMatchObject({ state: "stopped", stopReason: reason, attempts: 0 });
}

describe("one chain per contact", () => {
  it("a newer review request from the dispatcher supersedes this one", async () => {
    seedReq("newer", { sentAt: new Date(SENT_AT + 3600_000), reminder: null });
    await expectStop("superseded");
  });

  it("an inbox or workflow ask does not supersede it", async () => {
    seedReq("inboxAsk", { sentAt: new Date(SENT_AT + 3600_000), source: "inbox", reminder: null, tracked: undefined });
    expect(await run()).toEqual({ outcome: "sent" });
  });

  it("a click on ANY of the contact's requests since this one stops it", async () => {
    seedReq("newerClicked", { sentAt: new Date(SENT_AT + 3600_000), clickedAt: new Date(), reminder: null });
    await expectStop("clicked_other");
  });

  it("a click on an OLDER request made AFTER this one was sent stops it (the customer reviewed from the old link)", async () => {
    // A sent day 0, this one (B) day 1 superseding it, the customer taps A's link on day 2.
    seedReq("olderA", { sentAt: new Date(SENT_AT - 86_400_000), clickedAt: new Date(SENT_AT + 86_400_000), reminder: null });
    await expectStop("clicked_other");
  });

  it("a RE-click on an older link after this request stops it (lastClickedAt, not only the first click)", async () => {
    // A clicked day −9, this request (B) sent day 0, A clicked again day +1.
    seedReq("olderA", {
      sentAt: new Date(SENT_AT - 10 * 86_400_000), clickedAt: new Date(SENT_AT - 9 * 86_400_000),
      lastClickedAt: new Date(SENT_AT + 86_400_000), reminder: null,
    });
    await expectStop("clicked_other");
  });

  it("the same person under a duplicate contact (same number hash) counts: a newer request supersedes", async () => {
    seedReq("dupNewer", { contactId: "c_dup", sentAt: new Date(SENT_AT + 3600_000), reminder: null });
    await expectStop("superseded");
  });

  it("the same person under a duplicate contact: their click counts too", async () => {
    seedReq("dupClicked", { contactId: "c_dup", sentAt: new Date(SENT_AT - 86_400_000), clickedAt: new Date(SENT_AT + 60_000), reminder: null });
    await expectStop("clicked_other");
  });

  it("a click on an OLDER request (before this one) does not", async () => {
    mem.db.doc("subAccounts/sa1/reviewRequests/x").delete();
    seedReq("older", { sentAt: new Date(SENT_AT - 86_400_000), clickedAt: new Date(SENT_AT - 3600_000), reminder: null });
    expect(await run()).toEqual({ outcome: "sent" });
  });

  it("another contact's newer request is not this contact's", async () => {
    seedReq("otherContact", { contactId: "c2", toHash: phoneHash("+61400000009"), sentAt: new Date(SENT_AT + 3600_000), clickedAt: new Date(), reminder: null });
    expect(await run()).toEqual({ outcome: "sent" });
  });
});

describe("the customer replied", () => {
  it.each([["messages"], ["whatsappMessages"]])("an inbound %s after the request stops it", async (col) => {
    mem.seed(`contacts/c1/${col}/in1`, { direction: "inbound", createdAt: Timestamp.fromMillis(SENT_AT + 60_000) });
    await expectStop("replied");
  });

  it("an inbound before the request, or an outbound after it, does not", async () => {
    mem.seed("contacts/c1/messages/before", { direction: "inbound", createdAt: Timestamp.fromMillis(SENT_AT - 60_000) });
    mem.seed("contacts/c1/messages/ours", { direction: "outbound", createdAt: Timestamp.fromMillis(SENT_AT + 60_000) });
    expect(await run()).toEqual({ outcome: "sent" });
  });
});

describe("master controls and prerequisites", () => {
  it("an archived sub-account", async () => {
    setSub({}, { status: "archived" });
    await expectStop("archived");
  });

  it("automations paused", async () => {
    setSub({}, { automationsPaused: true });
    await expectStop("automations_paused");
  });

  it("an auto-triggered request whose auto-send was switched off", async () => {
    seedReq("req1", { trigger: "quote_paid" });
    setSub({ enabled: false, triggerOnQuotePaid: true });
    await expectStop("auto_send_off");
    seedReq("req1", { trigger: "deal_completed" });
    setSub({ enabled: true, triggerOnDealCompleted: false });
    await expectStop("auto_send_off");
  });

  it("a manual request runs whatever the auto-send switch says (it only gates auto sends)", async () => {
    setSub({ enabled: false });
    expect(await run()).toEqual({ outcome: "sent" });
  });

  it("the sub-account moved to the shared sender (replies can't be seen there)", async () => {
    dedicated.on = false;
    await expectStop("shared_sender");
  });

  it("the review link is no longer a Google review link", async () => {
    setSub({ reviewUrl: "https://example.com/review" });
    await expectStop("not_configured");
  });

  it("the number's inbound webhook was turned off (replies no longer reach us)", async () => {
    setSub({}, { twilioConfig: { enabled: true, inboundWebhookConfigured: false } });
    await expectStop("inbound_not_configured");
  });

  it("the review message template changed since the request", async () => {
    setSub({ messageTemplate: "A new wording: {{reviewUrl}}" });
    await expectStop("template_changed");
  });

  it("link tracking no longer available", async () => {
    delete process.env.AUTOMATIONS_TOKEN_SECRET;
    await expectStop("tracking_unavailable");
  });

  it("the contact's number changed", async () => {
    mem.seed("contacts/c1", { ...mem.read("contacts/c1"), phone: "+61400000000" });
    await expectStop("phone_changed");
  });

  it("the contact was deleted", async () => {
    await mem.db.doc("contacts/c1").delete();
    await expectStop("contact_deleted");
  });
});

describe("maximum reminders", () => {
  it("a lower maximum in the config now wins over the one stored on the request", async () => {
    setSub({ reminder: { everyDays: 2, maxRetries: 1 } });
    expect(await run()).toEqual({ outcome: "sent" });
    expect(req().reminder).toMatchObject({ attempts: 1, state: "done", stopReason: "retries_exhausted" });
    expect(publish).not.toHaveBeenCalled();
  });
});
