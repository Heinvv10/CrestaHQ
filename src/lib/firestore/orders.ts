import {
  collection,
  onSnapshot,
  query,
  where,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import type { Order } from "@/types/orders";

/**
 * Client-side subscription to a sub-account's orders (Payments v1).
 *
 * Read-only by design — `orders` is `allow write: if false` in rules. Every
 * mutation goes through lib/server/orders-service.ts, because an order's
 * status is a statement about money Stripe confirmed, not something a browser
 * may assert.
 *
 * Single equality filter, so no composite index is needed for this query; the
 * two `orders` composites exist for the status-filtered + date-sorted reads.
 * Sorting happens in memory — report ranges are small and it avoids forcing a
 * `createdAt` index on a collection that may be empty for most tenants.
 */
export function subscribeToOrders(
  subAccountId: string,
  callback: (orders: Order[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = query(
    collection(getFirebaseDb(), "orders"),
    where("subAccountId", "==", subAccountId),
  );
  return onSnapshot(
    q,
    (snap) => {
      const orders = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<Order, "id">),
      }));
      callback(orders);
    },
    (err) => onError?.(err),
  );
}
