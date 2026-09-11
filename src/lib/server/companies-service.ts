import "server-only";

/**
 * Server half of companies. Create/update/list are client-SDK writes under
 * the `companies` rules block; these two helpers are the parts that need
 * the Admin SDK — a cross-doc batch and a tenancy check on the link.
 */

export type CompanyLink =
  | { ok: true; companyId: string; company: string }
  | { ok: false; error: string };

/**
 * Verify `companyId` belongs to `subAccountId` and return the name to copy
 * into `contact.company`. Used by the contact create/update routes so a
 * client can neither link across tenants nor drift the display string.
 */
export async function resolveCompanyLink(
  db: FirebaseFirestore.Firestore,
  subAccountId: string,
  companyId: string,
): Promise<CompanyLink> {
  const snap = await db.doc(`companies/${companyId}`).get();
  const data = snap.data();
  if (!snap.exists || !data || data.subAccountId !== subAccountId) {
    return { ok: false, error: "Company not found" };
  }
  return { ok: true, companyId, company: String(data.name ?? "") };
}

/**
 * Delete a company and null `companyId` on every contact that pointed at
 * it, in one batch. The contacts keep their free-text `company` string —
 * the name is still true, only the link is gone. Returns how many contacts
 * were unlinked.
 */
export async function deleteCompanyAndUnlinkContacts(
  db: FirebaseFirestore.Firestore,
  companyId: string,
): Promise<number> {
  const linked = await db
    .collection("contacts")
    .where("companyId", "==", companyId)
    .get();
  const batch = db.batch();
  for (const d of linked.docs) {
    batch.update(d.ref, { companyId: null });
  }
  batch.delete(db.doc(`companies/${companyId}`));
  await batch.commit();
  return linked.docs.length;
}
