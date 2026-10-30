import "server-only";

import { createHmac, randomBytes } from "node:crypto";
import type Stripe from "stripe";

import { mapStripeSessionError } from "@/lib/stripe/session-error";
import { centsToStripeAmount } from "@/lib/stripe/amount";
import { createCheckoutSessionForSubAccount } from "@/lib/stripe/sub-account-client";
import { createPendingOrder } from "@/lib/server/orders-service";
import { attachCheckoutSession, isOrderAwaitingPayment } from "@/lib/server/product-link-orders";
import {
  deliverySnapshots,
  mintThanksToken,
  type BuyContext,
} from "@/lib/server/product-buy-service";
import type { OrderLineItem } from "@/types/orders";

/**
 * The money half of the express buy session route
 * (`POST /api/co/[sa]/buy/[slug]/session`), after the route's own checks.
 *
 * Order of work: pending order (amount and currency from the product doc) →
 * Stripe Checkout Session (order id in the metadata) → session id onto the
 * order → URL. The order is written BEFORE the provider call, so no session
 * exists without a row, and the URL reaches the buyer only once the order
 * knows its session. Any failure after the order is written closes it
 * (`failed`), so it can never be paid.
 */

export type SessionResult =
  | { ok: true; url: string; orderId: string }
  | { ok: false; status: number; error: string };

export const PAYMENTS_DOWN = "Payments are temporarily unavailable. Please try again later.";

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The session never opened (or its order can't be linked to it): close it. */
async function markUnpayable(orderId: string): Promise<void> {
  try {
    await attachCheckoutSession(orderId, null);
  } catch (err) {
    // It stays pending with no session id: unpayable (the buyer never got
    // a URL), just untidy.
    console.error(`[buy/session] could not close order=${orderId}: ${errMsg(err)}`);
  }
}

export async function openProductLinkSession(
  buy: BuyContext,
  subAccountId: string,
  slug: string,
): Promise<SessionResult> {
  const { product, agencyId } = buy;
  const currency = product.currency.toLowerCase();
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
      currency,
      lineItems,
      // Set by attachCheckoutSession once Stripe returns the session.
      stripeCheckoutSessionId: "",
      livemode: false,
      buyerEmail: null,
      buyerName: null,
      attribution: null,
      productLinkProductId: product.id,
      deliveries: deliverySnapshots([product]),
      thanksTokenHash: thanks.hash,
    });
  } catch (err) {
    // An unrecorded payment is worse than a failed checkout, so refuse.
    console.error(`[buy/session] pending order write failed sa=${subAccountId}: ${errMsg(err)}`);
    return { ok: false, status: 500, error: PAYMENTS_DOWN };
  }

  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  const buyPath = `${base}/co/${subAccountId}/buy/${slug}`;
  const description = (product.publicDescription || product.description || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  const promise =
    product.delivery?.type === "download"
      ? "Your download link appears right after payment."
      : null;

  let session: Stripe.Checkout.Session;
  try {
    session = await createCheckoutSessionForSubAccount({
      subAccountId,
      params: {
        mode: "payment",
        line_items: lineItems.map((li) => ({
          quantity: li.quantity,
          price_data: {
            currency,
            unit_amount: centsToStripeAmount(li.unitPriceCents, currency),
            product_data: {
              name: li.name,
              ...(description ? { description } : {}),
            },
          },
        })),
        submit_type: "pay",
        locale: "auto",
        name_collection: { individual: { enabled: true } },
        ...(promise ? { custom_text: { submit: { message: promise } } } : {}),
        success_url: `${buyPath}/thanks?order=${orderId}&t=${thanks.token}`,
        cancel_url: `${buyPath}?cancelled=1`,
        metadata: {
          leadstackSubAccountId: subAccountId,
          leadstackProductId: product.id,
          leadstackOrderId: orderId,
        },
      },
    });
  } catch (err) {
    const mapped = mapStripeSessionError(err);
    console.error(`[buy/session] stripe session failed sa=${subAccountId} — ${mapped.logDetail}`);
    await markUnpayable(orderId);
    return { ok: false, status: mapped.status, error: mapped.buyerMessage };
  }

  if (!session.url) {
    await markUnpayable(orderId);
    return { ok: false, status: 502, error: PAYMENTS_DOWN };
  }

  try {
    if (!(await attachCheckoutSession(orderId, { id: session.id, livemode: session.livemode }))) {
      throw new Error("order no longer pending");
    }
  } catch (err) {
    console.error(`[buy/session] attach session failed sa=${subAccountId} order=${orderId}: ${errMsg(err)}`);
    await markUnpayable(orderId);
    return { ok: false, status: 500, error: PAYMENTS_DOWN };
  }

  return { ok: true, url: session.url, orderId };
}

// ── Double-click dedupe ─────────────────────────────────────────────────────
// One buyer (IP) asking for the same product again within a minute gets the
// session already opened for them while its order still awaits payment,
// rather than a second pending order and a second live Stripe session.
// In-memory, like the checkout rate limiter: a double click lands on the one
// serving instance, and a restart only costs a duplicate pending order. The
// key is an HMAC under a per-process random salt, so no IP is kept.

const DEDUPE_MS = 60_000;
const MAX_TRACKED = 5_000;
const SALT = randomBytes(32);
const recent = new Map<string, { at: number; result: Promise<SessionResult> }>();

export function buyerKey(subAccountId: string, productId: string, ip: string): string {
  return createHmac("sha256", SALT).update(`${subAccountId}\n${productId}\n${ip}`).digest("hex");
}

export async function dedupedSession(
  key: string,
  open: () => Promise<SessionResult>,
): Promise<SessionResult> {
  const now = Date.now();
  if (recent.size > MAX_TRACKED) {
    for (const [k, v] of recent) if (now - v.at > DEDUPE_MS) recent.delete(k);
    if (recent.size > MAX_TRACKED) recent.clear();
  }
  const prior = recent.get(key);
  if (prior && now - prior.at < DEDUPE_MS) {
    const r = await prior.result;
    if (r.ok && (await isOrderAwaitingPayment(r.orderId))) return r;
  }
  // Set before the first await so a concurrent duplicate finds this one.
  const result = open();
  recent.set(key, { at: Date.now(), result });
  return result;
}
