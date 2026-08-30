import {
  collection,
  onSnapshot,
  query,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import type { Funnel } from "@/types/funnels";

/**
 * Client-side subscription to a sub-account's funnels (Labs experiment).
 *
 * Read-only — writes go through /api/sub-accounts/[id]/funnels/* so the slug
 * uniqueness check and the video host allow-list can't be bypassed. The
 * subcollection path is the tenancy boundary, so no `where` and no index.
 */
export function subscribeToFunnels(
  subAccountId: string,
  callback: (funnels: Funnel[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = query(
    collection(getFirebaseDb(), `subAccounts/${subAccountId}/funnels`),
  );
  return onSnapshot(
    q,
    (snap) => {
      const funnels = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<Funnel, "id">),
      }));
      funnels.sort((a, b) => a.name.localeCompare(b.name));
      callback(funnels);
    },
    (err) => onError?.(err),
  );
}
