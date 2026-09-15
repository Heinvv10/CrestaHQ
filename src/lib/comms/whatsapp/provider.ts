/**
 * The WhatsApp rail contract. Three implementations are planned:
 *
 *   twilio  — today's default. Twilio is the BSP; templates are Content API
 *             resources (HX…) and the 24h window applies.
 *   cloud   — Meta Graph direct. Our own WABA, our own templates, same window.
 *             Cheaper per message and the only rail that beats GHL on cost.
 *   bridge  — an unofficial rail (Baileys-class). No templates, no service
 *             window, no Meta billing. Ships as 1.2b.
 *
 * Selection is per sub-account so a cutover is one field flip, reversible in
 * seconds. That matters because moving a number off its current BSP resets its
 * WABA quality tier and throttles it for weeks — an all-or-nothing switch would
 * be untestable.
 *
 * Modelled on ndzinga-lms/lib/messaging/providers.ts, which already dispatches
 * two WhatsApp rails behind a single result contract in production.
 */

/**
 * What a rail can actually do. Declared rather than inferred so that adding the
 * bridge is an explicit statement — "this rail has no window and no templates"
 * — instead of a compliance guard that silently stops applying to it. Getting
 * this wrong on a Meta rail is how a sending number gets banned.
 */
export interface WhatsAppProviderCapabilities {
  /** Can send a pre-approved template (required to re-open a closed window). */
  supportsTemplates: boolean;
  /** Subject to Meta's 24-hour customer-service window. */
  enforcesWindow: boolean;
  /**
   * Can carry a file alongside the message. The bridge uploads the bytes to
   * WhatsApp directly; Cloud uploads them to Graph and sends by media id.
   * Twilio takes media only as a publicly reachable URL, which this seam does
   * not implement.
   *
   * Declared here rather than inferred from the provider name for the same
   * reason the other two flags are: a fourth rail must be forced to state
   * what it can do, instead of silently inheriting whichever default the last
   * comparison happened to produce.
   */
  supportsMedia: boolean;
  /** Decoded-byte cap for one attachment; 0 when `supportsMedia` is false. */
  maxMediaBytes: number;
  /** Exact MIME types this rail will put on the wire. Empty when it sends none. */
  mediaMimeTypes: readonly string[];
}

export type WhatsAppProviderId = "twilio" | "cloud" | "bridge";

/**
 * The bridge's limits, restated from `decodeMedia` in
 * services/wa-agent-bridge/api/server.go (`maxMediaBytes`,
 * `allowedMediaMimeTypes`). A deliberate duplication: the alternative is a
 * limits endpoint on the bridge and a fetch on every composer render, for two
 * values that have changed once. provider.test.ts parses the Go source and
 * fails when the two disagree.
 */
const BRIDGE_MAX_MEDIA_BYTES = 8 << 20;
const BRIDGE_MEDIA_MIME_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "application/pdf",
];

/**
 * What the Cloud rail will upload. A subset of Meta's supported types: audio
 * is left out because Meta accepts no caption on an audio message, and the
 * composer always sends the typed text as the caption — an audio file would
 * silently lose it. 16 MiB is Meta's cap for audio/video; images are capped
 * lower (5 MB) by Meta itself and come back as a 400 the operator can read.
 */
const CLOUD_MAX_MEDIA_BYTES = 16 << 20;
const CLOUD_MEDIA_MIME_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "video/mp4",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

export const WHATSAPP_PROVIDER_CAPABILITIES: Record<
  WhatsAppProviderId,
  WhatsAppProviderCapabilities
> = {
  twilio: {
    supportsTemplates: true,
    enforcesWindow: true,
    supportsMedia: false,
    maxMediaBytes: 0,
    mediaMimeTypes: [],
  },
  cloud: {
    supportsTemplates: true,
    enforcesWindow: true,
    supportsMedia: true,
    maxMediaBytes: CLOUD_MAX_MEDIA_BYTES,
    mediaMimeTypes: CLOUD_MEDIA_MIME_TYPES,
  },
  bridge: {
    supportsTemplates: false,
    enforcesWindow: false,
    supportsMedia: true,
    maxMediaBytes: BRIDGE_MAX_MEDIA_BYTES,
    mediaMimeTypes: BRIDGE_MEDIA_MIME_TYPES,
  },
};

/**
 * Legacy sub-accounts carry no `whatsappProvider` field. They are on Twilio —
 * reading undefined as anything else would silently reroute a live rail.
 */
export const DEFAULT_WHATSAPP_PROVIDER: WhatsAppProviderId = "twilio";

export function resolveWhatsAppProviderId(
  raw: string | null | undefined,
): WhatsAppProviderId {
  return raw === "cloud" || raw === "bridge" || raw === "twilio"
    ? raw
    : DEFAULT_WHATSAPP_PROVIDER;
}

export function capabilitiesFor(
  provider: WhatsAppProviderId,
): WhatsAppProviderCapabilities {
  return WHATSAPP_PROVIDER_CAPABILITIES[provider];
}

/**
 * Uniform send result across rails. Mirrors ndzinga-lms's `WaResult` so the
 * dispatch layer treats every provider identically.
 *
 * `providerOutcome` separates "the provider definitively refused" (do not
 * retry, surface to the operator) from "we do not know whether it was
 * delivered" (a timeout mid-flight — retrying risks a duplicate send). The
 * distinction is what stops a retry loop from double-messaging a customer.
 */
export interface WhatsAppSendResult {
  ok: boolean;
  /** Provider message id — Twilio SID or Meta `wamid.*`. Present when ok. */
  messageId?: string;
  error?: string;
  providerOutcome?: "DEFINITELY_REJECTED" | "AMBIGUOUS";
  /**
   * The rail that refused this send, when the provider named one — the
   * bridge's `refusedBy` code. Carried structurally rather than parsed back
   * out of `error`, so the UI can say what to do about it without pattern
   * matching on a message that is free to change.
   */
  refusedBy?: string;
  /**
   * A request-level rejection code the provider named — today the bridge's
   * `media_too_large`, `media_unsupported_type`, `media_invalid`.
   *
   * Deliberately NOT `refusedBy`. A rail refusal is the provider declining a
   * message on its merits and is rendered as such; this is the request itself
   * being wrong, which the caller can fix and retry. Carried structurally so a
   * route can answer 4xx instead of letting a caller error fall through to a
   * 502 that sends whoever reads it hunting an infrastructure fault.
   */
  providerErrorCode?: string;
  /** Set by the dispatchers when a provider was actually called (SP5 d1): a
   *  failure without it was decided before anything was sent. */
  attempted?: boolean;
  /** True when a dry-run/test path short-circuited the real send. */
  simulated?: boolean;
}

/**
 * Maps an HTTP status to a retry verdict. 4xx other than 429 is the provider
 * telling us the request itself is wrong — retrying reproduces it. 429 and 5xx
 * are ambiguous: the message may or may not have gone out.
 */
export function httpFailureOutcome(
  status: number,
): "DEFINITELY_REJECTED" | "AMBIGUOUS" {
  if (status === 429) return "AMBIGUOUS";
  return status >= 400 && status < 500 ? "DEFINITELY_REJECTED" : "AMBIGUOUS";
}
