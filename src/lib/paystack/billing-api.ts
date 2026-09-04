import "server-only";

import { BillingError } from "@/lib/billing/errors";
import { SUB_ACCOUNT_PLAN_KIND } from "@/lib/billing/kinds";
import type { BillingInterval } from "@/types/billing";
import { paystackRequest } from "./client";

/**
 * The Paystack half of Client Billing: what each endpoint is called, what it
 * takes, and what comes back.
 *
 * Split from `billing/paystack-provider.ts` so that file stays a readable map
 * from the `BillingProvider` contract onto these calls, and so the wire shapes
 * — the part that breaks when Paystack changes — sit in one place.
 */

export interface PaystackSubscription {
  subscription_code: string;
  email_token: string;
  next_payment_date: string | null;
  status?: string;
  authorization?: { authorization_code?: string } | null;
  customer?: { customer_code?: string } | null;
}

/**
 * Create a Paystack Plan. A Plan *is* the price — amount, interval and
 * currency together — so this is what both `createPlan` and `createPrice` mint.
 */
export async function createPaystackPlan(input: {
  name: string;
  description: string | null;
  amountCents: number;
  currency: string;
  interval: BillingInterval;
  metadata?: Record<string, string>;
}): Promise<string> {
  const plan = await paystackRequest<{ plan_code: string }>("POST", "/plan", {
    name: input.name,
    // Paystack takes the currency's subunit, which is cents for every currency
    // it settles — the same unit this codebase already stores.
    amount: input.amountCents,
    interval: input.interval === "year" ? "annually" : "monthly",
    currency: assertSupportedCurrency(input.currency),
    ...(input.description ? { description: input.description } : {}),
    metadata: { kind: SUB_ACCOUNT_PLAN_KIND, ...(input.metadata ?? {}) },
  });
  return plan.plan_code;
}

export async function createPaystackCustomer(input: {
  email: string;
  name: string;
  metadata: Record<string, string>;
}): Promise<string> {
  const customer = await paystackRequest<{ customer_code: string }>(
    "POST",
    "/customer",
    {
      email: input.email,
      first_name: input.name,
      metadata: input.metadata,
    },
  );
  return customer.customer_code;
}

/** Paystack opens checkout against an email, so the customer is read back. */
export async function readPaystackCustomerEmail(
  customerCode: string,
): Promise<string> {
  const customer = await paystackRequest<{ email: string }>(
    "GET",
    `/customer/${encodeURIComponent(customerCode)}`,
  );
  if (!customer.email) {
    throw new BillingError(
      "That Paystack customer has no email address on file.",
      500,
    );
  }
  return customer.email;
}

export function readPaystackSubscription(
  code: string,
): Promise<PaystackSubscription> {
  return paystackRequest<PaystackSubscription>(
    "GET",
    `/subscription/${encodeURIComponent(code)}`,
  );
}

/** Stop future charges. The client keeps access to the period already paid. */
export async function disablePaystackSubscription(
  sub: PaystackSubscription,
): Promise<void> {
  await paystackRequest("POST", "/subscription/disable", {
    code: sub.subscription_code,
    token: sub.email_token,
  });
}

/**
 * Start a subscription on a card the customer has already authorized — no
 * second checkout. `startDate` is how a plan switch lands on the renewal date
 * instead of billing immediately.
 */
export async function createPaystackSubscription(input: {
  customerCode: string;
  planCode: string;
  authorizationCode: string;
  startDate: string;
}): Promise<void> {
  await paystackRequest("POST", "/subscription", {
    customer: input.customerCode,
    plan: input.planCode,
    authorization: input.authorizationCode,
    start_date: input.startDate,
  });
}

/**
 * Paystack's per-subscription manage page — the nearest thing it has to a
 * billing portal. There is no customer-level equivalent, so the caller has to
 * resolve a subscription first.
 */
export async function findLivePaystackSubscription(
  customerCode: string,
): Promise<string> {
  const customer = await paystackRequest<{ id: number }>(
    "GET",
    `/customer/${encodeURIComponent(customerCode)}`,
  );
  const subs = await paystackRequest<
    { subscription_code: string; status: string }[]
  >("GET", `/subscription?customer=${customer.id}`);
  const live = subs.find((s) => s.status === "active") ?? subs[0];
  if (!live) {
    throw new BillingError(
      "There's no Paystack subscription to manage for this workspace yet.",
      404,
    );
  }
  return live.subscription_code;
}

export async function readPaystackManageLink(
  subscriptionCode: string,
): Promise<string> {
  const link = await paystackRequest<{ link: string }>(
    "GET",
    `/subscription/${encodeURIComponent(subscriptionCode)}/manage/link`,
  );
  return link.link;
}

/**
 * Open a hosted payment page.
 *
 * With `plan` set Paystack bills the plan's own amount and creates the
 * subscription on success, so `amountCents` is omitted in that case — sending a
 * second figure that disagrees is an error, not an override.
 */
export async function initializePaystackTransaction(input: {
  email: string;
  amountCents?: number;
  currency?: string;
  plan?: string;
  callbackUrl: string;
  metadata: Record<string, string>;
}): Promise<{ url: string; reference: string }> {
  const data = await paystackRequest<{
    authorization_url: string;
    reference: string;
  }>("POST", "/transaction/initialize", {
    email: input.email,
    ...(input.amountCents !== undefined ? { amount: input.amountCents } : {}),
    ...(input.currency
      ? { currency: assertSupportedCurrency(input.currency) }
      : {}),
    ...(input.plan ? { plan: input.plan } : {}),
    // Paystack has one return URL, not Stripe's success/cancel pair. An
    // abandoned payment simply never leaves the Paystack page, so a caller's
    // cancelUrl has nothing to bind to.
    callback_url: input.callbackUrl,
    metadata: input.metadata,
  });
  if (!data.authorization_url) {
    throw new BillingError("Paystack didn't return a checkout URL.", 502);
  }
  return { url: data.authorization_url, reference: data.reference };
}

/** Currencies Paystack can actually settle. ZAR is this deployment's. */
const SUPPORTED_CURRENCIES = new Set([
  "NGN",
  "ZAR",
  "GHS",
  "KES",
  "USD",
  "XOF",
  "EGP",
]);

/**
 * Plan docs store currency lowercase (a Stripe convention). Paystack wants it
 * uppercase, and refuses anything it can't settle — better to name the wrong
 * currency here than to have a plan create fail with Paystack's own wording
 * halfway through.
 */
export function assertSupportedCurrency(currency: string): string {
  const code = currency.trim().toUpperCase();
  if (!SUPPORTED_CURRENCIES.has(code)) {
    throw new BillingError(
      `Paystack can't bill in ${code}. Price this plan in ZAR.`,
    );
  }
  return code;
}
