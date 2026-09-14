import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SP5 d1 — a review link sent from the Conversations inbox is a review ask,
 * logged with source "inbox" and the person who pressed Send. Seam: the real
 * manual send routes → real contact access check → real conversation send
 * service → in-memory Firestore; only the providers are doubles. The
 * composer's "Ask for review" inserts the link into a normal message, so the
 * server-side URL check is what covers it.
 */

const sendSms = vi.fn();
const sendEmail = vi.fn();
const dispatchWhatsappSend = vi.fn();
const dispatchWhatsappTemplateSend = vi.fn();
vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
vi.mock("@/lib/comms/twilio", () => ({
  sendSmsForSubAccount: (...a: unknown[]) => sendSms(...a),
  sendWhatsappForSubAccount: vi.fn(),
  sendWhatsappTemplateForSubAccount: vi.fn(),
  smsIsConfigured: () => true,
  subAccountTwilioIsConfigured: () => true,
  SmsRecipientUnsubscribedError: class extends Error {},
}));
vi.mock("@/lib/comms/resend", () => ({
  emailIsConfigured: () => true,
  tenantFrom: () => "desk@tenant.test",
  sendEmail: (...a: unknown[]) => sendEmail(...a),
}));
vi.mock("@/lib/comms/whatsapp/send-dispatch", () => ({ dispatchWhatsappSend: (...a: unknown[]) => dispatchWhatsappSend(...a) }));
vi.mock("@/lib/comms/whatsapp/template-dispatch", () => ({
  dispatchWhatsappTemplateSend: (...a: unknown[]) => dispatchWhatsappTemplateSend(...a),
}));
vi.mock("@/lib/comms/whatsapp/readiness", () => ({
  checkWhatsappReadiness: async () => ({ ready: true, provider: "cloud", sender: { phoneNumber: "+15550002" } }),
}));
vi.mock("@/lib/comms/ai/agent", () => ({ getChannelConfig: async () => null }));
vi.mock("@/lib/server/conversations-service", () => ({ upsertConversationForMessage: async () => undefined }));
vi.mock("@/lib/server/usage-meter", () => ({ checkQuota: async () => ({ allowed: true }), UsageQuotaExceededError: class extends Error {} }));

import { AGENCY, SA, asUser, mem, resetSync } from "@/test/gbp-sync-harness";
import { POST as smsPOST } from "@/app/api/comms/sms/send/route";
import { POST as emailPOST } from "@/app/api/comms/email/send/route";
import { POST as waPOST } from "@/app/api/comms/whatsapp/send/route";
import { POST as waTplPOST } from "@/app/api/comms/whatsapp/send-template/route";

const REVIEW_URL = "https://g.page/r/fixture/review";
const CONTACT = "c_inbox";
const rows = () => mem.list(`subAccounts/${SA}/reviewRequests`);
const call = (route: (r: Request) => Promise<Response>, path: string, body: Record<string, unknown>, uid = "uid_collab") =>
  route(asUser(`http://127.0.0.1:3100${path}`, uid, "POST", JSON.stringify({ contactId: CONTACT, ...body })));

beforeEach(() => {
  resetSync();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  sendSms.mockReset().mockResolvedValue({ sid: "SMinbox1", from: "+15550001", mode: "dedicated" });
  sendEmail.mockReset().mockResolvedValue({ id: "<m1@tenant.test>" });
  dispatchWhatsappSend.mockReset().mockResolvedValue({ ok: true, messageId: "wamid.in1", sentAs: "text", provider: "cloud" });
  dispatchWhatsappTemplateSend.mockReset().mockResolvedValue({ ok: true, messageId: "wamid.tpl1", provider: "cloud" });
  mem.seed(`subAccounts/${SA}`, {
    ...mem.read(`subAccounts/${SA}`)!,
    name: "Fixture Co",
    twilioConfig: { enabled: true },
    whatsappEnabledByAgency: true,
    googleReviewConfig: { reviewUrl: REVIEW_URL, channel: "sms" },
  });
  mem.seed(`contacts/${CONTACT}`, {
    name: "Fixture Person", phone: "+15005550006", email: "person@example.test", agencyId: AGENCY, subAccountId: SA,
    createdByUid: "uid_admin",
  });
});

describe("inbox SMS", () => {
  it("a message with the review link writes one inbox row with the sender", async () => {
    const res = await call(smsPOST, "/api/comms/sms/send", { body: `Hi! A quick review would help: ${REVIEW_URL}` });
    expect(res.status).toBe(200);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      agencyId: AGENCY, subAccountId: SA, contactId: CONTACT, createdByUid: "uid_collab", channel: "sms",
      source: "inbox", trigger: null, status: "sent", messageSid: "SMinbox1", failureKind: null,
    });
    expect(JSON.stringify(rows())).not.toMatch(/Fixture Person|\+1500|g\.page/);
  });

  it("a message without it writes nothing", async () => {
    expect((await call(smsPOST, "/api/comms/sms/send", { body: "Your technician is on the way." })).status).toBe(200);
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(rows()).toEqual([]);
  });

  it("a review ask the provider rejected is logged failed, by kind", async () => {
    sendSms.mockRejectedValueOnce(new Error("carrier said no to +15005550006"));
    expect((await call(smsPOST, "/api/comms/sms/send", { body: `Review us: ${REVIEW_URL}` })).status).toBe(502);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ source: "inbox", status: "failed", failureKind: "send_failed", messageSid: null });
  });

  it("a caller who cannot reach the contact sends nothing and logs nothing", async () => {
    expect((await call(smsPOST, "/api/comms/sms/send", { body: REVIEW_URL }, "uid_other_admin")).status).toBe(403);
    expect(rows()).toEqual([]);
  });
});

describe("inbox email and WhatsApp", () => {
  it("an email whose body carries the link is logged as email", async () => {
    const res = await call(emailPOST, "/api/comms/email/send", { subject: "Thanks", body: `Review: ${REVIEW_URL}` });
    expect(res.status).toBe(200);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ channel: "email", source: "inbox", status: "sent" });
  });

  it("a free-form WhatsApp carrying the link is logged as whatsapp", async () => {
    expect((await call(waPOST, "/api/comms/whatsapp/send", { body: `Review: ${REVIEW_URL}` })).status).toBe(200);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ channel: "whatsapp", source: "inbox", status: "sent", messageSid: "wamid.in1" });
  });

  it("a template send whose manual value is the link is logged; its refusal too", async () => {
    mem.seed(`subAccounts/${SA}/whatsappTemplates/t1`, {
      name: "thanks", displayName: "Thanks", body: "Thanks {{1}}! {{2}}", status: "approved",
      variables: [
        { position: 1, label: "Name", sampleValue: "Ben", source: "merge_tag", mergeTag: "contact.firstName" },
        { position: 2, label: "Link", sampleValue: "https://x.test", source: "manual", mergeTag: null },
      ],
    });
    expect((await call(waTplPOST, "/api/comms/whatsapp/send-template", { templateId: "t1", manualValues: { 2: REVIEW_URL } })).status).toBe(200);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ channel: "whatsapp", source: "inbox", status: "sent", messageSid: "wamid.tpl1" });

    dispatchWhatsappTemplateSend.mockResolvedValueOnce({ ok: false, error: "WA_TEMPLATE_NOT_APPROVED" });
    expect((await call(waTplPOST, "/api/comms/whatsapp/send-template", { templateId: "t1", manualValues: { 2: REVIEW_URL } })).status).toBe(409);
    expect(rows().filter((r) => r.status === "failed")).toMatchObject([{ failureKind: "WA_TEMPLATE_NOT_APPROVED" }]);

    // The same template with an ordinary value is not a review ask.
    await call(waTplPOST, "/api/comms/whatsapp/send-template", { templateId: "t1", manualValues: { 2: "https://example.test/booking" } });
    expect(rows()).toHaveLength(2);
  });
});
