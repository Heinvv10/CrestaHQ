import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { isSellableProduct, sellOnlinePriceError } from "@/lib/products/sell-online";
import { chooseProductPayRail } from "@/lib/products/pay-rail";
import type { Product } from "@/types/products";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * The public catalog of a sub-account: what its buy pages and website may
 * show. One builder so they never disagree. A product is listed only when it
 * is on sale, its price is still valid and a rail can take its currency right
 * now (`chooseProductPayRail`, which also checks the agency gate), so a
 * Paystack-only workspace never lists a USD product it cannot charge.
 */

export async function listSellableProducts(
  subAccountId: string,
  sub: Partial<SubAccountDoc>,
): Promise<Product[]> {
  const snap = await getAdminDb()
    .collection("products")
    .where("subAccountId", "==", subAccountId)
    .where("sellOnline", "==", true)
    .get();
  return snap.docs
    .map((d) => ({ id: d.id, ...(d.data() as Omit<Product, "id">) }))
    .filter(
      (p) =>
        isSellableProduct(p) &&
        sellOnlinePriceError(p.unitPriceCents, p.currency) === null &&
        chooseProductPayRail(sub, p.currency).ok,
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}
