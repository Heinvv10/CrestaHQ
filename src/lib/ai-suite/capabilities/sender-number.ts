import "server-only";

import { agencyAllowsSharedSms } from "@/lib/agency/policy";
import { smsIsConfigured, subAccountTwilioIsConfigured } from "@/lib/comms/twilio";
import { resolveWhatsappSender } from "@/lib/comms/whatsapp/resolve-sender";
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
    // The default sender, as dispatchWhatsappSend resolves it (no senderId).
    const r = resolveWhatsappSender(sub);
    return r.ok ? `${r.sender.phoneNumber || "(number not recorded)"} (${r.sender.label})` : null;
  }
  // getTwilioForSubAccount: the dedicated number, else the shared one if the agency allows it.
  if (subAccountTwilioIsConfigured(sub?.twilioConfig)) return sub!.twilioConfig!.fromNumber;
  if (smsIsConfigured() && (await agencyAllowsSharedSms(sub?.agencyId ?? null))) {
    return process.env.TWILIO_FROM_NUMBER?.trim() || null;
  }
  return null;
}

/** The number a voice call rings from: the sub-account's Twilio number in
 *  twilio-byoc mode; a Vapi-managed number is only known by its Vapi id. */
export function voiceSenderNumber(sub: SubAccountDoc | undefined, voice: Pick<VoiceChannelConfig, "numberMode" | "vapiPhoneNumberId">): string {
  return (voice.numberMode ?? "twilio-byoc") === "vapi-managed"
    ? `the Vapi-managed number ${voice.vapiPhoneNumberId} (its number isn't recorded here)`
    : sub?.twilioConfig?.fromNumber || "(no Twilio number on this workspace)";
}
