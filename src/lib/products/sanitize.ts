import type { Product } from "@/types/products";

/**
 * Shared product-payload sanitizer for the products create + update routes.
 *
 * Lives in lib/ (not in a route.ts) because Next 15 forbids non-handler
 * exports from route files — the `[productId]` route needs to reuse this, so
 * it can't hang off the collection route's module.
 */

export interface CreateProductPayload {
  name?: string;
  description?: string;
  unitPriceCents?: number;
  currency?: string;
  active?: boolean;
  bumpEligible?: boolean;
  bumpHeadline?: string;
}

export function sanitizeProductPayload(
  body: CreateProductPayload,
): Partial<Product> {
  const out: Partial<Product> = {};

  if (typeof body.name === "string") {
    out.name = body.name.trim().slice(0, 200);
  }
  if (typeof body.description === "string") {
    out.description = body.description.trim().slice(0, 2_000);
  }
  if (
    typeof body.unitPriceCents === "number" &&
    Number.isFinite(body.unitPriceCents)
  ) {
    out.unitPriceCents = Math.max(0, Math.round(body.unitPriceCents));
  }
  if (typeof body.currency === "string" && body.currency.trim()) {
    out.currency = body.currency.trim().toUpperCase().slice(0, 3);
  }
  if (typeof body.active === "boolean") {
    out.active = body.active;
  }
  if (typeof body.bumpEligible === "boolean") {
    out.bumpEligible = body.bumpEligible;
  }
  if (typeof body.bumpHeadline === "string") {
    // 140 chars — a bump pitch that needs more than that belongs in the
    // product description, which the checkout page falls back to.
    out.bumpHeadline = body.bumpHeadline.trim().slice(0, 140);
  }

  return out;
}
