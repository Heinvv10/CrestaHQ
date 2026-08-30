import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { CheckoutPageError } from "@/lib/checkout/sanitize";
import { slugifyCheckoutSlug } from "@/types/checkout-pages";
import { defaultFormAppearance } from "@/types/forms";
import type { Product } from "@/types/products";

/**
 * Create a published checkout page from a product, or reuse the one we made
 * earlier for the same product+owner.
 *
 * Exists so a funnel can sell a product in one click without the operator
 * building a checkout page first — while keeping the rule that the funnel
 * NEVER owns payment. It gets a real checkout page: visible in the Checkout
 * list, editable there, able to gain order bumps and capture fields later.
 * One money path, no hidden entities.
 *
 * Idempotent per owner: called again for the same funnel and product it
 * returns the existing page instead of piling up duplicates every save.
 */
export async function ensureCheckoutPageForProduct(input: {
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  productId: string;
  /** Opaque owner tag, e.g. `funnel:<funnelId>`. */
  ownerKey: string;
  /** Used for the page name + slug seed. */
  label: string;
}): Promise<string> {
  const db = getAdminDb();

  const productSnap = await db.doc(`products/${input.productId}`).get();
  if (!productSnap.exists) {
    throw new CheckoutPageError("That product no longer exists.");
  }
  const product = productSnap.data() as Product;
  if (product.subAccountId !== input.subAccountId) {
    throw new CheckoutPageError("That product no longer exists.");
  }
  if (!product.active) {
    throw new CheckoutPageError(
      "That product is archived. Restore it, or pick another.",
    );
  }
  if (product.unitPriceCents <= 0) {
    throw new CheckoutPageError(
      `"${product.name}" has no price. Set one before selling it.`,
    );
  }

  const col = db.collection(`subAccounts/${input.subAccountId}/checkoutPages`);

  // Reuse — equality-only query, no index needed.
  const existing = await col
    .where("createdForKey", "==", input.ownerKey)
    .limit(1)
    .get();
  if (!existing.empty) {
    const doc = existing.docs[0];
    // Re-point + re-publish in case the operator swapped the product or the
    // page was unpublished by hand.
    await doc.ref.set(
      {
        productId: input.productId,
        status: "published",
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return doc.id;
  }

  // Unique slug — append a counter rather than failing on a clash.
  const base = slugifyCheckoutSlug(input.label || product.name) || "offer";
  let slug = base;
  for (let i = 2; i <= 20; i++) {
    const clash = await col.where("slug", "==", slug).limit(1).get();
    if (clash.empty) break;
    slug = `${base}-${i}`.slice(0, 60);
  }

  const ref = col.doc();
  await ref.set({
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    createdByUid: input.createdByUid,
    slug,
    name: input.label || product.name,
    // Published immediately: it was created BY an explicit "sell this product"
    // action, and a draft would silently break the funnel's buy button.
    status: "published",
    productId: input.productId,
    bumpProductIds: [],
    headline: product.name,
    subheadline: product.description ?? "",
    collectFields: [],
    autoTags: [],
    pipelineStageId: null,
    successUrl: null,
    appearance: defaultFormAppearance(),
    /** Ownership tag — makes this call idempotent and shows the operator in
     *  the Checkout list where the page came from. */
    createdForKey: input.ownerKey,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return ref.id;
}
