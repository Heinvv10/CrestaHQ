import "server-only";

import { getStorage } from "firebase-admin/storage";

/**
 * WhatsApp media objects in Firebase Storage.
 *
 * Unlike the community avatar route, these objects are written WITHOUT a
 * `firebaseStorageDownloadTokens` metadata entry. A download token is a
 * permanent, unauthenticated, public URL — the wrong thing entirely for a
 * customer's photo or voice note (POPIA). Reads go through
 * `/api/comms/whatsapp/media/[contactId]/[messageId]`, which authorises the
 * caller first.
 */

const BUCKET_ENV = "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET";

/**
 * Object path. NO filename segment — the filename lives on the doc, so a
 * hostile or non-ASCII name never reaches a bucket path or a
 * `Content-Disposition` header derived from one. One message = one object.
 */
export function whatsappMediaPath(a: {
  agencyId: string;
  subAccountId: string;
  contactId: string;
  messageDocId: string;
}): string {
  return `whatsapp-media/${a.agencyId}/${a.subAccountId}/${a.contactId}/${a.messageDocId}`;
}

function bucket() {
  const name = process.env[BUCKET_ENV];
  if (!name) return null;
  return getStorage().bucket(name);
}

/**
 * Write the bytes. Returns a reason instead of throwing when the bucket env
 * var is unset, so a deployment without Storage degrades to a text-only
 * message row rather than losing the message.
 */
export async function putWhatsappMedia(opts: {
  path: string;
  bytes: Buffer;
  contentType: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const b = bucket();
  if (!b) {
    console.warn(`[whatsapp-media] ${BUCKET_ENV} is unset — not storing media`);
    return { ok: false, reason: "bucket_unconfigured" };
  }
  try {
    await b.file(opts.path).save(opts.bytes, {
      resumable: false,
      metadata: { contentType: opts.contentType },
    });
    return { ok: true };
  } catch (err) {
    console.error("[whatsapp-media] store failed", err);
    return { ok: false, reason: "store_failed" };
  }
}

/** Stream one object back. Null when the bucket is unconfigured or the object is gone. */
export async function openWhatsappMedia(path: string): Promise<{
  stream: AsyncIterable<Buffer>;
  sizeBytes: number;
  contentType: string;
} | null> {
  const b = bucket();
  if (!b) return null;
  const file = b.file(path);
  let sizeBytes = 0;
  let contentType = "application/octet-stream";
  try {
    const [meta] = await file.getMetadata();
    sizeBytes = Number(meta.size ?? 0);
    contentType = meta.contentType ?? contentType;
  } catch {
    // Missing object, or metadata unreadable — indistinguishable to the caller,
    // and both mean "there is nothing to serve".
    return null;
  }
  return { stream: file.createReadStream(), sizeBytes, contentType };
}
