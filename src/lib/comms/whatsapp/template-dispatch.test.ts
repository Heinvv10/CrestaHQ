import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SubAccountDoc } from "@/types";
import type { WhatsappTemplateDoc } from "@/types/whatsapp-templates";

const getWabaCreds = vi.fn();
const sendWhatsappCloud = vi.fn();

vi.mock("./cloud-credentials", () => ({
  getWabaCreds: (...a: unknown[]) => getWabaCreds(...a),
}));
vi.mock("./cloud-client", () => ({
  sendWhatsappCloud: (...a: unknown[]) => sendWhatsappCloud(...a),
}));

import { dispatchWhatsappTemplateSend } from "./template-dispatch";

const sub = (provider?: string) =>
  ({ whatsappProvider: provider }) as unknown as SubAccountDoc;

/** Legacy template: flat fields only, i.e. approved on Twilio. */
const twilioApproved = {
  name: "review_request",
  language: "en",
  contentSid: "HX1",
  status: "approved",
} as unknown as WhatsappTemplateDoc;

const cloudApproved = {
  name: "review_request",
  language: "en",
  contentSid: null,
  status: "draft",
  registrations: {
    cloud: { externalId: "999", status: "approved", rejectionReason: null },
  },
} as unknown as WhatsappTemplateDoc;

function input(overrides: Record<string, unknown> = {}) {
  return {
    subAccountId: "sa_1",
    subAccount: sub(),
    to: "+27821234567",
    template: twilioApproved,
    values: ["Hein"],
    sendViaTwilio: vi.fn().mockResolvedValue({ ok: true, messageId: "SM1" }),
    ...overrides,
  };
}

describe("dispatchWhatsappTemplateSend", () => {
  beforeEach(() => {
    getWabaCreds.mockReset();
    sendWhatsappCloud.mockReset();
  });

  it("sends a Twilio-approved template through Twilio with its Content SID", async () => {
    const i = input();
    const r = await dispatchWhatsappTemplateSend(i);
    expect(r).toMatchObject({ ok: true, provider: "twilio" });
    expect(i.sendViaTwilio).toHaveBeenCalledWith("HX1");
  });

  it("refuses a Twilio-approved template on the Cloud rail", async () => {
    // The core per-rail rule. Twilio's BSP approved this against Twilio's
    // WABA; ours has never seen it, so sending it by name would fail at Meta
    // with the window already shut and the customer unreachable.
    const i = input({ subAccount: sub("cloud"), template: twilioApproved });
    const r = await dispatchWhatsappTemplateSend(i);
    expect(r.ok).toBe(false);
    expect(sendWhatsappCloud).not.toHaveBeenCalled();
    expect(i.sendViaTwilio).not.toHaveBeenCalled();
  });

  it("tells the operator which rail the approval is missing on", async () => {
    // An operator looking at a green "approved" badge needs to be told the
    // approval belongs to the other rail, not just that the send failed.
    const r = await dispatchWhatsappTemplateSend(
      input({ subAccount: sub("cloud") }),
    );
    if (!r.ok) expect(r.error).toMatch(/Cloud rail|Meta WhatsApp account/);
  });

  it("sends a Cloud-approved template by name and language, not by id", async () => {
    // Meta addresses templates by name+language; there is no Content SID
    // equivalent to pass.
    getWabaCreds.mockResolvedValue({
      phoneNumberId: "PN",
      wabaId: "WA",
      accessToken: "T",
    });
    sendWhatsappCloud.mockResolvedValue({ ok: true, messageId: "wamid.1" });
    await dispatchWhatsappTemplateSend(
      input({ subAccount: sub("cloud"), template: cloudApproved }),
    );
    expect(sendWhatsappCloud).toHaveBeenCalledWith(
      expect.objectContaining({
        template: expect.objectContaining({
          name: "review_request",
          language: "en",
          approved: true,
        }),
      }),
    );
  });

  it("passes a null window so the cloud sender stays on its template branch", async () => {
    // A template send is for a shut window by definition. Anything else could
    // let the sender emit free-form text that Meta rejects.
    getWabaCreds.mockResolvedValue({
      phoneNumberId: "PN",
      wabaId: "WA",
      accessToken: "T",
    });
    sendWhatsappCloud.mockResolvedValue({ ok: true, messageId: "wamid.1" });
    await dispatchWhatsappTemplateSend(
      input({ subAccount: sub("cloud"), template: cloudApproved }),
    );
    expect(sendWhatsappCloud).toHaveBeenCalledWith(
      expect.objectContaining({ lastInboundAt: null }),
    );
  });

  it("maps positional values into Meta's body parameters", async () => {
    getWabaCreds.mockResolvedValue({
      phoneNumberId: "PN",
      wabaId: "WA",
      accessToken: "T",
    });
    sendWhatsappCloud.mockResolvedValue({ ok: true, messageId: "wamid.1" });
    await dispatchWhatsappTemplateSend(
      input({
        subAccount: sub("cloud"),
        template: cloudApproved,
        values: ["Hein", "Velocity"],
      }),
    );
    const arg = sendWhatsappCloud.mock.calls[0][0] as {
      template: { components: unknown[] };
    };
    expect(arg.template.components).toEqual([
      {
        type: "body",
        parameters: [
          { type: "text", text: "Hein" },
          { type: "text", text: "Velocity" },
        ],
      },
    ]);
  });

  it("omits the body component entirely for a template with no variables", async () => {
    // Meta rejects a body component carrying an empty parameter list.
    getWabaCreds.mockResolvedValue({
      phoneNumberId: "PN",
      wabaId: "WA",
      accessToken: "T",
    });
    sendWhatsappCloud.mockResolvedValue({ ok: true, messageId: "wamid.1" });
    await dispatchWhatsappTemplateSend(
      input({ subAccount: sub("cloud"), template: cloudApproved, values: [] }),
    );
    const arg = sendWhatsappCloud.mock.calls[0][0] as {
      template: { components: unknown[] };
    };
    expect(arg.template.components).toEqual([]);
  });

  it("refuses when the cloud rail has no credentials", async () => {
    getWabaCreds.mockRejectedValue(new Error("not configured"));
    const r = await dispatchWhatsappTemplateSend(
      input({ subAccount: sub("cloud"), template: cloudApproved }),
    );
    expect(r.ok).toBe(false);
    expect(sendWhatsappCloud).not.toHaveBeenCalled();
  });

  it("refuses on the bridge rail, which has no templates at all", async () => {
    const i = input({ subAccount: sub("bridge") });
    const r = await dispatchWhatsappTemplateSend(i);
    expect(r).toMatchObject({ ok: false, provider: "bridge" });
    expect(i.sendViaTwilio).not.toHaveBeenCalled();
  });

  it.each(["pending", "rejected", "paused", "disabled"] as const)(
    "refuses a template whose Twilio status is %s",
    async (status) => {
      const i = input({ template: { ...twilioApproved, status } });
      const r = await dispatchWhatsappTemplateSend(i);
      expect(r.ok).toBe(false);
      expect(i.sendViaTwilio).not.toHaveBeenCalled();
    },
  );

  it("refuses an approved Twilio template with no Content SID", async () => {
    const i = input({ template: { ...twilioApproved, contentSid: null } });
    expect((await dispatchWhatsappTemplateSend(i)).ok).toBe(false);
    expect(i.sendViaTwilio).not.toHaveBeenCalled();
  });
});
