import {
  collection,
  onSnapshot,
  query,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import type { CheckoutPage } from "@/types/checkout-pages";

/**
 * Client-side subscription to a sub-account's checkout pages.
 *
 * Writes go through `/api/sub-accounts/[id]/checkout-pages/*` (Admin SDK) so
 * product/currency/slug validation can't be bypassed. The browser only reads —
 * same split as products and bookingPages.
 *
 * No `where` clause needed: the subcollection path is already the tenancy
 * boundary, so this needs no composite index.
 */
export function subscribeToCheckoutPages(
  subAccountId: string,
  callback: (pages: CheckoutPage[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = query(
    collection(getFirebaseDb(), `subAccounts/${subAccountId}/checkoutPages`),
  );
  return onSnapshot(
    q,
    (snap) => {
      const pages = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<CheckoutPage, "id">),
      }));
      pages.sort((a, b) => a.name.localeCompare(b.name));
      callback(pages);
    },
    (err) => onError?.(err),
  );
}
