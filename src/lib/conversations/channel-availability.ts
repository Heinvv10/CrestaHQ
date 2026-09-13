import { metaCanInstagramDm } from "@/lib/comms/meta-capabilities";
import { whatsappSenderConfigured } from "@/lib/comms/whatsapp/sender-configured";
import type { Contact } from "@/types/contacts";
import type { SubAccountDoc } from "@/types";
import type { ConversationChannel } from "@/types/conversations";

/**
 * SP2 T7 — which composer channels can reach this contact, and why not.
 *
 * The one place that decides it. It is the conjunction of two checks that
 * used to live apart: the thread page's `availableChannels` (is the channel
 * connected and allowed for this sub-account) and the composer's
 * `hasIdentity` / `optedOut` (can THIS contact be reached on it). Their
 * semantics are kept exactly; the only change is that a channel failing
 * either is now listed with the reason instead of hidden or silently greyed.
 *
 * Display and selection only. `available: true` never means more than both
 * old checks already allowed — the send routes re-check everything, and they
 * remain the authority.
 */

/** Every channel the reply composer can send on. Web chat has its own. */
export const COMPOSER_CHANNELS = [
  "email",
  "sms",
  "whatsapp",
  "messenger",
  "instagram",
] as const satisfies readonly ConversationChannel[];

export type ComposerChannel = (typeof COMPOSER_CHANNELS)[number];

export const CHANNEL_LABEL: Record<ComposerChannel, string> = {
  email: "Email",
  sms: "SMS",
  whatsapp: "WhatsApp",
  messenger: "Messenger",
  instagram: "Instagram",
};

export type ChannelUnavailableCode =
  | "agency_gate_off"
  | "not_connected"
  | "ig_scope_missing"
  | "no_email"
  | "no_phone"
  | "no_meta_identity"
  | "channel_not_used"
  | "opted_out";

export type ChannelOption = {
  channel: ComposerChannel;
  label: string;
  available: boolean;
  code: ChannelUnavailableCode | null;
  /** Operator-facing reason, shown beside a disabled channel. */
  reason: string | null;
};

export type ChannelSubAccount = Pick<
  SubAccountDoc,
  | "emailProvider"
  | "smtpConfig"
  | "twilioConfig"
  | "whatsappEnabledByAgency"
  | "metaInboxEnabledByAgency"
  | "metaConfig"
  | "whatsappSenders"
  | "whatsappProvider"
  | "whatsappCloudMeta"
  | "whatsappBridgeMeta"
>;

export type ChannelContact = Pick<
  Contact,
  | "email"
  | "phone"
  | "emailOptedOut"
  | "smsOptedOut"
  | "whatsappOptedOut"
  | "metaUserId"
>;

function reasonText(
  code: ChannelUnavailableCode,
  channel: ComposerChannel,
): string {
  switch (code) {
    case "agency_gate_off":
      return "Turned off by your agency";
    case "not_connected":
      return "Not connected";
    case "ig_scope_missing":
      return "Instagram DM permission missing";
    case "no_email":
      return "No email address";
    case "no_phone":
      return "No phone number";
    case "no_meta_identity":
      return "No Meta identity on this contact";
    case "channel_not_used":
      return `Hasn't messaged on ${CHANNEL_LABEL[channel]}`;
    case "opted_out":
      return `Opted out of ${CHANNEL_LABEL[channel]}`;
  }
}

/** The first reason this channel cannot be used, or null when it can. */
function unavailableCode(
  channel: ComposerChannel,
  sub: ChannelSubAccount | null | undefined,
  contact: ChannelContact,
  channelsSeen: readonly ConversationChannel[],
): ChannelUnavailableCode | null {
  switch (channel) {
    case "email":
      if (!(sub?.emailProvider === "smtp" && sub.smtpConfig?.verifiedAt)) {
        return "not_connected";
      }
      if (!contact.email) return "no_email";
      return contact.emailOptedOut ? "opted_out" : null;
    case "sms":
      if (!sub?.twilioConfig?.enabled) return "not_connected";
      if (!contact.phone) return "no_phone";
      return contact.smsOptedOut ? "opted_out" : null;
    case "whatsapp":
      if (sub?.whatsappEnabledByAgency !== true) return "agency_gate_off";
      // Rail-agnostic on purpose: asking a bridge or Cloud workspace for a
      // Twilio number is not a stricter check, it is the wrong one.
      if (!whatsappSenderConfigured(sub)) return "not_connected";
      if (!contact.phone) return "no_phone";
      return contact.whatsappOptedOut ? "opted_out" : null;
    case "messenger":
    case "instagram":
      // BETA Meta channels: agency gate, a connected Page, a Meta identity on
      // the contact, and the contact has actually used this channel — so we
      // never expose a reply path the recipient can't receive. Instagram also
      // needs the IG messaging scope, declinable independently of Messenger's.
      // No STOP-style opt-out exists on Meta.
      if (sub?.metaInboxEnabledByAgency !== true) return "agency_gate_off";
      if (!sub.metaConfig?.connected) return "not_connected";
      if (channel === "instagram" && !metaCanInstagramDm(sub.metaConfig)) {
        return "ig_scope_missing";
      }
      if (!contact.metaUserId) return "no_meta_identity";
      return channelsSeen.includes(channel) ? null : "channel_not_used";
  }
}

export function composerChannelOptions(input: {
  subAccount: ChannelSubAccount | null | undefined;
  contact: ChannelContact;
  /** The conversation's `channelsSeen` (Meta channels need a prior message). */
  channelsSeen?: readonly ConversationChannel[] | null;
}): ChannelOption[] {
  const seen = input.channelsSeen ?? [];
  return COMPOSER_CHANNELS.map((channel) => {
    const code = unavailableCode(channel, input.subAccount, input.contact, seen);
    return {
      channel,
      label: CHANNEL_LABEL[channel],
      available: code === null,
      code,
      reason: code ? reasonText(code, channel) : null,
    };
  });
}
