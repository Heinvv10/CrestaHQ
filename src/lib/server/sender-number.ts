import "server-only";

import { agencyAllowsSharedSms } from "@/lib/agency/policy";
import { smsIsConfigured, subAccountTwilioIsConfigured } from "@/lib/comms/twilio";
import { railNumber, resolveWhatsappSender } from "@/lib/comms/whatsapp/resolve-sender";
import type { SubAccountDoc } from "@/types";
import type { VoiceChannelConfig } from "@/types/ai";

/**
 * The number an agent's SMS or WhatsApp message goes out from, resolved the
 * way the send resolves it (without reading any secret): `number` is what
 * is pinned and re-checked (at send, at a scheduled fire), `display` what
 * the approval preview's "From" row shows. For WhatsApp the pin is
 * `<rail>:<number>` (a switch to another rail at the same number is a
 * different sender) and the display adds the sender's label, so a label
 * rename re-shows the preview but refuses nothing.
 * Null when there is none (the send is then refused).
 */
export async function messageSender(
  sub: SubAccountDoc | undefined,
  channel: "sms" | "whatsapp"
): Promise<{ number: string; display: string } | null> {
  if (channel === "whatsapp") {
    // The default sender, as dispatchWhatsappSend resolves it (no senderId),
    // by its rail's CONNECTED number (what the rail sends from), not the
    // number typed into the registry.
    const r = resolveWhatsappSender(sub);
    if (!r.ok) return null;
    const number = railNumber(sub, r.provider);
    return { number: `${r.provider}:${number}`, display: `${number || "(no number connected)"} (${r.sender.label})` };
  }
  // getTwilioForSubAccount: the dedicated number, else the shared one if the agency allows it.
  const number = subAccountTwilioIsConfigured(sub?.twilioConfig)
    ? sub!.twilioConfig!.fromNumber
    : smsIsConfigured() && (await agencyAllowsSharedSms(sub?.agencyId ?? null))
      ? process.env.TWILIO_FROM_NUMBER?.trim() || null
      : null;
  return number ? { number, display: number } : null;
}

/** The number a voice call rings from. Calls go out through the Vapi phone
 *  resource (vapiPhoneNumberId), so it is the number that resource was
 *  provisioned from (recorded at provisioning as vapiPhoneNumber), not the
 *  Twilio number now: a Twilio number change doesn't move it. Without the
 *  record (legacy, or vapi-managed) only the Vapi id is known. */
export function voiceSenderNumber(voice: Pick<VoiceChannelConfig, "numberMode" | "vapiPhoneNumberId" | "vapiPhoneNumber">): string {
  if ((voice.numberMode ?? "twilio-byoc") === "vapi-managed") {
    return `the Vapi-managed number ${voice.vapiPhoneNumberId} (its number isn't recorded here)`;
  }
  return voice.vapiPhoneNumber || `the number imported to Vapi as ${voice.vapiPhoneNumberId}`;
}
