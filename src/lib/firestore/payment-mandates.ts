import {
  collection,
  onSnapshot,
  query,
  where,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import type { PaymentMandate } from "@/types/payment-mandates";

/**
 * Client-side subscription to one contact's saved cards. Reads the display
 * doc only — the authorization under `private/` is unreadable to clients.
 * Revoking goes through `/api/sub-accounts/[id]/payment-mandates/[id]/revoke`.
 *
 * Two equality filters, sorted in memory — no composite index, same as
 * `subscribeToQuotesForContact`.
 */
export function subscribeToContactMandates(
  subAccountId: string,
  contactId: string,
  callback: (mandates: PaymentMandate[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = query(
    collection(getFirebaseDb(), "paymentMandates"),
    where("subAccountId", "==", subAccountId),
    where("contactId", "==", contactId),
  );
  return onSnapshot(
    q,
    (snap) => {
      const mandates = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<PaymentMandate, "id">),
      }));
      const ms = (m: PaymentMandate) =>
        (m.createdAt as { toMillis?: () => number })?.toMillis?.() ?? 0;
      mandates.sort((a, b) => ms(b) - ms(a));
      callback(mandates);
    },
    (err) => onError?.(err),
  );
}
