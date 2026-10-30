import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import type { SubAccountDoc } from "@/types";

/**
 * Who a usage invoice goes to, and whose email Paystack opens a payment page
 * for: the workspace's account contact, else an active admin who isn't the
 * agency owner. Null = nobody to email.
 */
export async function billingRecipient(sub: SubAccountDoc): Promise<string | null> {
  const contact = sub.accountContact?.email?.trim();
  if (contact && contact.includes("@")) return contact;
  const db = getAdminDb();
  const agency = sub.agencyId ? (await db.doc(`agencies/${sub.agencyId}`).get()).data() : null;
  const members = await db
    .collection(`subAccounts/${sub.id}/subAccountMembers`)
    .where("role", "==", "admin")
    .get();
  const admin = members.docs
    .map((d) => d.data() as { uid?: string; email?: string; status?: string })
    .find((m) => m.status === "active" && m.uid !== agency?.ownerUid && m.email?.includes("@"));
  return admin?.email ?? null;
}
