import type { Timestamp, FieldValue } from "firebase/firestore";
import type { OrderDeliverySnapshot } from "@/types/orders";

/**
 * `entitlements/{orderId}_{productId}`: what a paid product order delivered.
 * Top-level with tenancy keys, like `orders`. Written only by the server; the
 * deterministic id is what stops a replayed webhook granting twice.
 */

export type EntitlementStatus = "active" | "revoked";

export type FulfilmentState = "pending" | "sending" | "done" | "failed";

export interface Entitlement {
  id: string;
  agencyId: string;
  subAccountId: string;
  contactId: string | null;
  buyerEmail: string | null;
  orderId: string;
  productId: string;
  productName: string;
  /** Copied from the order, so later product edits don't change it. */
  delivery: OrderDeliverySnapshot["delivery"];
  status: EntitlementStatus;
  fulfilment: {
    state: FulfilmentState;
    error: string | null;
    /** Epoch ms. */
    at: number;
    /** Community deliveries only. */
    memberId?: string | null;
  };
  /** Times the delivery email went out (first send plus staff re-sends). */
  sends: number;
  livemode: boolean;
  createdAt: Timestamp | FieldValue | null;
  revokedAt?: Timestamp | FieldValue | null;
}
