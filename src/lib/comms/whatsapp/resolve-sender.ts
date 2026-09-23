import {
  capabilitiesFor,
  resolveWhatsAppProviderId,
  type WhatsAppProviderCapabilities,
  type WhatsAppProviderId,
} from "./provider";
import {
  LEGACY_WHATSAPP_SENDER_ID,
  type WhatsAppSender,
} from "@/types/whatsapp-senders";

/**
 * THE one place a WhatsApp send decides which sender it is going out on.
 *
 * Readiness, template approval and dispatch all resolve through this function
 * so they cannot disagree about the rail in play. They have disagreed before:
 * `execWhatsappTemplate` asked `checkWhatsappReadiness` for the rail and then
 * asked `resolveProviderForSubAccount` again for the approval check, which is
 * two reads of the same fact and two chances to answer differently.
 *
 * Pure and client-safe — it reads only the member-readable display metadata on
 * the sub-account doc, so the settings UI and the builder can call it too.
 */

/** The sub-account fields a sender resolves from. */
export interface WhatsappSenderSource {
  whatsappSenders?: WhatsAppSender[] | null;
  whatsappProvider?: string | null;
  twilioConfig?: { whatsappFromNumber?: string | null } | null;
  whatsappCloudMeta?: {
    displayPhoneNumber?: string | null;
    phoneNumberId?: string | null;
  } | null;
  whatsappBridgeMeta?: { displayPhoneNumber?: string | null } | null;
}

export type WhatsappSenderResolution =
  | {
      ok: true;
      sender: WhatsAppSender;
      provider: WhatsAppProviderId;
      capabilities: WhatsAppProviderCapabilities;
    }
  | { ok: false; error: string };

const RAIL_LABEL: Record<WhatsAppProviderId, string> = {
  twilio: "Twilio",
  cloud: "WhatsApp Cloud",
  bridge: "Linked device",
};

function railNumber(
  sub: WhatsappSenderSource | null | undefined,
  provider: WhatsAppProviderId,
): string {
  switch (provider) {
    case "cloud":
      return sub?.whatsappCloudMeta?.displayPhoneNumber ?? "";
    case "bridge":
      return sub?.whatsappBridgeMeta?.displayPhoneNumber ?? "";
    default:
      return sub?.twilioConfig?.whatsappFromNumber ?? "";
  }
}

/**
 * Every sender this sub-account can send from — always at least one.
 *
 * A sub-account with no registry gets a synthesized sender for the rail it
 * already runs on, so a workspace that predates this feature behaves exactly
 * as it did: same rail, same number, same credentials, nothing migrated.
 */
export function listWhatsappSenders(
  sub: WhatsappSenderSource | null | undefined,
): WhatsAppSender[] {
  const stored = sub?.whatsappSenders;
  if (stored && stored.length > 0) return stored;
  const provider = resolveWhatsAppProviderId(sub?.whatsappProvider);
  return [
    {
      id: LEGACY_WHATSAPP_SENDER_ID,
      label: RAIL_LABEL[provider],
      provider,
      phoneNumber: railNumber(sub, provider),
      isDefault: true,
    },
  ];
}

/**
 * Resolve the sender a send goes out on.
 *
 * `senderId` is the step's choice; empty or absent means the sub-account
 * default, which is what every workflow built before the registry carries.
 * An id that is not in THIS sub-account's registry is refused rather than
 * falling back to the default — a step pointing at another workspace's number,
 * or at a sender that was deleted, must fail loudly instead of quietly sending
 * from somewhere else.
 */
export function resolveWhatsappSender(
  sub: WhatsappSenderSource | null | undefined,
  senderId?: string | null,
): WhatsappSenderResolution {
  const senders = listWhatsappSenders(sub);
  const wanted = senderId?.trim();

  let sender: WhatsAppSender | undefined;
  if (wanted) {
    sender = senders.find((s) => s.id === wanted);
    if (!sender) {
      return {
        ok: false,
        error:
          "The WhatsApp sender this step was set to send from no longer exists on this workspace. Pick a sender again.",
      };
    }
  } else {
    sender = senders.find((s) => s.isDefault === true) ?? senders[0];
  }

  if (sender.credentialsId) {
    // Fails closed. Per-sender credentials are not implemented — every rail
    // still reads one credential doc per sub-account — so honouring the field
    // would mean sending this sender's messages on another sender's account.
    return {
      ok: false,
      error: `The WhatsApp sender "${sender.label}" asks for its own credentials, which this workspace doesn't support yet.`,
    };
  }

  const provider = resolveWhatsAppProviderId(sender.provider);
  return { ok: true, sender, provider, capabilities: capabilitiesFor(provider) };
}

/**
 * Does this sub-account have a sender on `provider` AT ALL?
 *
 * The question an INBOUND webhook asks, and it is not the same question a send
 * asks. Traffic arrives on whichever rail the customer's message came in on;
 * "is that rail the DEFAULT?" would drop a real message to a real number
 * merely because another sender is the one workflows send from. Membership is
 * the correct guard, and it still refuses a rail the workspace does not run —
 * a bridge left pointed at a workspace that disconnected it.
 *
 * For a sub-account with no registry the only member is the synthesized
 * sender, so this is exactly the old `provider === "<rail>"` check.
 */
export function hasWhatsappSenderOnRail(
  sub: WhatsappSenderSource | null | undefined,
  provider: WhatsAppProviderId,
): boolean {
  return listWhatsappSenders(sub).some(
    (s) => resolveWhatsAppProviderId(s.provider) === provider,
  );
}

/**
 * The sender on `provider` a reply should go out on — the rail's default if it
 * is the workspace default, else the first sender on that rail. Null when the
 * workspace has no sender on it (the caller then falls back to the default).
 *
 * Replies must leave from the number the customer wrote to: answering an
 * inbound on one number from another is a message from a stranger.
 */
export function whatsappSenderIdOnRail(
  sub: WhatsappSenderSource | null | undefined,
  provider: WhatsAppProviderId,
): string | null {
  const onRail = listWhatsappSenders(sub).filter(
    (s) => resolveWhatsAppProviderId(s.provider) === provider,
  );
  return (onRail.find((s) => s.isDefault === true) ?? onRail[0])?.id ?? null;
}
