import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
  updateDoc,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import type { SmartListDoc } from "@/types/contacts";
import type { ConditionGroup } from "@/types/workflows";
import type { TenantScope } from "@/types";

/**
 * Client-side CRUD for saved smart lists. Member-writable in
 * firestore.rules (same as contact notes) — there is no server route.
 */
function listsRef(subAccountId: string) {
  return collection(getFirebaseDb(), "subAccounts", subAccountId, "smartLists");
}

export function subscribeToSmartLists(
  subAccountId: string,
  callback: (lists: SmartListDoc[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  return onSnapshot(
    listsRef(subAccountId),
    (snap) => {
      const list = snap.docs.map(
        (d) => ({ id: d.id, ...(d.data() as Omit<SmartListDoc, "id">) }),
      );
      list.sort((a, b) => a.name.localeCompare(b.name));
      callback(list);
    },
    (err) => onError?.(err),
  );
}

export async function createSmartList(
  scope: TenantScope,
  createdByUid: string,
  name: string,
  filters: ConditionGroup,
): Promise<string> {
  const ref = await addDoc(listsRef(scope.subAccountId), {
    name,
    filters,
    agencyId: scope.agencyId,
    subAccountId: scope.subAccountId,
    createdByUid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

export async function renameSmartList(
  subAccountId: string,
  id: string,
  name: string,
): Promise<void> {
  await updateDoc(doc(listsRef(subAccountId), id), {
    name,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteSmartList(
  subAccountId: string,
  id: string,
): Promise<void> {
  await deleteDoc(doc(listsRef(subAccountId), id));
}
