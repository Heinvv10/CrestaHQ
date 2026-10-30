import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import type { Company, CompanyFormData } from "@/types/companies";
import type { TenantScope } from "@/types";

const COMPANIES = "companies";

/**
 * Live list of a sub-account's companies, sorted by name client-side (a
 * single equality clause needs no composite index). Reads and writes go
 * through the client SDK under the `companies` rules block; only delete is
 * a server route, because it has to unlink contacts too.
 */
export function subscribeToCompanies(
  scope: TenantScope,
  callback: (companies: Company[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = query(
    collection(getFirebaseDb(), COMPANIES),
    where("subAccountId", "==", scope.subAccountId),
  );
  return onSnapshot(
    q,
    (snap) => {
      const list = snap.docs.map(
        (d) => ({ id: d.id, ...(d.data() as Omit<Company, "id">) }),
      );
      list.sort((a, b) => a.name.localeCompare(b.name));
      callback(list);
    },
    (err) => onError?.(err),
  );
}

export function subscribeToCompany(
  id: string,
  callback: (company: Company | null) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  return onSnapshot(
    doc(getFirebaseDb(), COMPANIES, id),
    (snap) => {
      if (!snap.exists()) {
        callback(null);
        return;
      }
      callback({ id: snap.id, ...(snap.data() as Omit<Company, "id">) });
    },
    (err) => onError?.(err),
  );
}

export async function createCompany(
  scope: TenantScope,
  createdByUid: string,
  data: CompanyFormData,
): Promise<string> {
  const ref = await addDoc(collection(getFirebaseDb(), COMPANIES), {
    ...data,
    agencyId: scope.agencyId,
    subAccountId: scope.subAccountId,
    createdByUid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

export async function updateCompany(
  id: string,
  data: Partial<CompanyFormData>,
): Promise<void> {
  await updateDoc(doc(getFirebaseDb(), COMPANIES, id), {
    ...data,
    updatedAt: serverTimestamp(),
  });
}
