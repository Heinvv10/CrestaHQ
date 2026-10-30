import {
  addDoc,
  collection,
  limit,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import type { ActivityType } from "@/types/contacts";
import type { ActivityDoc, ActivityMeta } from "@/types/activities";

const CONTACTS = "contacts";
const ACTIVITIES = "activities";

export async function addActivity(
  contactId: string,
  payload: {
    type: ActivityType;
    content: string;
    createdBy: string;
    meta?: ActivityMeta;
  },
): Promise<string> {
  const ref = await addDoc(
    collection(getFirebaseDb(), CONTACTS, contactId, ACTIVITIES),
    {
      type: payload.type,
      content: payload.content,
      createdBy: payload.createdBy,
      meta: payload.meta ?? null,
      createdAt: serverTimestamp(),
    },
  );
  return ref.id;
}

export function subscribeToActivities(
  contactId: string,
  callback: (activities: ActivityDoc[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  // Capped — a long-lived contact accrues hundreds of rows and Firestore
  // bills per document read on every profile open.
  const q = query(
    collection(getFirebaseDb(), CONTACTS, contactId, ACTIVITIES),
    orderBy("createdAt", "desc"),
    limit(50),
  );
  return onSnapshot(
    q,
    (snap) => {
      callback(
        snap.docs.map(
          (d) => ({ id: d.id, ...(d.data() as Omit<ActivityDoc, "id">) }),
        ),
      );
    },
    (err) => onError?.(err),
  );
}
