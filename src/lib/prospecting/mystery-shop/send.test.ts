import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The send seam: channel availability and the provider calls, each faked at
 * the existing rail (sendEmail, the outbound compliance gate, placeContactCall).
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const sendEmail = vi.fn();
vi.mock("@/lib/comms/resend", async (orig) => ({
  ...(await orig<typeof import("@/lib/comms/resend")>()),
  sendEmail: (...a: unknown[]) => sendEmail(...a),
}));
const compliance = vi.fn();
vi.mock("@/lib/comms/voice/outbound-compliance", () => ({ checkOutboundCompliance: (...a: unknown[]) => compliance(...a) }));
const ready = vi.fn();
const place = vi.fn();
vi.mock("@/lib/server/voice-call", () => ({
  outboundVoiceReady: (...a: unknown[]) => ready(...a),
  placeContactCall: (...a: unknown[]) => place(...a),
}));

vi.mock("./form/engine-image", () => ({ formEngineAvailable: async () => true }));

const { channelStates, sendMysteryShop } = await import("./send");
const { EmailSuppressedError } = await import("@/lib/comms/email-suppression");
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";

const VOICE = { vapiAssistantId: "a", vapiPhoneNumberId: "p" };
const SMTP_SUB = {
  name: "Cresta HQ",
  emailProvider: "smtp",
  smtpConfig: { host: "smtp.x", fromEmail: "info@crestahq.com", verifiedAt: "2026-10-01T00:00:00Z" },
  mailboxConfig: { enabled: true, verifiedAt: "2026-10-01T00:00:00Z", username: "Info@CrestaHQ.com" },
} as unknown as SubAccountDoc;
const contact = { agencyId: "ag1", subAccountId: "sa1", email: "info@acme.co.za", phone: "0821234567" } as Contact;
const enquiry = { email: { subject: "Enquiry", body: "Hi" }, call: "Hi, I'm calling from Cresta HQ." };
const base = { shopId: "s1", subAccountId: "sa1", sub: SMTP_SUB, contact, contactId: "c1", uid: "u1", enquiry, consentAck: true };

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crm.test");
  sendEmail.mockReset().mockResolvedValue({ id: "<m1@crestahq.com>", saved: true });
  compliance.mockReset().mockResolvedValue({ allowed: true, e164: "+27821234567" });
  ready.mockReset().mockResolvedValue({ ok: true, voice: VOICE, agentTimezone: "Africa/Johannesburg" });
  place.mockReset().mockResolvedValue({ ok: true, callId: "call_1" });
});

describe("channelStates", () => {
  it("email needs SMTP verified and the IMAP mailbox; call needs the outbound voice rail", async () => {
    expect(await channelStates("sa1", SMTP_SUB)).toEqual({
      email: { available: true },
      call: { available: true },
      // The WhatsApp rules are route.whatsapp.test.ts's; an agency gate off is the first of them.
      whatsapp: { available: false, reason: "WhatsApp is disabled for this sub-account by your agency." },
      // The form needs the synced mailbox and the engine (form/target.test.ts), not SMTP.
      form: { available: true },
    });
    expect((await channelStates("sa1", { ...SMTP_SUB, emailProvider: "resend" })).form).toEqual({ available: true });
    ready.mockResolvedValue({ ok: false, status: 403, error: "Outbound calling is disabled for this workspace." });
    const noSmtp = await channelStates("sa1", { ...SMTP_SUB, emailProvider: "resend" });
    expect(noSmtp.email).toMatchObject({ available: false, reason: expect.stringMatching(/SMTP/) });
    expect(noSmtp.call).toEqual({ available: false, reason: "Outbound calling is disabled for this workspace." });
    const unverified = { ...SMTP_SUB, smtpConfig: { ...SMTP_SUB.smtpConfig!, verifiedAt: "" } };
    expect((await channelStates("sa1", unverified)).email.available).toBe(false);
    const noMailbox = { ...SMTP_SUB, mailboxConfig: null } as unknown as SubAccountDoc;
    expect((await channelStates("sa1", noMailbox)).email).toMatchObject({ available: false, reason: expect.stringMatching(/IMAP/) });
    const failing = { ...SMTP_SUB, mailboxConfig: { enabled: true, verifiedAt: "2026-10-01T00:00:00Z", username: "desk@crestahq.com", lastError: "Mailbox login failed." } } as unknown as SubAccountDoc;
    expect((await channelStates("sa1", failing)).email).toEqual({ available: false, reason: "The mailbox sync is failing: Mailbox login failed." });
    // The SMTP sender (bounces' return path) must be the synced mailbox (the Reply-To).
    const other = { ...SMTP_SUB, mailboxConfig: { enabled: true, verifiedAt: "x", username: "desk@crestahq.com" } } as unknown as SubAccountDoc;
    expect((await channelStates("sa1", other)).email).toEqual({
      available: false, reason: "Mystery-shop email needs the SMTP sender and the synced mailbox to be the same address.",
    });
    // Replies must come back to the synced mailbox: without its address there is no Reply-To.
    for (const username of ["desk", "", undefined]) {
      const unknown = { ...SMTP_SUB, mailboxConfig: { enabled: true, verifiedAt: "x", username } } as unknown as SubAccountDoc;
      expect((await channelStates("sa1", unknown)).email).toEqual({ available: false, reason: "The mailbox address isn't known." });
    }
  });
});

describe("the call channel and the public URL", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("is unavailable, not an uncertain send later, when the public URL Vapi calls back is not set", async () => {
    vi.stubEnv("VAPI_PUBLIC_BASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect((await channelStates("sa1", SMTP_SUB)).call).toEqual({
      available: false, reason: "Voice calling needs the app's public URL (VAPI_PUBLIC_BASE_URL or NEXT_PUBLIC_APP_URL).",
    });
    vi.stubEnv("VAPI_PUBLIC_BASE_URL", "https://crm.example.com");
    expect((await channelStates("sa1", SMTP_SUB)).call).toEqual({ available: true });
  });
});

describe("email", () => {
  it("goes through sendEmail on the sub-account's SMTP, archived to the contact, suppression checked", async () => {
    expect(await sendMysteryShop({ ...base, channel: "email", target: "info@acme.co.za" })).toEqual({
      ok: true, providerRef: "<m1@crestahq.com>",
    });
    expect(sendEmail).toHaveBeenCalledWith({
      to: "info@acme.co.za", subject: "Enquiry", text: "Hi", subAccount: SMTP_SUB, meter: { subAccountId: "sa1" },
      replyTo: "info@crestahq.com",
      archive: true, contactId: "c1", sentByUid: "u1",
    });
  });

  it("an opted-out contact or a suppressed address is refused; a provider error fails", async () => {
    const optedOut = await sendMysteryShop({ ...base, contact: { ...contact, emailOptedOut: true }, channel: "email", target: "info@acme.co.za" });
    expect(optedOut).toMatchObject({ ok: false, kind: "refused", code: "opted_out" });
    sendEmail.mockRejectedValueOnce(new EmailSuppressedError("info@acme.co.za", "hard_bounce"));
    expect(await sendMysteryShop({ ...base, channel: "email", target: "info@acme.co.za" })).toMatchObject({
      ok: false, kind: "refused", code: "email_suppressed",
    });
    sendEmail.mockRejectedValueOnce(new Error("SMTP is not connected."));
    expect(await sendMysteryShop({ ...base, channel: "email", target: "info@acme.co.za" })).toEqual({
      ok: false, kind: "failed", reason: "SMTP is not connected.",
    });
  });

  it("an error after the SMTP server was asked is uncertain, not failed", async () => {
    const { markProviderAttempted } = await import("@/lib/comms/provider-attempt");
    sendEmail.mockRejectedValueOnce(markProviderAttempted(new Error("socket hang up")));
    expect(await sendMysteryShop({ ...base, channel: "email", target: "info@acme.co.za" })).toEqual({
      ok: false, kind: "uncertain", providerRef: null, reason: "socket hang up",
    });
  });
});

describe("call", () => {
  it("passes the operator's own consent through — never a hard-coded true", async () => {
    compliance.mockResolvedValueOnce({ allowed: false, code: "no_consent", reason: "Confirm you have consent to call this contact." });
    expect(await sendMysteryShop({ ...base, consentAck: false, channel: "call", target: "+27821234567" })).toMatchObject({
      ok: false, kind: "refused", code: "no_consent",
    });
    expect(compliance).toHaveBeenCalledWith(expect.objectContaining({ consentAck: false }));
    expect(place).not.toHaveBeenCalled();
  });

  it("passes the compliance gate with the operator's consent for the confirmed number, then places a capped call", async () => {
    expect(await sendMysteryShop({ ...base, channel: "call", target: "+27821234567" })).toEqual({ ok: true, providerRef: "call_1" });
    expect(compliance).toHaveBeenCalledWith(expect.objectContaining({
      subAccountId: "sa1", consentAck: true, contact: expect.objectContaining({ phone: "+27821234567" }),
    }));
    expect(place).toHaveBeenCalledWith(expect.objectContaining({
      customerNumber: "+27821234567",
      mysteryShop: { id: "s1", firstMessage: "Hi, I'm calling from Cresta HQ.", maxDurationSeconds: 120 },
    }));
  });

  it("a compliance refusal is refused with its code and reason, and nothing is dialled", async () => {
    compliance.mockResolvedValueOnce({ allowed: false, code: "outside_window", reason: "It's outside the calling window." });
    expect(await sendMysteryShop({ ...base, channel: "call", target: "+27821234567" })).toEqual({
      ok: false, kind: "refused", code: "outside_window", reason: "It's outside the calling window.",
    });
    expect(place).not.toHaveBeenCalled();
  });

  it("a call Vapi rejected fails; one whose fate is unknown is uncertain", async () => {
    place.mockResolvedValueOnce({ ok: false, error: "Vapi POST /call -> 400", uncertain: false });
    expect(await sendMysteryShop({ ...base, channel: "call", target: "+27821234567" })).toEqual({
      ok: false, kind: "failed", reason: "Vapi POST /call -> 400",
    });
    place.mockResolvedValueOnce({ ok: false, error: "fetch failed", uncertain: true });
    expect(await sendMysteryShop({ ...base, channel: "call", target: "+27821234567" })).toEqual({
      ok: false, kind: "uncertain", providerRef: null, reason: "fetch failed",
    });
  });
});

describe("form", () => {
  it("is refused as not available yet, and nothing is sent", async () => {
    expect(await sendMysteryShop({ ...base, channel: "form", target: "https://acme.co.za/contact" })).toEqual({
      ok: false, kind: "refused", code: "channel_unavailable", reason: "Not available yet.",
    });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(place).not.toHaveBeenCalled();
  });
});
