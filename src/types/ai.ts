import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * AI Agents architecture (post-refactor):
 *
 *   - One **shared profile** per sub-account at
 *     `subAccounts/{id}/aiAgent/profile` — the bot's identity. Persona,
 *     brand voice, business hours, default escalation rules. Configured
 *     once in the AI Agents → Overview area.
 *
 *   - One **per-channel config** per sub-account at
 *     `subAccounts/{id}/aiAgent/{channelId}` — operational settings for
 *     that channel. Enabled toggle, model override, context size, and
 *     optional overrides of the profile's escalation defaults.
 *
 * The webhook resolver merges profile + channel into an effective config
 * before calling the LLM. Channel overrides win when set, profile values
 * fill the gaps.
 *
 * Legacy `subAccounts/{id}/aiConfig/main` (the pre-refactor doc) is
 * auto-migrated into the new shape on first read — see agent.ts.
 */

/** Identity + brand voice. Shared across every channel the agent speaks
 *  on. Disabled by default at the channel level — flipping a channel on
 *  requires this profile to have a non-empty systemPrompt. */
export interface AiAgentProfile {
  systemPrompt: string;
  /** Injected into the prompt as {{businessName}}. Falls back to the
   *  sub-account's name if blank. */
  businessName: string;
  /** Hours during which AI auto-replies are active across all channels.
   *  Channels can in theory override later if needed, but in practice a
   *  business has one set of operating hours. */
  hoursStart: number;
  hoursEnd: number;
  /** IANA timezone, e.g. "Australia/Sydney". */
  timezone: string;
  /** Default escalation triggers. Channels can override with their own
   *  list (SMS users type "manager"; voice users might say something
   *  different) or extend by adding their own. */
  escalationKeywords: string[];
  /** Where escalation notifications go by default. Channels can override
   *  to route per-channel (e.g. voice escalations to a different team). */
  escalationNotifyEmail: string | null;
  /** Optional public website for this client. When set, the operator can
   *  trigger a Firecrawl scrape to populate websiteKb — a markdown blob
   *  the agent uses as additional context when replying. Validated as
   *  a real URL on save. */
  websiteUrl: string | null;
  /** Snapshot of the homepage content (markdown), capped at ~6000 chars.
   *  Populated by /ai-agent/profile/refresh-kb. Null until first refresh
   *  or after the operator clears the URL. */
  websiteKb: string | null;
  /** When the KB snapshot above was last refreshed. UI shows "Last
   *  refreshed 2h ago" so the operator knows whether to re-crawl. */
  websiteKbFetchedAt: Timestamp | FieldValue | null;
  /** Where the KB snapshot came from: a Firecrawl scrape (the Refresh KB
   *  button) or the gitpage premium build hand-off. Absent on legacy docs =
   *  Firecrawl. */
  websiteKbSource?: "firecrawl" | "gitpage-build" | null;
  /** The website doc id whose build seeded the KB (gitpage-build only). */
  websiteKbSiteId?: string | null;
  /**
   * The values the website hand-off last filled in automatically. A field
   * whose current value still equals its seeded value has not been edited by
   * the operator, so the next published site may replace it; anything the
   * operator changed is left alone.
   */
  websiteSeeded?: {
    systemPrompt?: string | null;
    businessName?: string | null;
    welcomeMessage?: string | null;
    accentColor?: string | null;
    websiteUrl?: string | null;
  } | null;
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

export const DEFAULT_AI_AGENT_PROFILE: Omit<
  AiAgentProfile,
  "createdAt" | "updatedAt"
> = {
  systemPrompt: "",
  businessName: "",
  // 24/7 by default (start === end). An after-hours lead that gets
  // captured beats a silent agent for almost every operator — narrowing
  // the window is a deliberate choice, not something a new workspace
  // should have to discover it needs to UNDO after missing a night of
  // leads. The out-of-hours behaviors (SMS pause, web-chat closed note)
  // only kick in once an operator sets a real window.
  hoursStart: 0,
  hoursEnd: 0,
  timezone: "Australia/Sydney",
  // NB: keep these tight. The matcher is substring-based (case-insensitive),
  // so anything too generic ("human", "help") will swallow legitimate
  // conversion intents like "I want to talk to a human" — the bot would
  // then silently escalate instead of asking for contact details.
  // Visitor-wants-a-human is handled by the [[form]] marker in the
  // system prompt; reserve escalation for hostility / give-up signals.
  escalationKeywords: ["complaint", "refund", "stop ai", "speak to manager"],
  escalationNotifyEmail: null,
  websiteUrl: null,
  websiteKb: null,
  websiteKbFetchedAt: null,
};

/** Per-channel operational config. Stored at
 *  `subAccounts/{id}/aiAgent/{channelId}`. One doc per channel id. */
export interface AiChannelConfig {
  enabled: boolean;
  /** How many of the most-recent thread messages to feed the LLM. */
  contextMessageCount: number;
  /** OpenRouter model id, e.g. "anthropic/claude-haiku-4-5". Null =
   *  fall back to the deployment-wide AI_REPLIES_DEFAULT_MODEL. */
  modelOverride: string | null;
  /** Set when OpenRouter refused `modelOverride` on a live reply and the
   *  reply fell back to the app default. Cleared when the override changes. */
  modelRejected?: { model: string; at: number } | null;
  /** Optional channel-specific overrides of the profile's escalation
   *  defaults. Null = use the profile value. Empty array = explicitly
   *  no escalation keywords on this channel. */
  escalationKeywordsOverride: string[] | null;
  escalationNotifyEmailOverride: string | null;
  /** Informational lifetime running total. Not enforced. */
  totalTokensUsed: number;
  /** Web-chat-specific config — populated only on the `web-chat` channel
   *  doc, null elsewhere. The widget loader reads these via the public
   *  /api/web-chat/config endpoint to theme + gate access. */
  webChat: WebChatChannelConfig | null;
  /** Voice-specific config — populated only on the `voice` channel doc,
   *  null elsewhere. Holds Vapi assistant/number linkage + voice render
   *  preferences. The channel save route provisions / updates the linked
   *  Vapi resources whenever this block changes. */
  voice: VoiceChannelConfig | null;
  /** WhatsApp-specific config — populated only on the `whatsapp` channel
   *  doc, null elsewhere. The Twilio creds + sender number live on the
   *  sub-account's `twilioConfig` (reused from SMS), so this block only
   *  holds WhatsApp-channel operational preferences. */
  whatsapp: WhatsappChannelConfig | null;
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

/** Which phone-number resource the voice agent attaches to. Drives the
 *  provisioning branch in the channel save route + the gate the UI
 *  enforces before allowing enable. */
export type VoiceNumberMode = "twilio-byoc" | "vapi-managed";

/** Voice-channel-only settings. Lives at
 *  `subAccounts/{id}/aiAgent/voice`.voice. The Vapi linkage fields are
 *  populated by the channel save route after a successful provisioning
 *  round-trip; clearing them forces a re-provision on the next save. */
export interface VoiceChannelConfig {
  /** First sentence Vapi speaks when the call connects. Kept separate
   *  from the persona prompt so operators can tweak greeting wording
   *  without touching the shared identity. */
  greeting: string;
  /** Vapi voice provider id, e.g. "11labs" or "openai". */
  voiceProvider: string;
  /** Provider-specific voice id, e.g. an ElevenLabs voice id or an
   *  OpenAI voice name ("alloy", "shimmer"). */
  voiceId: string;
  /**
   * Optional provider voice model/version (e.g. an ElevenLabs model id,
   * or a Vapi native voice version). Sent verbatim as the Vapi voice
   * block's `version` when set; null/undefined (default + legacy docs)
   * sends nothing so the provider default applies. Stored + round-tripped
   * because omitting it rendered correctly-named voices on the provider's
   * oldest model.
   */
  voiceVersion?: string | null;
  /**
   * Optional explicit transcriber (STT). Null/undefined (default + legacy
   * docs) sends NO transcriber block — Vapi's default applies. Stored
   * explicitly because an omitted block survives PATCH only by accident
   * and silently resets on the 404 re-create path.
   */
  transcriberProvider?: string | null;
  transcriberModel?: string | null;
  /** Hard cap on call length (seconds). Vapi enforces this server-side. */
  maxCallSeconds: number;
  /**
   * Voice Booking v1 — slug of the PUBLISHED booking page the inbound
   * voice agent may book appointments on during a call. Null (default,
   * and what legacy docs read as) = live booking off; the agent falls
   * back to sharing/promising the booking link. Deposit-taking pages are
   * refused at runtime even if selected. See VOICE_BOOKING_V1_PLAN.md.
   */
  bookingPageSlug?: string | null;
  /** Which phone-number resource the voice agent attaches to.
   *    - "twilio-byoc"   (default): reuse the sub-account's dedicated
   *       Twilio number — one number serves SMS + Voice. Production.
   *    - "vapi-managed":  attach to a phone-number resource the
   *       operator already owns inside Vapi (e.g. a Vapi-provisioned
   *       US number used for testing without AU regulatory bundles).
   *  Defaulting to "twilio-byoc" keeps every pre-existing sub-account
   *  on the original behavior after the upgrade. */
  numberMode: VoiceNumberMode;
  /** Linkage to the Vapi assistant resource we provision for this
   *  sub-account. Null until the operator's first successful save.
   *  Always server-managed — operators don't paste this. */
  vapiAssistantId: string | null;
  /** Linkage to the Vapi phoneNumber resource.
   *    - In "twilio-byoc" mode: server-managed. Populated when the
   *      provisioning side-effect creates the BYOC resource bound to
   *      the operator's Twilio creds; cleared on disable.
   *    - In "vapi-managed" mode: operator-supplied. The settings UI
   *      surfaces an input that PATCHes this; the provisioning
   *      side-effect just binds our assistant to it. */
  vapiPhoneNumberId: string | null;
  /** twilio-byoc only: the number the Vapi phone resource was provisioned
   *  from (server-managed, stamped when it is created). Calls ring from it
   *  whatever the Twilio number is now. Absent on older configs. */
  vapiPhoneNumber?: string | null;

  // ── Outbound calling (operator-initiated click-to-call) ──────────────
  // Reuses the same provisioned assistant + phone number as inbound. The
  // compliance gate (lib/comms/voice/outbound-compliance.ts) enforces
  // these limits natively before any call is placed. Globally safe
  // defaults — no US-only assumptions.

  /** Master switch for outbound calling on this sub-account. Independent
   *  of the inbound `enabled` toggle (a sub-account can answer calls
   *  without dialing out, or vice-versa). Also requires the agency gate
   *  `outboundVoiceEnabledByAgency` to be on. */
  outboundEnabled: boolean;
  /** First line the agent speaks on an OUTBOUND call — distinct from the
   *  inbound `greeting` ("thanks for calling…" makes no sense outbound).
   *  Pushed to Vapi per-call via assistantOverrides.firstMessage. */
  outboundFirstMessage: string;
  /** Persona / system prompt used ONLY on outbound calls. Outbound is a
   *  proactive conversation (the AI is calling them about an offer), so it
   *  needs different instructions than the shared inbound persona. When
   *  blank, outbound falls back to the shared profile persona. The LLM
   *  webhook swaps this in when the call's metadata marks it outbound. */
  outboundSystemPrompt: string;
  /** Timezone-aware calling window, evaluated in the CONTACT's local
   *  timezone (derived from their phone country). Null = fall back to the
   *  agent profile timezone with these default hours. */
  outboundWindow: { startHour: number; endHour: number; timezone: string } | null;
  /** Burst cap — max outbound calls per minute for this sub-account
   *  (in-memory token bucket). */
  outboundPerMinuteCap: number;
  /** Max outbound calls per day for this sub-account (Firestore count). */
  outboundDailyCap: number;
  /** Max calls to any single number per day (anti-harassment). */
  outboundPerNumberPerDay: number;
  /** Optional ISO 3166-1 alpha-2 allow-list. Null = allow all countries
   *  (global default). Non-empty = block calls to numbers outside it. */
  allowedCountries: string[] | null;
}

/** Web-chat-channel-only settings. Lives at
 *  `subAccounts/{id}/aiAgent/web-chat`.webChat. */
export interface WebChatChannelConfig {
  /** Hostnames allowed to load the widget. Origin header is compared
   *  case-insensitively. Empty list = no domain restriction (test mode
   *  only — should never be empty in production). Each entry is just the
   *  hostname (no protocol, no path), e.g. ["example.com", "www.example.com"]. */
  allowedDomains: string[];
  /** First bot message shown when the visitor opens the widget. */
  welcomeMessage: string;
  /** Accent color hex (e.g. "#7c3aed"). Used for the bubble background +
   *  send button. The rest of the widget chrome is neutral. */
  accentColor: string;
  /** Where the floating bubble sits on the host page. */
  position: "right" | "left";
}

/** WhatsApp-channel-only settings. Lives at
 *  `subAccounts/{id}/aiAgent/whatsapp`.whatsapp. WhatsApp rides the
 *  sub-account's existing Twilio credentials + a dedicated WhatsApp sender
 *  number stored on `twilioConfig`, so this block stays small. */
export interface WhatsappChannelConfig {
  /** Twilio/Meta session window in hours. WhatsApp only permits free-form
   *  (non-template) sends within this many hours of the contact's last
   *  INBOUND message. Outside it, a pre-approved template is required —
   *  a v2 feature — so v1 simply blocks the send. Meta's window is 24h;
   *  surfaced as config in case the platform window ever changes. */
  sessionWindowHours: number;
}

export const DEFAULT_AI_CHANNEL_CONFIG: Omit<
  AiChannelConfig,
  "createdAt" | "updatedAt"
> = {
  enabled: false,
  contextMessageCount: 10,
  modelOverride: null,
  escalationKeywordsOverride: null,
  escalationNotifyEmailOverride: null,
  totalTokensUsed: 0,
  webChat: null,
  voice: null,
  whatsapp: null,
};

export const DEFAULT_WHATSAPP_CONFIG: WhatsappChannelConfig = {
  sessionWindowHours: 24,
};

export const DEFAULT_WEB_CHAT_CONFIG: WebChatChannelConfig = {
  allowedDomains: [],
  welcomeMessage: "Hi! How can I help?",
  accentColor: "#7c3aed",
  position: "right",
};

export const DEFAULT_VOICE_CONFIG: VoiceChannelConfig = {
  greeting: "Hi, thanks for calling. How can I help?",
  // OpenAI voice names are literal, stable API constants that Vapi resolves
  // without any provider key on the operator's side. The old default
  // ("11labs"/"burt") was a Vapi preset name that no longer resolves —
  // assistant creation 400s with "Couldn't Find 11labs Voice". ElevenLabs
  // voices are still usable via the custom voice-ID input in the Voice
  // settings UI (requires an ID confirmed in Vapi's voice library).
  voiceProvider: "openai",
  voiceId: "alloy",
  maxCallSeconds: 600,
  bookingPageSlug: null,
  numberMode: "twilio-byoc",
  vapiAssistantId: null,
  vapiPhoneNumberId: null,
  outboundEnabled: false,
  outboundFirstMessage:
    "Hi, this is the team following up on your enquiry — is now a good time for a quick chat?",
  outboundSystemPrompt: "",
  outboundWindow: { startHour: 9, endHour: 18, timezone: "Australia/Sydney" },
  outboundPerMinuteCap: 10,
  outboundDailyCap: 200,
  outboundPerNumberPerDay: 1,
  allowedCountries: null,
};

/** The merged result of profile + channel, ready for the LLM call. */
export interface ResolvedAiAgent {
  profile: AiAgentProfile;
  channel: AiChannelConfig;
  /** Effective values after applying channel overrides. */
  effective: {
    enabled: boolean;
    systemPrompt: string;
    businessName: string;
    hoursStart: number;
    hoursEnd: number;
    timezone: string;
    escalationKeywords: string[];
    escalationNotifyEmail: string | null;
    contextMessageCount: number;
    modelOverride: string | null;
    websiteKb: string | null;
  };
}

/** Why a given inbound text did NOT receive an AI reply. Persisted to the
 *  activity timeline so the operator can debug a quiet bot. */
export type AiSkipReason =
  | "disabled"
  | "no_prompt"
  | "outside_hours"
  | "escalation_keyword"
  | "contact_opted_out"
  | "no_contact_match"
  | "llm_failed";
