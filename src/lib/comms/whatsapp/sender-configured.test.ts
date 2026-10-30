import { describe, expect, it } from "vitest";
import { whatsappSenderConfigured } from "./sender-configured";

const twilio = { twilioConfig: { whatsappFromNumber: "+27110000000" } };
const cloud = { whatsappCloudMeta: { phoneNumberId: "1234567890" } };
const bridge = { whatsappBridgeMeta: { displayPhoneNumber: "+27784356159" } };

describe("whatsappSenderConfigured", () => {
  it("asks each rail for its OWN sender", () => {
    expect(whatsappSenderConfigured({ ...twilio, whatsappProvider: "twilio" })).toBe(true);
    expect(whatsappSenderConfigured({ ...cloud, whatsappProvider: "cloud" })).toBe(true);
    expect(whatsappSenderConfigured({ ...bridge, whatsappProvider: "bridge" })).toBe(true);
  });

  it("does not accept another rail's sender as this rail's", () => {
    // The bug this function was extracted to fix, in both directions: a Cloud
    // workspace was refused for having no Twilio number, and a workspace with
    // a stale twilioConfig left over from a migration must not read as ready
    // on a rail it no longer sends over.
    expect(whatsappSenderConfigured({ ...twilio, whatsappProvider: "cloud" })).toBe(false);
    expect(whatsappSenderConfigured({ ...twilio, whatsappProvider: "bridge" })).toBe(false);
    expect(whatsappSenderConfigured({ ...cloud, whatsappProvider: "twilio" })).toBe(false);
    expect(whatsappSenderConfigured({ ...bridge, whatsappProvider: "twilio" })).toBe(false);
    expect(whatsappSenderConfigured({ ...cloud, whatsappProvider: "bridge" })).toBe(false);
  });

  it("treats a legacy workspace with no provider field as Twilio", () => {
    // Matches DEFAULT_WHATSAPP_PROVIDER. Reading undefined as anything else
    // would silently report every pre-existing workspace as unconfigured.
    expect(whatsappSenderConfigured(twilio)).toBe(true);
    expect(whatsappSenderConfigured(cloud)).toBe(false);
  });

  it.each([
    ["null sub-account", null],
    ["undefined sub-account", undefined],
    ["empty object", {}],
    ["blank twilio number", { twilioConfig: { whatsappFromNumber: "" } }],
    ["null cloud id", { whatsappProvider: "cloud", whatsappCloudMeta: { phoneNumberId: null } }],
    ["null bridge number", { whatsappProvider: "bridge", whatsappBridgeMeta: { displayPhoneNumber: null } }],
    ["bridge meta absent", { whatsappProvider: "bridge" }],
  ])("is false for %s", (_label, sub) => {
    expect(whatsappSenderConfigured(sub)).toBe(false);
  });

  it("falls back to Twilio for an unrecognised provider value", () => {
    expect(whatsappSenderConfigured({ ...twilio, whatsappProvider: "carrier-pigeon" })).toBe(true);
    expect(whatsappSenderConfigured({ ...cloud, whatsappProvider: "carrier-pigeon" })).toBe(false);
  });
});
