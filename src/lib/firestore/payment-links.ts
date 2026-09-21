import {
  collection,
  onSnapshot,
  query,
  where,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import type { PaymentLink } from "@/types/payment-links";

/**
 * Client-side subscription to a sub-account's Paystack payment links.
 *
 * Read-only: `paymentLinks` is `allow write: if false`. Creation and
 * deactivation go through `/api/sub-accounts/[id]/payment-links`.
 *
 * Single equality filter, sorted in memory — no composite index, same as
 * `subscribeToOrders`.
 */
export function subscribeToPaymentLinks(
  subAccountId: string,
  callback: (links: PaymentLink[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = query(
    collection(getFirebaseDb(), "paymentLinks"),
    where("subAccountId", "==", subAccountId),
  );
  return onSnapshot(
    q,
    (snap) => {
      const links = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<PaymentLink, "id">),
      }));
      const ms = (l: PaymentLink) =>
        (l.createdAt as { toMillis?: () => number })?.toMillis?.() ?? 0;
      links.sort((a, b) => ms(b) - ms(a));
      callback(links);
    },
    (err) => onError?.(err),
  );
}
