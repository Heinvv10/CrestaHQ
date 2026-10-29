import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import type { Product } from "@/types/products";

/** Quote / invoice statuses still in play: their line items may be edited. */
const OPEN_QUOTE = new Set(["draft", "sent", "viewed", "accepted"]);

export interface ProductSeller {
  kind: "checkout page" | "funnel" | "buy link";
  id: string;
  name: string;
}

type Getter = (q: FirebaseFirestore.Query) => Promise<FirebaseFirestore.QuerySnapshot>;
/** The product as the caller read it (in a transaction, as it read it there). */
type SoldProduct = Pick<Product, "id"> & Partial<Pick<Product, "sellOnline" | "slug">>;

/**
 * The checkout pages (as the offer or an order bump) and funnels that sell a
 * product, and its own buy link while it is on sale (`sellOnline`, whatever
 * the gate says): a change to its price, currency or active flag changes what
 * their buyers pay, and deleting it breaks them. `get` lets a transaction
 * read them; `sellOnline` comes from the caller's own read of the product.
 */
export async function productSellers(subAccountId: string, product: SoldProduct, get: Getter = (q) => q.get()): Promise<ProductSeller[]> {
  const productId = product.id;
  const db = getAdminDb();
  const pages = db.collection(`subAccounts/${subAccountId}/checkoutPages`);
  const [offer, bump, funnels] = await Promise.all([
    get(pages.where("productId", "==", productId)),
    get(pages.where("bumpProductIds", "array-contains", productId)),
    get(db.collection(`subAccounts/${subAccountId}/funnels`).where("productId", "==", productId)),
  ]);
  const byId = new Map<string, ProductSeller>();
  for (const d of [...offer.docs, ...bump.docs]) byId.set(`cp:${d.id}`, { kind: "checkout page", id: d.id, name: String(d.data().name ?? "") });
  for (const d of funnels.docs) byId.set(`fu:${d.id}`, { kind: "funnel", id: d.id, name: String(d.data().name ?? "") });
  if (product.sellOnline === true) byId.set(`bl:${productId}`, { kind: "buy link", id: productId, name: String(product.slug ?? "") });
  return [...byId.values()];
}

/**
 * What a product is used by, for a delete's review: what sells it (a delete
 * would break those) and open quotes / invoices whose line items point at it
 * (they keep their own snapshot of name and price, so they are unaffected).
 */
export async function productUsage(
  subAccountId: string,
  product: SoldProduct,
): Promise<{ checkoutPages: number; funnels: number; onSale: boolean; openQuotes: number }> {
  const [sellers, quotes] = await Promise.all([
    productSellers(subAccountId, product),
    getAdminDb().collection("quotes").where("subAccountId", "==", subAccountId).get(),
  ]);
  const openQuotes = quotes.docs.filter((d) => {
    const q = d.data();
    return (
      OPEN_QUOTE.has(q.status as string) &&
      Array.isArray(q.lineItems) &&
      q.lineItems.some((li: { productId?: unknown }) => li?.productId === product.id)
    );
  }).length;
  return {
    checkoutPages: sellers.filter((s) => s.kind === "checkout page").length,
    funnels: sellers.filter((s) => s.kind === "funnel").length,
    onSale: sellers.some((s) => s.kind === "buy link"),
    openQuotes,
  };
}
