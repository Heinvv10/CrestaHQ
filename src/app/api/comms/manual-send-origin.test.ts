import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Quiet hours hold AUTOMATED sends only. A person pressing Send in the
 * composer — SMS, WhatsApp free-form or a WhatsApp template — must reach the
 * seam marked "manual", or it would be held at night like a workflow step.
 * Real routes → real contact access → real conversation send service →
 * in-memory Firestore; the seams are spies, so nothing is sent.
 */

const sendSms = vi.fn();
const dispatchWhatsappSend = vi.fn();
const dispatchWhatsappTemplateSend = vi.fn();
vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
vi.mock("@/lib/comms/twilio", () => ({
  sendSmsForSubAccount: (...a: unknown[]) => sendSms(...a),
  sendWhatsappForSubAccount: vi.fn(),
  sendWhatsappTemplateForSubAccount: vi.fn(),
  smsIsConfigured: () => true,
  subAccountTwilioIsConfigured: () => true,
  SmsRecipientUnsubscribedError: class extends Error {},
}));
vi.mock("@/lib/comms/whatsapp/send-dispatch", () => ({ dispatchWhatsappSend: (...a: unknown[]) => dispatchWhatsappSend(...a) }));
vi.mock("@/lib/comms/whatsapp/template-dispatch", () => ({
  dispatchWhatsappTemplateSend: (...a: unknown[]) => dispatchWhatsappTemplateSend(...a),
}));
vi.mock("@/lib/comms/whatsapp/readiness", () => ({
  checkWhatsappReadiness: async () => ({ ready: true, provider: "cloud", sender: { phoneNumber: "+15550002" } }),
}));
vi.mock("@/lib/comms/ai/agent", () => ({ getChannelConfig: async () => null }));
vi.mock("@/lib/server/conversations-service", () => ({ upsertConversationForMessage: async () => undefined }));
vi.mock("@/lib/server/usage-meter", () => ({ checkQuota: async () => ({ allowed: true }), UsageQuotaExceededError: class extends Error {} }));

import { AGENCY, SA, asUser, mem, resetSync } from "@/test/gbp-sync-harness";
import { POST as smsPOST } from "@/app/api/comms/sms/send/route";
import { POST as waPOST } from "@/app/api/comms/whatsapp/send/route";
import { POST as waTplPOST } from "@/app/api/comms/whatsapp/send-template/route";

const CONTACT = "c_manual";
const call = (route: (r: Request) => Promise<Response>, path: string, body: Record<string, unknown>) =>
  route(asUser(`http://127.0.0.1:3100${path}`, "uid_collab", "POST", JSON.stringify({ contactId: CONTACT, ...body })));
const originOf = (spy: ReturnType<typeof vi.fn>) => (spy.mock.calls[0] as [{ origin?: string }])[0].origin;

beforeEach(() => {
  resetSync();
  sendSms.mockReset().mockResolvedValue({ sid: "SM1", from: "+15550001", mode: "dedicated" });
  dispatchWhatsappSend.mockReset().mockResolvedValue({ ok: true, messageId: "wamid.1", sentAs: "text", provider: "cloud" });
  dispatchWhatsappTemplateSend.mockReset().mockResolvedValue({ ok: true, messageId: "wamid.2", provider: "cloud" });
  mem.seed(`subAccounts/${SA}`, {
    ...mem.read(`subAccounts/${SA}`)!,
    name: "Fixture Co", twilioConfig: { enabled: true }, whatsappEnabledByAgency: true,
    sendWindow: { startHour: 8, endHour: 20, timezone: "Africa/Johannesburg" },
  });
  mem.seed(`contacts/${CONTACT}`, {
    name: "Fixture Person", phone: "+15005550006", agencyId: AGENCY, subAccountId: SA, createdByUid: "uid_admin",
  });
  mem.seed(`subAccounts/${SA}/whatsappTemplates/t1`, {
    name: "follow_up", displayName: "Follow up", body: "Hi {{1}}", status: "approved",
    variables: [{ position: 1, label: "Name", sampleValue: "Ben", source: "merge_tag", mergeTag: "contact.firstName" }],
  });
});

describe("composer sends reach the seam as manual", () => {
  it("SMS", async () => {
    expect((await call(smsPOST, "/api/comms/sms/send", { body: "On my way" })).status).toBe(200);
    expect(originOf(sendSms)).toBe("manual");
  });

  it("WhatsApp free-form", async () => {
    expect((await call(waPOST, "/api/comms/whatsapp/send", { body: "On my way" })).status).toBe(200);
    expect(originOf(dispatchWhatsappSend)).toBe("manual");
  });

  it("WhatsApp template", async () => {
    expect((await call(waTplPOST, "/api/comms/whatsapp/send-template", { templateId: "t1" })).status).toBe(200);
    expect(originOf(dispatchWhatsappTemplateSend)).toBe("manual");
  });
});
