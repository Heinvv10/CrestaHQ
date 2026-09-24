import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubAccountDoc } from "@/types";
import type { WhatsappTemplateDoc } from "@/types/whatsapp-templates";

/**
 * Quiet hours are enforced at the shared send seams, so every automated
 * caller gets them: the SMS sender and both WhatsApp dispatchers. The carrier
 * and every rail are spies — nothing is sent. 21:00Z = 23:00 SAST.
 */

const sendSmsVia = vi.fn();
const getWabaCreds = vi.fn();
const sendWhatsappCloud = vi.fn();

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => {
    throw new Error("the seams must not touch Firestore here");
  },
}));
vi.mock("@/lib/comms/sms/select", () => ({
  sendSmsVia: (...a: unknown[]) => sendSmsVia(...a),
}));
vi.mock("@/lib/server/usage-meter", () => ({
  checkQuota: async () => ({ allowed: true }),
  recordUsage: async () => undefined,
}));
vi.mock("@/lib/server/sub-account-secrets", () => ({
  readSubAccountSecret: async () => "token",
}));
vi.mock("@/lib/comms/whatsapp/cloud-credentials", () => ({
  getWabaCreds: (...a: unknown[]) => getWabaCreds(...a),
}));
vi.mock("@/lib/comms/whatsapp/cloud-client", () => ({
  sendWhatsappCloud: (...a: unknown[]) => sendWhatsappCloud(...a),
}));

const { sendSmsForSubAccount } = await import("./twilio");
const { dispatchWhatsappSend } = await import("./whatsapp/send-dispatch");
const { dispatchWhatsappTemplateSend } = await import("./whatsapp/template-dispatch");
const { QuietHoursDeferredError } = await import("./quiet-hours");

const WINDOW = { startHour: 8, endHour: 20, timezone: "Africa/Johannesburg" };
const sub = {
  agencyId: "ag1",
  sendWindow: WINDOW,
  whatsappProvider: "cloud",
  twilioConfig: { enabled: true, accountSid: "AC1", authTokenSet: true, fromNumber: "+27110000000" },
} as unknown as SubAccountDoc;
const NIGHT = new Date("2026-09-24T21:00:00Z");
const DAY = new Date("2026-09-24T10:00:00Z");
const OPEN = new Date("2026-09-25T06:00:00Z");

const sms = (origin?: "manual" | "automated") =>
  sendSmsForSubAccount({ subAccountId: "sa1", subAccount: sub, to: "+27821234567", body: "hi", origin });
const wa = (origin?: "manual" | "automated") =>
  dispatchWhatsappSend({
    subAccountId: "sa1", subAccount: sub, contactId: "c1", to: "+27821234567", body: "hi",
    lastInboundAt: new Date(Date.now() - 3600_000), origin,
    sendViaTwilio: async () => ({ ok: true, messageId: "SM1" }),
  });
const tpl = {
  name: "follow_up", language: "en", body: "Hi", variables: [],
  registrations: { cloud: { status: "approved", externalId: "x" } },
} as unknown as WhatsappTemplateDoc;
const waTemplate = (origin?: "manual" | "automated") =>
  dispatchWhatsappTemplateSend({
    subAccountId: "sa1", subAccount: sub, to: "+27821234567", template: tpl, values: [], origin,
    sendViaTwilio: async () => ({ ok: true, messageId: "SM1" }),
  });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  sendSmsVia.mockReset().mockResolvedValue({ sid: "SMsms" });
  getWabaCreds.mockReset().mockResolvedValue({ phoneNumberId: "PN", wabaId: "WA", accessToken: "T" });
  sendWhatsappCloud.mockReset().mockResolvedValue({ ok: true, messageId: "wamid.1" });
});
afterEach(() => vi.useRealTimers());

describe("SMS seam", () => {
  it("defers an automated send at 23:00 SAST to the window's end, sending nothing", async () => {
    vi.setSystemTime(NIGHT);
    const err = await sms().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuietHoursDeferredError);
    expect((err as InstanceType<typeof QuietHoursDeferredError>).hold.until).toEqual(OPEN);
    expect(sendSmsVia).not.toHaveBeenCalled();
  });

  it("sends a manual send at 23:00 now", async () => {
    vi.setSystemTime(NIGHT);
    await expect(sms("manual")).resolves.toMatchObject({ sid: "SMsms" });
    expect(sendSmsVia).toHaveBeenCalledOnce();
  });

  it("sends an automated send inside the window now", async () => {
    vi.setSystemTime(DAY);
    await expect(sms()).resolves.toMatchObject({ sid: "SMsms" });
  });
});

describe("WhatsApp free-form seam", () => {
  it("refuses an automated send at 23:00 with quiet_hours + when they end, touching no rail", async () => {
    vi.setSystemTime(NIGHT);
    const r = await wa("automated");
    expect(r).toMatchObject({ ok: false, refusedBy: "quiet_hours", attempted: false });
    expect(r.quietHours?.until).toEqual(OPEN);
    expect(sendWhatsappCloud).not.toHaveBeenCalled();
  });

  it("sends a manual send at 23:00 now", async () => {
    vi.setSystemTime(NIGHT);
    await expect(wa("manual")).resolves.toMatchObject({ ok: true, messageId: "wamid.1" });
  });

  it("sends an automated send inside the window now", async () => {
    vi.setSystemTime(DAY);
    await expect(wa()).resolves.toMatchObject({ ok: true });
  });
});

describe("WhatsApp template seam", () => {
  it("refuses an automated template send at 23:00, touching no rail", async () => {
    vi.setSystemTime(NIGHT);
    const r = await waTemplate();
    expect(r).toMatchObject({ ok: false, refusedBy: "quiet_hours" });
    expect(sendWhatsappCloud).not.toHaveBeenCalled();
  });

  it("sends a manual template send at 23:00 now", async () => {
    vi.setSystemTime(NIGHT);
    await expect(waTemplate("manual")).resolves.toMatchObject({ ok: true });
  });
});
