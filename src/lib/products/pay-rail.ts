import { stripeCanChargeCurrency } from "@/lib/stripe/amount";
import { PAYMENT_LINK_CURRENCY } from "@/types/payment-links";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * Which of the sub-account's own rails sells a product online, decided in one
 * place (UPSTREAM_PORT_PLAN_1_0_54 "F"). Upstream sells on Stripe only; ours
 * also has Paystack, the South African card rail.
 *
 *   - Stripe is ready when Payments is on, `stripeConnectionMeta.ready` (the
 *     webhook step is done, so a payment can be heard) and Stripe can price
 *     the currency (`stripeCanChargeCurrency`).
 *   - Paystack is ready when Payments is on, a connection exists and the
 *     product is in ZAR.
 *   - Both ready: Stripe, the same order invoices use (Decision 2), so the app
 *     has one rule.
 *
 * Selling also needs `sellOnlineEnabledByAgency`. Pure and client-safe (no
 * server imports): the product editor shows "sells via X" / "not ready
 * because Y" from the same function the routes enforce. It reads only the
 * member-readable connection meta; the payment session (F2/F3) still loads
 * the stored secret and refuses if it is gone.
 */

export type ProductPayRail = "stripe" | "paystack";

export type ProductPayRailChoice =
  | { ok: true; rail: ProductPayRail }
  | { ok: false; reason: string };

type PayRailSub = Pick<
  SubAccountDoc,
  | "sellOnlineEnabledByAgency"
  | "paymentsEnabledByAgency"
  | "stripeConnectionMeta"
  | "paystackConnectionMeta"
>;

export function chooseProductPayRail(
  sub: Partial<PayRailSub> | null | undefined,
  currency: string,
): ProductPayRailChoice {
  if (sub?.sellOnlineEnabledByAgency !== true) {
    return no("Selling online is turned off for this workspace. Ask your agency owner.");
  }
  if (sub.paymentsEnabledByAgency !== true) {
    return no("Payments is turned off for this workspace. Ask your agency owner.");
  }
  const code = (currency || "").trim().toUpperCase();
  const stripe = sub.stripeConnectionMeta ?? null;
  const paystack = sub.paystackConnectionMeta ?? null;

  if (stripe?.ready === true && stripeCanChargeCurrency(code)) {
    return { ok: true, rail: "stripe" };
  }
  if (paystack && code === PAYMENT_LINK_CURRENCY) {
    return { ok: true, rail: "paystack" };
  }

  if (!stripe && !paystack) {
    return no("Connect Stripe or Paystack under Settings → Payments first.");
  }
  const blockers: string[] = [];
  if (stripe) {
    blockers.push(
      stripe.ready !== true
        ? "Stripe isn't ready yet (finish its webhook step under Settings → Payments)"
        : `Stripe can't charge ${code || "this currency"}`,
    );
  }
  if (paystack) {
    blockers.push(`Paystack only takes ${PAYMENT_LINK_CURRENCY}, and this product is priced in ${code || "no currency"}`);
  }
  return no(`${blockers.join("; ")}.`);
}

const no = (reason: string): ProductPayRailChoice => ({ ok: false, reason });
