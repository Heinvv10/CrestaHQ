import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { isDocId } from "@/lib/server/doc-id";
import { agentEditStamp } from "@/lib/server/agent-edit-stamp";
import type { AgentActor } from "@/lib/workflows/agent-hold";
import type { CompanyFormData } from "@/types/companies";

/**
 * Server half of companies. The dashboard creates/updates/lists through the
 * client SDK under the `companies` rules block; the Admin SDK paths here are
 * a cross-doc batch, a tenancy check on the link, and create/update for API
 * agents — which write the same doc shape as lib/firestore/companies.ts.
 * Companies fire no workflow triggers or webhooks.
 */

/** Create a company exactly as the dashboard's createCompany does. */
export async function createCompanyServerSide(input: {
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  data: CompanyFormData;
  /** An API agent's write: stamped (see agentEditStamp). */
  actor?: Pick<AgentActor, "keyPrefix">;
}): Promise<string> {
  const ref = getAdminDb().collection("companies").doc();
  await ref.set({
    ...input.data,
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    createdByUid: input.createdByUid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    ...agentEditStamp(input.actor),
  });
  return ref.id;
}

/**
 * Patch a company as the dashboard's updateCompany does (the company doc
 * only: linked contacts keep the name copied at link time). Returns false
 * when the company is missing or in another sub-account; the check and the
 * write share one transaction.
 */
export async function updateCompanyServerSide(opts: {
  companyId: string;
  subAccountId: string;
  data: Partial<CompanyFormData>;
  /** An API agent's write: stamped (see agentEditStamp). */
  actor?: Pick<AgentActor, "keyPrefix">;
}): Promise<boolean> {
  if (!isDocId(opts.companyId)) return false;
  const db = getAdminDb();
  const ref = db.doc(`companies/${opts.companyId}`);
  return db.runTransaction(async (tx) => {
    const current = (await tx.get(ref)).data();
    if (!current || current.subAccountId !== opts.subAccountId) return false;
    tx.update(ref, { ...opts.data, updatedAt: FieldValue.serverTimestamp(), ...agentEditStamp(opts.actor) });
    return true;
  });
}

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
