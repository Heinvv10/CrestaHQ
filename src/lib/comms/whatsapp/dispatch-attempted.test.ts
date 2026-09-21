import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubAccountDoc } from "@/types";
import type { WhatsappTemplateDoc } from "@/types/whatsapp-templates";

/**
 * `attempted` on a WhatsApp dispatch result (SP5 d1): true only when a
 * provider was actually called. A review ask counts as a failed request only
 * then — a refusal decided before anything was sent (no approved template, a
 * shut window, missing credentials) is no request at all.
 */

const getWabaCreds = vi.fn();
const sendWhatsappCloud = vi.fn();
const getBridgeCreds = vi.fn();
const sendWhatsappBridge = vi.fn();
vi.mock("./cloud-credentials", () => ({ getWabaCreds: (...a: unknown[]) => getWabaCreds(...a) }));
vi.mock("./cloud-client", () => ({ sendWhatsappCloud: (...a: unknown[]) => sendWhatsappCloud(...a) }));
vi.mock("./bridge-credentials", () => ({ getBridgeCreds: (...a: unknown[]) => getBridgeCreds(...a) }));
vi.mock("./bridge-client", () => ({ sendWhatsappBridge: (...a: unknown[]) => sendWhatsappBridge(...a) }));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => {
    throw new Error("no Firestore: lastInboundAt is supplied");
  },
}));

import { dispatchWhatsappSend } from "./send-dispatch";
import { dispatchWhatsappTemplateSend } from "./template-dispatch";

const sub = (provider?: string) => ({ whatsappProvider: provider }) as unknown as SubAccountDoc;
const rejected = { ok: false, error: "rejected", providerOutcome: "DEFINITELY_REJECTED" };
const tpl = { name: "thanks", language: "en", contentSid: "HX1", status: "approved" } as unknown as WhatsappTemplateDoc;

function send(over: Record<string, unknown> = {}) {
  return dispatchWhatsappSend({
    subAccountId: "sa_1", subAccount: sub(), contactId: "c1", to: "+27821234567", body: "hi",
    lastInboundAt: new Date(Date.now() - 3600_000), sendViaTwilio: vi.fn().mockResolvedValue(rejected), ...over,
  });
}

beforeEach(() => {
  for (const f of [getWabaCreds, sendWhatsappCloud, getBridgeCreds, sendWhatsappBridge]) f.mockReset();
  getWabaCreds.mockResolvedValue({ phoneNumberId: "PN", wabaId: "WA", accessToken: "T" });
  getBridgeCreds.mockResolvedValue({ baseUrl: "http://127.0.0.1:1", token: "t" });
});

describe("dispatchWhatsappSend", () => {
  it.each([
    ["twilio", () => undefined],
    ["cloud", () => sendWhatsappCloud.mockResolvedValue(rejected)],
    ["bridge", () => sendWhatsappBridge.mockResolvedValue(rejected)],
  ])("a provider's own failure on %s is attempted", async (provider, arrange) => {
    arrange();
    expect(await send({ subAccount: sub(provider === "twilio" ? undefined : provider) })).toMatchObject({ ok: false, attempted: true });
  });

  it("a shut window with no template is decided before sending: not attempted", async () => {
    const r = await send({ lastInboundAt: null, template: null });
    expect(r.ok).toBe(false);
    expect(r.attempted).toBeUndefined();
  });

  it("missing Cloud credentials: not attempted", async () => {
    getWabaCreds.mockRejectedValueOnce(new Error("no creds"));
    expect((await send({ subAccount: sub("cloud") })).attempted).toBeUndefined();
  });
});

describe("dispatchWhatsappTemplateSend", () => {
  it("Twilio and Cloud provider failures are attempted", async () => {
    expect(await dispatchWhatsappTemplateSend({
      subAccountId: "sa_1", subAccount: sub(), to: "+27821234567", template: tpl, values: [],
      sendViaTwilio: vi.fn().mockResolvedValue(rejected),
    })).toMatchObject({ ok: false, attempted: true });
    sendWhatsappCloud.mockResolvedValue(rejected);
    const cloudTpl = { ...tpl, registrations: { cloud: { externalId: "9", status: "approved", rejectionReason: null } } } as unknown as WhatsappTemplateDoc;
    expect(await dispatchWhatsappTemplateSend({
      subAccountId: "sa_1", subAccount: sub("cloud"), to: "+27821234567", template: cloudTpl, values: [], sendViaTwilio: vi.fn(),
    })).toMatchObject({ ok: false, attempted: true });
  });

  it("a template not approved on the rail is refused before sending: not attempted", async () => {
    const r = await dispatchWhatsappTemplateSend({
      subAccountId: "sa_1", subAccount: sub("cloud"), to: "+27821234567", template: tpl, values: [], sendViaTwilio: vi.fn(),
    });
    expect(r.ok).toBe(false);
    expect(r.attempted).toBeUndefined();
    expect(sendWhatsappCloud).not.toHaveBeenCalled();
  });
});
