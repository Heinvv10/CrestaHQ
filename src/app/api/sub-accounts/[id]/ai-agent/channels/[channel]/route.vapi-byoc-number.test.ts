import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * twilio-byoc: calls ring from the Vapi phone resource, registered from the
 * Twilio number of that moment. The voice config records that number
 * (vapiPhoneNumber) when the resource is (re)registered, keeps it while the
 * same resource is only rebound, and clears it with the resource.
 */

const ensure = vi.hoisted(() => vi.fn());
vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
vi.mock("@/lib/server/sub-account-secrets", () => ({ readSubAccountSecret: async () => "tok" }));
vi.mock("@/lib/comms/voice/vapi", () => ({
  vapiIsConfigured: () => true,
  vapiPhoneNumberExists: async () => true,
  bindVapiAssistantToPhoneNumber: vi.fn(),
  deleteVapiAssistant: vi.fn(),
  deleteVapiPhoneNumber: vi.fn(),
  ensureVapiAssistant: async () => ({ assistantId: "asst1" }),
  ensureVapiPhoneNumber: ensure,
  unbindVapiPhoneNumber: vi.fn(),
  VapiError: class extends Error {},
}));

const { mem, claims } = await import("@/test/gbp-sync-store");
const { PATCH } = await import("./route");

const SA = "sa1";
const save = (voice: Record<string, unknown>) =>
  PATCH(
    new Request(`https://app.test/api/sub-accounts/${SA}/ai-agent/channels/voice`, {
      method: "PATCH",
      headers: { "x-user-uid": "owner", "content-type": "application/json" },
      body: JSON.stringify({ voice }),
    }),
    { params: Promise.resolve({ id: SA, channel: "voice" }) },
  );
const stored = () => mem.read(`subAccounts/${SA}/aiAgent/voice`)?.voice as { vapiPhoneNumberId?: string; vapiPhoneNumber?: string | null };

beforeEach(() => {
  mem.clear();
  ensure.mockReset();
  claims.set("owner", { status: "active", agencyRole: "owner", agencyId: "ag1" });
  mem.seed(`subAccounts/${SA}`, {
    agencyId: "ag1", name: "One", inboundVoiceEnabledByAgency: true,
    twilioConfig: { enabled: true, accountSid: "AC1", authTokenSet: true, fromNumber: "+27870000001" },
  });
  mem.seed(`subAccounts/${SA}/aiAgent/profile`, { systemPrompt: "Be helpful.", businessName: "One", timezone: "UTC", escalationKeywords: [] });
  mem.seed(`subAccounts/${SA}/aiAgent/voice`, { enabled: true, voice: { numberMode: "twilio-byoc", vapiAssistantId: null, vapiPhoneNumberId: null } });
});

describe("PATCH voice (twilio-byoc) records the provisioned number", () => {
  it("a newly registered resource stores its number; a rebind of the same one keeps it", async () => {
    ensure.mockResolvedValueOnce({ phoneNumberId: "pn1", number: "+27870000001" });
    expect((await save({ maxCallSeconds: 300 })).status).toBe(200);
    expect(stored()).toMatchObject({ vapiPhoneNumberId: "pn1", vapiPhoneNumber: "+27870000001" });
    // The Twilio number changes, but the resource is only rebound (no number back).
    mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`), twilioConfig: { enabled: true, accountSid: "AC1", authTokenSet: true, fromNumber: "+27870000002" } });
    ensure.mockResolvedValueOnce({ phoneNumberId: "pn1" });
    expect((await save({ maxCallSeconds: 301 })).status).toBe(200);
    expect(stored()).toMatchObject({ vapiPhoneNumberId: "pn1", vapiPhoneNumber: "+27870000001" });
  });

  it("disabling voice clears the recorded number with the resource", async () => {
    mem.seed(`subAccounts/${SA}/aiAgent/voice`, { enabled: false, voice: { numberMode: "twilio-byoc", vapiAssistantId: "asst1", vapiPhoneNumberId: "pn1", vapiPhoneNumber: "+27870000001" } });
    expect((await save({ maxCallSeconds: 300 })).status).toBe(200);
    expect(stored()).toMatchObject({ vapiPhoneNumberId: null, vapiPhoneNumber: null });
  });

  it("another resource id with no number back leaves no stale number", async () => {
    mem.seed(`subAccounts/${SA}/aiAgent/voice`, { enabled: true, voice: { numberMode: "twilio-byoc", vapiAssistantId: "asst1", vapiPhoneNumberId: "pn1", vapiPhoneNumber: "+27870000001" } });
    ensure.mockResolvedValueOnce({ phoneNumberId: "pn2" });
    expect((await save({ maxCallSeconds: 300 })).status).toBe(200);
    expect(stored()).toMatchObject({ vapiPhoneNumberId: "pn2", vapiPhoneNumber: null });
  });
});
