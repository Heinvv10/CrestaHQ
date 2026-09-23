import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SubAccountDoc } from "@/types";

const getWabaCreds = vi.fn();
const sendWhatsappCloud = vi.fn();
const getBridgeCreds = vi.fn();
const sendWhatsappBridge = vi.fn();

vi.mock("./cloud-credentials", () => ({
  getWabaCreds: (...a: unknown[]) => getWabaCreds(...a),
}));
vi.mock("./cloud-client", () => ({
  sendWhatsappCloud: (...a: unknown[]) => sendWhatsappCloud(...a),
}));
vi.mock("./bridge-credentials", () => ({
  getBridgeCreds: (...a: unknown[]) => getBridgeCreds(...a),
}));
vi.mock("./bridge-client", () => ({
  sendWhatsappBridge: (...a: unknown[]) => sendWhatsappBridge(...a),
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => {
    throw new Error("dispatch must not touch Firestore when lastInboundAt is supplied");
  },
}));

import { dispatchWhatsappSend } from "./send-dispatch";

const sub = (provider?: string) =>
  ({ whatsappProvider: provider }) as unknown as SubAccountDoc;

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    subAccountId: "sa_1",
    subAccount: sub(),
    contactId: "c1",
    to: "+27821234567",
    body: "hello",
    lastInboundAt: new Date(Date.now() - 3600_000),
    sendViaTwilio: vi.fn().mockResolvedValue({ ok: true, messageId: "SM1" }),
    ...overrides,
  };
}

describe("dispatchWhatsappSend", () => {
  beforeEach(() => {
    getWabaCreds.mockReset();
    sendWhatsappCloud.mockReset();
    getBridgeCreds.mockReset();
    sendWhatsappBridge.mockReset();
  });

  it("routes a legacy sub-account to Twilio", async () => {
    const input = baseInput();
    const r = await dispatchWhatsappSend(input);
    expect(r).toMatchObject({ ok: true, messageId: "SM1", provider: "twilio" });
    expect(input.sendViaTwilio).toHaveBeenCalledOnce();
    expect(sendWhatsappCloud).not.toHaveBeenCalled();
  });

  it("routes a cut-over sub-account to Cloud and never to Twilio", async () => {
    // The failure that matters: a workspace moved to Cloud still billing
    // through Twilio would be invisible except on the invoice.
    getWabaCreds.mockResolvedValue({
      phoneNumberId: "PN",
      wabaId: "WA",
      accessToken: "T",
    });
    sendWhatsappCloud.mockResolvedValue({ ok: true, messageId: "wamid.1" });
    const input = baseInput({ subAccount: sub("cloud") });
    const r = await dispatchWhatsappSend(input);
    expect(r).toMatchObject({ provider: "cloud", messageId: "wamid.1" });
    expect(input.sendViaTwilio).not.toHaveBeenCalled();
  });

  it("fails clearly when the cloud rail has no credentials", async () => {
    getWabaCreds.mockRejectedValue(new Error("not configured for sa_1"));
    const r = await dispatchWhatsappSend(baseInput({ subAccount: sub("cloud") }));
    expect(r.ok).toBe(false);
    expect(r.providerOutcome).toBe("DEFINITELY_REJECTED");
    expect(sendWhatsappCloud).not.toHaveBeenCalled();
  });

  it("does NOT silently fall back to Twilio when the cloud rail fails", async () => {
    // Falling back would send from a different number than the customer
    // expects and re-introduce the Twilio cost the cutover exists to remove.
    getWabaCreds.mockRejectedValue(new Error("nope"));
    const input = baseInput({ subAccount: sub("cloud") });
    await dispatchWhatsappSend(input);
    expect(input.sendViaTwilio).not.toHaveBeenCalled();
  });

  it("routes a bridge sub-account to the bridge sender and never to Twilio", async () => {
    getBridgeCreds.mockResolvedValue({
      baseUrl: "http://b:1",
      token: "t",
      webhookSecret: "w",
    });
    sendWhatsappBridge.mockResolvedValue({ ok: true, messageId: "3EB0" });
    const input = baseInput({ subAccount: sub("bridge") });
    const r = await dispatchWhatsappSend(input);
    expect(r).toMatchObject({ ok: true, messageId: "3EB0", provider: "bridge" });
    expect(input.sendViaTwilio).not.toHaveBeenCalled();
    expect(sendWhatsappCloud).not.toHaveBeenCalled();
  });

  it("does not claim a send is human unless the caller said so", async () => {
    // The default has to be false at every layer. A send wrongly marked human
    // escapes quiet hours, which means a customer's phone lighting up at 03:00
    // — so "forgot to pass it" must fail towards the guard, not around it.
    getBridgeCreds.mockResolvedValue({ baseUrl: "http://b:1", token: "t", webhookSecret: "w" });
    sendWhatsappBridge.mockResolvedValue({ ok: true, messageId: "3EB0" });
    await dispatchWhatsappSend(baseInput({ subAccount: sub("bridge") }));
    expect(sendWhatsappBridge).toHaveBeenCalledWith(
      expect.objectContaining({ humanReply: false }),
    );
  });

  it("passes humanReply through to the bridge when the caller marks it", async () => {
    getBridgeCreds.mockResolvedValue({ baseUrl: "http://b:1", token: "t", webhookSecret: "w" });
    sendWhatsappBridge.mockResolvedValue({ ok: true, messageId: "3EB0" });
    await dispatchWhatsappSend(baseInput({ subAccount: sub("bridge"), humanReply: true }));
    expect(sendWhatsappBridge).toHaveBeenCalledWith(
      expect.objectContaining({ humanReply: true }),
    );
  });

  it("fails clearly when the bridge rail has no credentials", async () => {
    // Otherwise this fails deep inside a fetch against an empty base URL.
    getBridgeCreds.mockRejectedValue(new Error("not configured for sa_1"));
    const input = baseInput({ subAccount: sub("bridge") });
    const r = await dispatchWhatsappSend(input);
    expect(r.ok).toBe(false);
    expect(r.providerOutcome).toBe("DEFINITELY_REJECTED");
    expect(sendWhatsappBridge).not.toHaveBeenCalled();
    expect(input.sendViaTwilio).not.toHaveBeenCalled();
  });

  it("passes a caller-supplied idempotency key through to the bridge", async () => {
    // The bridge generates one per call when none is given, so a caller whose
    // own retry must converge has to supply a stable key.
    getBridgeCreds.mockResolvedValue({
      baseUrl: "http://b:1",
      token: "t",
      webhookSecret: "w",
    });
    sendWhatsappBridge.mockResolvedValue({ ok: true, messageId: "3EB0" });
    await dispatchWhatsappSend(
      baseInput({ subAccount: sub("bridge"), idempotencyKey: "wf-step-7" }),
    );
    expect(sendWhatsappBridge).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "wf-step-7" }),
    );
  });

  it("passes an attachment through to the bridge sender", async () => {
    getBridgeCreds.mockResolvedValue({
      baseUrl: "http://b:1",
      token: "t",
      webhookSecret: "w",
    });
    sendWhatsappBridge.mockResolvedValue({ ok: true, messageId: "3EB0" });
    const attachment = {
      filename: "report.png",
      contentType: "image/png",
      data: new Blob([new Uint8Array([0, 1, 2])]),
    };
    await dispatchWhatsappSend(baseInput({ subAccount: sub("bridge"), attachment }));
    // Encoded for the bridge's JSON wire format at the last step.
    expect(sendWhatsappBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        media: { filename: "report.png", contentType: "image/png", dataBase64: "AAEC" },
      }),
    );
  });

  it("hands the bridge no media when the caller attached nothing", async () => {
    getBridgeCreds.mockResolvedValue({
      baseUrl: "http://b:1",
      token: "t",
      webhookSecret: "w",
    });
    sendWhatsappBridge.mockResolvedValue({ ok: true, messageId: "3EB0" });
    await dispatchWhatsappSend(baseInput({ subAccount: sub("bridge") }));
    expect(sendWhatsappBridge).toHaveBeenCalledWith(
      expect.objectContaining({ media: null }),
    );
  });

  it("refuses an attachment on Twilio rather than dropping it", async () => {
    // Silently sending the caption alone is the worst outcome: the operator is
    // told the report went, the prospect never receives it, and nothing in the
    // thread says which happened.
    const attachment = {
      filename: "report.png",
      contentType: "image/png",
      data: new Blob([new Uint8Array([0, 1, 2])]),
    };
    const input = baseInput({ attachment });
    const r = await dispatchWhatsappSend(input);
    expect(r.ok).toBe(false);
    expect(r.provider).toBe("twilio");
    expect(r.providerOutcome).toBe("DEFINITELY_REJECTED");
    // A code, so the route answers 400 (fix the request) rather than 502.
    expect(r.providerErrorCode).toBe("media_unsupported_rail");
    expect(input.sendViaTwilio).not.toHaveBeenCalled();
  });

  it("passes an attachment through to the cloud sender", async () => {
    getWabaCreds.mockResolvedValue({
      phoneNumberId: "PN",
      wabaId: "WA",
      accessToken: "T",
    });
    sendWhatsappCloud.mockResolvedValue({ ok: true, messageId: "wamid.1" });
    const attachment = {
      filename: "report.png",
      contentType: "image/png",
      data: new Blob([new Uint8Array([0, 1, 2])]),
    };
    const r = await dispatchWhatsappSend(
      baseInput({ subAccount: sub("cloud"), attachment }),
    );
    expect(r.ok).toBe(true);
    expect(sendWhatsappCloud).toHaveBeenCalledWith(
      expect.objectContaining({ media: attachment }),
    );
  });

  it("hands the cloud sender no media when the caller attached nothing", async () => {
    getWabaCreds.mockResolvedValue({ phoneNumberId: "PN", wabaId: "WA", accessToken: "T" });
    sendWhatsappCloud.mockResolvedValue({ ok: true, messageId: "wamid.1" });
    await dispatchWhatsappSend(baseInput({ subAccount: sub("cloud") }));
    expect(sendWhatsappCloud).toHaveBeenCalledWith(
      expect.objectContaining({ media: null }),
    );
  });

  it("forwards the window and template to the cloud sender", async () => {
    getWabaCreds.mockResolvedValue({
      phoneNumberId: "PN",
      wabaId: "WA",
      accessToken: "T",
    });
    sendWhatsappCloud.mockResolvedValue({ ok: true, messageId: "wamid.1" });
    const template = {
      name: "t",
      language: "en",
      components: [],
      approved: true,
    };
    const lastInboundAt = new Date("2026-09-01T00:00:00Z");
    await dispatchWhatsappSend(
      baseInput({ subAccount: sub("cloud"), template, lastInboundAt, windowHours: 4 }),
    );
    // Dropping either would collapse every send to "no window, no template"
    // and refuse it — the failure ndzinga-lms calls out explicitly.
    expect(sendWhatsappCloud).toHaveBeenCalledWith(
      expect.objectContaining({ template, lastInboundAt, windowHours: 4 }),
    );
  });

  it("skips the Firestore window read when lastInboundAt is supplied", async () => {
    // The admin mock throws if touched, so this passing proves the read is
    // genuinely skipped rather than merely tolerated.
    await expect(dispatchWhatsappSend(baseInput())).resolves.toMatchObject({
      ok: true,
    });
  });

  it("treats an explicit null lastInboundAt as a closed window, not as unknown", async () => {
    // A contact who has never messaged in has no open window. Reading null as
    // "unknown, proceed" would send free-form into a closed window — the exact
    // send Meta rejects and charges nothing for only because it never lands.
    const r = await dispatchWhatsappSend(
      baseInput({ subAccount: sub("cloud"), lastInboundAt: null }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE");
    expect(sendWhatsappCloud).not.toHaveBeenCalled();
  });
});

describe("the window decision is made once, for every rail", () => {
  beforeEach(() => {
    getWabaCreds.mockReset();
    sendWhatsappCloud.mockReset();
    getBridgeCreds.mockReset();
    sendWhatsappBridge.mockReset();
  });

  const closed = new Date(Date.now() - 30 * 3600_000);

  it("refuses a Twilio send outside the window without calling Twilio", async () => {
    // This is the behaviour the send route used to implement inline. Moving it
    // here is what stops the next call site from forgetting it.
    const input = baseInput({ lastInboundAt: closed });
    const r = await dispatchWhatsappSend(input);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE");
    expect(input.sendViaTwilio).not.toHaveBeenCalled();
  });

  it("refuses a Cloud send outside the window without spending a Graph call", async () => {
    const input = baseInput({ subAccount: sub("cloud"), lastInboundAt: closed });
    const r = await dispatchWhatsappSend(input);
    expect(r.ok).toBe(false);
    expect(getWabaCreds).not.toHaveBeenCalled();
    expect(sendWhatsappCloud).not.toHaveBeenCalled();
  });

  it("allows an out-of-window Cloud send when an approved template exists", async () => {
    getWabaCreds.mockResolvedValue({
      phoneNumberId: "PN",
      wabaId: "WA",
      accessToken: "T",
    });
    sendWhatsappCloud.mockResolvedValue({ ok: true, messageId: "wamid.1" });
    const r = await dispatchWhatsappSend(
      baseInput({
        subAccount: sub("cloud"),
        lastInboundAt: closed,
        template: { name: "t", language: "en", components: [], approved: true },
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("still sends free-form in-window even with a template available", async () => {
    // The $87/mo rule, asserted at the dispatch layer too: a template must not
    // win merely because one exists.
    getWabaCreds.mockResolvedValue({
      phoneNumberId: "PN",
      wabaId: "WA",
      accessToken: "T",
    });
    sendWhatsappCloud.mockResolvedValue({ ok: true, messageId: "wamid.1" });
    const input = baseInput({
      subAccount: sub("cloud"),
      template: { name: "t", language: "en", components: [], approved: true },
    });
    await dispatchWhatsappSend(input);
    // The cloud sender receives the template and decides text vs template
    // itself; what matters here is that dispatch did not refuse the send.
    expect(sendWhatsappCloud).toHaveBeenCalledOnce();
  });

  it("does not apply the window to the bridge rail", async () => {
    // The bridge is not a Meta rail: no window, no templates. A send with a
    // long-closed window must still reach the bridge sender.
    getBridgeCreds.mockResolvedValue({
      baseUrl: "http://b:1",
      token: "t",
      webhookSecret: "w",
    });
    sendWhatsappBridge.mockResolvedValue({ ok: true, messageId: "3EB0" });
    const r = await dispatchWhatsappSend(
      baseInput({ subAccount: sub("bridge"), lastInboundAt: closed }),
    );
    expect(r.ok).toBe(true);
    expect(sendWhatsappBridge).toHaveBeenCalledOnce();
  });

  describe("Twilio rail with the window shut", () => {
    const shut = new Date(Date.now() - 48 * 3600_000);
    const approved = { name: "t", language: "en", components: [], approved: true };

    it("sends the approved template, never the free-form body", async () => {
      // Twilio accepts the free-form create and rejects it asynchronously
      // (63016), so a step that sent the body logged ok for a message that
      // was never delivered.
      const sendTemplateViaTwilio = vi.fn().mockResolvedValue({ ok: true, messageId: "SMt" });
      const input = baseInput({ lastInboundAt: shut, template: approved, sendTemplateViaTwilio });
      const r = await dispatchWhatsappSend(input);
      expect(r).toMatchObject({ ok: true, messageId: "SMt", provider: "twilio", sentAs: "template" });
      expect(sendTemplateViaTwilio).toHaveBeenCalledOnce();
      expect(input.sendViaTwilio).not.toHaveBeenCalled();
    });

    it("keeps a template sender's own attempted:false refusal", async () => {
      const sendTemplateViaTwilio = vi.fn().mockResolvedValue({
        ok: false, error: "WA_TEMPLATE_VARIABLE_EMPTY", providerOutcome: "DEFINITELY_REJECTED", attempted: false,
      });
      const r = await dispatchWhatsappSend(baseInput({ lastInboundAt: shut, template: approved, sendTemplateViaTwilio }));
      expect(r).toMatchObject({ ok: false, error: "WA_TEMPLATE_VARIABLE_EMPTY", attempted: false });
    });

    it("refuses with the window reason when no Twilio template sender was given", async () => {
      const input = baseInput({ lastInboundAt: shut, template: approved });
      const r = await dispatchWhatsappSend(input);
      expect(r).toMatchObject({
        ok: false,
        provider: "twilio",
        error: "WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE",
        providerOutcome: "DEFINITELY_REJECTED",
      });
      expect(input.sendViaTwilio).not.toHaveBeenCalled();
    });

    it("still sends free-form inside the window even with a template available", async () => {
      const sendTemplateViaTwilio = vi.fn();
      const input = baseInput({ template: approved, sendTemplateViaTwilio });
      const r = await dispatchWhatsappSend(input);
      expect(r).toMatchObject({ ok: true, messageId: "SM1", sentAs: "text" });
      expect(sendTemplateViaTwilio).not.toHaveBeenCalled();
    });
  });
});
