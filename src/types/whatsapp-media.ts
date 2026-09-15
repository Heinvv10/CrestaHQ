/**
 * The one shape describing a file carried by a WhatsApp message, on every rail
 * (Cloud API, Go bridge) and in both directions.
 *
 * Deliberately NOT a URL: the bytes live in a private Storage object and are
 * served through an authorised route, because these are customers' photos and
 * voice notes (POPIA). See `src/lib/comms/whatsapp/media-storage.ts`.
 */

export const WHATSAPP_MEDIA_KINDS = [
  "image",
  "audio",
  "video",
  "document",
  "sticker",
] as const;

export type WhatsappMediaKind = (typeof WHATSAPP_MEDIA_KINDS)[number];

/**
 * Present on a `whatsappMessages` row that carried a file. Absent on text rows
 * — do not treat missing as an empty object.
 */
export interface WhatsappMedia {
  kind: WhatsappMediaKind;
  mimeType: string;
  /** As the sender named it, or a synthesised one. NEVER trusted in a header. */
  filename: string;
  sizeBytes: number;
  /** Object path inside the bucket. Not a URL — see the serving route. */
  storagePath: string;
}

/**
 * Narrow a Firestore `media` value to the shape above, or null.
 *
 * A stored row is DATA, not a type. Casting one with `as` and then calling
 * `.split()` on a field that a partial write left undefined turns a bad row
 * into an unhandled 500; every consumer must get a row it can trust or nothing
 * at all.
 */
export function parseWhatsappMedia(value: unknown): WhatsappMedia | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const { kind, mimeType, filename, sizeBytes, storagePath } = v;
  if (
    typeof kind !== "string" ||
    !(WHATSAPP_MEDIA_KINDS as readonly string[]).includes(kind)
  ) {
    return null;
  }
  if (typeof mimeType !== "string" || mimeType.length === 0) return null;
  if (typeof filename !== "string") return null;
  if (typeof storagePath !== "string" || storagePath.length === 0) return null;
  if (
    typeof sizeBytes !== "number" ||
    !Number.isFinite(sizeBytes) ||
    sizeBytes < 0
  ) {
    return null;
  }
  return {
    kind: kind as WhatsappMediaKind,
    mimeType,
    filename,
    sizeBytes,
    storagePath,
  };
}

/** Why a message that HAD a file arrived without one. Mutually exclusive with `media`. */
export type WhatsappMediaDropped =
  | "too_large"
  | "fetch_failed"
  | "unsupported_type";

/**
 * MIME types this app will put in a `Content-Type` on a media response.
 * Anything else is served as `application/octet-stream`, so a row written with
 * a hostile mime (`text/html`) can never be rendered as a document in the
 * operator's own origin.
 */
export const WHATSAPP_MEDIA_MIME_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/amr",
  "audio/aac",
  "video/mp4",
  "video/3gpp",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
];

/**
 * WhatsApp sends codec parameters on some types (`audio/ogg; codecs=opus`),
 * so compare on the bare type.
 */
export function isAllowedWhatsappMediaMime(mimeType: string): boolean {
  const bare = mimeType.split(";")[0]!.trim().toLowerCase();
  return WHATSAPP_MEDIA_MIME_TYPES.includes(bare);
}

/** Conversation-preview label for a caption-less media message. */
export function mediaPreviewLabel(m: WhatsappMedia): string {
  switch (m.kind) {
    case "image":
      return "📷 Photo";
    case "audio":
      return "🎤 Voice note";
    case "video":
      return "🎬 Video";
    case "sticker":
      return "🌟 Sticker";
    case "document":
      return `📄 ${m.filename}`;
  }
}

/**
 * Human-facing reason shown in the thread when the file could not be stored.
 * Takes any string: the bridge names its own reasons (`delivery_failed`,
 * `shutdown`, …) and the row stores them verbatim, so an unknown one must
 * still say the file was lost rather than render blank.
 */
export function mediaDroppedLabel(reason: WhatsappMediaDropped | string): string {
  switch (reason) {
    case "too_large":
      return "Attachment not saved — too large";
    case "unsupported_type":
      return "Attachment not saved — unsupported file type";
    case "fetch_failed":
      return "Attachment not saved — download failed";
    default:
      return "Attachment not saved";
  }
}
