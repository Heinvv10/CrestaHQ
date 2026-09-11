import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";

/**
 * Server-side twin of the `assigneeIsMemberOrNull` rule: an assignee is
 * either null or an ACTIVE row under the sub-account's members. Routes
 * that write `assignedToUid` through the Admin SDK (rules bypass) call
 * this so the API cannot store what the client SDK would be refused.
 */
export async function isAssignableMember(
  subAccountId: string,
  uid: string,
): Promise<boolean> {
  const snap = await getAdminDb()
    .doc(`subAccounts/${subAccountId}/subAccountMembers/${uid}`)
    .get();
  return snap.exists && snap.data()?.status === "active";
}

/**
 * Read `assignedToUid` off a request body: `undefined` when the field was
 * not sent (leave unchanged), `null` to unassign, a string to assign.
 * Anything else reads as "not sent".
 */
export function parseAssignedToUid(
  body: Record<string, unknown>,
): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(body, "assignedToUid")) return undefined;
  const v = body.assignedToUid;
  if (v === null) return null;
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
