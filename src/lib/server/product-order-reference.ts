import { isDocId } from "@/lib/server/doc-id";

/**
 * `po-{orderId}`: the Paystack reference of an express buy-page order's one
 * checkout (also the id of its `paymentAttempts` doc). One reference per
 * order, because the order is created per click and Paystack refuses a
 * reference it has already seen. Pure, so the session and the reconciler
 * agree on the shape.
 */
export function productOrderReference(orderId: string): string {
  return `po-${orderId}`;
}

export function parseProductOrderReference(reference: string): string | null {
  const id = /^po-([A-Za-z0-9]{1,100})$/.exec(reference)?.[1];
  return id && isDocId(id) ? id : null;
}
