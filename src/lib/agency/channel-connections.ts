/**
 * Every channel / payment connection stored on a `subAccounts/{id}` doc
 * (`SubAccountDoc`), by the field its connect route writes and its
 * disconnect route clears. Plain module, no server imports, so the A6
 * teardown script can import it too (AGENCY_AGENT_API_PLAN.md D3).
 * Connections kept outside the doc (per-member Google Calendar tokens, AI
 * channel configs) are not seen here.
 */
export const CHANNEL_CONNECTION_FIELDS = [
  "twilioConfig",
  "resendConfig",
  "smtpConfig",
  "mailboxConfig",
  "metaConfig",
  "whatsappCloudMeta",
  "whatsappBridgeMeta",
  "whatsappSenders",
  "googleConnectionMeta",
  "stripeConnectionMeta",
  "paystackConnectionMeta",
  "paypalConfig",
  "webinar1ConnectionMeta",
  "apexgeoConnected",
  "ghlImportConfig",
] as const;

/** Whether the sub-account has any channel or payment connection: a field
 *  above set (an emptied sender list and a `false` flag are not). */
export function hasChannelConnection(sub: Record<string, unknown> | undefined): boolean {
  return CHANNEL_CONNECTION_FIELDS.some((field) => {
    const v = sub?.[field];
    if (Array.isArray(v)) return v.length > 0;
    return v !== null && v !== undefined && v !== false;
  });
}
