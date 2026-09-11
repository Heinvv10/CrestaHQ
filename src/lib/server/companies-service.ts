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
 * Delete a company and null `companyId` on every contact in the SAME
 * sub-account that pointed at it. Scoped by `subAccountId` (not just the
 * company id) so a foreign tenant's contact that somehow carries this id is
 * never written to. The contacts keep their free-text `company` string —
 * the name is still true, only the link is gone. Batches are chunked at
 * Firestore's 500-write limit; the company doc goes in the last chunk.
 * Returns how many contacts were unlinked.
 */
export async function deleteCompanyAndUnlinkContacts(
  db: FirebaseFirestore.Firestore,
  companyId: string,
  subAccountId: string,
): Promise<number> {
  const linked = await db
    .collection("contacts")
    .where("subAccountId", "==", subAccountId)
    .where("companyId", "==", companyId)
    .get();
  const refs = linked.docs.map((d) => d.ref);
  // 499 contacts + the company delete fit one batch.
  const CHUNK = 499;
  for (let i = 0; i < refs.length; i += CHUNK) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + CHUNK)) {
      batch.update(ref, { companyId: null });
    }
    if (i + CHUNK >= refs.length) batch.delete(db.doc(`companies/${companyId}`));
    await batch.commit();
  }
  if (refs.length === 0) {
    const batch = db.batch();
    batch.delete(db.doc(`companies/${companyId}`));
    await batch.commit();
  }
  return refs.length;
}
