import "server-only";

import { getStorage } from "firebase-admin/storage";

import { getAdminApp } from "@/lib/firebase/admin";

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

/** The media bucket, or null when the env var is unset. Shared with staged-upload.ts. */
export function bucket() {
  const name = process.env[BUCKET_ENV];
  if (!name) return null;
  // The app is passed explicitly: a webhook may reach Storage before anything
  // has initialised the default app, and `getStorage()` would then throw
  // "The default Firebase app does not exist".
  return getStorage(getAdminApp()).bucket(name);
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
  try {
    // Inside the try: resolving the bucket can throw synchronously (no admin
    // app), and on the outbound path this runs AFTER the customer has the
    // file — a throw here would lose the thread row and answer 500, which
    // invites a resend.
    const b = bucket();
    if (!b) {
      console.warn(`[whatsapp-media] ${BUCKET_ENV} is unset — not storing media`);
      return { ok: false, reason: "bucket_unconfigured" };
    }
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

/** A half-open byte range, both ends inclusive, as HTTP `Range` expresses it. */
export interface MediaByteRange {
  start: number;
  end: number;
}

/**
 * Open one object. Null when the bucket is unconfigured or the object is gone.
 *
 * Returns the object's size and a `read` that can be called for the whole
 * object or for one byte range — the size comes back BEFORE any bytes are
 * requested, because the caller needs it to decide whether a client's `Range`
 * is satisfiable, and a second metadata round trip would let the two disagree.
 */
export async function openWhatsappMedia(path: string): Promise<{
  sizeBytes: number;
  contentType: string;
  read: (range?: MediaByteRange) => AsyncIterable<Buffer>;
} | null> {
  try {
    // Inside the try: resolving the bucket can throw synchronously (no admin
    // app), and the serving route would then answer an unhandled 500 instead
    // of its 404.
    const b = bucket();
    if (!b) return null;
    const file = b.file(path);
    const [meta] = await file.getMetadata();
    return {
      sizeBytes: Number(meta.size ?? 0),
      contentType: meta.contentType ?? "application/octet-stream",
      read: (range) =>
        range
          ? file.createReadStream({ start: range.start, end: range.end })
          : file.createReadStream(),
    };
  } catch (err) {
    // Missing object, unreadable metadata, or Storage that would not
    // initialise — all mean "there is nothing to serve" to the caller, but only
    // the log can tell them apart. A missing object is a normal state (deleted,
    // or an upload that failed after the row was written), so it is not logged.
    // Never the raw error: a Storage ApiError carries the request headers,
    // Authorization bearer token included.
    const e = err as { code?: unknown; message?: unknown } | null;
    if (e?.code !== 404) {
      console.warn("[whatsapp-media] open failed", {
        path,
        code: e?.code,
        message: e?.message,
      });
    }
    return null;
  }
}
