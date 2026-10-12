import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { isReachable } from "@/lib/api/agent-reach";
import { isDocId } from "@/lib/server/doc-id";
import { CapabilityUserError, type AiSuiteActionContext } from "./types";

/** Shared by the agency-level capabilities (agency.ts). */

/**
 * list_sub_accounts' rows. An agent key lists only what it can reach,
 * filtered BEFORE the 50-row cap, and is told when the cap cut the list;
 * chat lists the first 50 of `mine` (the caller's agency), gates or not.
 */
export async function subAccountsToList(
  mine: FirebaseFirestore.Query,
  ctx: Pick<AiSuiteActionContext, "agencyId" | "apiKey">,
): Promise<{ docs: FirebaseFirestore.QueryDocumentSnapshot[]; count: string; truncated: boolean }> {
  if (!ctx.apiKey) {
    const docs = (await mine.limit(50).get()).docs;
    return { docs, count: String(docs.length), truncated: false };
  }
  const reachable = (await mine.get()).docs.filter((d) => isReachable(d.data(), ctx.agencyId));
  const docs = reachable.slice(0, 50);
  const truncated = reachable.length > docs.length;
  return { docs, count: truncated ? `showing ${docs.length} of ${reachable.length}` : String(docs.length), truncated };
}

/** A `subAccountId` with surrounding spaces is refused, never trimmed: an
 *  agent call's reach was checked on the id as sent (resolveReach refuses
 *  padded ids too). Null when the id is exact, absent or blank. */
export function paddedSubAccountId(raw: unknown): { ok: false; error: string } | null {
  const sent = (raw as Record<string, unknown> | null)?.subAccountId;
  return typeof sent === "string" && sent.trim() && sent !== sent.trim()
    ? { ok: false, error: "the sub-account id must be exactly as list_sub_accounts returned it, with no surrounding spaces" }
    : null;
}

/** The sub-account `id` names when it is one of `agencyId`'s, else the one
 *  not-found refusal. A value that is not a doc id is never read. */
export async function subAccountInAgency(agencyId: string, id: unknown): Promise<FirebaseFirestore.DocumentSnapshot> {
  const snap = isDocId(id) ? await getAdminDb().doc(`subAccounts/${id}`).get() : null;
  if (!snap?.exists || snap.data()?.agencyId !== agencyId) {
    throw new CapabilityUserError("That sub-account wasn't found in this agency.");
  }
  return snap;
}
