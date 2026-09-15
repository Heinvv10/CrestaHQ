import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * Media Library — per-sub-account file storage (GHL "Media Storage" parity).
 *
 * Docs live at `subAccounts/{id}/media/{mediaId}` and
 * `subAccounts/{id}/mediaFolders/{folderId}` (member-read, server-write-only
 * — the same model as `customFields`). The bytes live in Firebase Storage at
 * `media/{subAccountId}/{mediaId}/{fileName}`; the browser uploads there
 * directly under `storage.rules`, then registers the object through
 * `POST /api/sub-accounts/[id]/media`, which reads the object's REAL size and
 * content-type back from the bucket before writing the doc.
 */

export const MEDIA_MAX_BYTES = 25 * 1024 * 1024;

export type MediaKind = "image" | "video" | "document";

/** Content types the bucket accepts (mirrored in storage.rules). */
export function isAllowedMediaContentType(contentType: string): boolean {
  return (
    contentType.startsWith("image/") ||
    contentType.startsWith("video/") ||
    contentType === "application/pdf"
  );
}

export function mediaKindOf(contentType: string): MediaKind {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  return "document";
}

export interface MediaAssetDoc {
  id: string;
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  /** Display name — editable, independent of the stored file name. */
  name: string;
  /** `mediaFolders/{id}`; null = library root. */
  folderId: string | null;
  /** `media/{subAccountId}/{mediaId}/{fileName}` in the bucket. */
  storagePath: string;
  contentType: string;
  /** Bytes, as reported by the bucket (never the client). */
  size: number;
  /** Firebase token download URL. */
  downloadUrl: string;
  kind: MediaKind;
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

export interface MediaFolderDoc {
  id: string;
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  name: string;
  /** Parent folder id; null = library root. */
  parentId: string | null;
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}
