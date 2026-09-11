import {
  collection,
  onSnapshot,
  query,
  where,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import type {
  CustomFieldEntity,
  CustomFieldFolder,
} from "@/types/custom-fields";

/**
 * Subscribe to a sub-account's custom-field folders for one entity, ordered
 * by `order`. Writes go through the Admin-SDK routes; read-only for members
 * at the rules level (same as `subscribeToCustomFields`).
 */
export function subscribeToCustomFieldFolders(
  subAccountId: string,
  entity: CustomFieldEntity,
  callback: (folders: CustomFieldFolder[]) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const q = query(
    collection(
      getFirebaseDb(),
      "subAccounts",
      subAccountId,
      "customFieldFolders"
    ),
    where("entity", "==", entity)
  );
  return onSnapshot(
    q,
    (snap) => {
      const list = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<CustomFieldFolder, "id">),
      }));
      list.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
      callback(list);
    },
    (err) => onError?.(err)
  );
}
