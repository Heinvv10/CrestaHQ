import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { toMillis } from "@/lib/server/usage-billing-shared";
import type { SubAccountDoc } from "@/types";

/**
 * Who a usage invoice goes to, and whose email Paystack opens a payment page
 * for. Deterministic, and never agency staff:
 *   1. the workspace's account contact;
 *   2. else the earliest-added ACTIVE admin member of the workspace who is not
 *      an agency user (not the agency owner, no `agencyMembers` row).
 * Null when neither exists, and also when the admin choice is not cleanly
 * determinable (a candidate with no readable `addedAt`): the caller refuses
 * rather than guess. Ties on `addedAt` break on uid.
 */
export async function billingRecipient(sub: SubAccountDoc): Promise<string | null> {
  // A stored value that isn't a string is absent, never a crash.
  const contact = typeof sub.accountContact?.email === "string" ? sub.accountContact.email.trim() : "";
  if (contact.includes("@")) return contact;
  if (!sub.agencyId) return null;

  const db = getAdminDb();
  const [agency, members] = await Promise.all([
    db.doc(`agencies/${sub.agencyId}`).get(),
    db.collection(`subAccounts/${sub.id}/subAccountMembers`).where("role", "==", "admin").get(),
  ]);
  const ownerUid = agency.data()?.ownerUid;
  const admins = members.docs
    .map((d) => d.data() as { uid?: string; email?: unknown; status?: string; addedAt?: unknown })
    .filter((m): m is typeof m & { uid: string; email: string } =>
      m.status === "active" && typeof m.uid === "string" && !!m.uid && m.uid !== ownerUid &&
      typeof m.email === "string" && m.email.trim().includes("@"));
  const agencyUser = await Promise.all(
    admins.map(async (m) => (await db.doc(`agencies/${sub.agencyId}/agencyMembers/${m.uid}`).get()).exists),
  );
  const clients = admins
    .filter((_, i) => !agencyUser[i])
    .map((m) => ({ uid: m.uid, email: m.email.trim(), addedMs: toMillis(m.addedAt) }));
  if (clients.some((c) => c.addedMs === null)) return null;
  clients.sort((a, b) => (a.addedMs as number) - (b.addedMs as number) || a.uid.localeCompare(b.uid));
  return clients[0]?.email ?? null;
}
