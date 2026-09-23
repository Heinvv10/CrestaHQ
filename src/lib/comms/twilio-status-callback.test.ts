import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every Twilio WhatsApp send registers the status callback, so a message
 * Twilio accepts and later fails (63016, 30007…) is reported back instead of
 * staying "sent". Real senders, Twilio client stubbed at `messages.create`.
 */

const m = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("twilio", () => ({ default: () => ({ messages: { create: m.create } }) }));
// Private credentials doc absent → the secret reader falls back to the
// legacy twilioConfig.authToken below.
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({ doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }) }),
}));
vi.mock("@/lib/server/usage-meter", () => ({ recordUsage: vi.fn(), checkQuota: async () => ({ allowed: true }) }));
vi.mock("@/lib/agency/policy", () => ({ agencyAllowsSharedSms: async () => false }));

import { sendWhatsappForSubAccount, sendWhatsappTemplateForSubAccount } from "./twilio";
import type { SubAccountDoc } from "@/types";

const ORIGINAL = { ...process.env };
const sub = {
  agencyId: "ag1",
  twilioConfig: { enabled: true, accountSid: "AC_test", authToken: "tok", fromNumber: "+15017122661", whatsappFromNumber: "+15017122662" },
} as unknown as SubAccountDoc;
const CALLBACK = "https://crm.example.test/api/webhooks/twilio/whatsapp/status";

beforeEach(() => {
  m.create.mockReset().mockResolvedValue({ sid: "SM1" });
  process.env.NEXT_PUBLIC_APP_URL = "https://crm.example.test/";
});
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("Twilio WhatsApp sends register the status callback", () => {
  it("free-form", async () => {
    await sendWhatsappForSubAccount({ subAccountId: "sa1", subAccount: sub, to: "+15005550006", body: "hi" });
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ statusCallback: CALLBACK }));
  });

  it("template", async () => {
    await sendWhatsappTemplateForSubAccount({ subAccountId: "sa1", subAccount: sub, to: "+15005550006", contentSid: "HX1", contentVariables: [] });
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ statusCallback: CALLBACK }));
  });

  it("omits it rather than sending a relative URL Twilio would reject", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    await sendWhatsappForSubAccount({ subAccountId: "sa1", subAccount: sub, to: "+15005550006", body: "hi" });
    expect(m.create.mock.calls[0][0]).not.toHaveProperty("statusCallback");
  });
});
