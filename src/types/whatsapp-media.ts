/**
 * The one shape describing a file carried by a WhatsApp message, on every rail
 * (Cloud API, Go bridge) and in both directions.
 *
 * Deliberately NOT a URL: the bytes live in a private Storage object and are
 * served through an authorised route, because these are customers' photos and
 * voice notes (POPIA). See `src/lib/comms/whatsapp/media-storage.ts`.
 */

export type WhatsappMediaKind =
  | "image"
  | "audio"
  | "video"
  | "document"
  | "sticker";

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
  sha256?: string;
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

/** Human-facing reason shown in the thread when the file could not be stored. */
export function mediaDroppedLabel(reason: WhatsappMediaDropped): string {
  switch (reason) {
    case "too_large":
      return "Attachment not saved — too large";
    case "unsupported_type":
      return "Attachment not saved — unsupported file type";
    case "fetch_failed":
      return "Attachment not saved — download failed";
  }
}
