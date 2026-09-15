import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb, getAdminStorage } from "@/lib/firebase/admin";
import {
  MEDIA_MAX_BYTES,
  isAllowedMediaContentType,
  mediaKindOf,
  type MediaAssetDoc,
  type MediaFolderDoc,
} from "@/types/media";

/**
 * Media Library service (Admin SDK). The browser uploads bytes straight to
 * the bucket; everything that touches a Firestore doc or deletes an object
 * goes through here. Every refusal is a `MediaError` with the HTTP status
 * the route should answer with.
 */

export class MediaError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MEDIA_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Trimmed display/folder name, or null when empty or over 120 characters. */
export function validateMediaName(v: unknown): string | null {
  const name = typeof v === "string" ? v.trim() : "";
  return name.length >= 1 && name.length <= 120 ? name : null;
}

function requireName(v: unknown): string {
  const name = validateMediaName(v);
  if (!name) throw new MediaError(400, "Name must be 1–120 characters.");
  return name;
}

function optionalId(v: unknown, label: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || !MEDIA_ID_RE.test(v)) {
    throw new MediaError(400, `${label} must be a document id or null.`);
  }
  return v;
}

/**
 * The bucket path this upload may claim: `media/{sa}/{mediaId}/{fileName}`,
 * exactly one file-name segment. Anything else — another sub-account's
 * prefix, a nested path, a bare prefix — is refused before the bucket is
 * consulted.
 */
export function isOwnedStoragePath(
  storagePath: unknown,
  subAccountId: string,
  mediaId: string,
): storagePath is string {
  if (typeof storagePath !== "string") return false;
  const prefix = `media/${subAccountId}/${mediaId}/`;
  if (!storagePath.startsWith(prefix)) return false;
  const fileName = storagePath.slice(prefix.length);
  return fileName.length > 0 && !fileName.includes("/") && fileName !== "..";
}

/** A Firebase token URL for exactly this object, nothing else. */
function isDownloadUrlFor(url: unknown, storagePath: string): url is string {
  if (typeof url !== "string") return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.origin === "https://firebasestorage.googleapis.com" &&
    parsed.pathname.endsWith(`/o/${encodeURIComponent(storagePath)}`) &&
    parsed.searchParams.get("alt") === "media"
  );
}

const mediaCol = (sa: string) => getAdminDb().collection(`subAccounts/${sa}/media`);
const folderCol = (sa: string) =>
  getAdminDb().collection(`subAccounts/${sa}/mediaFolders`);

async function requireFolder(sa: string, folderId: string) {
  const snap = await folderCol(sa).doc(folderId).get();
  if (!snap.exists) throw new MediaError(404, "Folder not found");
  return snap.data() as MediaFolderDoc;
}

export interface CreateMediaInput {
  subAccountId: string;
  agencyId: string;
  uid: string;
  body: Record<string, unknown>;
}

/**
 * Register an object the browser has already uploaded. Size and content
 * type come from the bucket's own metadata — the body's values are ignored.
 */
export async function createMediaAsset(
  input: CreateMediaInput,
): Promise<MediaAssetDoc> {
  const { subAccountId, agencyId, uid, body } = input;
  const mediaId = body.mediaId;
  if (typeof mediaId !== "string" || !MEDIA_ID_RE.test(mediaId)) {
    throw new MediaError(400, "mediaId is required.");
  }
  if (!isOwnedStoragePath(body.storagePath, subAccountId, mediaId)) {
    throw new MediaError(400, "storagePath is outside this upload's prefix.");
  }
  const storagePath = body.storagePath;
  if (!isDownloadUrlFor(body.downloadUrl, storagePath)) {
    throw new MediaError(400, "downloadUrl does not point at this object.");
  }
  const name = requireName(body.name);
  const folderId = optionalId(body.folderId, "folderId");
  if (folderId) await requireFolder(subAccountId, folderId);

  const ref = mediaCol(subAccountId).doc(mediaId);
  if ((await ref.get()).exists) {
    throw new MediaError(409, "This upload is already registered.");
  }

  const file = getAdminStorage().bucket().file(storagePath);
  const [exists] = await file.exists();
  if (!exists) throw new MediaError(404, "Uploaded file not found in storage.");
  const [meta] = await file.getMetadata();
  const size = Number(meta.size ?? 0);
  const contentType = String(meta.contentType ?? "");
  if (!isAllowedMediaContentType(contentType) || size > MEDIA_MAX_BYTES) {
    // The rules should have refused this; clean up rather than index it.
    await file.delete({ ignoreNotFound: true });
    throw new MediaError(400, "File type or size is not allowed.");
  }

  const now = FieldValue.serverTimestamp();
  const doc: Omit<MediaAssetDoc, "id"> = {
    agencyId,
    subAccountId,
    createdByUid: uid,
    name,
    folderId,
    storagePath,
    contentType,
    size,
    downloadUrl: body.downloadUrl,
    kind: mediaKindOf(contentType),
    createdAt: now,
    updatedAt: now,
  };
  await ref.set(doc);
  return { id: mediaId, ...doc };
}

/** Rename and/or move. `{ folderId: null }` moves back to the root. */
export async function updateMediaAsset(
  subAccountId: string,
  mediaId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const ref = mediaCol(subAccountId).doc(mediaId);
  if (!(await ref.get()).exists) throw new MediaError(404, "File not found");
  const update: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (body.name !== undefined) update.name = requireName(body.name);
  if (body.folderId !== undefined) {
    const folderId = optionalId(body.folderId, "folderId");
    if (folderId) await requireFolder(subAccountId, folderId);
    update.folderId = folderId;
  }
  await ref.update(update);
}

/** Object first, then doc — a missing object is not an error. */
export async function deleteMediaAsset(
  subAccountId: string,
  mediaId: string,
): Promise<void> {
  const ref = mediaCol(subAccountId).doc(mediaId);
  const snap = await ref.get();
  if (!snap.exists) throw new MediaError(404, "File not found");
  const { storagePath } = snap.data() as MediaAssetDoc;
  if (isOwnedStoragePath(storagePath, subAccountId, mediaId)) {
    await getAdminStorage()
      .bucket()
      .file(storagePath)
      .delete({ ignoreNotFound: true });
  }
  await ref.delete();
}

export async function createMediaFolder(input: CreateMediaInput): Promise<string> {
  const { subAccountId, agencyId, uid, body } = input;
  const name = requireName(body.name);
  const parentId = optionalId(body.parentId, "parentId");
  if (parentId) await requireFolder(subAccountId, parentId);
  const ref = folderCol(subAccountId).doc();
  const now = FieldValue.serverTimestamp();
  const doc: Omit<MediaFolderDoc, "id"> = {
    agencyId,
    subAccountId,
    createdByUid: uid,
    name,
    parentId,
    createdAt: now,
    updatedAt: now,
  };
  await ref.set(doc);
  return ref.id;
}

/** Walk up from `startId`; true when `target` is on the chain. */
async function isAncestorOrSelf(
  sa: string,
  startId: string,
  target: string,
): Promise<boolean> {
  let cursor: string | null = startId;
  for (let hops = 0; cursor && hops < 50; hops++) {
    if (cursor === target) return true;
    const snap = await folderCol(sa).doc(cursor).get();
    cursor = snap.exists ? ((snap.data() as MediaFolderDoc).parentId ?? null) : null;
  }
  return false;
}

export async function updateMediaFolder(
  subAccountId: string,
  folderId: string,
  body: Record<string, unknown>,
): Promise<void> {
  await requireFolder(subAccountId, folderId);
  const update: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (body.name !== undefined) update.name = requireName(body.name);
  if (body.parentId !== undefined) {
    const parentId = optionalId(body.parentId, "parentId");
    if (parentId && (await isAncestorOrSelf(subAccountId, parentId, folderId))) {
      throw new MediaError(400, "A folder cannot be moved into itself.");
    }
    update.parentId = parentId;
  }
  await folderCol(subAccountId).doc(folderId).update(update);
}

/** Refuses (409) while the folder still holds files or sub-folders. */
export async function deleteMediaFolder(
  subAccountId: string,
  folderId: string,
): Promise<void> {
  await requireFolder(subAccountId, folderId);
  const [files, children] = await Promise.all([
    mediaCol(subAccountId).where("folderId", "==", folderId).limit(1).get(),
    folderCol(subAccountId).where("parentId", "==", folderId).limit(1).get(),
  ]);
  if (!files.empty || !children.empty) {
    throw new MediaError(409, "Empty the folder before deleting it.");
  }
  await folderCol(subAccountId).doc(folderId).delete();
}
