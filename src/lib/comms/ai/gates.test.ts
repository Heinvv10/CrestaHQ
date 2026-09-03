import { describe, expect, it } from "vitest";

import {
  aiChannelGateOn,
  anyAiChannelGateOn,
  aiChannelLockedMessage,
} from "./gates";
import type { SubAccountDoc } from "@/types";

/**
 * Regression tests for the agency AI-channel gates.
 *
 * These are the switches that decide whether a sub-account may burn the
 * agency's OpenRouter credits (and, for voice, Vapi minutes). A silent
 * regression is expensive in BOTH directions:
 *   - flip a default-ON channel to OFF and every legacy deployment's live
 *     bot goes silent on upgrade;
 *   - flip a default-OFF channel to ON and every deployment starts spending
 *     on WhatsApp / Meta DMs nobody authorised.
 *
 * So each channel is asserted at all three states (true / false / undefined),
 * with the undefined case pinned to the documented per-channel default.
 */

type GateSub = Parameters<typeof aiChannelGateOn>[0];

/** A sub-account doc with NO gate fields at all — the legacy shape. */
const LEGACY = {} as GateSub;

function sub(fields: Partial<SubAccountDoc>): GateSub {
  return fields as GateSub;
}

describe("aiChannelGateOn — explicit true always enables", () => {
  it.each([
    ["sms", "smsAgentEnabledByAgency"],
    ["web-chat", "webChatEnabledByAgency"],
    ["voice", "inboundVoiceEnabledByAgency"],
    ["whatsapp", "whatsappEnabledByAgency"],
    ["meta", "metaAgentEnabledByAgency"],
  ] as const)("%s is on when %s === true", (channel, field) => {
    expect(aiChannelGateOn(sub({ [field]: true }), channel)).toBe(true);
  });
});

describe("aiChannelGateOn — explicit false always locks", () => {
  // This is the half that protects the AGENCY: an owner who ticks a channel
  // off must have it stay off, including on the channels that default ON.
  it.each([
    ["sms", "smsAgentEnabledByAgency"],
    ["web-chat", "webChatEnabledByAgency"],
    ["voice", "inboundVoiceEnabledByAgency"],
    ["whatsapp", "whatsappEnabledByAgency"],
    ["meta", "metaAgentEnabledByAgency"],
  ] as const)("%s is locked when %s === false", (channel, field) => {
    expect(aiChannelGateOn(sub({ [field]: false }), channel)).toBe(false);
  });
});

describe("aiChannelGateOn — per-channel default when the field is undefined", () => {
  // The opt-OUT half: these three pre-existed the gate, so a legacy doc that
  // has never seen the field must keep the bot RUNNING.
  it.each(["sms", "web-chat", "voice"] as const)(
    "%s defaults ON for a legacy doc (opt-out channel)",
    (channel) => {
      expect(aiChannelGateOn(LEGACY, channel)).toBe(true);
    },
  );

  // The opt-IN half: these shipped gated-off, so undefined must NOT spend.
  it.each(["whatsapp", "meta"] as const)(
    "%s defaults OFF for a legacy doc (opt-in channel)",
    (channel) => {
      expect(aiChannelGateOn(LEGACY, channel)).toBe(false);
    },
  );

  it("treats an explicitly-undefined field the same as a missing one", () => {
    expect(aiChannelGateOn(sub({ smsAgentEnabledByAgency: undefined }), "sms")).toBe(
      true,
    );
    expect(
      aiChannelGateOn(sub({ whatsappEnabledByAgency: undefined }), "whatsapp"),
    ).toBe(false);
  });
});

describe("aiChannelGateOn — channels read their OWN field", () => {
  it("does not let one channel's gate leak into another", () => {
    // Every gate explicitly off except WhatsApp: only WhatsApp may pass.
    const s = sub({
      smsAgentEnabledByAgency: false,
      webChatEnabledByAgency: false,
      inboundVoiceEnabledByAgency: false,
      whatsappEnabledByAgency: true,
      metaAgentEnabledByAgency: false,
    });
    expect(aiChannelGateOn(s, "whatsapp")).toBe(true);
    expect(aiChannelGateOn(s, "sms")).toBe(false);
    expect(aiChannelGateOn(s, "web-chat")).toBe(false);
    expect(aiChannelGateOn(s, "voice")).toBe(false);
    expect(aiChannelGateOn(s, "meta")).toBe(false);
  });

  it("the inbound voice gate is NOT the outbound voice gate", () => {
    // outboundVoiceEnabledByAgency must not enable the inbound channel.
    const s = sub({
      inboundVoiceEnabledByAgency: false,
      outboundVoiceEnabledByAgency: true,
    });
    expect(aiChannelGateOn(s, "voice")).toBe(false);
  });
});

/** Every AI channel explicitly off — the "no AI at all" baseline. */
const ALL_OFF = sub({
  smsAgentEnabledByAgency: false,
  webChatEnabledByAgency: false,
  inboundVoiceEnabledByAgency: false,
  whatsappEnabledByAgency: false,
  metaAgentEnabledByAgency: false,
  outboundVoiceEnabledByAgency: false,
});

describe("anyAiChannelGateOn", () => {
  it("is false only when EVERY channel (incl. outbound) is explicitly off", () => {
    expect(anyAiChannelGateOn(ALL_OFF)).toBe(false);
  });

  it.each([
    "smsAgentEnabledByAgency",
    "webChatEnabledByAgency",
    "inboundVoiceEnabledByAgency",
    "whatsappEnabledByAgency",
    "metaAgentEnabledByAgency",
  ] as const)("is true when only %s is on", (field) => {
    expect(anyAiChannelGateOn({ ...ALL_OFF, [field]: true })).toBe(true);
  });

  it("is true when ONLY outbound voice is on (it spends Vapi minutes too)", () => {
    expect(
      anyAiChannelGateOn({ ...ALL_OFF, outboundVoiceEnabledByAgency: true }),
    ).toBe(true);
  });

  it("is false when outbound voice is merely undefined (opt-in, not default-on)", () => {
    const s = { ...ALL_OFF } as Record<string, unknown>;
    delete s.outboundVoiceEnabledByAgency;
    expect(anyAiChannelGateOn(s as Parameters<typeof anyAiChannelGateOn>[0])).toBe(
      false,
    );
  });

  it("is true for a legacy doc — the default-ON channels still count", () => {
    // Preserves pre-gate behaviour of "Test this persona" + the KB refresh.
    expect(anyAiChannelGateOn({} as Parameters<typeof anyAiChannelGateOn>[0])).toBe(
      true,
    );
  });
});

describe("aiChannelLockedMessage", () => {
  it("names the channel and points at the agency owner", () => {
    const msg = aiChannelLockedMessage("WhatsApp");
    expect(msg).toContain("WhatsApp");
    expect(msg).toContain("agency owner");
  });
});
