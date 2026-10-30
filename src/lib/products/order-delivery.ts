import type { Order } from "@/types/orders";

/**
 * Whether a paid product order owes its buyer a delivery. Pure (no server
 * imports) so the delivery service, the redeliver route and the Payments
 * report's Re-send button all ask the same question.
 */

/** Only express buy links deliver; invoices, deposits and community orders carry their own effects. */
export function orderDelivers(order: Pick<Order, "source">): boolean {
  return order.source === "product_link";
}

/**
 * Why an order is not owed its delivery right now:
 *  - "withdrawn": it is not paid (refunded, failed, expired, pending), or it is
 *    held. Nothing should be delivered and no entitlement should stay live.
 *  - "review": it is paid and unheld but flagged for a person. Delivery waits;
 *    once the flag is resolved a re-send delivers.
 *  - "none": owed.
 * A resolved flag (`attentionOpen === false`) no longer blocks.
 */
export function deliveryBlock(
  order: Pick<Order, "source" | "status" | "heldAt" | "attention" | "attentionOpen">,
): "none" | "withdrawn" | "review" {
  if (!orderDelivers(order)) return "withdrawn";
  if (order.status !== "paid" && order.status !== "partially_refunded") return "withdrawn";
  if (order.heldAt) return "withdrawn";
  if (order.attention && order.attentionOpen !== false) return "review";
  return "none";
}

/** Whether the order, as it stands, is owed its delivery. */
export function orderDeliverable(
  order: Pick<Order, "source" | "status" | "heldAt" | "attention" | "attentionOpen">,
): boolean {
  return deliveryBlock(order) === "none";
}
