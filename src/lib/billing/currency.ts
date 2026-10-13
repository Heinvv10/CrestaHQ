import "server-only";

import { getBillingProvider } from "@/lib/billing/provider";

/** The currency an omitted one means: the provider's own (Paystack's here is ZAR). */
export const defaultBillingCurrency = (): string => (getBillingProvider().id === "paystack" ? "zar" : "usd");

/** The currency a client's usage overage is valued in: its plan's, else the
 *  provider's own. The ONE answer for the agency usage route (and so the
 *  Manage dialog) and the assistant's sub_account_usage. */
export function usageCurrency(billing: { currency?: string | null } | null | undefined): string {
  return billing?.currency || defaultBillingCurrency();
}
