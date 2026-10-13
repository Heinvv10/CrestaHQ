import "server-only";

import { getBillingProvider } from "@/lib/billing/provider";
import { BillingError } from "@/lib/billing/errors";
import { CapabilityUserError } from "./types";
import { assertSupportedCurrency } from "@/lib/paystack/billing-api";
import { usageCurrency } from "@/lib/billing/currency";
import { isZeroDecimalCurrency, stripeCanChargeCurrency } from "@/lib/stripe/amount";

export { defaultBillingCurrency } from "@/lib/billing/currency";

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

/**
 * The currency a one-time charge bills in. Named by the caller: that one.
 * Omitted (`currencyDefaulted`): the client's overage currency
 * (`usageCurrency`), so invoicing overage bills what the usage section
 * showed — but only when that is the currency the card already showed (the
 * provider's default); a client billed in another one is refused, never
 * charged in a currency nobody confirmed.
 */
export function chargeCurrencyFor(args: Record<string, unknown>, billing: { currency?: string | null } | null | undefined): string {
  const shown = args.currency as string;
  if (args.currencyDefaulted !== true) return shown;
  const actual = usageCurrency(billing);
  if (actual !== shown) {
    throw new CapabilityUserError(`This client is billed in ${actual.toUpperCase()}, not ${shown.toUpperCase()}: ask again naming the currency to charge in.`);
  }
  return actual;
}
