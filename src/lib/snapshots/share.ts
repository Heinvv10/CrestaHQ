import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import { scrubImportedPayload } from "@/lib/snapshots/import-scrub";
import {
  SNAPSHOT_SHARE_EXPIRY_DAYS,
  type SnapshotPayload,
  type SnapshotShareStatus,
  type SnapshotShareSummary,
} from "@/types/snapshots";

/**
 * Snapshot share links + cross-agency import.
 *
 * A share lives under the snapshot it shares and stores only the sha256 of
 * its token; `snapshotShareIndex/{tokenHash}` resolves a presented token back
 * to it. Importing copies the snapshot into the importer's own agency as a new
 * doc carrying `importedFrom: { importedAt }` and nothing that points back at
 * the source tenant (see import-scrub.ts).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const INVALID_LINK = "Invalid or expired link";

export function hashShareToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isShareExpiryDays(value: unknown): value is (typeof SNAPSHOT_SHARE_EXPIRY_DAYS)[number] {
  return (SNAPSHOT_SHARE_EXPIRY_DAYS as readonly unknown[]).includes(value);
}

type ShareData = FirebaseFirestore.DocumentData;

export function shareStatus(share: ShareData, now: Date): SnapshotShareStatus {
  if (share.revokedAt) return "revoked";
  if (share.singleUse && (share.usedCount ?? 0) >= 1) return "used";
  if ((share.expiresAt?.toMillis?.() ?? 0) <= now.getTime()) return "expired";
  return "active";
}

function toSummary(id: string, share: ShareData, now: Date): SnapshotShareSummary {
  return {
    id,
    snapshotId: share.snapshotId,
    snapshotName: share.snapshotName ?? "",
    expiresAt: share.expiresAt?.toMillis?.() ?? 0,
    singleUse: share.singleUse === true,
    usedCount: share.usedCount ?? 0,
    revokedAt: share.revokedAt?.toMillis?.() ?? null,
    createdAt: share.createdAt?.toMillis?.() ?? null,
    status: shareStatus(share, now),
  };
}

interface CreateShareInput {
  agencyId: string;
  snapshotId: string;
  uid: string;
  expiresInDays: (typeof SNAPSHOT_SHARE_EXPIRY_DAYS)[number];
  singleUse: boolean;
  now?: Date;
}

/**
 * Mint a share for a snapshot in the caller's agency. Returns the raw token
 * exactly once. Refuses a snapshot not in that agency, and one that was itself
 * imported — a copy is the importer's to apply, not to redistribute.
 */
export async function createSnapshotShare(
  db: Firestore,
  input: CreateShareInput,
): Promise<{ share: SnapshotShareSummary; token: string } | "not_found" | "imported"> {
  const { agencyId, snapshotId, uid, expiresInDays, singleUse } = input;
  const now = input.now ?? new Date();
  const snapshotRef = db.doc(`agencies/${agencyId}/snapshots/${snapshotId}`);
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashShareToken(token);
  const ref = snapshotRef.collection("shares").doc();

  const share = await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(snapshotRef);
    if (!snapshot.exists) return "not_found" as const;
    if (snapshot.data()?.importedFrom) return "imported" as const;
    const doc = {
      id: ref.id,
      agencyId,
      snapshotId,
      snapshotName: snapshot.data()?.name ?? "",
      createdByUid: uid,
      tokenHash,
      expiresAt: Timestamp.fromMillis(now.getTime() + expiresInDays * DAY_MS),
      singleUse,
      usedCount: 0,
      revokedAt: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    tx.set(ref, doc);
    tx.set(db.doc(`snapshotShareIndex/${tokenHash}`), {
      agencyId,
      snapshotId,
      shareId: ref.id,
      createdByUid: uid,
      createdAt: FieldValue.serverTimestamp(),
    });
    return doc;
  });
  if (typeof share === "string") return share;

  return { share: toSummary(ref.id, { ...share, createdAt: null }, now), token };
}

/** Every share across the agency's snapshots, newest first. */
export async function listSnapshotShares(
  db: Firestore,
  agencyId: string,
  now: Date = new Date(),
): Promise<SnapshotShareSummary[]> {
  // Per-snapshot reads instead of a collection-group query: an agency holds a
  // handful of snapshots, and a group query would need its own index.
  const snapshots = await db.collection(`agencies/${agencyId}/snapshots`).get();
  const perSnapshot = await Promise.all(
    snapshots.docs.map((d) => d.ref.collection("shares").get()),
  );
  return perSnapshot
    .flatMap((s) => s.docs)
    .map((d) => toSummary(d.id, d.data(), now))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/** Revoke a share and drop its index entry. False when it does not exist. */
export async function revokeSnapshotShare(
  db: Firestore,
  input: { agencyId: string; snapshotId: string; shareId: string; now?: Date },
): Promise<boolean> {
  const { agencyId, snapshotId, shareId } = input;
  const ref = db.doc(`agencies/${agencyId}/snapshots/${snapshotId}/shares/${shareId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const share = snap.data();
    if (!snap.exists || !share) return false;
    if (!share.revokedAt) {
      tx.update(ref, {
        revokedAt: Timestamp.fromDate(input.now ?? new Date()),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    tx.delete(db.doc(`snapshotShareIndex/${share.tokenHash}`));
    return true;
  });
}

export type ImportOutcome =
  | { ok: true; snapshotId: string }
  | { ok: false; status: 404 | 409; error: string };

/**
 * Import the snapshot behind a share token into the caller's agency. Every
 * refusal that concerns the link itself (unknown, revoked, expired, used up,
 * source gone) is the same 404, so a caller learns nothing about which.
 */
export async function importSharedSnapshot(
  db: Firestore,
  input: { token: string; agencyId: string; uid: string; now?: Date },
): Promise<ImportOutcome> {
  const now = input.now ?? new Date();
  const tokenHash = hashShareToken(input.token);
  const invalid: ImportOutcome = { ok: false, status: 404, error: INVALID_LINK };

  return db.runTransaction(async (tx): Promise<ImportOutcome> => {
    const indexSnap = await tx.get(db.doc(`snapshotShareIndex/${tokenHash}`));
    const index = indexSnap.data();
    if (!indexSnap.exists || !index) return invalid;

    const sourcePath = `agencies/${index.agencyId}/snapshots/${index.snapshotId}`;
    const shareRef = db.doc(`${sourcePath}/shares/${index.shareId}`);
    const shareSnap = await tx.get(shareRef);
    const share = shareSnap.data();
    if (!shareSnap.exists || !share) return invalid;
    if (shareStatus(share, now) !== "active") return invalid;

    if (share.agencyId === input.agencyId) {
      return {
        ok: false,
        status: 409,
        error: "This snapshot already belongs to your agency.",
      };
    }

    const sourceSnap = await tx.get(db.doc(sourcePath));
    const source = sourceSnap.data();
    if (!sourceSnap.exists || !source) return invalid;

    const sourceIds = new Set(
      [share.agencyId, source.sourceSubAccountId, source.createdByUid, share.createdByUid]
        .filter((v): v is string => typeof v === "string" && v.length > 0),
    );
    const payload = (source.payload ?? {}) as SnapshotPayload;

    const ref = db.collection(`agencies/${input.agencyId}/snapshots`).doc();
    tx.set(ref, {
      id: ref.id,
      agencyId: input.agencyId,
      name: source.name ?? "",
      description: source.description ?? "",
      version: source.version,
      sourceSubAccountId: null,
      createdByUid: input.uid,
      createdAt: FieldValue.serverTimestamp(),
      payload: scrubImportedPayload(payload, sourceIds),
      importedFrom: { importedAt: FieldValue.serverTimestamp() },
    });
    tx.update(shareRef, {
      usedCount: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { ok: true, snapshotId: ref.id };
  });
}
