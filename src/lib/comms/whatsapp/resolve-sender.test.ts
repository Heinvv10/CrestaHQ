import { describe, it, expect } from "vitest";
import { listWhatsappSenders, resolveWhatsappSender } from "./resolve-sender";
import type { WhatsAppSender } from "@/types/whatsapp-senders";

/**
 * The one resolution readiness, template approval and dispatch all share.
 *
 * The cases that matter are the ones where a wrong answer is invisible: a
 * workspace with no registry must resolve to exactly what it sends on today,
 * and a sender id from somewhere else must be refused rather than quietly
 * falling back to the default number.
 */

const twilio: WhatsAppSender = {
  id: "s_twilio",
  label: "Sales",
  provider: "twilio",
  phoneNumber: "+15550001",
  isDefault: true,
};
const cloud: WhatsAppSender = {
  id: "s_cloud",
  label: "Support",
  provider: "cloud",
  phoneNumber: "+27784356159",
};

describe("a sub-account with a registry", () => {
  const sub = { whatsappSenders: [twilio, cloud] };

  it("picks the sender the step named", () => {
    const r = resolveWhatsappSender(sub, "s_cloud");
    expect(r.ok && r.sender.id).toBe("s_cloud");
    expect(r.ok && r.provider).toBe("cloud");
  });

  it("picks the default when the step names none", () => {
    for (const unset of [undefined, null, "", "  "]) {
      const r = resolveWhatsappSender(sub, unset);
      expect(r.ok && r.sender.id).toBe("s_twilio");
    }
  });

  it("refuses a sender id belonging to another sub-account", () => {
    // Not a fallback to the default: a step pointing at a number this
    // workspace does not own must fail loudly, not send from a different one.
    const r = resolveWhatsappSender(sub, "s_from_another_workspace");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/no longer exists/);
  });

  it("falls back to the first sender when none is flagged default", () => {
    const r = resolveWhatsappSender({
      whatsappSenders: [{ ...twilio, isDefault: false }, cloud],
    });
    expect(r.ok && r.sender.id).toBe("s_twilio");
  });

  it("refuses a sender asking for credentials of its own", () => {
    // Per-sender credentials do not exist yet. Honouring the field would send
    // this sender's messages on another sender's account.
    const r = resolveWhatsappSender({
      whatsappSenders: [{ ...cloud, credentialsId: "cred_1", isDefault: true }],
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/credentials/);
  });
});

describe("a sub-account with no registry behaves exactly as before", () => {
  it.each([
    [
      "twilio",
      { twilioConfig: { whatsappFromNumber: "+15550002" } },
      "+15550002",
    ],
    [
      "cloud",
      { whatsappCloudMeta: { displayPhoneNumber: "+27110000000" } },
      "+27110000000",
    ],
    [
      "bridge",
      { whatsappBridgeMeta: { displayPhoneNumber: "+27784356159" } },
      "+27784356159",
    ],
  ] as const)("synthesizes the %s sender it already sends on", (
    provider,
    meta,
    number,
  ) => {
    const r = resolveWhatsappSender({ whatsappProvider: provider, ...meta });
    expect(r.ok && r.provider).toBe(provider);
    expect(r.ok && r.sender.phoneNumber).toBe(number);
    expect(r.ok && r.sender.isDefault).toBe(true);
  });

  it("reads a missing provider as twilio, like every legacy workspace", () => {
    const r = resolveWhatsappSender({
      twilioConfig: { whatsappFromNumber: "+15550002" },
    });
    expect(r.ok && r.provider).toBe("twilio");
  });

  it("still resolves when nothing at all is connected", () => {
    // The send path refuses on readiness, not here — a resolver that throws
    // would take down the settings UI of an unconfigured workspace.
    const r = resolveWhatsappSender(null);
    expect(r.ok && r.sender.phoneNumber).toBe("");
  });

  it("lists exactly one sender", () => {
    expect(listWhatsappSenders({ whatsappProvider: "cloud" })).toHaveLength(1);
  });
});
