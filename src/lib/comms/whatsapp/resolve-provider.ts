import {
  capabilitiesFor,
  resolveWhatsAppProviderId,
  type WhatsAppProviderCapabilities,
  type WhatsAppProviderId,
} from "./provider";

/**
 * Which WhatsApp rail a sub-account sends on, plus what that rail can do.
 * Mirrors ndzinga-lms's `resolveProvider("WHATSAPP", tenantId)`, minus the DB
 * read — CrestaHQ's callers already hold the sub-account doc.
 *
 * Pure and total: a missing doc or an unrecognised value resolves to Twilio
 * rather than throwing, because this sits inside send paths where failing safe
 * to the default rail beats a crash.
 */
export function resolveProviderForSubAccount(
  sub: { whatsappProvider?: string | null } | null | undefined,
): {
  provider: WhatsAppProviderId;
  capabilities: WhatsAppProviderCapabilities;
} {
  const provider = resolveWhatsAppProviderId(sub?.whatsappProvider);
  return { provider, capabilities: capabilitiesFor(provider) };
}
