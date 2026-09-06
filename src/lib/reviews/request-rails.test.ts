import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The review dispatcher's WhatsApp gate, on the Cloud and bridge rails.
 *
 * `maybeSendReviewRequest` used to gate every WhatsApp send on
 * `subAccountWhatsappIsConfigured(subAccount.twilioConfig)` — Twilio
 * credentials plus a Twilio sender number. Both send helpers underneath it
 * (`sendWhatsappFreeFormForSubAccount`, `dispatchWhatsappTemplateSend`) were
 * already rail-agnostic, so on a Cloud or bridge workspace this ONE gate was
 * the whole defect: a manual review request that would have sent fine was
 * refused with "add a Twilio number".
 *
 * These drive the real dispatcher. The Twilio double is pinned to FALSE
 * throughout, so any test here that passes while the old gate is restored
 * would be proving nothing.
 *
 * (The Twilio-rail guard ladder lives in `request-whatsapp.test.ts`; the
 * SMS/config guards in `request.test.ts`.)
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

// --- the rails themselves ------------------------------------------------

const cloudConfigured = vi.fn(async () => true);
const getBridgeCreds = vi.fn(async () => ({
  baseUrl: "http://bridge.local",
  token: "t",
}));
const bridgeHealth = vi.fn(async () => ({
  reachable: true,
  connected: true,
  killed: false,
}));

vi.mock("@/lib/comms/whatsapp/cloud-credentials", () => ({
  whatsappCloudIsConfigured: (...a: unknown[]) => cloudConfigured(...(a as [])),
}));
vi.mock("@/lib/comms/whatsapp/bridge-credentials", () => ({
  getBridgeCreds: (...a: unknown[]) => getBridgeCreds(...(a as [])),
}));
vi.mock("@/lib/comms/whatsapp/bridge-client", () => ({
  bridgeHealth: (...a: unknown[]) => bridgeHealth(...(a as [])),
}));

// The dispatchers are the seam the gate either reaches or doesn't. Faked so
// the assertion is "the gate let the send through", not "the bridge answered".
const freeForm = vi.fn(async () => ({ sid: "WAF1", from: "+27784356159" }));
const templateDispatch = vi.fn(async () => ({ ok: true, messageId: "WAT1" }));

vi.mock("@/lib/comms/whatsapp/send-dispatch", () => ({
  sendWhatsappFreeFormForSubAccount: (...a: unknown[]) =>
    freeForm(...(a as [])),
}));
vi.mock("@/lib/comms/whatsapp/template-dispatch", () => ({
  dispatchWhatsappTemplateSend: (...a: unknown[]) =>
    templateDispatch(...(a as [])),
}));

import {
  collections,
  resetHarness,
  setApprovedTemplate,
  setReviewCfg,
  setSub,
  subAccountWhatsappIsConfigured,
  ts,
  AG,
  C,
  SA,
  WA_THREAD_PATH,
} from "@/test/reviews-request-harness";
import { maybeSendReviewRequest } from "./request";

function send() {
  return maybeSendReviewRequest({
    subAccountId: SA,
    agencyId: AG,
    contactId: C,
    trigger: "quote_paid",
  });
}

/** An open 24h window, so free-form mode is compliant. */
function openWindow() {
  collections[WA_THREAD_PATH] = [
    { direction: "inbound", createdAt: ts(Date.now() - 60 * 60 * 1000) },
  ];
}

beforeEach(() => {
  resetHarness();
  cloudConfigured.mockResolvedValue(true);
  bridgeHealth.mockResolvedValue({
    reachable: true,
    connected: true,
    killed: false,
  });
  freeForm.mockResolvedValue({ sid: "WAF1", from: "+27784356159" });
  templateDispatch.mockResolvedValue({ ok: true, messageId: "WAT1" });
  // Every test below is on a non-Twilio rail, where this is genuinely false.
  subAccountWhatsappIsConfigured.mockReturnValue(false);
});

describe("readiness is per rail, not per Twilio credential", () => {
  it("sends a free-form review request on the BRIDGE rail", async () => {
    setSub({ whatsappEnabledByAgency: true, whatsappProvider: "bridge" });
    setReviewCfg({ channel: "whatsapp_manual" });
    openWindow();
    expect(await send()).toEqual({ sent: true });
    expect(freeForm).toHaveBeenCalledTimes(1);
  });

  it("sends a free-form review request on the CLOUD rail", async () => {
    setSub({ whatsappEnabledByAgency: true, whatsappProvider: "cloud" });
    setReviewCfg({ channel: "whatsapp_manual" });
    openWindow();
    expect(await send()).toEqual({ sent: true });
    expect(freeForm).toHaveBeenCalledTimes(1);
  });

  it("sends a TEMPLATE review request on the CLOUD rail", async () => {
    setSub({ whatsappEnabledByAgency: true, whatsappProvider: "cloud" });
    setApprovedTemplate();
    expect(await send()).toEqual({ sent: true });
    expect(templateDispatch).toHaveBeenCalledTimes(1);
  });

  it("still refuses when the rail itself is not ready", async () => {
    // Health belongs to the send path, and it must still bite: an unreachable
    // bridge is a refusal, just not a Twilio-shaped one.
    setSub({ whatsappEnabledByAgency: true, whatsappProvider: "bridge" });
    setReviewCfg({ channel: "whatsapp_manual" });
    openWindow();
    bridgeHealth.mockResolvedValue({
      reachable: false,
      connected: false,
      killed: false,
    });
    expect(await send()).toEqual({
      sent: false,
      reason: "whatsapp_not_configured",
    });
    expect(freeForm).not.toHaveBeenCalled();
  });

  it("still refuses a Cloud workspace whose credentials are missing", async () => {
    setSub({ whatsappEnabledByAgency: true, whatsappProvider: "cloud" });
    setReviewCfg({ channel: "whatsapp_manual" });
    openWindow();
    cloudConfigured.mockResolvedValue(false);
    expect(await send()).toEqual({
      sent: false,
      reason: "whatsapp_not_configured",
    });
    expect(freeForm).not.toHaveBeenCalled();
  });
});

describe("a rail with no templates says so", () => {
  it("refuses a template send on the bridge with its own distinct reason", async () => {
    // NOT `template_not_approved`: there is nothing to approve, and the fix is
    // to change the channel or the rail rather than to wait on Meta.
    setSub({ whatsappEnabledByAgency: true, whatsappProvider: "bridge" });
    setApprovedTemplate();
    expect(await send()).toEqual({
      sent: false,
      reason: "rail_has_no_templates",
    });
    expect(templateDispatch).not.toHaveBeenCalled();
  });

  it("refuses before reading the configured template id", async () => {
    // Order matters: with no template selected, a check placed after the
    // `no_template` guard would report the wrong fact.
    setSub({ whatsappEnabledByAgency: true, whatsappProvider: "bridge" });
    setReviewCfg({ channel: "whatsapp_template", whatsappTemplateId: null });
    expect(await send()).toEqual({
      sent: false,
      reason: "rail_has_no_templates",
    });
  });

  it("still allows a template send on Twilio, which supports them", async () => {
    setSub({ whatsappEnabledByAgency: true, whatsappProvider: "twilio" });
    subAccountWhatsappIsConfigured.mockReturnValue(true);
    setApprovedTemplate();
    expect(await send()).toEqual({ sent: true });
    expect(templateDispatch).toHaveBeenCalledTimes(1);
  });
});
