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
 * Paid (or only partly refunded), not held, and not flagged for a person. A
 * resolved flag (`attentionOpen === false`) no longer blocks, so staff can
 * re-send once they have looked.
 */
export function orderDeliverable(
  order: Pick<Order, "source" | "status" | "heldAt" | "attention" | "attentionOpen">,
): boolean {
  if (!orderDelivers(order)) return false;
  if (order.status !== "paid" && order.status !== "partially_refunded") return false;
  if (order.heldAt) return false;
  if (order.attention && order.attentionOpen !== false) return false;
  return true;
}
