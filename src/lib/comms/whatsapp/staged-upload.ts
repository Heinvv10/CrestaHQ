import "server-only";

import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { getAdminDb } from "@/lib/firebase/admin";
import { mediaKindForMime } from "@/types/whatsapp-media";
import type { SubAccountDoc } from "@/types";
import { bucket } from "./media-storage";
import { uploadCapFor, type OutboundAttachment, type WhatsAppProviderCapabilities } from "./provider";
import { resolveWhatsappSender } from "./resolve-sender";

/**
 * Composer attachments, uploaded by the browser straight to Storage.
 *
 * The browser asks `/api/comms/whatsapp/upload-url` for a short-lived V4
 * signed PUT URL, PUTs the raw file to it, and sends only the `stagedId`.
 * The send route then reads the object back, checks it, sends it and deletes
 * it. The file never travels as base64 through src/middleware.ts, which is
 * what held Cloud documents at 16 MiB.
 *
 * TENANCY. A staged object's path is built ONLY from values the server
 * already trusts — the contact's `agencyId` / `subAccountId` (read by
 * `requireContactAccessible`, which has just authorised the caller for that
 * contact) and the caller's own uid — plus a random id this module issued.
 * The client supplies the id and nothing else, and an id that is not exactly
 * the issued shape is refused, so it can never climb out of its segment.
 * Another user's, sub-account's or agency's object is therefore unreachable
 * by construction: the path the server rebuilds is the caller's own.
 *
 * Signed URLs bypass Storage rules; `storage.rules` denies `whatsapp-staging/**`
 * to every client SDK regardless.
 */

export const STAGING_PREFIX = "whatsapp-staging/";

/** How long a signed PUT URL stays usable. */
export const STAGED_UPLOAD_URL_TTL_MS = 10 * 60_000;

/** 18 random bytes as base64url: exactly 24 characters from [A-Za-z0-9_-]. */
const STAGED_ID = /^[A-Za-z0-9_-]{24}$/;

export function newStagedId(): string {
  return randomBytes(18).toString("base64url");
}

/** Null when `stagedId` is not the shape `newStagedId` issues. */
export function stagingPath(a: {
  agencyId: string;
  subAccountId: string;
  uid: string;
  stagedId: string;
}): string | null {
  if (!STAGED_ID.test(a.stagedId)) return null;
  return `${STAGING_PREFIX}${a.agencyId}/${a.subAccountId}/${a.uid}/${a.stagedId}`;
}

/**
 * The rail this sub-account sends on, for checking a file against it. The
 * same gate and the same sender resolution the send itself uses, so a URL is
 * never issued for a file the send would refuse on those grounds.
 */
export async function stagingRail(
  subAccountId: string,
): Promise<
  | { ok: true; capabilities: WhatsAppProviderCapabilities }
  | { ok: false; status: number; error: string }
> {
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const sub = snap.exists ? (snap.data() as SubAccountDoc) : null;
  if (sub?.whatsappEnabledByAgency !== true) {
    return { ok: false, status: 403, error: "WhatsApp is disabled for this sub-account by your agency." };
  }
  const resolved = resolveWhatsappSender(sub);
  if (!resolved.ok) return { ok: false, status: 503, error: resolved.error };
  return { ok: true, capabilities: resolved.capabilities };
}

export interface MediaRefusal {
  code: "media_unsupported_rail" | "media_unsupported_type" | "media_too_large" | "media_invalid";
  error: string;
}

/**
 * Whether a file of this type and size may be uploaded for this rail. Called
 * with the client's DECLARED values before a URL is issued, and again with
 * the staged object's REAL metadata before anything is sent — the second is
 * the one that counts. A photo may exceed the rail's image cap up to the raw
 * upload cap: the send route shrinks it to the rail's cap (image-shrink.ts).
 * So may a phone video when this host can transcode (`host.videoTranscode`,
 * video-transcode.ts); both routes pass the same cached answer.
 */
export function mediaRefusal(
  caps: WhatsAppProviderCapabilities,
  contentType: string,
  sizeBytes: number,
  host: { videoTranscode: boolean },
): MediaRefusal | null {
  if (!caps.supportsMedia) {
    return { code: "media_unsupported_rail", error: "This WhatsApp rail cannot send attachments." };
  }
  const cap = uploadCapFor(caps, contentType, host);
  if (cap === 0) {
    return {
      code: "media_unsupported_type",
      error: `Attachment type ${contentType || "(none)"} cannot be sent on this rail.`,
    };
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    return { code: "media_invalid", error: "The attachment is empty." };
  }
  if (sizeBytes > cap) {
    return {
      code: "media_too_large",
      error: `Attachment is ${sizeBytes} bytes; the limit for a ${mediaKindForMime(contentType)} is ${cap}.`,
    };
  }
  return null;
}

/** The byte cap a staged upload is signed with. */
export function stagedUploadCap(
  caps: WhatsAppProviderCapabilities,
  contentType: string,
  host: { videoTranscode: boolean },
): number {
  return uploadCapFor(caps, contentType, host);
}

/**
 * Null when the bucket is unconfigured.
 *
 * Both `contentType` and `x-goog-content-length-range` are part of the
 * signature, so the PUT must carry exactly these values or Storage refuses it.
 * The range is what bounds the upload itself: without it a URL is good for
 * any size Storage accepts (5 TiB) for as long as a PUT started before
 * expiry keeps streaming, and the send route's check comes only afterwards.
 * The browser must send the returned `contentLengthRange` verbatim.
 */
export async function signStagedUpload(
  path: string,
  contentType: string,
  maxBytes: number,
): Promise<{ url: string; expiresAt: number; contentLengthRange: string } | null> {
  const b = bucket();
  if (!b) return null;
  const expiresAt = Date.now() + STAGED_UPLOAD_URL_TTL_MS;
  const contentLengthRange = `0,${maxBytes}`;
  const [url] = await b.file(path).getSignedUrl({
    version: "v4",
    action: "write",
    expires: expiresAt,
    contentType,
    extensionHeaders: { "x-goog-content-length-range": contentLengthRange },
  });
  return { url, expiresAt, contentLengthRange };
}

/** A staged object as Storage reports it — never as the client described it. */
export interface StagedObject {
  path: string;
  sizeBytes: number;
  contentType: string;
  /**
   * Pins every later read and copy to the object that was checked. The signed
   * URL stays usable for its full TTL, so without this a client could replace
   * the object between the check and the read.
   */
  generation: string;
}

/** A staged file ready to send: its bytes, and the object they came from. */
export interface StagedAttachment {
  outbound: OutboundAttachment;
  staged: StagedObject;
  /**
   * True when `outbound` is not the staged object's bytes — a photo re-encoded
   * to fit the rail. The thread's copy is then written from `outbound`, so it
   * is what the customer received, not what the operator picked.
   */
  rewritten?: true;
}

/** Null when the object is missing (never uploaded, expired, already sent). */
export async function statStaged(path: string): Promise<StagedObject | null> {
  try {
    // Inside the try: resolving the bucket can throw synchronously (no admin
    // app), and the send route would then answer an unhandled 500.
    const b = bucket();
    if (!b) return null;
    const [meta] = await b.file(path).getMetadata();
    return {
      path,
      sizeBytes: Number(meta.size ?? 0),
      contentType: meta.contentType ?? "",
      generation: String(meta.generation ?? ""),
    };
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown } | null;
    // Never the raw error: a Storage ApiError carries the request headers.
    if (e?.code !== 404) {
      console.warn("[whatsapp-staging] stat failed", { path, code: e?.code, message: e?.message });
    }
    return null;
  }
}

/** Blob parts are cut at this size so no more than one of them sits in the JS heap. */
const PART_BYTES = 8 << 20;

/**
 * The object's bytes as ONE Blob. Chunks are folded into Blob parts as they
 * arrive, and a Blob built from Blobs references them rather than copying,
 * so a 100 MB object costs ~100 MB plus one part — not the chunk list plus a
 * concatenated Buffer plus a copy for the multipart upload.
 *
 * Throws when the stream yields more or fewer bytes than the checked size.
 */
export async function readStaged(obj: StagedObject): Promise<Blob> {
  const b = bucket();
  if (!b) throw new Error("bucket_unconfigured");
  const file = b.file(obj.path, obj.generation ? { generation: Number(obj.generation) } : {});
  const parts: Blob[] = [];
  let pending: Buffer<ArrayBuffer>[] = [];
  let pendingBytes = 0;
  let total = 0;
  for await (const chunk of file.createReadStream() as AsyncIterable<Buffer<ArrayBuffer>>) {
    total += chunk.length;
    if (total > obj.sizeBytes) throw new Error("staged object grew after it was checked");
    pending.push(chunk);
    pendingBytes += chunk.length;
    if (pendingBytes >= PART_BYTES) {
      parts.push(new Blob(pending));
      pending = [];
      pendingBytes = 0;
    }
  }
  if (total !== obj.sizeBytes) throw new Error("staged object read short");
  parts.push(new Blob(pending));
  return new Blob(parts, { type: obj.contentType });
}

/**
 * The object's bytes streamed to a NEW file at `dest` (created 0600, refused
 * if it exists), never held in memory: a video to transcode may be 250 MB.
 * Throws, as `readStaged` does, when the stream yields more or fewer bytes
 * than the checked size; the caller owns the file either way.
 */
export async function downloadStaged(obj: StagedObject, dest: string): Promise<void> {
  const b = bucket();
  if (!b) throw new Error("bucket_unconfigured");
  const file = b.file(obj.path, obj.generation ? { generation: Number(obj.generation) } : {});
  let total = 0;
  const counted = new Transform({
    transform(chunk: Buffer, _enc, done) {
      total += chunk.length;
      done(total > obj.sizeBytes ? new Error("staged object grew after it was checked") : null, chunk);
    },
  });
  await pipeline(file.createReadStream(), counted, createWriteStream(dest, { flags: "wx", mode: 0o600 }));
  if (total !== obj.sizeBytes) throw new Error("staged object read short");
}

/**
 * The thread's copy, made by Storage itself from the checked generation —
 * no bytes pass through this process. Never throws; see putWhatsappMedia.
 */
export async function copyStagedTo(
  obj: StagedObject,
  destPath: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const b = bucket();
    if (!b) return { ok: false, reason: "bucket_unconfigured" };
    const src = b.file(obj.path, obj.generation ? { generation: Number(obj.generation) } : {});
    await src.copy(b.file(destPath));
    return { ok: true };
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown } | null;
    console.error("[whatsapp-staging] copy failed", { code: e?.code, message: e?.message });
    return { ok: false, reason: "store_failed" };
  }
}

/** Best effort: whatever this misses, the daily sweep removes. Never throws. */
export async function deleteStaged(path: string): Promise<void> {
  try {
    const b = bucket();
    if (!b) return;
    await b.file(path).delete({ ignoreNotFound: true });
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown } | null;
    console.warn("[whatsapp-staging] delete failed", { path, code: e?.code, message: e?.message });
  }
}

/** Staged objects older than this were abandoned: a URL lives 10 minutes. */
export const STALE_STAGED_AGE_MS = 60 * 60_000;

/**
 * Per-run bounds. A flood of abandoned uploads must not make one run so long
 * that QStash times it out and retries it into a loop: the sweep lists a page
 * at a time and stops after `maxDeletes`, and the next day's run (or the
 * bucket lifecycle rule, if one is added) takes the rest.
 */
const SWEEP_PAGE_SIZE = 500;
const SWEEP_MAX_DELETES = 5_000;
const SWEEP_DELETE_CONCURRENCY = 25;

/**
 * Delete every object under `whatsapp-staging/` created more than
 * `STALE_STAGED_AGE_MS` ago — uploads that were attached and never sent.
 * Listed by prefix, and each name is checked against it again before the
 * delete, so nothing outside the staging area can be touched.
 */
export async function sweepStaleStaged(
  now = Date.now(),
  opts: { pageSize?: number; maxDeletes?: number } = {},
): Promise<{ deleted: number; kept: number; truncated: boolean }> {
  const pageSize = opts.pageSize ?? SWEEP_PAGE_SIZE;
  const maxDeletes = opts.maxDeletes ?? SWEEP_MAX_DELETES;
  const b = bucket();
  if (!b) return { deleted: 0, kept: 0, truncated: false };
  let deleted = 0;
  let kept = 0;
  let pageToken: string | undefined;
  do {
    const [files, next] = await b.getFiles({
      prefix: STAGING_PREFIX,
      maxResults: pageSize,
      autoPaginate: false,
      ...(pageToken ? { pageToken } : {}),
    });
    const stale = [];
    for (const f of files) {
      const created = Date.parse(String(f.metadata?.timeCreated ?? ""));
      if (f.name.startsWith(STAGING_PREFIX) && now - created > STALE_STAGED_AGE_MS) stale.push(f);
      else kept += 1;
    }
    for (let i = 0; i < stale.length; i += SWEEP_DELETE_CONCURRENCY) {
      if (deleted >= maxDeletes) return { deleted, kept, truncated: true };
      const batch = stale.slice(i, Math.min(i + SWEEP_DELETE_CONCURRENCY, i + maxDeletes - deleted));
      await Promise.all(batch.map((f) => f.delete({ ignoreNotFound: true })));
      deleted += batch.length;
    }
    pageToken = (next as { pageToken?: string } | null | undefined)?.pageToken;
    if (pageToken && deleted >= maxDeletes) return { deleted, kept, truncated: true };
  } while (pageToken);
  return { deleted, kept, truncated: false };
}
