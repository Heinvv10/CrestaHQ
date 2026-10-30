import { isZeroDecimalCurrency } from "@/lib/stripe/amount";
import type { Product } from "@/types/products";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * Client-safe Sell Online helpers, shared by the Products UI and the server
 * routes so what the operator sees matches what the API enforces. Which rail
 * sells a product is `chooseProductPayRail` (lib/products/pay-rail.ts,
 * also pure).
 */

export function sellOnlineGateOn(
  sub: Partial<Pick<SubAccountDoc, "sellOnlineEnabledByAgency">> | null | undefined,
): boolean {
  return sub?.sellOnlineEnabledByAgency === true;
}

export function isSellableProduct(
  p: Pick<Product, "active" | "sellOnline" | "slug">,
): boolean {
  return p.active === true && p.sellOnline === true && !!p.slug;
}

export function slugifyProductSlug(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

/**
 * "thanks" is a sibling route under /co/[saId]/buy/. The rest mirror the
 * checkout page reserved list plus "buy", so a product slug never reads like
 * one of the /co routes.
 */
const RESERVED_PRODUCT_SLUGS = new Set(["api", "new", "thanks", "preview", "buy"]);

export function productSlugError(slug: string): string | null {
  if (!slug) return "Add a URL slug.";
  if (slug.length < 2) return "Slug must be at least 2 characters.";
  if (slug.length > 60) return "Keep the slug under 60 characters.";
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug)) {
    return "Use lowercase letters, numbers and hyphens (can't start or end with a hyphen).";
  }
  if (RESERVED_PRODUCT_SLUGS.has(slug)) return `"${slug}" is reserved, pick another.`;
  return null;
}

/**
 * Currencies a product may be sold online in: the quote builder's list
 * (ZAR for Paystack). Catalog-only products keep any currency.
 */
export const SELL_ONLINE_CURRENCIES = [
  "USD",
  "AUD",
  "EUR",
  "GBP",
  "CAD",
  "NZD",
  "JPY",
  "CHF",
  "SGD",
  "HKD",
  "ZAR",
] as const;
const SELL_ONLINE_CURRENCY_SET = new Set<string>(SELL_ONLINE_CURRENCIES);

/** Same ceiling as payment links and plan prices (1,000,000.00). */
export const MAX_SELL_ONLINE_PRICE_CENTS = 100_000_000;

/** Why a product can't be sold online at this price, or null when it can. */
export function sellOnlinePriceError(unitPriceCents: unknown, currency: unknown): string | null {
  if (typeof currency !== "string" || !SELL_ONLINE_CURRENCY_SET.has(currency)) {
    return `Products sold online must be priced in one of ${SELL_ONLINE_CURRENCIES.join(", ")}.`;
  }
  if (typeof unitPriceCents !== "number" || !Number.isInteger(unitPriceCents) || unitPriceCents <= 0) {
    return "Set a price above zero before selling online.";
  }
  if (unitPriceCents > MAX_SELL_ONLINE_PRICE_CENTS) {
    return "That price is too high to sell online.";
  }
  // JPY and the other zero-decimal currencies charge whole units: 123.45
  // would be charged as 123 while the order books 123.45.
  if (isZeroDecimalCurrency(currency) && unitPriceCents % 100 !== 0) {
    return `${currency} prices must be whole amounts (no cents).`;
  }
  return null;
}

/** Path of the express buy link; prefix with the app origin for a full URL. */
export function expressBuyPath(subAccountId: string, slug: string): string {
  return `/co/${subAccountId}/buy/${slug}`;
}

export const PUBLIC_DESCRIPTION_MAX = 2_000;
export const DOWNLOAD_LABEL_MAX = 80;
