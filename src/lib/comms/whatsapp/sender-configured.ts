import { resolveWhatsAppProviderId } from "./provider";

/**
 * Does this workspace have a WhatsApp sender configured, on the rail it
 * actually sends over?
 *
 * The client-side counterpart to `checkWhatsappReadiness`, and it exists for
 * the same reason that function does: asking a Cloud or bridge workspace for a
 * Twilio number is not a stricter check, it is the wrong one. It refuses a
 * workspace that is correctly configured. Settings UI did exactly that — it
 * read `twilioConfig.whatsappFromNumber` unconditionally — so a connected
 * Cloud workspace saw its WhatsApp channels greyed out with no explanation.
 *
 * This is a PURE, CLIENT-SAFE check and deliberately weaker than readiness:
 * it answers "has a sender been connected", never "is that sender healthy
 * right now". Health needs a credential read and a live probe, both server
 * only. A component that renders a channel as available is not promising the
 * send will succeed — the send path re-checks, and it is the one that can.
 *
 * It reads only the non-secret display metadata each connect route writes onto
 * the sub-account doc, which every active member may already read.
 */
export function whatsappSenderConfigured(
  sub:
    | {
        whatsappProvider?: string | null;
        twilioConfig?: { whatsappFromNumber?: string | null } | null;
        whatsappCloudMeta?: { phoneNumberId?: string | null } | null;
        whatsappBridgeMeta?: { displayPhoneNumber?: string | null } | null;
      }
    | null
    | undefined,
): boolean {
  switch (resolveWhatsAppProviderId(sub?.whatsappProvider)) {
    case "cloud":
      return !!sub?.whatsappCloudMeta?.phoneNumberId;
    case "bridge":
      return !!sub?.whatsappBridgeMeta?.displayPhoneNumber;
    default:
      return !!sub?.twilioConfig?.whatsappFromNumber;
  }
}
