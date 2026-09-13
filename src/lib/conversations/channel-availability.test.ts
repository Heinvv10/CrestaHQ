import { describe, expect, it } from "vitest";
import {
  composerChannelOptions,
  initialComposerChannel,
  type ChannelContact,
  type ChannelSubAccount,
  type ComposerChannel,
} from "./channel-availability";

/** Every channel connected and allowed; each test breaks one thing. */
const SUB = {
  emailProvider: "smtp",
  smtpConfig: { verifiedAt: "2026-09-01T00:00:00Z" },
  twilioConfig: { enabled: true },
  whatsappEnabledByAgency: true,
  whatsappProvider: "cloud",
  whatsappCloudMeta: { phoneNumberId: "pn1", displayPhoneNumber: "+27 60" },
  metaInboxEnabledByAgency: true,
  metaConfig: {
    connected: true,
    capabilities: { inbox: true, publish: false, instagramDm: true },
  },
} as unknown as ChannelSubAccount;

const CONTACT: ChannelContact = {
  email: "a@example.test",
  phone: "+27820000000",
  emailOptedOut: false,
  smsOptedOut: false,
  whatsappOptedOut: false,
  metaUserId: "psid-1",
};
const SEEN = ["messenger", "instagram"] as const;

function option(
  channel: ComposerChannel,
  sub: Partial<Record<string, unknown>> = {},
  contact: Partial<ChannelContact> = {},
  channelsSeen: readonly ("messenger" | "instagram")[] = SEEN,
) {
  const o = composerChannelOptions({
    subAccount: { ...SUB, ...sub } as ChannelSubAccount,
    contact: { ...CONTACT, ...contact },
    channelsSeen,
  }).find((x) => x.channel === channel)!;
  return { available: o.available, code: o.code, reason: o.reason };
}

describe("composerChannelOptions", () => {
  it("lists every composer channel, in order, never web chat", () => {
    const all = composerChannelOptions({ subAccount: SUB, contact: CONTACT, channelsSeen: SEEN });
    expect(all.map((o) => o.channel)).toEqual(["email", "sms", "whatsapp", "messenger", "instagram"]);
    expect(all.every((o) => o.available && o.reason === null)).toBe(true);
  });

  it("lists every channel as not connected on a bare sub-account", () => {
    const all = composerChannelOptions({ subAccount: null, contact: CONTACT });
    expect(all.map((o) => o.available)).toEqual([false, false, false, false, false]);
  });

  describe("email", () => {
    it("needs a verified SMTP sender", () => {
      expect(option("email", { smtpConfig: { verifiedAt: null } })).toEqual({
        available: false, code: "not_connected", reason: "Not connected",
      });
      expect(option("email", { emailProvider: "resend" }).code).toBe("not_connected");
    });
    it("needs an email address", () => {
      expect(option("email", {}, { email: "" })).toEqual({
        available: false, code: "no_email", reason: "No email address",
      });
    });
    it("respects the email opt-out", () => {
      expect(option("email", {}, { emailOptedOut: true })).toEqual({
        available: false, code: "opted_out", reason: "Opted out of Email",
      });
    });
  });

  describe("sms", () => {
    it("needs Twilio enabled", () => {
      expect(option("sms", { twilioConfig: { enabled: false } }).code).toBe("not_connected");
      expect(option("sms", { twilioConfig: null }).code).toBe("not_connected");
    });
    it("needs a phone number", () => {
      expect(option("sms", {}, { phone: "" })).toEqual({
        available: false, code: "no_phone", reason: "No phone number",
      });
    });
    it("respects the SMS opt-out, independent of WhatsApp's", () => {
      expect(option("sms", {}, { smsOptedOut: true })).toEqual({
        available: false, code: "opted_out", reason: "Opted out of SMS",
      });
      expect(option("sms", {}, { whatsappOptedOut: true }).available).toBe(true);
    });
  });

  describe("whatsapp", () => {
    it("is off when the agency gate is off, even if connected", () => {
      expect(option("whatsapp", { whatsappEnabledByAgency: false })).toEqual({
        available: false, code: "agency_gate_off", reason: "Turned off by your agency",
      });
      expect(option("whatsapp", { whatsappEnabledByAgency: undefined }).code).toBe("agency_gate_off");
    });
    it("needs a sender on the rail it sends over", () => {
      expect(option("whatsapp", { whatsappCloudMeta: null }).code).toBe("not_connected");
      // A Twilio number does not connect a Cloud workspace.
      expect(
        option("whatsapp", { whatsappCloudMeta: null, twilioConfig: { enabled: true, whatsappFromNumber: "+1" } }).code,
      ).toBe("not_connected");
      expect(
        option("whatsapp", { whatsappProvider: "bridge", whatsappBridgeMeta: { displayPhoneNumber: "+27" } }).available,
      ).toBe(true);
    });
    it("needs a phone number", () => {
      expect(option("whatsapp", {}, { phone: "" }).code).toBe("no_phone");
    });
    it("respects the WhatsApp opt-out", () => {
      expect(option("whatsapp", {}, { whatsappOptedOut: true })).toEqual({
        available: false, code: "opted_out", reason: "Opted out of WhatsApp",
      });
    });
  });

  describe.each(["messenger", "instagram"] as const)("%s", (ch) => {
    it("is behind metaInboxEnabledByAgency", () => {
      expect(option(ch, { metaInboxEnabledByAgency: false }).code).toBe("agency_gate_off");
    });
    it("needs a connected Page", () => {
      expect(option(ch, { metaConfig: { connected: false } }).code).toBe("not_connected");
      expect(option(ch, { metaConfig: null }).code).toBe("not_connected");
    });
    it("needs a Meta identity on the contact", () => {
      expect(option(ch, {}, { metaUserId: null })).toEqual({
        available: false, code: "no_meta_identity", reason: "No Meta identity on this contact",
      });
    });
    it("needs the contact to have used the channel", () => {
      const other = ch === "messenger" ? "instagram" : "messenger";
      expect(option(ch, {}, {}, [other]).code).toBe("channel_not_used");
    });
    it("has no opt-out concept", () => {
      expect(
        option(ch, {}, { emailOptedOut: true, smsOptedOut: true, whatsappOptedOut: true }).available,
      ).toBe(true);
    });
  });

  it("instagram also needs the IG DM scope; messenger does not", () => {
    const noIg = { metaConfig: { connected: true, capabilities: { inbox: true, publish: false, instagramDm: false } } };
    expect(option("instagram", noIg)).toEqual({
      available: false, code: "ig_scope_missing", reason: "Instagram DM permission missing",
    });
    expect(option("messenger", noIg).available).toBe(true);
  });

  it("reports the sub-account reason before the contact's", () => {
    expect(option("whatsapp", { whatsappEnabledByAgency: false }, { phone: "", whatsappOptedOut: true }).code).toBe(
      "agency_gate_off",
    );
    expect(option("email", { smtpConfig: null }, { email: "" }).code).toBe("not_connected");
  });
});

describe("initialComposerChannel", () => {
  const opts = (sub: Partial<Record<string, unknown>> = {}, contact: Partial<ChannelContact> = {}) =>
    composerChannelOptions({
      subAccount: { ...SUB, ...sub } as ChannelSubAccount,
      contact: { ...CONTACT, ...contact },
      channelsSeen: SEEN,
    });

  it("opens on the last-used channel when it is usable", () => {
    expect(initialComposerChannel(opts(), "whatsapp")).toBe("whatsapp");
    expect(initialComposerChannel(opts(), "instagram")).toBe("instagram");
  });

  it.each([
    ["opted out", "whatsapp", {}, { whatsappOptedOut: true }],
    ["no phone", "sms", {}, { phone: "" }],
    ["no email", "email", {}, { email: "" }],
    ["no Meta identity", "messenger", {}, { metaUserId: null }],
  ] as const)("keeps the last-used channel when the contact blocks it (%s)", (_n, ch, sub, contact) => {
    expect(initialComposerChannel(opts(sub, contact), ch)).toBe(ch);
  });

  it("keeps a Meta channel the contact never used there", () => {
    const o = composerChannelOptions({ subAccount: SUB, contact: CONTACT, channelsSeen: ["messenger"] });
    expect(initialComposerChannel(o, "instagram")).toBe("instagram");
  });

  it.each([
    ["not connected", "whatsapp", { whatsappCloudMeta: null }],
    ["agency gate off", "whatsapp", { whatsappEnabledByAgency: false }],
    ["IG scope missing", "instagram", { metaConfig: { connected: true, capabilities: { inbox: true, publish: false, instagramDm: false } } }],
  ] as const)("falls back to the first available when the WORKSPACE blocks it (%s)", (_n, ch, sub) => {
    expect(initialComposerChannel(opts(sub), ch)).toBe("email");
  });

  it("never falls back to a channel the contact opted out of", () => {
    expect(
      initialComposerChannel(opts({ whatsappEnabledByAgency: false }, { emailOptedOut: true, smsOptedOut: true }), "whatsapp"),
    ).toBe("messenger");
  });

  it("uses the first available with no (or a web-chat) last channel, and null when none is", () => {
    expect(initialComposerChannel(opts(), undefined)).toBe("email");
    expect(initialComposerChannel(opts(), "web-chat")).toBe("email");
    expect(initialComposerChannel(composerChannelOptions({ subAccount: null, contact: CONTACT }), "sms")).toBeNull();
  });
});
