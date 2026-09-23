import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";

/**
 * Whether a doc id taken from request input names a doc in the caller's
 * sub-account (and, when given, the API key's mode). Routes that link a
 * contact/deal/event by id must check this before writing: membership of
 * the ROUTE's sub-account says nothing about the doc the id points at.
 * Callers answer `false` with a 404, never a 403, so a foreign id is
 * indistinguishable from a missing one.
 */
export async function refInSubAccount(
  collection: "contacts" | "deals" | "events",
  id: string,
  subAccountId: string,
  mode?: string,
): Promise<boolean> {
  if (!id || id.includes("/")) return false;
  const snap = await getAdminDb().collection(collection).doc(id).get();
  if (!snap.exists) return false;
  const data = snap.data() ?? {};
  if (data.subAccountId !== subAccountId) return false;
  return mode === undefined || data.mode === mode;
}
