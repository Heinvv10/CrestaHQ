import type { SubAccountDoc } from "@/types";
import type { ConfiguredChannelId } from "@/lib/comms/ai/agent";

/**
 * Agency-level gating for the AI-agent channels. Each AI channel spends the
 * agency's shared OpenRouter credits (Voice additionally burns Vapi minutes),
 * so the agency owner controls which channels a sub-account may run — the same
 * `*EnabledByAgency` pattern the WhatsApp + Outbound Voice gates already use.
 *
 * Centralised here so the enable-time check (channels PATCH route) and the
 * runtime checks (inbound webhooks, widget config/message, Vapi LLM turn) all
 * read the SAME field per channel and can't drift.
 *
 * Default-when-undefined (legacy docs) differs by channel — see CHANNEL_GATE:
 *   - SMS / Web Chat / Inbound Voice PRE-EXISTED this gate (they were always
 *     available before gating shipped), so they default ON. Upgrading a
 *     deployment doesn't silently cut off a tenant's running bot; the gate is
 *     opt-OUT (the agency flips it off to clamp cost). Explicit `false` locks.
 *   - WhatsApp shipped gated-off from day one, so it stays opt-IN (default OFF,
 *     `=== true`).
 */

/**
 * Per-channel gate field + the default applied when the field is undefined on
 * a legacy doc. `defaultOn` encodes the opt-out vs opt-in distinction above.
 */
const CHANNEL_GATE: Record<
  ConfiguredChannelId,
  { field: keyof SubAccountDoc; defaultOn: boolean }
> = {
  sms: { field: "smsAgentEnabledByAgency", defaultOn: true },
  "web-chat": { field: "webChatEnabledByAgency", defaultOn: true },
  voice: { field: "inboundVoiceEnabledByAgency", defaultOn: true },
  whatsapp: { field: "whatsappEnabledByAgency", defaultOn: false },
  // Messenger + Instagram AI — opt-IN (shipped gated-off, WhatsApp
  // precedent). NB: the effective bot ALSO needs metaInboxEnabledByAgency
  // (the DMs must exist at all) — that's enforced where this gate is read.
  meta: { field: "metaAgentEnabledByAgency", defaultOn: false },
};

/**
 * True when the agency has enabled this AI channel for the sub-account.
 * `voice` here is the INBOUND voice gate — outbound voice is gated separately
 * at the call/campaign routes via `outboundVoiceEnabledByAgency`. An explicit
 * boolean always wins; only a missing field falls back to the channel default.
 */
export function aiChannelGateOn(
  sub: Pick<
    SubAccountDoc,
    | "smsAgentEnabledByAgency"
    | "webChatEnabledByAgency"
    | "inboundVoiceEnabledByAgency"
    | "whatsappEnabledByAgency"
    | "metaAgentEnabledByAgency"
  >,
  channelId: ConfiguredChannelId,
): boolean {
  const { field, defaultOn } = CHANNEL_GATE[channelId];
  const value = (sub as Record<string, unknown>)[field];
  if (value === true) return true;
  if (value === false) return false;
  return defaultOn;
}

/**
 * True when the agency has enabled AT LEAST ONE AI channel (inbound or
 * outbound) for the sub-account. Used to gate the shared AI support endpoints
 * that spend tokens/Firecrawl without belonging to a single channel — the
 * "Test this persona" dry-run and the website-KB refresh. If the agency hasn't
 * turned on any AI channel, there's no reason to let the sub-account burn
 * credits testing or scraping.
 */
export function anyAiChannelGateOn(
  sub: Pick<
    SubAccountDoc,
    | "smsAgentEnabledByAgency"
    | "webChatEnabledByAgency"
    | "inboundVoiceEnabledByAgency"
    | "whatsappEnabledByAgency"
    | "metaAgentEnabledByAgency"
    | "outboundVoiceEnabledByAgency"
  >,
): boolean {
  // Uses aiChannelGateOn so the default-on channels (SMS/Web Chat/Voice) count
  // for legacy docs — preserving the pre-gate behavior of Test + KB refresh.
  return (
    aiChannelGateOn(sub, "sms") ||
    aiChannelGateOn(sub, "web-chat") ||
    aiChannelGateOn(sub, "voice") ||
    aiChannelGateOn(sub, "whatsapp") ||
    aiChannelGateOn(sub, "meta") ||
    sub.outboundVoiceEnabledByAgency === true
  );
}

/** Friendly 403 message for a channel locked by the agency. */
export function aiChannelLockedMessage(label: string): string {
  return `${label} is disabled for this sub-account by your agency. Ask your agency owner to enable it.`;
}
