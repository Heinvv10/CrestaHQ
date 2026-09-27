import "server-only";

import { agencyAllowsSharedSms } from "@/lib/agency/policy";
import { smsIsConfigured, subAccountTwilioIsConfigured } from "@/lib/comms/twilio";
import { railNumber, resolveWhatsappSender } from "@/lib/comms/whatsapp/resolve-sender";
import type { SubAccountDoc } from "@/types";
import type { VoiceChannelConfig } from "@/types/ai";

/**
 * The number an agent's SMS, WhatsApp message or voice call goes out from,
 * resolved the way the send resolves it (without reading any secret), for
 * the approval preview's "From" row and its pin: a default sender changed
 * after the proposal changes the preview. Null when there is none (the send
 * is then refused).
 */
export async function messageSenderNumber(
  sub: SubAccountDoc | undefined,
  channel: "sms" | "whatsapp"
): Promise<string | null> {
  if (channel === "whatsapp") {
    // The default sender, as dispatchWhatsappSend resolves it (no senderId),
    // shown by its rail's CONNECTED number (what the rail sends from), not
    // the number typed into the registry.
    const r = resolveWhatsappSender(sub);
    return r.ok ? `${railNumber(sub, r.provider) || "(no number connected)"} (${r.sender.label})` : null;
  }
  // getTwilioForSubAccount: the dedicated number, else the shared one if the agency allows it.
  if (subAccountTwilioIsConfigured(sub?.twilioConfig)) return sub!.twilioConfig!.fromNumber;
  if (smsIsConfigured() && (await agencyAllowsSharedSms(sub?.agencyId ?? null))) {
    return process.env.TWILIO_FROM_NUMBER?.trim() || null;
  }
  return null;
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
