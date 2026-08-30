import {
  collection,
  doc,
  onSnapshot,
  query,
  where,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import type { CommunityGroup } from "@/types/community";

/**
 * Client-side subscription for the dashboard Community groups list. All writes
 * go through the Admin-SDK routes at /api/sub-accounts/[id]/community/* so the
 * client write path is closed at the rules level. The public /c/ pages fetch
 * server-side via the Admin SDK, so this read stays member-scoped.
 *
 * Single equality filter on `subAccountId` (auto-indexed). Groups per
 * sub-account are bounded; sorting happens client-side.
 */
export function subscribeToCommunityGroups(
  subAccountId: string,
  callback: (groups: CommunityGroup[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = query(
    collection(getFirebaseDb(), `subAccounts/${subAccountId}/communityGroups`),
    where("subAccountId", "==", subAccountId),
  );
  return onSnapshot(
    q,
    (snap) => {
      callback(
        snap.docs.map(
          (d) => ({ id: d.id, ...(d.data() as Omit<CommunityGroup, "id">) }),
        ),
      );
    },
    (err) => onError?.(err),
  );
}

/** Single-group subscription (staff dashboard pages that need the group's
 *  mode/branding without the whole list). */
export function subscribeToCommunityGroup(
  subAccountId: string,
  groupId: string,
  callback: (group: CommunityGroup | null) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  return onSnapshot(
    doc(
      getFirebaseDb(),
      `subAccounts/${subAccountId}/communityGroups/${groupId}`,
    ),
    (snap) => {
      callback(
        snap.exists()
          ? { id: snap.id, ...(snap.data() as Omit<CommunityGroup, "id">) }
          : null,
      );
    },
    (err) => onError?.(err),
  );
}
