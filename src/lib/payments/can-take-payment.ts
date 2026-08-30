import type { SubAccountDoc } from "@/types/tenancy";

/**
 * "Can this sub-account collect money from its own customers?"
 *
 * ONE predicate, deliberately. Before Payments v1 the answer was always
 * "does it have a paypal.me username", and that assumption was hard-coded
 * into at least seven independent places — the invoice send route, the
 * booking book route, three booking-page write routes, the booking editor,
 * the community purchase service. Adding a card rail meant every one of them
 * silently blocked a Stripe-only workspace, each with its own wording, and
 * they were found one at a time in production.
 *
 * Import this instead of reading `paypalConfig` directly. If a third rail ever
 * lands, it goes here and nowhere else.
 *
 * Client-safe: pure, no server imports, so the dashboard editors can use the
 * same logic the API routes enforce.
 */

/** Loose shape so callers can pass a partial/raw Firestore doc. */
type PaymentCapableSub = Pick<
  SubAccountDoc,
  "paypalConfig" | "paymentsEnabledByAgency" | "stripeConnectionMeta"
>;

/** paypal.me link generation — stateless, no confirmation callback. */
export function hasPaypalRail(
  sub: Partial<PaymentCapableSub> | null | undefined,
): boolean {
  return !!sub?.paypalConfig?.username;
}

/**
 * Card via the sub-account's OWN Stripe. Requires BOTH the agency gate and a
 * connection that can actually confirm payments — `ready === false` means the
 * webhook step is unfinished, so a payment would succeed with nothing to mark
 * the order paid. Treat that as "no card rail" rather than offering it.
 */
export function hasCardRail(
  sub: Partial<PaymentCapableSub> | null | undefined,
): boolean {
  return (
    sub?.paymentsEnabledByAgency === true &&
    sub?.stripeConnectionMeta?.ready === true
  );
}

/** True when at least one rail can collect. */
export function canTakePayment(
  sub: Partial<PaymentCapableSub> | null | undefined,
): boolean {
  return hasPaypalRail(sub) || hasCardRail(sub);
}

/** Shared copy for the "you can't collect money yet" states. */
export const NO_PAYMENT_RAIL_MESSAGE =
  "Connect Stripe or PayPal under Settings → Payments first.";
