import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { BillingError } from "@/lib/billing/errors";
import { getAdminDb } from "@/lib/firebase/admin";
import { initializePaystackTransaction } from "@/lib/paystack/billing-api";
import { createPendingOrder } from "@/lib/server/orders-service";
import { attachCheckoutSession, openPaystackAttempt } from "@/lib/server/product-link-orders";
import {
  deliverySnapshots,
  mintThanksToken,
  type BuyContext,
} from "@/lib/server/product-buy-service";
import { PAYMENTS_DOWN, type SessionResult } from "@/lib/server/product-buy-session";
import type { OrderLineItem } from "@/types/orders";

/**
 * The Paystack half of the express buy session route
 * (`POST /api/co/[sa]/buy/[slug]/session`), the twin of
 * `openProductLinkSession` for ZAR workspaces on Paystack.
 *
 * Order of work: pending order (amount and currency from the product doc, the
 * buyer's email from the form) → `paymentAttempts/{reference}` with the
 * order's id, and the reference onto the order, in ONE transaction that reads
 * the connection → Paystack's initialize → URL. Both records are committed
 * BEFORE Paystack is called, so no checkout exists without them, and the URL
 * reaches the buyer only once they are. Any failure after the order is
 * written closes it (`failed`) and the attempt (`refused`), so it can never be
 * paid. Nothing here marks anything paid: that is the webhook reconciler
 * (`paystack/product-order-reconciler.ts`).
 */

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function closeOrder(orderId: string): Promise<void> {
  try {
    await attachCheckoutSession(orderId, null);
  } catch (err) {
    // It stays pending with no checkout URL handed out: unpayable, just untidy.
    console.error(`[buy/paystack] could not close order=${orderId}: ${errMsg(err)}`);
  }
}

export async function openProductPaystackSession(
  buy: BuyContext,
  subAccountId: string,
  slug: string,
  email: string,
): Promise<SessionResult> {
  const { product, agencyId } = buy;
  const lineItems: OrderLineItem[] = [
    {
      productId: product.id,
      name: product.name,
      description: product.description ?? "",
      unitPriceCents: product.unitPriceCents,
      quantity: 1,
      isBump: false,
    },
  ];
  const thanks = mintThanksToken();

  let orderId: string;
  try {
    orderId = await createPendingOrder({
      agencyId,
      subAccountId,
      contactId: null,
      checkoutPageId: null,
      source: "product_link",
      currency: product.currency.toLowerCase(),
      lineItems,
      // Paystack has no Checkout Session: the order's `paystackReference` is
      // its checkout, set with the attempt below.
      stripeCheckoutSessionId: "",
      // Set from the connection's key when the attempt is written.
      livemode: false,
      buyerEmail: email,
      buyerName: null,
      attribution: null,
      productLinkProductId: product.id,
      deliveries: deliverySnapshots([product]),
      thanksTokenHash: thanks.hash,
    });
  } catch (err) {
    // An unrecorded payment is worse than a failed checkout, so refuse.
    console.error(`[buy/paystack] pending order write failed sa=${subAccountId}: ${errMsg(err)}`);
    return { ok: false, status: 500, error: PAYMENTS_DOWN };
  }

  let opened: Awaited<ReturnType<typeof openPaystackAttempt>>;
  try {
    opened = await openPaystackAttempt(orderId, product.createdByUid);
  } catch (err) {
    console.error(`[buy/paystack] attempt write failed sa=${subAccountId} order=${orderId}: ${errMsg(err)}`);
    await closeOrder(orderId);
    return { ok: false, status: 500, error: PAYMENTS_DOWN };
  }
  if (!opened.ok) {
    console.error(`[buy/paystack] not opened sa=${subAccountId} order=${orderId}: ${opened.reason}`);
    await closeOrder(orderId);
    return { ok: false, status: 503, error: PAYMENTS_DOWN };
  }

  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  try {
    const { url } = await initializePaystackTransaction({
      email,
      amountCents: product.unitPriceCents,
      currency: product.currency,
      // Paystack sends the buyer back here. The page only reads the order's
      // state; it is the webhook that marks it paid.
      callbackUrl: `${base}/co/${subAccountId}/buy/${slug}/thanks?order=${orderId}&t=${thanks.token}`,
      reference: opened.reference,
      metadata: { orderId, subAccountId, productId: product.id },
      displayName: product.name,
      secretKey: opened.secretKey,
    });
    return { ok: true, url, orderId };
  } catch (err) {
    // Paystack opened no checkout, so nothing can be charged on this
    // reference. If the attempt write fails too it stays open, and at worst a
    // later disconnect flags a checkout that never took money.
    console.error(`[buy/paystack] initialize failed sa=${subAccountId} order=${orderId}: ${errMsg(err)}`);
    await getAdminDb()
      .doc(`paymentAttempts/${opened.reference}`)
      .update({ state: "refused", reason: "Paystack did not open the checkout.", updatedAt: FieldValue.serverTimestamp() })
      .catch((e: unknown) => console.error(`[buy/paystack] attempt ${opened.reference} not marked refused: ${errMsg(e)}`));
    await closeOrder(orderId);
    return { ok: false, status: err instanceof BillingError ? 502 : 500, error: PAYMENTS_DOWN };
  }
}
