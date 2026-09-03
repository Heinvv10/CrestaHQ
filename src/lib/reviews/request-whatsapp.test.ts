import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The WhatsApp half of the review dispatcher's guard ladder (the SMS/config
 * guards are in `request.test.ts`; both share the doubles in
 * `src/test/reviews-request-harness.ts`).
 *
 * A business-initiated WhatsApp is only compliant two ways: inside the
 * customer's 24h session window (free-form), or via a Meta-APPROVED template.
 * CLAUDE.md claims a non-compliant send is "impossible" — these tests try to
 * make one happen (agency gate off, no sender, closed window, unapproved
 * template, missing contentSid, unresolved variables) and assert that nothing
 * reaches Twilio in any of those states.
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
  collections,
  resetHarness,
  sendSms,
  sendWhatsapp,
  sendWhatsappTemplate,
  setApprovedTemplate,
  setContact,
  setReviewCfg,
  setSub,
  subAccountWhatsappIsConfigured,
  ts,
  upsertConversation,
  writes,
  AG,
  C,
  SA,
  WA_THREAD_PATH,
} from "@/test/reviews-request-harness";
import { maybeSendReviewRequest } from "./request";

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

// ---- opt-out ----------------------------------------------------------

describe("opted_out (WhatsApp)", () => {
  it("refuses WhatsApp to a contact with whatsappOptedOut", async () => {
    setSub({ whatsappEnabledByAgency: true });
    setApprovedTemplate();
    setContact({ whatsappOptedOut: true });
    expect(await send()).toEqual({ sent: false, reason: "opted_out" });
    expectNothingSent();
  });

  it("checks the opt-out of the channel actually being used", async () => {
    // WhatsApp send to someone who only ever STOPped SMS — still allowed.
    setSub({ whatsappEnabledByAgency: true });
    setApprovedTemplate();
    setContact({ smsOptedOut: true });
    expect(await send()).toEqual({ sent: true });
  });
});

// ---- agency gate + sender ---------------------------------------------

describe("whatsapp_gate_off / whatsapp_not_configured", () => {
  it("refuses WhatsApp when the agency gate is off", async () => {
    setSub({ whatsappEnabledByAgency: false });
    setApprovedTemplate();
    expect(await send()).toEqual({ sent: false, reason: "whatsapp_gate_off" });
    expectNothingSent();
  });

  it("treats a MISSING agency gate as off (opt-in)", async () => {
    setApprovedTemplate();
    expect(await send()).toEqual({ sent: false, reason: "whatsapp_gate_off" });
    expectNothingSent();
  });

  it("refuses when the gate is on but no WhatsApp sender is configured", async () => {
    setSub({ whatsappEnabledByAgency: true });
    setApprovedTemplate();
    subAccountWhatsappIsConfigured.mockReturnValue(false);
    expect(await send()).toEqual({
      sent: false,
      reason: "whatsapp_not_configured",
    });
    expectNothingSent();
  });
});

// ---- free-form: the 24h session window --------------------------------

describe("window_closed (whatsapp_manual, free-form)", () => {
  beforeEach(() => {
    setSub({ whatsappEnabledByAgency: true });
    setReviewCfg({ channel: "whatsapp_manual" });
  });

  it("refuses free-form WhatsApp when the thread has no inbound at all", async () => {
    collections[WA_THREAD_PATH] = [];
    expect(await send()).toEqual({ sent: false, reason: "window_closed" });
    expectNothingSent();
  });

  it("refuses when the last inbound is older than 24h", async () => {
    collections[WA_THREAD_PATH] = [
      { direction: "inbound", createdAt: ts(Date.now() - 25 * 60 * 60 * 1000) },
    ];
    expect(await send()).toEqual({ sent: false, reason: "window_closed" });
    expectNothingSent();
  });

  it("measures the window from the last INBOUND, ignoring newer outbounds", async () => {
    // Our own reply doesn't extend (or close) the customer's 24h window.
    collections[WA_THREAD_PATH] = [
      { direction: "outbound", createdAt: ts(Date.now() - 60_000) },
      { direction: "inbound", createdAt: ts(Date.now() - 26 * 60 * 60 * 1000) },
    ];
    expect(await send()).toEqual({ sent: false, reason: "window_closed" });
    expectNothingSent();
  });

  it("sends free-form when the customer messaged within 24h", async () => {
    collections[WA_THREAD_PATH] = [
      { direction: "inbound", createdAt: ts(Date.now() - 60 * 60 * 1000) },
    ];
    expect(await send()).toEqual({ sent: true });
    expect(sendWhatsapp).toHaveBeenCalledTimes(1);
    expect(sendWhatsappTemplate).not.toHaveBeenCalled();
  });
});

// ---- template approval ------------------------------------------------

describe("template compliance — an unapproved template can never be sent", () => {
  beforeEach(() => {
    setSub({ whatsappEnabledByAgency: true });
  });

  it("refuses when no template is selected", async () => {
    setReviewCfg({ channel: "whatsapp_template", whatsappTemplateId: null });
    expect(await send()).toEqual({ sent: false, reason: "no_template" });
    expectNothingSent();
  });

  it("refuses when the selected template document is gone", async () => {
    setReviewCfg({
      channel: "whatsapp_template",
      whatsappTemplateId: "missing",
    });
    expect(await send()).toEqual({
      sent: false,
      reason: "template_not_approved",
    });
    expectNothingSent();
  });

  it.each([
    "draft",
    "submitting",
    "pending",
    "rejected",
    "failed",
    "paused",
    "disabled",
  ])("refuses a template in status %s", async (status) => {
    setApprovedTemplate({ status });
    expect(await send()).toEqual({
      sent: false,
      reason: "template_not_approved",
    });
    expectNothingSent();
  });

  it("refuses an approved template that has no contentSid (nothing to send)", async () => {
    setApprovedTemplate({ contentSid: "" });
    expect(await send()).toEqual({
      sent: false,
      reason: "template_not_approved",
    });
    expectNothingSent();
  });

  it("refuses when a template variable resolves empty (would send a hole)", async () => {
    setContact({ name: "" });
    setApprovedTemplate();
    expect(await send()).toEqual({
      sent: false,
      reason: "template_var_missing",
    });
    expectNothingSent();
  });

  it("sends the approved template via the contentSid path, not free-form", async () => {
    setApprovedTemplate();
    expect(await send()).toEqual({ sent: true });
    expect(sendWhatsappTemplate).toHaveBeenCalledTimes(1);
    expect(sendWhatsapp).not.toHaveBeenCalled();
    const arg = (
      sendWhatsappTemplate.mock.calls[0] as unknown as [
        { contentSid: string; contentVariables: string[] },
      ]
    )[0];
    expect(arg.contentSid).toBe("HX123");
    expect(arg.contentVariables).toEqual(["Jane"]);
  });

  it("logs the send on the thread + unified inbox as a WhatsApp message", async () => {
    setApprovedTemplate();
    await send();
    expect(writes.some((w) => w.path === `${WA_THREAD_PATH}/WA2`)).toBe(true);
    expect(upsertConversation).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "whatsapp", direction: "outbound" })
    );
  });
});
