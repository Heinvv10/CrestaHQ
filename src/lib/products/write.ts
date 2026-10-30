import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { agentEditStamp } from "@/lib/server/agent-edit-stamp";
import type { AgentActor } from "@/lib/workflows/agent-hold";
import { DEFAULT_PRODUCT } from "@/types/products";
import type { Product } from "@/types/products";

/**
 * Create a catalog product from a sanitized payload (sanitizeProductPayload),
 * shared by the products route and the agent capability. `agencyId` falls
 * back to the sub-account's; null when neither is known.
 */
export async function createProduct(opts: {
  subAccountId: string;
  agencyId?: string | null;
  createdByUid: string;
  sanitized: Partial<Product>;
  actor?: AgentActor;
}): Promise<string | null> {
  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${opts.subAccountId}`).get();
  const agencyId = opts.agencyId ?? (subSnap.data()?.agencyId as string | undefined);
  if (!agencyId) return null;
  const docRef = db.collection("products").doc();
  const doc: Omit<Product, "id"> = {
    ...DEFAULT_PRODUCT,
    agencyId,
    subAccountId: opts.subAccountId,
    createdByUid: opts.createdByUid,
    ...opts.sanitized,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await docRef.set({ ...doc, ...agentEditStamp(opts.actor) });
  return docRef.id;
}
