import { getDownloadURL, ref, uploadBytesResumable } from "firebase/storage";
import { getFirebaseStorage } from "@/lib/firebase/client";
import {
  MEDIA_MAX_BYTES,
  isAllowedMediaContentType,
  type MediaAssetDoc,
} from "@/types/media";

/**
 * Browser side of a Media Library upload: pre-check, generate the id (so the
 * bucket path is known before a byte moves), resumable upload with progress,
 * then register the object through the API — which reads the real size and
 * type back from the bucket before writing the doc.
 */

export const MEDIA_ACCEPT = "image/*,video/*,application/pdf";

/** Refusal message, or null when the file may be uploaded. */
export function precheckMediaFile(file: File): string | null {
  if (!isAllowedMediaContentType(file.type)) {
    return `${file.name}: choose an image, a video, or a PDF.`;
  }
  if (file.size > MEDIA_MAX_BYTES) {
    return `${file.name} is too large — keep it under 25 MB.`;
  }
  return null;
}

/** Keep the object name predictable: ASCII word characters, dot, dash. */
export function sanitiseFileName(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
  return (clean || "file").slice(0, 100);
}

export async function uploadMediaFile(
  file: File,
  subAccountId: string,
  folderId: string | null,
  onProgress: (fraction: number) => void,
): Promise<MediaAssetDoc> {
  const mediaId = crypto.randomUUID();
  const storagePath = `media/${subAccountId}/${mediaId}/${sanitiseFileName(file.name)}`;
  const storageRef = ref(getFirebaseStorage(), storagePath);
  const task = uploadBytesResumable(storageRef, file, { contentType: file.type });
  await new Promise<void>((resolve, reject) => {
    task.on(
      "state_changed",
      (snap) => onProgress(snap.totalBytes ? snap.bytesTransferred / snap.totalBytes : 0),
      reject,
      resolve,
    );
  });
  const downloadUrl = await getDownloadURL(storageRef);

  const res = await fetch(`/api/sub-accounts/${subAccountId}/mediaz`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mediaId,
      name: file.name,
      storagePath,
      contentType: file.type,
      size: file.size,
      downloadUrl,
      folderId,
    }),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    error?: string;
    asset?: MediaAssetDoc;
  };
  if (!res.ok || !payload.asset) {
    throw new Error(payload.error ?? "Couldn't save the upload.");
  }
  return payload.asset;
}
