import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `expect` on maybeSendReviewRequest: an approved agent completion sends only
 * to the number, on the channel, the person reviewed. Any change between the
 * approval and the (asynchronous) send refuses it before anything goes out.
 */

vi.mock("@/lib/firebase/admin", async () => {
  const h = await import("@/test/reviews-request-harness");
  return { getAdminDb: () => h.fakeDb() };
});
vi.mock("@/lib/comms/twilio", async () => {
  const h = await import("@/test/reviews-request-harness");
  return {
    sendSmsForSubAccount: (...a: unknown[]) => h.sendSms(...(a as [])),
    sendWhatsappForSubAccount: (...a: unknown[]) => h.sendWhatsapp(...(a as [])),
    sendWhatsappTemplateForSubAccount: (...a: unknown[]) => h.sendWhatsappTemplate(...(a as [])),
    smsIsConfigured: () => h.smsIsConfigured(),
    subAccountTwilioIsConfigured: () => h.subAccountTwilioIsConfigured(),
    subAccountWhatsappIsConfigured: () => h.subAccountWhatsappIsConfigured(),
  };
});
const held = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => true));
const scheduled = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => undefined));
const superseded = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => undefined));
vi.mock("@/lib/reviews/reminder", async (orig) => ({
  ...((await orig()) as object), scheduleReviewReminder: scheduled, supersedeOtherReminders: superseded,
}));
vi.mock("@/lib/comms/quiet-hours-hold", () => ({ holdForQuietHours: held }));
vi.mock("@/lib/server/conversations-service", async () => {
  const h = await import("@/test/reviews-request-harness");
  return { upsertConversationForMessage: (...a: unknown[]) => h.upsertConversation(...(a as [])) };
});

import { QuietHoursDeferredError } from "@/lib/comms/quiet-hours";
import type { SendReviewInput } from "./request";
import { AG, C, SA, SUB_PATH, docs, resetHarness, setSub, sendSms, sendWhatsappTemplate, setApprovedTemplate, setContact, setReviewCfg } from "@/test/reviews-request-harness";
import { maybeSendReviewRequest } from "./request";
import { phoneHash } from "./reminder-checks";
import { templateFingerprint } from "@/lib/comms/whatsapp/template-fingerprint";
import type { SubAccountDoc } from "@/types";
import type { WhatsappTemplateDoc } from "@/types/whatsapp-templates";

type Expect = NonNullable<SendReviewInput["expect"]>;
const PHONE = "+61412345678";
const TEXT = "Hi Jane from Acme Plumbing: https://g.page/r/acme/review";
const APPROVED: Expect = { phone: PHONE, channel: "sms", body: TEXT };
const request = (expected: Expect): SendReviewInput => ({ subAccountId: SA, agencyId: AG, contactId: C, trigger: "deal_completed", expect: expected });
const send = (expected: Expect) => maybeSendReviewRequest(request(expected));
const REFUSED = { sent: false, reason: "changed_since_approval" };

beforeEach(() => {
  resetHarness();
  setReviewCfg({ triggerOnDealCompleted: true, messageTemplate: "Hi {{firstName}} from {{businessName}}: {{reviewUrl}}" });
});

it("the reviewed number, channel and text → sent, that text", async () => {
  expect(await send(APPROVED)).toEqual({ sent: true });
  expect(sendSms).toHaveBeenCalledTimes(1);
  expect((sendSms.mock.calls[0] as unknown as [{ body: string }])[0].body).toBe(TEXT);
});

it.each([
  ["the contact's number", () => setContact({ phone: "+61499999999" })],
  ["the contact's name (so the text)", () => setContact({ name: "visit-evil.example.com Doe" })],
  ["the message template", () => setReviewCfg({ messageTemplate: "Other {{reviewUrl}}" })],
  ["the template, to the breaker's lure", () => setReviewCfg({ messageTemplate: "URGENT {{firstName}}: claim your prize at {{reviewUrl}}" })],
])("%s changed since approval → refused, nothing sent", async (_label, change) => {
  change();
  expect(await send(APPROVED)).toEqual(REFUSED);
  expect(sendSms).not.toHaveBeenCalled();
});

it("the configured channel changed since approval → refused, nothing sent", async () => {
  expect(await send({ ...APPROVED, channel: "whatsapp_manual" })).toEqual(REFUSED);
  expect(sendSms).not.toHaveBeenCalled();
});

it("held for quiet hours, then the name changes before the release → the release sends nothing", async () => {
  sendSms.mockRejectedValueOnce(new QuietHoursDeferredError({ retryAfterSec: 60, until: new Date(Date.now() + 60_000), timezone: "UTC" }));
  expect(await send(APPROVED)).toEqual({ sent: false, reason: "quiet_hours_held" });
  const stored = (held.mock.calls[0]![0] as { payload: { request: SendReviewInput } }).payload.request;
  expect(stored.expect).toEqual(APPROVED);
  setContact({ name: "visit-evil.example.com Doe" });
  // What quiet-hours-release does with a held review request.
  expect(await maybeSendReviewRequest(stored)).toEqual(REFUSED);
  expect(sendSms).toHaveBeenCalledTimes(1);
});

const TPL_TEXT = "Hi Jane, mind leaving us a review?";
/** What an approver of the t1 review template would have been shown (and pinned). */
function approvedTemplate(): Expect {
  const tpl = docs[`${SUB_PATH}/whatsappTemplates/t1`] as unknown as WhatsappTemplateDoc;
  return { phone: PHONE, channel: "whatsapp_template", body: TPL_TEXT, fingerprint: templateFingerprint("t1", docs[SUB_PATH] as unknown as SubAccountDoc, tpl, ["Jane"]) };
}

describe("a WhatsApp template", () => {
  beforeEach(() => setApprovedTemplate());

  it("its filled text and fingerprint match → past the check; a variable's source changing refuses", async () => {
    const approved = approvedTemplate();
    expect(await send(approved)).not.toEqual(REFUSED);
    setContact({ name: "Joan Doe" });
    expect(await send(approved)).toEqual(REFUSED);
  });

  it("swapped for another template with the same text but other buttons and id → refused, nothing sent", async () => {
    const approved = approvedTemplate();
    docs[`${SUB_PATH}/whatsappTemplates/t2`] = {
      ...(docs[`${SUB_PATH}/whatsappTemplates/t1`] as object), name: "lure", contentSid: "HX999",
      buttons: [{ type: "url", text: "Claim", url: "https://evil.example" }],
    };
    setReviewCfg({ whatsappTemplateId: "t2" });
    expect(await send(approved)).toEqual(REFUSED);
    expect(sendWhatsappTemplate).not.toHaveBeenCalled();
  });

  it("its buttons changed since approval (same text) → refused", async () => {
    const approved = approvedTemplate();
    Object.assign(docs[`${SUB_PATH}/whatsappTemplates/t1`] as object, { buttons: [{ type: "url", text: "Claim", url: "https://evil.example" }] });
    expect(await send(approved)).toEqual(REFUSED);
  });

  it("sends the very template it checked: a change after the check never reaches the send", async () => {
    setSub({ whatsappEnabledByAgency: true });
    setReviewCfg({ triggerOnDealCompleted: true });
    setApprovedTemplate();
    const approved = approvedTemplate();
    const path = `${SUB_PATH}/whatsappTemplates/t1`;
    const original = docs[path];
    let reads = 0;
    // The first read is the check; any later one would see a swapped template.
    Object.defineProperty(docs, path, { configurable: true, enumerable: true, get: () => (reads++ === 0 ? original : { ...(original as object), contentSid: "HX999" }) });
    expect(await send(approved)).toEqual({ sent: true });
    expect(sendWhatsappTemplate).toHaveBeenCalledTimes(1);
    expect((sendWhatsappTemplate.mock.calls[0] as unknown as [{ contentSid: string }])[0]).toMatchObject({ contentSid: "HX123" });
  });

  it("no longer fillable (deleted since approval) → refused as changed", async () => {
    const approved = approvedTemplate();
    delete docs[`${SUB_PATH}/whatsappTemplates/t1`];
    expect(await send(approved)).toEqual(REFUSED);
    expect(sendWhatsappTemplate).not.toHaveBeenCalled();
  });
});

describe("reminders", () => {
  beforeEach(() => {
    vi.stubEnv("AUTOMATIONS_TOKEN_SECRET", "test-secret");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crm.example");
    setReviewCfg({ reminder: { everyDays: 3, maxRetries: 2 } });
    const sub = docs[SUB_PATH] as { twilioConfig: Record<string, unknown> };
    sub.twilioConfig = { ...sub.twilioConfig, inboundWebhookConfigured: true };
  });
  afterEach(() => vi.unstubAllEnvs());

  it("a person's request with reminders on schedules one, through a tracking link", async () => {
    await maybeSendReviewRequest({ subAccountId: SA, agencyId: AG, contactId: C, trigger: "deal_completed" });
    expect(scheduled).toHaveBeenCalledTimes(1);
    expect((sendSms.mock.calls[0] as unknown as [{ body: string }])[0].body).not.toContain("https://g.page/r/acme/review");
  });

  it("an approved request schedules none, ends any still waiting, and sends the approved text byte for byte", async () => {
    expect(await send(APPROVED)).toEqual({ sent: true });
    expect(scheduled).not.toHaveBeenCalled();
    expect(superseded).toHaveBeenCalledWith(SA, C, phoneHash(PHONE), "");
    expect((sendSms.mock.calls[0] as unknown as [{ body: string }])[0].body).toBe(TEXT);
  });
});
