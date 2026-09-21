import { mediaKindForMime, type WhatsappMediaKind } from "@/types/whatsapp-media";

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
  /**
   * Decoded-byte cap for one attachment, per message kind
   * (`mediaKindForMime`); all 0 when `supportsMedia` is false. Per kind
   * because Meta's caps differ by kind, and a file the picker admits must
   * not then fail at Graph after a full upload.
   */
  maxMediaBytes: Readonly<Record<WhatsappMediaKind, number>>;
  /** Exact MIME types this rail will put on the wire. Empty when it sends none. */
  mediaMimeTypes: readonly string[];
  /**
   * Longest message, in Unicode CODE POINTS (`[...text].length`), that may
   * ride as a file's caption; 0 when `supportsMedia` is false. Code points
   * because that is what the bridge's `maxTextRunes` counts; UTF-16 length
   * would block an emoji-heavy caption at half its real allowance. Meta does
   * not state its counting unit. If it counts more strictly, the worst case
   * is a clean 400 from Graph after the upload, never a wrong delivery.
   */
  maxMediaCaptionChars: number;
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
const BRIDGE_MAX_MEDIA_BYTES = sameCapForEveryKind(8 << 20);
/** The caption IS the bridge's `Text`, so its cap is `maxTextRunes`. */
const BRIDGE_MAX_CAPTION_CHARS = 4096;
const BRIDGE_MEDIA_MIME_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "application/pdf",
  "video/mp4",
];

/** Meta's caption limit, the same 1024 `interactive.ts` holds a body to. */
const CLOUD_MAX_CAPTION_CHARS = 1024;

/**
 * What the Cloud rail will upload. A subset of Meta's supported types:
 *
 * - audio is left out because Meta accepts no caption on an audio message,
 *   and the composer always sends the typed text as the caption — an audio
 *   file would silently lose it.
 * - video/mp4 goes only once its codecs are checked. Meta requires H.264 +
 *   AAC inside the container; an iPhone's HEVC `.mp4` passes a MIME check,
 *   uploads, gets a wamid, and then fails asynchronously while the thread
 *   row says "sent". The send route reads the codecs out of the file first
 *   (`checkWhatsappVideoCodecs` in video-codec.ts) and refuses anything else
 *   before the upload. NOT YET PROVEN: a real handset receiving one.
 *
 * Caps per Meta's media documentation (as encoded by both
 * @whatsapp-cloudapi/client and @kapso/whatsapp-cloud-api, checked
 * 2026-09-15): image 5 MB, audio 16 MB, video 16 MB, document 100 MB,
 * sticker 100 KB. Meta's image cap is DECIMAL megabytes, so it is 5_000_000
 * here: a binary 5 MiB would admit a 5.1 MB photo that Meta then refuses
 * after the upload. Documents get Meta's full 100 MB, also decimal: the
 * composer PUTs the file straight to a Storage staging object
 * (staged-upload.ts), so it no longer rides through src/middleware.ts as
 * base64 and the body cap there does not bound it; the upload URL is signed
 * for at most this cap. Stickers are never sent from the composer (webp is
 * not listed), so 0.
 */
const CLOUD_MAX_MEDIA_BYTES: Readonly<Record<WhatsappMediaKind, number>> = {
  image: 5_000_000,
  audio: 16 << 20,
  video: 16 << 20,
  document: 100_000_000,
  sticker: 0,
};

function sameCapForEveryKind(bytes: number): Readonly<Record<WhatsappMediaKind, number>> {
  return { image: bytes, audio: bytes, video: bytes, document: bytes, sticker: bytes };
}
const CLOUD_MEDIA_MIME_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "application/pdf",
  "video/mp4",
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
    maxMediaBytes: sameCapForEveryKind(0),
    mediaMimeTypes: [],
    maxMediaCaptionChars: 0,
  },
  cloud: {
    supportsTemplates: true,
    enforcesWindow: true,
    supportsMedia: true,
    maxMediaBytes: CLOUD_MAX_MEDIA_BYTES,
    mediaMimeTypes: CLOUD_MEDIA_MIME_TYPES,
    maxMediaCaptionChars: CLOUD_MAX_CAPTION_CHARS,
  },
  bridge: {
    supportsTemplates: false,
    enforcesWindow: false,
    supportsMedia: true,
    maxMediaBytes: BRIDGE_MAX_MEDIA_BYTES,
    mediaMimeTypes: BRIDGE_MEDIA_MIME_TYPES,
    maxMediaCaptionChars: BRIDGE_MAX_CAPTION_CHARS,
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
 * Photo types the send route can re-encode to JPEG to fit the rail
 * (image-shrink.ts). HEIC/HEIF is deliberately absent: the prebuilt sharp
 * binary cannot decode it.
 */
export const SHRINKABLE_IMAGE_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/webp"];

/**
 * The most a composer photo may be UPLOADED at; the rail's image cap still
 * bounds what is SENT. Phone photos are typically 3–12 MB and occasionally
 * ~20 MB (a 48/50 MP full-resolution shot), so 25 MB admits them all with
 * headroom while keeping the file read into memory bounded.
 */
export const RAW_IMAGE_UPLOAD_BYTES = 25_000_000;

/**
 * Phone video types the send route can transcode to H.264/AAC MP4 to fit the
 * rail (video-transcode.ts) — only on a host where ffmpeg was found. `.mov`
 * is what an iPhone records; `.3gp` what older Android phones do.
 */
export const TRANSCODABLE_VIDEO_TYPES: readonly string[] = ["video/mp4", "video/quicktime", "video/3gpp"];

/**
 * The most a composer video may be UPLOADED at when the host can transcode;
 * the rail's video cap still bounds what is SENT. A phone records 1080p30 at
 * roughly 60 MB a minute in HEVC and 130 MB in H.264, so 250 MB admits a
 * 2–3 minute clip — the 180-second limit the transcode enforces anyway
 * (video-transcode.ts). The file goes to a temp file on disk, never into
 * memory, so this bounds disk and download time, not the heap.
 */
export const RAW_VIDEO_UPLOAD_BYTES = 250_000_000;

/**
 * The upload cap for a file of this type on this rail, or 0 when the rail
 * takes no such file. Photos the rail can receive as JPEG get the raw upload
 * cap, and so do phone videos when the host can transcode them
 * (`videoTranscode`: ffmpeg found — the server's `videoTranscodeAvailable`,
 * which the browser learns from `GET /api/comms/whatsapp/upload-url`).
 * Everything else gets the rail's own cap for its kind.
 */
export function uploadCapFor(
  caps: WhatsAppProviderCapabilities,
  contentType: string,
  host: { videoTranscode: boolean },
): number {
  if (!caps.supportsMedia) return 0;
  if (
    SHRINKABLE_IMAGE_TYPES.includes(contentType) &&
    caps.mediaMimeTypes.includes("image/jpeg") &&
    caps.maxMediaBytes.image > 0
  ) {
    return RAW_IMAGE_UPLOAD_BYTES;
  }
  if (host.videoTranscode && transcodesVideo(caps, contentType)) return RAW_VIDEO_UPLOAD_BYTES;
  if (!caps.mediaMimeTypes.includes(contentType)) return 0;
  return caps.maxMediaBytes[mediaKindForMime(contentType)];
}

/** Whether a file of this type goes through the video transcode path on this rail, given ffmpeg. */
export function transcodesVideo(caps: WhatsAppProviderCapabilities, contentType: string): boolean {
  return (
    TRANSCODABLE_VIDEO_TYPES.includes(contentType) &&
    caps.mediaMimeTypes.includes("video/mp4") &&
    caps.maxMediaBytes.video > 0
  );
}

/**
 * A file on its way out, as the dispatcher and the Cloud client carry it.
 *
 * A Blob rather than a Buffer or base64: a Blob built from a Storage stream
 * holds one copy of the bytes outside the JS heap, a `File` made from it for
 * Graph's multipart upload references that copy instead of duplicating it,
 * and undici streams it onto the wire. At 100 MB that is the difference
 * between one copy and four. The bridge's wire format is base64 JSON, so the
 * dispatcher encodes it there, under the bridge's 8 MiB cap.
 */
export interface OutboundAttachment {
  filename: string;
  contentType: string;
  data: Blob;
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
