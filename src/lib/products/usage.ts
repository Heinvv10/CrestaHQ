import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";

/** Quote / invoice statuses still in play: their line items may be edited. */
const OPEN_QUOTE = new Set(["draft", "sent", "viewed", "accepted"]);

/**
 * What a product is used by, for a delete's review: checkout pages that sell
 * it (as the offer or a bump) and funnels that picked it — a delete would
 * break those — and open quotes / invoices whose line items point at it
 * (they keep their own snapshot of name and price, so they are unaffected).
 */
export async function productUsage(
  subAccountId: string,
  productId: string,
): Promise<{ checkoutPages: number; funnels: number; openQuotes: number }> {
  const db = getAdminDb();
  const pages = db.collection(`subAccounts/${subAccountId}/checkoutPages`);
  const [offer, bump, funnels, quotes] = await Promise.all([
    pages.where("productId", "==", productId).get(),
    pages.where("bumpProductIds", "array-contains", productId).get(),
    db.collection(`subAccounts/${subAccountId}/funnels`).where("productId", "==", productId).get(),
    db.collection("quotes").where("subAccountId", "==", subAccountId).get(),
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
    checkoutPages: new Set([...offer.docs, ...bump.docs].map((d) => d.id)).size,
    funnels: funnels.size,
    openQuotes,
  };
}
