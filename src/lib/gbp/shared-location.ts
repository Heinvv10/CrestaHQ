import "server-only";

import type { Firestore, QuerySnapshot, Transaction } from "firebase-admin/firestore";

/**
 * Whether a sub-account OTHER than `exceptId` manages this Google location —
 * the `listing_shared` refusal (MULTI_LISTING_V1_PLAN.md H1). Two queries,
 * unioned: `googleListing.locationName ==` catches every main listing,
 * including docs written before `googleLocationNames` existed (no backfill
 * needed), and `googleLocationNames array-contains` catches extra listings.
 * Either alone fails OPEN. Pass `tx` to read inside a transaction.
 */
export async function heldByAnotherSubAccount(
  db: Firestore,
  tx: Transaction | null,
  locationName: string,
  exceptId: string,
): Promise<boolean> {
  const subs = db.collection("subAccounts");
  const queries = [
    subs.where("googleListing.locationName", "==", locationName),
    subs.where("googleLocationNames", "array-contains", locationName),
  ];
  const snaps: QuerySnapshot[] = await Promise.all(queries.map((q) => (tx ? tx.get(q) : q.get())));
  return snaps.some((s) => s.docs.some((d) => d.id !== exceptId));
}
