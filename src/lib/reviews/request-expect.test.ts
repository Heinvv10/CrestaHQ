import { beforeEach, expect, it, vi } from "vitest";

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
vi.mock("@/lib/server/conversations-service", async () => {
  const h = await import("@/test/reviews-request-harness");
  return { upsertConversationForMessage: (...a: unknown[]) => h.upsertConversation(...(a as [])) };
});

import { AG, C, SA, resetHarness, sendSms, setContact, setReviewCfg } from "@/test/reviews-request-harness";
import { maybeSendReviewRequest } from "./request";

const send = (expected: { phone: string; channel: "sms" | "whatsapp_template" | "whatsapp_manual" }) =>
  maybeSendReviewRequest({ subAccountId: SA, agencyId: AG, contactId: C, trigger: "deal_completed", expect: expected });

beforeEach(() => {
  resetHarness();
  setReviewCfg({ triggerOnDealCompleted: true });
});

it("the reviewed number and channel → sent", async () => {
  expect(await send({ phone: "+61412345678", channel: "sms" })).toEqual({ sent: true });
  expect(sendSms).toHaveBeenCalledTimes(1);
});

it("the contact's number changed since approval → refused, nothing sent", async () => {
  setContact({ phone: "+61499999999" });
  expect(await send({ phone: "+61412345678", channel: "sms" })).toEqual({ sent: false, reason: "changed_since_approval" });
  expect(sendSms).not.toHaveBeenCalled();
});

it("the configured channel changed since approval → refused, nothing sent", async () => {
  expect(await send({ phone: "+61412345678", channel: "whatsapp_manual" })).toEqual({ sent: false, reason: "changed_since_approval" });
  expect(sendSms).not.toHaveBeenCalled();
});
