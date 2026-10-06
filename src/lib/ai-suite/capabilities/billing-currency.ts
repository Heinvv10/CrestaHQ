import "server-only";

import { getBillingProvider } from "@/lib/billing/provider";
import { BillingError } from "@/lib/billing/errors";
import { assertSupportedCurrency } from "@/lib/paystack/billing-api";
import { isZeroDecimalCurrency, stripeCanChargeCurrency } from "@/lib/stripe/amount";

/**
 * Why the configured Client Billing provider can't take `currency`, or null.
 * Amounts are kept in hundredths and handed to Stripe as they are, so a
 * zero-decimal currency would bill 100× and a three-decimal one can't be
 * priced; Paystack settles only its own list. No provider configured is
 * judged as Stripe, the default.
 */
export function currencyRefusal(currency: string): string | null {
  if (getBillingProvider().id === "paystack") {
    try {
      assertSupportedCurrency(currency);
      return null;
    } catch (err) {
      if (err instanceof BillingError) return err.message;
      throw err;
    }
  }
  return stripeCanChargeCurrency(currency) && !isZeroDecimalCurrency(currency)
    ? null
    : `Client Billing can't charge in ${currency.toUpperCase()}: use a currency with cents, such as zar or usd.`;
}
