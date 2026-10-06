import "server-only";

import { getBillingProvider } from "@/lib/billing/provider";
import { BillingError } from "@/lib/billing/errors";
import { assertSupportedCurrency } from "@/lib/paystack/billing-api";
import { isZeroDecimalCurrency, stripeCanChargeCurrency } from "@/lib/stripe/amount";

/** The currency an omitted one means: the provider's own (Paystack's here is ZAR). */
export const defaultBillingCurrency = (): string => (getBillingProvider().id === "paystack" ? "zar" : "usd");

/**
 * Why the configured Client Billing provider can't take `currency`, or null.
 * Amounts are kept in hundredths and handed to Stripe as they are, so a
 * zero-decimal currency would bill 100× and a three-decimal one can't be
 * priced; Paystack settles only its own list. No provider configured is
 * judged as Stripe, the default.
 */
export function currencyRefusal(currency: string): string | null {
  if (getBillingProvider().id === "paystack") {
    // XOF has no subunit, and how Paystack reads its amount is unconfirmed:
    // refused rather than risk billing 100x. The rest of its list is a buyer's choice.
    if (currency.trim().toLowerCase() === "xof") {
      return "Client Billing can't charge in XOF on Paystack: its amount handling is unconfirmed. Use another currency your Paystack account settles.";
    }
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
