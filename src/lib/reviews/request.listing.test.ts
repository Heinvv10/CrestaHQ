import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * MULTI_LISTING_V1_PLAN.md PR 5 — a review request for one listing. Real
 * dispatcher on an in-memory Firestore; only Twilio, the WhatsApp dispatch,
 * the inbox upsert and the QStash publish are doubles. Who receives the
 * message never changes: only the link inside it, and only when an EXTRA
 * listing is named. The main listing, or none, sends exactly today's body.
 */

const mem = createMemoryFirestore();
const sendSms = vi.fn();
const sendWa = vi.fn();
const sendTpl = vi.fn();
const publish = vi.fn();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/comms/twilio", () => ({
  smsIsConfigured: () => true,
  subAccountTwilioIsConfigured: () => true,
  sendSmsForSubAccount: (...a: unknown[]) => sendSms(...a),
  sendWhatsappForSubAccount: (...a: unknown[]) => sendWa(...a),
  sendWhatsappTemplateForSubAccount: (...a: unknown[]) => sendTpl(...a),
}));
vi.mock("@/lib/comms/whatsapp/readiness", () => ({ checkWhatsappReadiness: async () => ({ ready: true, provider: "bridge" }) }));
vi.mock("@/lib/comms/whatsapp/send-dispatch", () => ({
  sendWhatsappFreeFormForSubAccount: async (i: { body: string }) => sendWa(i),
}));
vi.mock("@/lib/comms/whatsapp/template-dispatch", () => ({ dispatchWhatsappTemplateSend: (...a: unknown[]) => sendTpl(...a) }));
vi.mock("@/lib/server/conversations-service", () => ({ upsertConversationForMessage: async () => undefined }));
vi.mock("@/lib/automations/qstash", () => ({ publishCallback: (...a: unknown[]) => publish(...a) }));

const { maybeSendReviewRequest } = await import("./request");

const MAIN = "locations/main-1";
const B = "locations/extra-b";
const MAIN_URL = "https://g.page/r/acme/review";
const B_URL = "https://g.page/r/acme-b/review";
const body = (url: string) =>
  `Hi Jane, thanks for choosing Acme Plumbing! If you have a moment, a quick Google review would mean a lot: ${url}`;
const rows = () => mem.list("subAccounts/sa1/reviewRequests");
const smsBody = () => (sendSms.mock.calls[0] as [{ body: string; to: string }])[0].body;
const send = (locationName?: string) =>
  maybeSendReviewRequest({
    subAccountId: "sa1", agencyId: "ag1", contactId: "c1", trigger: "manual", actorUid: "u1",
    ...(locationName === undefined ? {} : { locationName }),
  });

function seed(cfg: Record<string, unknown> = {}) {
  mem.seed("subAccounts/sa1", {
    name: "Acme Plumbing", agencyId: "ag1", twilioConfig: { enabled: true, inboundWebhookConfigured: true }, whatsappEnabledByAgency: true,
    googleListing: { locationName: MAIN, title: "Acme Main", newReviewUri: null },
    googleExtraListings: [{ locationName: B, title: "Acme B", newReviewUri: "https://review.fixture.example/b-proposed" }],
    googleLocationNames: [MAIN, B],
    googleReviewConfig: {
      enabled: false, reviewUrl: MAIN_URL, channel: "sms", messageTemplate: "", whatsappTemplateId: null,
      cooldownDays: 90, triggerOnQuotePaid: false, triggerOnDealCompleted: false, listingUrls: { "extra-b": B_URL }, ...cfg,
    },
  });
}

function expectNothingSent() {
  expect(sendSms).not.toHaveBeenCalled();
  expect(sendWa).not.toHaveBeenCalled();
  expect(sendTpl).not.toHaveBeenCalled();
  expect(rows()).toEqual([]);
  expect(mem.read("contacts/c1")?.reviewRequestedAt).toBeUndefined();
}

beforeEach(() => {
  mem.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-for-click-tokens";
  process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
  sendSms.mockReset().mockResolvedValue({ sid: "SM1", from: "+15550001", mode: "dedicated" });
  sendWa.mockReset().mockResolvedValue({ sid: "WA1", from: "+15550002" });
  sendTpl.mockReset();
  publish.mockReset().mockResolvedValue({ messageId: "q1" });
  seed();
  mem.seed("contacts/c1", { name: "Jane Doe", phone: "+61412345678", agencyId: "ag1", subAccountId: "sa1" });
});

describe("an extra listing's request", () => {
  it("sends B's adopted link to the same contact and logs locationName B", async () => {
    expect(await send(B)).toEqual({ sent: true });
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(smsBody()).toBe(body(B_URL));
    expect((sendSms.mock.calls[0] as [{ to: string }])[0].to).toBe("+61412345678");
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ locationName: B, contactId: "c1", channel: "sms", trigger: "manual", status: "sent" });
  });

  it("over in-window WhatsApp, B's link too", async () => {
    seed({ channel: "whatsapp_manual" });
    expect(await send(B)).toEqual({ sent: true });
    expect((sendWa.mock.calls[0] as [{ body: string }])[0].body).toBe(body(B_URL));
    expect(rows()[0]).toMatchObject({ locationName: B, channel: "whatsapp" });
  });

  it("with no adopted link for B: refused listing_url_not_configured, nothing sent — never the main's link", async () => {
    seed({ listingUrls: {} });
    expect(await send(B)).toEqual({ sent: false, reason: "listing_url_not_configured" });
    expectNothingSent();
  });

  it("over an approved WhatsApp template (which carries the main's link): refused listing_needs_template", async () => {
    seed({ channel: "whatsapp_template", whatsappTemplateId: "t1" });
    expect(await send(B)).toEqual({ sent: false, reason: "listing_needs_template" });
    expectNothingSent();
  });

  it("with reminders on: no /rr tracking link, no reminder, B's plain link", async () => {
    seed({ reminder: { everyDays: 2, maxRetries: 2 } });
    expect(await send(B)).toEqual({ sent: true });
    expect(smsBody()).toBe(body(B_URL));
    expect(rows()[0]).not.toHaveProperty("reminder");
    expect(rows()[0]).not.toHaveProperty("tracked");
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("the main listing, or none, is today's send", () => {
  it.each([["no locationName", undefined], ["the main's locationName", MAIN]])("%s: exact body, no locationName on the row", async (_l, loc) => {
    expect(await send(loc)).toEqual({ sent: true });
    expect(smsBody()).toBe(body(MAIN_URL));
    expect(Object.keys(rows()[0]).sort()).toEqual([
      "agencyId", "channel", "clickedAt", "contactId", "createdByUid", "failureKind", "feedbackAt", "id", "messageSid",
      "sentAt", "source", "status", "subAccountId", "trigger",
    ]);
  });

  it("a main send with reminders on still gets its tracked link (unchanged)", async () => {
    seed({ reminder: { everyDays: 2, maxRetries: 2 } });
    expect(await send(MAIN)).toEqual({ sent: true });
    expect(smsBody()).toContain("http://127.0.0.1:3100/rr/");
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
