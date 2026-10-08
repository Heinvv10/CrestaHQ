import { beforeEach, describe, expect, it, vi } from "vitest";

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

const { channelStates, sendMysteryShop } = await import("./send");
const { EmailSuppressedError } = await import("@/lib/comms/email-suppression");
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";

const VOICE = { vapiAssistantId: "a", vapiPhoneNumberId: "p" };
const SMTP_SUB = {
  name: "Cresta HQ",
  emailProvider: "smtp",
  smtpConfig: { host: "smtp.x", fromEmail: "info@crestahq.com", verifiedAt: "2026-10-01T00:00:00Z" },
  mailboxConfig: { enabled: true, verifiedAt: "2026-10-01T00:00:00Z" },
} as unknown as SubAccountDoc;
const contact = { agencyId: "ag1", subAccountId: "sa1", email: "info@acme.co.za", phone: "0821234567" } as Contact;
const enquiry = { email: { subject: "Enquiry", body: "Hi" }, call: "Hi, I'm calling from Cresta HQ." };
const base = { shopId: "s1", subAccountId: "sa1", sub: SMTP_SUB, contact, contactId: "c1", uid: "u1", enquiry };

beforeEach(() => {
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
      whatsapp: { available: false, reason: "Not available yet." },
      form: { available: false, reason: "Not available yet." },
    });
    ready.mockResolvedValue({ ok: false, status: 403, error: "Outbound calling is disabled for this workspace." });
    const noSmtp = await channelStates("sa1", { ...SMTP_SUB, emailProvider: "resend" });
    expect(noSmtp.email).toMatchObject({ available: false, reason: expect.stringMatching(/SMTP/) });
    expect(noSmtp.call).toEqual({ available: false, reason: "Outbound calling is disabled for this workspace." });
    const unverified = { ...SMTP_SUB, smtpConfig: { ...SMTP_SUB.smtpConfig!, verifiedAt: "" } };
    expect((await channelStates("sa1", unverified)).email.available).toBe(false);
    const noMailbox = { ...SMTP_SUB, mailboxConfig: null } as unknown as SubAccountDoc;
    expect((await channelStates("sa1", noMailbox)).email).toMatchObject({ available: false, reason: expect.stringMatching(/IMAP/) });
  });
});

describe("email", () => {
  it("goes through sendEmail on the sub-account's SMTP, archived to the contact, suppression checked", async () => {
    expect(await sendMysteryShop({ ...base, channel: "email", target: "info@acme.co.za" })).toEqual({
      ok: true, providerRef: "<m1@crestahq.com>",
    });
    expect(sendEmail).toHaveBeenCalledWith({
      to: "info@acme.co.za", subject: "Enquiry", text: "Hi", subAccount: SMTP_SUB, smtpSubAccountId: "sa1",
      suppressionSubAccountId: "sa1", archive: true, contactId: "c1", sentByUid: "u1",
    });
  });

  it("an opted-out contact or a suppressed address is refused; a provider error fails", async () => {
    const optedOut = await sendMysteryShop({ ...base, contact: { ...contact, emailOptedOut: true }, channel: "email", target: "info@acme.co.za" });
    expect(optedOut).toMatchObject({ ok: false, kind: "refused", code: "opted_out" });
    sendEmail.mockRejectedValueOnce(new EmailSuppressedError("info@acme.co.za", "hard_bounce"));
    expect(await sendMysteryShop({ ...base, channel: "email", target: "info@acme.co.za" })).toMatchObject({
      ok: false, kind: "refused", code: "email_suppressed",
    });
    sendEmail.mockRejectedValueOnce(new Error("554 rejected"));
    expect(await sendMysteryShop({ ...base, channel: "email", target: "info@acme.co.za" })).toEqual({
      ok: false, kind: "failed", reason: "554 rejected",
    });
  });
});

describe("call", () => {
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

  it("a Vapi failure fails", async () => {
    place.mockResolvedValueOnce({ ok: false, error: "Vapi 500" });
    expect(await sendMysteryShop({ ...base, channel: "call", target: "+27821234567" })).toEqual({
      ok: false, kind: "failed", reason: "Vapi 500",
    });
  });
});
