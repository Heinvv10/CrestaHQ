import "server-only";

import {
  FieldValue,
  type DocumentReference,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import { toPortablePayload } from "@/lib/snapshots/portable";
import { hashShareToken, shareStatus } from "@/lib/snapshots/share";
import { buildSnapshotFile, type SnapshotFile } from "@/lib/snapshots/snapshot-file";
import type { SnapshotPayload } from "@/types/snapshots";

type ShareData = FirebaseFirestore.DocumentData;

interface ActiveShare {
  shareRef: DocumentReference;
  share: ShareData;
  source: ShareData;
}

/**
 * Resolve a presented token to a live share and its source snapshot, inside
 * `tx` (all reads, no writes). Null for every way a link can be bad — unknown,
 * revoked, expired, used up, source gone — so callers answer them identically.
 */
export async function activeShare(
  db: Firestore,
  tx: Transaction,
  token: string,
  now: Date,
): Promise<ActiveShare | null> {
  const indexSnap = await tx.get(db.doc(`snapshotShareIndex/${hashShareToken(token)}`));
  const index = indexSnap.data();
  if (!indexSnap.exists || !index) return null;

  const sourceRef = db.doc(`agencies/${index.agencyId}/snapshots/${index.snapshotId}`);
  const shareRef = sourceRef.collection("shares").doc(index.shareId);
  const shareSnap = await tx.get(shareRef);
  const share = shareSnap.data();
  if (!shareSnap.exists || !share || shareStatus(share, now) !== "active") return null;

  const sourceSnap = await tx.get(sourceRef);
  const source = sourceSnap.data();
  if (!sourceSnap.exists || !source) return null;
  return { shareRef, share, source };
}

export function portableOf({ share, source }: ActiveShare): SnapshotPayload {
  const sourceIds = new Set(
    [share.agencyId, source.sourceSubAccountId, source.createdByUid, share.createdByUid]
      .filter((v): v is string => typeof v === "string" && v.length > 0),
  );
  return toPortablePayload((source.payload ?? {}) as SnapshotPayload, sourceIds);
}

export function countUse(tx: Transaction, shareRef: DocumentReference): void {
  tx.update(shareRef, {
    usedCount: FieldValue.increment(1),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

export interface SharedSnapshotPreview {
  name: string;
  expiresAt: number;
  singleUse: boolean;
  counts: Record<"forms" | "messageTemplates" | "products" | "workflows" | "customFields", number> & {
    aiProfile: boolean;
  };
}

/** What the public share page shows. Viewing is not a use. */
export async function previewSharedSnapshot(
  db: Firestore,
  token: string,
  now: Date = new Date(),
): Promise<SharedSnapshotPreview | null> {
  return db.runTransaction(async (tx) => {
    const found = await activeShare(db, tx, token, now);
    if (!found) return null;
    const p = (found.source.payload ?? {}) as Partial<SnapshotPayload>;
    return {
      name: found.source.name ?? "",
      expiresAt: found.share.expiresAt.toMillis(),
      singleUse: found.share.singleUse === true,
      counts: {
        forms: p.forms?.length ?? 0,
        messageTemplates: p.messageTemplates?.length ?? 0,
        products: p.products?.length ?? 0,
        workflows: p.workflows?.length ?? 0,
        customFields: p.customFields?.length ?? 0,
        aiProfile: Boolean(p.aiProfile),
      },
    };
  });
}

/** The portable file behind a link, counted as a use. Null when the link is bad. */
export async function downloadSharedSnapshot(
  db: Firestore,
  input: { token: string; now?: Date },
): Promise<SnapshotFile | null> {
  const now = input.now ?? new Date();
  return db.runTransaction(async (tx) => {
    const found = await activeShare(db, tx, input.token, now);
    if (!found) return null;
    countUse(tx, found.shareRef);
    return buildSnapshotFile(found.source.name ?? "", portableOf(found), now);
  });
}

