import "server-only";

import { FieldPath } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";

/** Quote / invoice statuses still in play: their line items may be edited. */
const OPEN_QUOTE = new Set(["draft", "sent", "viewed", "accepted"]);

export interface ProductSeller {
  kind: "checkout page" | "funnel" | "buy link";
  id: string;
  name: string;
}

type Getter = (q: FirebaseFirestore.Query) => Promise<FirebaseFirestore.QuerySnapshot>;

/**
 * The checkout pages (as the offer or an order bump) and funnels that sell a
 * product, and its own buy link while it is on sale (`sellOnline`, whatever
 * the gate says): a change to its price, currency or active flag changes what
 * their buyers pay, and deleting it breaks them. `get` lets a transaction
 * read them.
 */
export async function productSellers(subAccountId: string, productId: string, get: Getter = (q) => q.get()): Promise<ProductSeller[]> {
  const db = getAdminDb();
  const pages = db.collection(`subAccounts/${subAccountId}/checkoutPages`);
  const [offer, bump, funnels, online] = await Promise.all([
    get(pages.where("productId", "==", productId)),
    get(pages.where("bumpProductIds", "array-contains", productId)),
    get(db.collection(`subAccounts/${subAccountId}/funnels`).where("productId", "==", productId)),
    get(
      db
        .collection("products")
        .where(FieldPath.documentId(), "==", productId)
        .where("sellOnline", "==", true),
    ),
  ]);
  const byId = new Map<string, ProductSeller>();
  for (const d of [...offer.docs, ...bump.docs]) byId.set(`cp:${d.id}`, { kind: "checkout page", id: d.id, name: String(d.data().name ?? "") });
  for (const d of funnels.docs) byId.set(`fu:${d.id}`, { kind: "funnel", id: d.id, name: String(d.data().name ?? "") });
  for (const d of online.docs) byId.set(`bl:${d.id}`, { kind: "buy link", id: d.id, name: String(d.data().slug ?? "") });
  return [...byId.values()];
}

/**
 * What a product is used by, for a delete's review: what sells it (a delete
 * would break those) and open quotes / invoices whose line items point at it
 * (they keep their own snapshot of name and price, so they are unaffected).
 */
export async function productUsage(
  subAccountId: string,
  productId: string,
): Promise<{ checkoutPages: number; funnels: number; onSale: boolean; openQuotes: number }> {
  const [sellers, quotes] = await Promise.all([
    productSellers(subAccountId, productId),
    getAdminDb().collection("quotes").where("subAccountId", "==", subAccountId).get(),
  ]);
  const openQuotes = quotes.docs.filter((d) => {
    const q = d.data();
    return (
      OPEN_QUOTE.has(q.status as string) &&
      Array.isArray(q.lineItems) &&
      q.lineItems.some((li: { productId?: unknown }) => li?.productId === productId)
    );
  }).length;
  return {
    checkoutPages: sellers.filter((s) => s.kind === "checkout page").length,
    funnels: sellers.filter((s) => s.kind === "funnel").length,
    onSale: sellers.some((s) => s.kind === "buy link"),
    openQuotes,
  };
}
