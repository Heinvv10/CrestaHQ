import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SP5 d1 — the provider-attempt mark on the real Twilio and Resend senders,
 * with their clients stubbed: a rejected `messages.create` / `emails.send`
 * (and Resend's `{ error }` result) is attempted, and the error the caller
 * sees is otherwise exactly what it was before the mark.
 */

const m = vi.hoisted(() => ({ create: vi.fn(), resendSend: vi.fn() }));
vi.mock("twilio", () => ({ default: () => ({ messages: { create: m.create } }) }));
vi.mock("resend", () => ({ Resend: class { emails = { send: m.resendSend }; } }));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: vi.fn() }));
vi.mock("@/lib/server/usage-meter", () => ({ recordUsage: vi.fn(), checkQuota: async () => ({ allowed: true }) }));
vi.mock("@/lib/agency/policy", () => ({ agencyAllowsSharedSms: async () => false }));
vi.mock("@/lib/landing/resolve-brand", () => ({ resolveCustomBrand: async () => ({ name: "LeadStack" }) }));
vi.mock("@/lib/server/email-conversations", () => ({ recordEmailMessage: vi.fn() }));
vi.mock("@/lib/server/sub-account-secrets", () => ({ readSubAccountSecret: async () => "tok" }));

import { SmsRecipientUnsubscribedError, sendSmsForSubAccount, sendWhatsappForSubAccount, sendWhatsappTemplateForSubAccount } from "./twilio";
import { sendEmail } from "./resend";
import { providerAttempted } from "./provider-attempt";
import type { SubAccountDoc } from "@/types";

const ORIGINAL = { ...process.env };
const sub = {
  agencyId: "ag1",
  twilioConfig: { enabled: true, accountSid: "AC_test", authToken: "tok", fromNumber: "+15017122661", whatsappFromNumber: "+15017122662" },
} as unknown as SubAccountDoc;
const caught = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

beforeEach(() => {
  m.create.mockReset();
  m.resendSend.mockReset();
  delete process.env.SMS_PROVIDER;
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.EMAIL_FROM = "Test <sender@example.com>";
});
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("Twilio", () => {
  it("a rejected WhatsApp free-form create is attempted, the same error object", async () => {
    const rejection = Object.assign(new Error("Twilio 63016"), { code: 63016 });
    m.create.mockRejectedValue(rejection);
    const err = await caught(sendWhatsappForSubAccount({ subAccountId: "sa1", subAccount: sub, to: "+15005550006", body: "hi" }));
    expect(err).toBe(rejection);
    expect(providerAttempted(err)).toBe(true);
    expect((err as { code: number }).code).toBe(63016);
  });

  it("a rejected WhatsApp template create is attempted, the same error object", async () => {
    const rejection = new Error("Twilio 63024");
    m.create.mockRejectedValue(rejection);
    const err = await caught(sendWhatsappTemplateForSubAccount({ subAccountId: "sa1", subAccount: sub, to: "+15005550006", contentSid: "HX1", contentVariables: [] }));
    expect(err).toBe(rejection);
    expect(providerAttempted(err)).toBe(true);
  });

  it("a WhatsApp send refused before Twilio (no sender number) is not attempted", async () => {
    const noWa = { ...sub, twilioConfig: { ...sub.twilioConfig!, whatsappFromNumber: null } } as unknown as SubAccountDoc;
    const err = await caught(sendWhatsappForSubAccount({ subAccountId: "sa1", subAccount: noWa, to: "+15005550006", body: "hi" }));
    expect(providerAttempted(err)).toBe(false);
    expect(m.create).not.toHaveBeenCalled();
  });

  it("an SMS 21610 becomes SmsRecipientUnsubscribedError, attempted", async () => {
    m.create.mockRejectedValue(Object.assign(new Error("unsubscribed"), { code: 21610 }));
    const err = await caught(sendSmsForSubAccount({ subAccountId: "sa1", subAccount: sub, to: "+15005550006", body: "hi" }));
    expect(err).toBeInstanceOf(SmsRecipientUnsubscribedError);
    expect(providerAttempted(err)).toBe(true);
  });
});

describe("Resend", () => {
  const input = { to: "friend@example.com", subject: "Hi", text: "Hello" };

  it("a rejected send is attempted, the same error object", async () => {
    const rejection = new Error("fetch failed");
    m.resendSend.mockRejectedValue(rejection);
    const err = await caught(sendEmail(input));
    expect(err).toBe(rejection);
    expect(providerAttempted(err)).toBe(true);
  });

  it("an { error } result is attempted, with Resend's message", async () => {
    m.resendSend.mockResolvedValue({ data: null, error: { message: "domain not verified" } });
    const err = await caught(sendEmail(input));
    expect((err as Error).message).toBe("domain not verified");
    expect(providerAttempted(err)).toBe(true);
  });

  it("a result with no message id is attempted", async () => {
    m.resendSend.mockResolvedValue({ data: {}, error: null });
    const err = await caught(sendEmail(input));
    expect((err as Error).message).toBe("Resend send failed: no message id returned");
    expect(providerAttempted(err)).toBe(true);
  });

  it("no EMAIL_FROM: refused before Resend, not attempted", async () => {
    delete process.env.EMAIL_FROM;
    const err = await caught(sendEmail(input));
    expect(providerAttempted(err)).toBe(false);
    expect(m.resendSend).not.toHaveBeenCalled();
  });
});
