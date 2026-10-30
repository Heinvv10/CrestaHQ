import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured } from "@/lib/comms/resend";
import { isHexColor } from "@/lib/hex-color";
import { isSafeSocialUrl } from "@/lib/website/premium";
import { isDocId } from "@/lib/server/doc-id";
import { isSellableProduct, sellOnlinePriceError } from "@/lib/products/sell-online";
import { chooseProductPayRail, type ProductPayRail } from "@/lib/products/pay-rail";
import {
  checkCheckoutPage,
  checkDeliveryTargets,
  SellOnlineError,
} from "@/lib/server/products-sell-online-service";
import type { Order, OrderDeliverySnapshot } from "@/types/orders";
import type { Product } from "@/types/products";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * Shared by the express buy page, its session route and its thanks page
 * (/co/[subAccountId]/buy/[slug]). Everything about money and links is read
 * from Firestore, never from the request.
 *
 * F1 checks a product only when it is saved, and the world moves after it, so
 * `loadBuyContext` re-checks all of it from the stored docs at render AND at
 * session time: the agency gate, a pay rail for the currency right now, the
 * price rules, a checkout page that still sells this product, and a community
 * delivery whose group (and course) still exists with Community on.
 */

export interface BuyBrand {
  name: string;
  logoUrl: string | null;
  accent: string;
}

export interface BuyContext {
  sub: Partial<SubAccountDoc>;
  agencyId: string;
  product: Product;
  brand: BuyBrand;
  rail: ProductPayRail;
  /** Set when the product's Buy button goes to a published checkout page. */
  checkoutPageSlug: string | null;
}

const DEFAULT_BUY_ACCENT = "#4f46e5";
const PRODUCT_SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;
const CHECKOUT_SLUG = /^[a-z0-9][a-z0-9-]{0,199}$/;

async function loadBrand(
  subAccountId: string,
  sub: Partial<SubAccountDoc>,
): Promise<BuyBrand> {
  let accent = DEFAULT_BUY_ACCENT;
  try {
    // Seeded from the website's primary colour at publish, so the buy page
    // matches the site the buyer just left.
    const chat = await getAdminDb()
      .doc(`subAccounts/${subAccountId}/aiAgent/web-chat`)
      .get();
    const c = chat.data()?.webChat?.accentColor;
    if (isHexColor(c)) accent = c;
  } catch (err) {
    // Cosmetic only: the default accent is fine.
    console.warn(
      `[buy] accent read failed sa=${subAccountId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const logo =
    typeof sub.logoUrl === "string" && isSafeSocialUrl(sub.logoUrl) ? sub.logoUrl : null;
  const name = typeof sub.name === "string" && sub.name.trim() ? sub.name.trim().slice(0, 120) : "Checkout";
  return { name, logoUrl: logo, accent };
}

/** The sub-account doc, or null for a malformed id or a missing doc. */
async function readSub(subAccountId: string): Promise<Partial<SubAccountDoc> | null> {
  if (!isDocId(subAccountId)) return null;
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  return snap.exists ? (snap.data() as Partial<SubAccountDoc>) : null;
}

/** Null = not for sale right now (the caller shows a friendly page or 404s). */
export async function loadBuyContext(
  subAccountId: string,
  slug: string,
): Promise<BuyContext | null> {
  if (typeof slug !== "string" || !PRODUCT_SLUG.test(slug)) return null;
  const sub = await readSub(subAccountId);
  if (!sub?.agencyId) return null;
  // Every buyer must get a confirmation email, so no sales without email.
  if (!emailIsConfigured(sub)) return null;

  const db = getAdminDb();
  // Slug uniqueness is a query at save time, not a claim doc, so two saves
  // can collide. Fail closed: an ambiguous slug sells nothing.
  const snap = await db
    .collection("products")
    .where("subAccountId", "==", subAccountId)
    .where("slug", "==", slug)
    .limit(2)
    .get();
  if (snap.size !== 1) return null;
  const product = { id: snap.docs[0].id, ...(snap.docs[0].data() as Omit<Product, "id">) };
  if (product.subAccountId !== subAccountId || !isSellableProduct(product)) return null;
  if (sellOnlinePriceError(product.unitPriceCents, product.currency) !== null) return null;
  const rail = chooseProductPayRail(sub, product.currency);
  if (!rail.ok) return null;

  try {
    if (product.delivery) await checkDeliveryTargets(db, subAccountId, sub, product.delivery);
  } catch (err) {
    if (err instanceof SellOnlineError) return null;
    throw err;
  }

  let checkoutPageSlug: string | null = null;
  if (product.checkoutPageId && isDocId(product.checkoutPageId)) {
    try {
      await checkCheckoutPage(db, subAccountId, product.checkoutPageId, product.id);
      const page = await db
        .doc(`subAccounts/${subAccountId}/checkoutPages/${product.checkoutPageId}`)
        .get();
      const pageSlug = page.data()?.slug;
      if (typeof pageSlug === "string" && CHECKOUT_SLUG.test(pageSlug)) checkoutPageSlug = pageSlug;
    } catch (err) {
      // The page was unpublished, deleted or re-pointed: never send the buyer
      // there. The product itself is still for sale through the express page.
      if (!(err instanceof SellOnlineError)) throw err;
    }
  }

  return {
    sub,
    agencyId: sub.agencyId,
    product,
    brand: await loadBrand(subAccountId, sub),
    rail: rail.rail,
    checkoutPageSlug,
  };
}

/**
 * False while the sale needs a path this build doesn't have yet: the Paystack
 * rail (unit F3) or granting community access (unit F4). The page says "not
 * available yet" and the session route answers 503 — no order, no session.
 */
export function canBuyExpressNow(buy: BuyContext): boolean {
  return buy.rail === "stripe" && buy.product.delivery?.type !== "community";
}

/** Brand for pages that must render even when the product is unavailable. */
export async function loadBuyBrand(subAccountId: string): Promise<BuyBrand> {
  const sub = await readSub(subAccountId);
  return loadBrand(subAccountId, sub ?? {});
}

export function deliverySnapshots(products: Product[]): OrderDeliverySnapshot[] {
  const out: OrderDeliverySnapshot[] = [];
  for (const p of products) {
    const d = p.delivery;
    if (d && d.type !== "none") out.push({ productId: p.id, delivery: d });
  }
  return out;
}

// ── Thanks-page token ───────────────────────────────────────────────────────
// The thanks URL carries the order id and a random token; only the token's
// hash is stored on the order. Without the token the page shows nothing about
// the order, so one buyer's link (or a guessed order id) never reveals
// another buyer's order.

const THANKS_TOKEN = /^[A-Za-z0-9_-]{43}$/;

const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");

export function mintThanksToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: sha256Hex(token) };
}

/**
 * The product_link order this thanks link names, or null when the id, the
 * tenant or the token doesn't match. Paid state is the order's own status:
 * the page never trusts the URL for it.
 */
export async function loadThanksOrder(
  subAccountId: string,
  orderId: unknown,
  token: unknown,
): Promise<Order | null> {
  if (!isDocId(subAccountId) || !isDocId(orderId)) return null;
  if (typeof token !== "string" || !THANKS_TOKEN.test(token)) return null;
  const snap = await getAdminDb().doc(`orders/${orderId}`).get();
  if (!snap.exists) return null;
  const order = { id: snap.id, ...(snap.data() as Omit<Order, "id">) };
  if (order.subAccountId !== subAccountId || order.source !== "product_link") return null;
  const stored = order.thanksTokenHash;
  if (typeof stored !== "string" || !/^[0-9a-f]{64}$/.test(stored)) return null;
  const ok = timingSafeEqual(Buffer.from(sha256Hex(token), "hex"), Buffer.from(stored, "hex"));
  return ok ? order : null;
}
