/**
 * Stripe amounts are in the currency's smallest unit — cents for USD, but
 * whole units for zero-decimal currencies (JPY, KRW, …). Sending `total * 100`
 * for those charges the buyer 100×.
 *
 * This app's own "cents" fields (`Order.totalCents`, …) stay `major × 100` in
 * every currency; only the amount handed to or read from Stripe converts.
 *
 * List: https://docs.stripe.com/currencies#zero-decimal
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga",
  "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);

export function isZeroDecimalCurrency(currency: string): boolean {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toLowerCase());
}

/** Major units (12.50 USD, 1000 JPY) → the amount Stripe expects. */
export function toStripeAmount(major: number, currency: string): number {
  return isZeroDecimalCurrency(currency) ? Math.round(major) : Math.round(major * 100);
}

/** An amount Stripe reported → this app's `major × 100` cents. */
export function stripeAmountToCents(amount: number, currency: string): number {
  return isZeroDecimalCurrency(currency) ? amount * 100 : amount;
}
