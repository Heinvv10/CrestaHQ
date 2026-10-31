import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import type { Order, OrderDeliverySnapshot } from "@/types/orders";

/**
 * What entitlements-service.ts records about a delivery besides the
 * entitlement itself: the contact's timeline, the wording of "delivered", and
 * the withdrawal of an entitlement whose order stopped being payable.
 */

type Delivery = OrderDeliverySnapshot["delivery"];

export function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The order stopped being payable between the claim and the email: nothing
 * was mailed, so the entitlement is revoked and cannot be re-sent. Access
 * already given stays until staff remove it (as for any refund).
 */
export async function withdraw(
  ref: FirebaseFirestore.DocumentReference,
  order: Order,
  productName: string,
  memberId: string | null,
): Promise<void> {
  try {
    await ref.update({
      status: "revoked",
      revokedAt: FieldValue.serverTimestamp(),
      fulfilment: {
        state: "failed",
        error: "The order was refunded, held or flagged before the email went out.",
        at: Date.now(),
        memberId,
      },
    });
  } catch (err) {
    console.error(`[entitlements] withdraw write failed order=${order.id}: ${reason(err)}`);
  }
  await writeActivity(
    order,
    "delivery_revoked",
    `${productName} was not delivered: the order was refunded, held or flagged before the email went out.`,
  );
}

export function deliveredText(
  productName: string,
  delivery: Delivery,
  email: string,
  inConfirmation: boolean,
): string {
  if (delivery.type === "community") {
    return `Delivered ${productName}: community access granted, sign-in link sent to ${email}.`;
  }
  return inConfirmation
    ? `Delivered ${productName}: download link included in the order confirmation to ${email}.`
    : `Delivered ${productName}: download link sent to ${email}.`;
}

export async function writeActivity(
  order: Pick<Order, "id" | "contactId">,
  type: "product_delivered" | "delivery_failed" | "delivery_revoked",
  content: string,
): Promise<void> {
  if (!order.contactId) return;
  try {
    await getAdminDb()
      .collection(`contacts/${order.contactId}/activities`)
      .add({
        type,
        content: content.slice(0, 500),
        createdBy: "system",
        meta: { orderId: order.id },
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn(`[entitlements] activity write failed order=${order.id}: ${reason(err)}`);
  }
}
