import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression tests for the Google review-request dispatcher — the SMS path
 * and the config/contact/cooldown guards. The WhatsApp compliance guards live
 * in `request-whatsapp.test.ts`; both files share the doubles in
 * `src/test/reviews-request-harness.ts`.
 *
 * Each guard here is a message we must NOT send, and ORDER matters as much as
 * presence: opt-out and cooldown are checked before anything reaches Twilio,
 * so several tests assert the send helper was never called at all rather than
 * merely checking the returned reason.
 */

vi.mock("@/lib/firebase/admin", async () => {
  const h = await import("@/test/reviews-request-harness");
  return { getAdminDb: () => h.fakeDb() };
});

vi.mock("@/lib/comms/twilio", async () => {
  const h = await import("@/test/reviews-request-harness");
  return {
    sendSmsForSubAccount: (...a: unknown[]) => h.sendSms(...(a as [])),
    sendWhatsappForSubAccount: (...a: unknown[]) =>
      h.sendWhatsapp(...(a as [])),
    sendWhatsappTemplateForSubAccount: (...a: unknown[]) =>
      h.sendWhatsappTemplate(...(a as [])),
    smsIsConfigured: () => h.smsIsConfigured(),
    subAccountTwilioIsConfigured: () => h.subAccountTwilioIsConfigured(),
    subAccountWhatsappIsConfigured: () => h.subAccountWhatsappIsConfigured(),
  };
});

vi.mock("@/lib/server/conversations-service", async () => {
  const h = await import("@/test/reviews-request-harness");
  return {
    upsertConversationForMessage: (...a: unknown[]) =>
      h.upsertConversation(...(a as [])),
  };
});

import {
  CONTACT_PATH,
  resetHarness,
  sendSms,
  sendWhatsapp,
  sendWhatsappTemplate,
  setApprovedTemplate,
  setContact,
  setReviewCfg,
  setSub,
  smsIsConfigured,
  subAccountTwilioIsConfigured,
  subAccountWhatsappIsConfigured,
  ts,
  upsertConversation,
  writes,
  AG,
  C,
  SA,
  SUB_PATH,
  docs,
} from "@/test/reviews-request-harness";
import { maybeSendReviewRequest } from "./request";

/** Nothing was handed to any Twilio send helper. */
function expectNothingSent() {
  expect(sendSms).not.toHaveBeenCalled();
  expect(sendWhatsapp).not.toHaveBeenCalled();
  expect(sendWhatsappTemplate).not.toHaveBeenCalled();
}

function send(
  trigger: "manual" | "quote_paid" | "deal_completed" = "quote_paid"
) {
  return maybeSendReviewRequest({
    subAccountId: SA,
    agencyId: AG,
    contactId: C,
    trigger,
  });
}

beforeEach(resetHarness);

// ---- baseline ---------------------------------------------------------

describe("the send path (baseline for the guard tests)", () => {
  it("sends SMS and reports sent:true when every guard passes", async () => {
    expect(await send()).toEqual({ sent: true });
    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  it("fills the merge tags — first name, business name, review URL", async () => {
    await send();
    const body = (sendSms.mock.calls[0] as unknown as [{ body: string }])[0]
      .body;
    expect(body).toContain("Jane");
    expect(body).not.toContain("Doe");
    expect(body).toContain("Acme Plumbing");
    expect(body).toContain("https://g.page/r/acme/review");
    expect(body).not.toMatch(/\{\{/);
  });

  it("stamps reviewRequestedAt so the cooldown can bite next time", async () => {
    await send();
    expect(writes.some((w) => w.path === CONTACT_PATH)).toBe(true);
  });
});

// ---- configuration guards --------------------------------------------

describe("not_configured", () => {
  it("refuses when the sub-account doc is missing", async () => {
    delete docs[SUB_PATH];
    expect(await send()).toEqual({ sent: false, reason: "not_configured" });
    expectNothingSent();
  });

  it("refuses when there is no googleReviewConfig", async () => {
    docs[SUB_PATH] = { name: "Acme" };
    expect(await send()).toEqual({ sent: false, reason: "not_configured" });
    expectNothingSent();
  });

  it("refuses when the review URL is blank — never send an empty link", async () => {
    setReviewCfg({ reviewUrl: "" });
    expect(await send()).toEqual({ sent: false, reason: "not_configured" });
    expectNothingSent();
  });
});

describe("trigger_disabled", () => {
  it("refuses an auto trigger when the feature is disabled", async () => {
    setReviewCfg({ enabled: false });
    expect(await send("quote_paid")).toEqual({
      sent: false,
      reason: "trigger_disabled",
    });
    expectNothingSent();
  });

  it("refuses quote_paid when only the deal_completed trigger is on", async () => {
    setReviewCfg({ triggerOnQuotePaid: false, triggerOnDealCompleted: true });
    expect(await send("quote_paid")).toEqual({
      sent: false,
      reason: "trigger_disabled",
    });
    expectNothingSent();
  });

  it("refuses deal_completed when only the quote_paid trigger is on", async () => {
    setReviewCfg({ triggerOnQuotePaid: true, triggerOnDealCompleted: false });
    expect(await send("deal_completed")).toEqual({
      sent: false,
      reason: "trigger_disabled",
    });
    expectNothingSent();
  });

  it("lets a MANUAL send through even with both auto triggers off", async () => {
    setReviewCfg({
      enabled: false,
      triggerOnQuotePaid: false,
      triggerOnDealCompleted: false,
    });
    expect(await send("manual")).toEqual({ sent: true });
  });
});

// ---- contact guards ---------------------------------------------------

describe("no_contact / no_phone", () => {
  it("refuses when the contact no longer exists", async () => {
    delete docs[CONTACT_PATH];
    expect(await send()).toEqual({ sent: false, reason: "no_contact" });
    expectNothingSent();
  });

  it("refuses when the contact has no phone number", async () => {
    setContact({ phone: "" });
    expect(await send()).toEqual({ sent: false, reason: "no_phone" });
    expectNothingSent();
  });
});

// ---- opt-out (the compliance invariant) -------------------------------

describe("opted_out (SMS)", () => {
  it("refuses SMS to a contact with a carrier STOP on file", async () => {
    setContact({ smsOptedOut: true });
    expect(await send()).toEqual({ sent: false, reason: "opted_out" });
    expectNothingSent();
  });

  it("refuses SMS to a contact who declined consent", async () => {
    setContact({ smsConsent: { consented: false } });
    expect(await send()).toEqual({ sent: false, reason: "opted_out" });
    expectNothingSent();
  });

  it("ignores whatsappOptedOut on the SMS channel", async () => {
    setContact({ whatsappOptedOut: true });
    expect(await send()).toEqual({ sent: true });
  });

  it("opt-out wins over EVERY later guard, from cooldown to the template", async () => {
    // Cooldown would fire, the WhatsApp sender is unconfigured, and the chosen
    // template is unapproved — the opt-out reason must still be the one
    // returned, and nothing may reach Twilio.
    setSub({ whatsappEnabledByAgency: true });
    setApprovedTemplate({ status: "rejected", contentSid: "" });
    setContact({
      whatsappOptedOut: true,
      reviewRequestedAt: ts(Date.now() - 1000),
    });
    subAccountWhatsappIsConfigured.mockReturnValue(false);
    expect(await send()).toEqual({ sent: false, reason: "opted_out" });
    expectNothingSent();
  });
});

// ---- cooldown ---------------------------------------------------------

describe("cooldown", () => {
  it("refuses an auto send inside the cooldown window", async () => {
    setContact({
      reviewRequestedAt: ts(Date.now() - 10 * 24 * 60 * 60 * 1000),
    });
    expect(await send()).toEqual({ sent: false, reason: "cooldown" });
    expectNothingSent();
  });

  it("allows an auto send once the cooldown has elapsed", async () => {
    setReviewCfg({ cooldownDays: 5 });
    setContact({ reviewRequestedAt: ts(Date.now() - 6 * 24 * 60 * 60 * 1000) });
    expect(await send()).toEqual({ sent: true });
  });

  it("falls back to the 90-day default when cooldownDays is 0", async () => {
    setReviewCfg({ cooldownDays: 0 });
    setContact({
      reviewRequestedAt: ts(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    expect(await send()).toEqual({ sent: false, reason: "cooldown" });
    expectNothingSent();
  });

  it("a MANUAL send bypasses the cooldown (operator intent)", async () => {
    setContact({ reviewRequestedAt: ts(Date.now() - 1000) });
    expect(await send("manual")).toEqual({ sent: true });
  });

  it("cooldown is checked BEFORE the send, not after", async () => {
    setContact({ reviewRequestedAt: ts(Date.now() - 1000) });
    await send();
    expectNothingSent();
    expect(upsertConversation).not.toHaveBeenCalled();
  });
});

// ---- SMS transport ----------------------------------------------------

describe("sms_not_configured", () => {
  it("refuses when neither a dedicated nor a shared Twilio sender exists", async () => {
    subAccountTwilioIsConfigured.mockReturnValue(false);
    smsIsConfigured.mockReturnValue(false);
    expect(await send()).toEqual({ sent: false, reason: "sms_not_configured" });
    expectNothingSent();
  });

  it("still sends via the shared sender when no dedicated number is set", async () => {
    subAccountTwilioIsConfigured.mockReturnValue(false);
    smsIsConfigured.mockReturnValue(true);
    sendSms.mockResolvedValue({ sid: "SM9", from: "+1555", mode: "shared" });
    expect(await send()).toEqual({ sent: true });
    // Shared-sender mode writes no thread row / inbox entry.
    expect(upsertConversation).not.toHaveBeenCalled();
  });
});

// ---- failure handling -------------------------------------------------

describe("send failure", () => {
  it("reports send_failed rather than throwing when Twilio rejects", async () => {
    sendSms.mockRejectedValue(new Error("twilio 21610"));
    expect(await send()).toEqual({ sent: false, reason: "send_failed" });
  });

  it("does not stamp the cooldown when the send failed", async () => {
    sendSms.mockRejectedValue(new Error("twilio 21610"));
    await send();
    expect(writes.some((w) => w.path === CONTACT_PATH)).toBe(false);
  });
});
