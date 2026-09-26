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
vi.mock("@/lib/reviews/reminder", async (orig) => ({
  ...((await orig()) as object), scheduleReviewReminder: scheduled, supersedeOtherReminders: async () => undefined,
}));
vi.mock("@/lib/comms/quiet-hours-hold", () => ({ holdForQuietHours: held }));
vi.mock("@/lib/server/conversations-service", async () => {
  const h = await import("@/test/reviews-request-harness");
  return { upsertConversationForMessage: (...a: unknown[]) => h.upsertConversation(...(a as [])) };
});

import { QuietHoursDeferredError } from "@/lib/comms/quiet-hours";
import type { SendReviewInput } from "./request";
import { AG, C, SA, SUB_PATH, docs, resetHarness, sendSms, sendWhatsappTemplate, setApprovedTemplate, setContact, setReviewCfg } from "@/test/reviews-request-harness";
import { maybeSendReviewRequest } from "./request";

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

it("a WhatsApp template: its text with the variables filled is compared; a variable's source changing refuses", async () => {
  setApprovedTemplate();
  const approved: Expect = { phone: PHONE, channel: "whatsapp_template", body: "Hi Jane, mind leaving us a review?" };
  expect(await send(approved)).not.toEqual(REFUSED);
  setContact({ name: "Joan Doe" });
  expect(await send(approved)).toEqual(REFUSED);
  expect(sendWhatsappTemplate).not.toHaveBeenCalled();
});

it("a WhatsApp template that can no longer be filled (deleted since approval) → refused as changed", async () => {
  setApprovedTemplate();
  delete docs[`${SUB_PATH}/whatsappTemplates/t1`];
  expect(await send({ phone: PHONE, channel: "whatsapp_template", body: "Hi Jane, mind leaving us a review?" })).toEqual(REFUSED);
  expect(sendWhatsappTemplate).not.toHaveBeenCalled();
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

  it("an approved request schedules none, and sends the approved text byte for byte", async () => {
    expect(await send(APPROVED)).toEqual({ sent: true });
    expect(scheduled).not.toHaveBeenCalled();
    expect((sendSms.mock.calls[0] as unknown as [{ body: string }])[0].body).toBe(TEXT);
  });
});
