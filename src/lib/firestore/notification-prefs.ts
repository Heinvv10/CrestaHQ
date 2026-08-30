import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import type { NotificationPrefsDoc } from "@/types/push";

/**
 * Per-user push-notification preferences at
 * `users/{uid}/settings/notifications` — a `subAccounts` map of
 * subAccountId → enabled. Self-scoped rules allow direct client
 * read/write (same trust level as the users/{uid} profile doc); the send
 * helper is the enforcement point for what a pref can actually turn on
 * (membership + territory are always re-checked server-side at send time).
 *
 * Missing key semantics — see types/push.ts: members default ON, the
 * agency owner (no membership row) defaults OFF.
 */

export async function getNotificationPrefs(
  uid: string,
): Promise<NotificationPrefsDoc> {
  const snap = await getDoc(
    doc(getFirebaseDb(), `users/${uid}/settings/notifications`),
  );
  return (snap.data() as NotificationPrefsDoc | undefined) ?? {};
}

export async function setSubAccountNotificationPref(
  uid: string,
  subAccountId: string,
  enabled: boolean,
): Promise<void> {
  await setDoc(
    doc(getFirebaseDb(), `users/${uid}/settings/notifications`),
    {
      subAccounts: { [subAccountId]: enabled },
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}
