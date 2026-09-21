import "server-only";

import { BillingError } from "@/lib/billing/errors";
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
}): Promise<string> {
  const plan = await paystackRequest<{ plan_code: string }>("POST", "/plan", {
    name: input.name,
    // Paystack takes the currency's subunit, which is cents for every currency
    // it settles — the same unit this codebase already stores.
    amount: input.amountCents,
    interval: input.interval === "year" ? "annually" : "monthly",
    currency: assertSupportedCurrency(input.currency),
    ...(input.description ? { description: input.description } : {}),
    // No metadata: `metadata` is not a documented parameter of Paystack's
    // create-plan endpoint, and a field the provider silently drops reads like
    // durable linkage that isn't there. The plan code → plan doc mapping lives
    // in Firestore, which is the only place anything reads it from.
  });
  return plan.plan_code;
}

/**
 * A plan's own amount, in the currency subunit.
 *
 * Read before a subscription checkout so the initialize call can carry an
 * amount. Paystack documents `amount` as required AND documents `plan` as
 * invalidating it; sending the plan's own figure is the one value that is
 * correct under either reading, and it cannot disagree with what the client is
 * actually billed. It also fails a bad plan code here — before the client is
 * handed a link — rather than on the payment page.
 */
export async function readPaystackPlanAmount(
  planCode: string,
): Promise<number> {
  const plan = await paystackRequest<{ amount: number }>(
    "GET",
    `/plan/${encodeURIComponent(planCode)}`,
  );
  if (typeof plan.amount !== "number") {
    throw new BillingError(
      "Paystack returned a plan with no amount — recreate this plan's price.",
      502,
    );
  }
  return plan.amount;
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
}): Promise<string> {
  // A past-due subscription's renewal date is already behind us. Paystack
  // rejects a start_date in the past, and since the old subscription has
  // already been disabled by then, that rejection would leave the client with
  // no subscription at all. They owe the renewal now, so start now.
  const startDate = notBeforeNow(input.startDate);
  const sub = await paystackRequest<{ subscription_code: string }>(
    "POST",
    "/subscription",
    {
      customer: input.customerCode,
      plan: input.planCode,
      authorization: input.authorizationCode,
      start_date: startDate,
    },
  );
  if (!sub.subscription_code) {
    throw new BillingError(
      "Paystack created a subscription without returning its code — check the Paystack dashboard before charging this client again.",
      502,
    );
  }
  return sub.subscription_code;
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
  // Paystack pages this list, so a client with a long billing history can have
  // their live subscription fall off the first page. Walk until it is found or
  // the history runs out.
  const perPage = 100;
  for (let page = 1; page <= MAX_SUBSCRIPTION_PAGES; page += 1) {
    const subs = await paystackRequest<
      { subscription_code: string; status: string }[]
    >(
      "GET",
      `/subscription?customer=${customer.id}&perPage=${perPage}&page=${page}`,
    );
    const live = subs.find((s) => s.status === "active");
    // Deliberately no "else take the first one": handing back a cancelled
    // subscription gives the client a manage page where they update a card
    // that bills nothing, and a success screen that means nothing.
    if (live) return live.subscription_code;
    if (subs.length < perPage) break;
  }
  throw new BillingError(
    "There's no active Paystack subscription to manage for this workspace.",
    404,
  );
}

/** 500 subscriptions is far past any real client; a bound beats an open loop. */
const MAX_SUBSCRIPTION_PAGES = 5;

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
 * Open a hosted payment page. With `plan` set, Paystack creates the
 * subscription on a successful payment.
 */
export async function initializePaystackTransaction(input: {
  email: string;
  amountCents?: number;
  currency?: string;
  plan?: string;
  callbackUrl: string;
  metadata: Record<string, string>;
  /**
   * What the payer is buying. Paystack's page has no line item — it renders
   * `metadata.custom_fields` — so without this a one-time charge shows the
   * payer a bare amount and nothing saying what it is for.
   */
  displayName?: string;
  /** Our own reference. Omitted → Paystack generates one. */
  reference?: string;
  /**
   * A sub-account's OWN secret key (payment links). Omitted → the agency's
   * `PAYSTACK_SECRET_KEY`, as Client Billing wants. See `paystackRequest`.
   */
  secretKey?: string;
}): Promise<{ url: string; reference: string }> {
  const data = await paystackRequest<{
    authorization_url: string;
    reference: string;
  }>("POST", "/transaction/initialize", {
    email: input.email,
    ...(input.reference ? { reference: input.reference } : {}),
    ...(input.amountCents !== undefined ? { amount: input.amountCents } : {}),
    ...(input.currency
      ? { currency: assertSupportedCurrency(input.currency) }
      : {}),
    ...(input.plan ? { plan: input.plan } : {}),
    // Paystack has one return URL, not Stripe's success/cancel pair. An
    // abandoned payment simply never leaves the Paystack page, so a caller's
    // cancelUrl has nothing to bind to.
    callback_url: input.callbackUrl,
    metadata: {
      ...input.metadata,
      ...(input.displayName
        ? {
            custom_fields: [
              {
                display_name: "Paying for",
                variable_name: "paying_for",
                value: input.displayName,
              },
            ],
          }
        : {}),
    },
  }, input.secretKey);
  if (!data.authorization_url) {
    throw new BillingError("Paystack didn't return a checkout URL.", 502);
  }
  return { url: data.authorization_url, reference: data.reference };
}

/** The fields of `GET /transaction/verify/:reference` a reconciler checks. */
export interface PaystackVerifiedTransaction {
  status: string;
  reference: string;
  /** "test" or "live" — which mode of the account took the payment. */
  domain?: string;
  /** Currency subunit (cents). Includes fees when the customer bears them. */
  amount: number;
  /** What was asked for, before customer-borne fees. See the reconciler. */
  requested_amount?: number;
  currency: string;
  customer?: { email?: string | null } | null;
}

/**
 * Ask Paystack what actually happened to a transaction, with the key of the
 * account it was made on. A webhook body is only a claim; this is the answer
 * the payment-link reconciler acts on.
 */
export function verifyPaystackTransaction(
  reference: string,
  secretKey: string,
): Promise<PaystackVerifiedTransaction> {
  return paystackRequest<PaystackVerifiedTransaction>(
    "GET",
    `/transaction/verify/${encodeURIComponent(reference)}`,
    undefined,
    secretKey,
  );
}

/**
 * Clamp a renewal date forward to now. An unparseable date is treated as past
 * rather than passed through — the switch still happens, one cycle early at
 * worst, instead of failing outright and stranding the client.
 */
export function notBeforeNow(date: string, now: Date = new Date()): string {
  const parsed = Date.parse(date);
  if (Number.isNaN(parsed) || parsed <= now.getTime()) return now.toISOString();
  return date;
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
      `Paystack can't settle ${code}. Use a currency it supports — ZAR here.`,
    );
  }
  return code;
}
