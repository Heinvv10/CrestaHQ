/**
 * Stripe amounts are in the currency's smallest unit — cents for USD, but
 * whole units for zero-decimal currencies (JPY, KRW, …). Sending `total * 100`
 * for those charges the buyer 100×.
 *
 * This app's own "cents" fields (`Order.totalCents`, `Product.unitPriceCents`,
 * …) stay `major × 100` in every currency; only the amount handed to or read
 * from Stripe converts.
 *
 * https://docs.stripe.com/currencies#zero-decimal — deliberately WITHOUT the
 * "special cases": ISK and UGX are zero-decimal in life but Stripe still
 * takes them as two-decimal values (5 UGX → 500); HUF and TWD charge as
 * two-decimal. All four are therefore ×100, the default.
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga",
  "pyg", "rwf", "vnd", "vuv", "xaf", "xof", "xpf",
]);

/**
 * Three-decimal currencies. Stripe's rules for these differ again (×1000 with
 * constraints), and nothing here prices in them — refused at checkout rather
 * than charged at a tenth of the price.
 */
const THREE_DECIMAL_CURRENCIES = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);

export function isZeroDecimalCurrency(currency: string): boolean {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toLowerCase());
}

/** False for currencies card checkout cannot price correctly. */
export function stripeCanChargeCurrency(currency: string): boolean {
  return !THREE_DECIMAL_CURRENCIES.has(currency.toLowerCase());
}

/** Major units (12.50 USD, 1000 JPY) → the amount Stripe expects. */
export function toStripeAmount(major: number, currency: string): number {
  if (!stripeCanChargeCurrency(currency)) {
    throw new Error(`Card checkout does not support ${currency.toUpperCase()}`);
  }
  return isZeroDecimalCurrency(currency) ? Math.round(major) : Math.round(major * 100);
}

/** This app's `major × 100` cents → the amount Stripe expects. */
export function centsToStripeAmount(cents: number, currency: string): number {
  return toStripeAmount(cents / 100, currency);
}

/** An amount Stripe reported → this app's `major × 100` cents. */
export function stripeAmountToCents(amount: number, currency: string): number {
  return isZeroDecimalCurrency(currency) ? amount * 100 : amount;
}
