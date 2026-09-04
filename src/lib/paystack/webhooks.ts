import "server-only";

import {
  SUB_ACCOUNT_CHARGE_KIND,
  SUB_ACCOUNT_PLAN_KIND,
} from "@/lib/billing/kinds";
import {
  activateSubAccountPlan,
  applySubAccountSubscriptionStatus,
  markSubAccountChargePaid,
} from "@/lib/server/billing-service";

/**
 * Client Billing's Paystack event router — the half that makes the rail real.
 * Without it a client's payment arrives and their workspace stays walled.
 *
 * It maps Paystack's events onto the SAME provider-neutral handlers Stripe
 * uses, so activation, the gate bundle, the dunning grace window and the
 * outbound webhook cannot drift between the two rails.
 *
 * Two shapes differ from Stripe and drive most of what follows:
 *
 *   - **A payment and its subscription arrive as separate events**, in no
 *     guaranteed order. `charge.success` carries our metadata but no
 *     subscription code; `subscription.create` carries the code but none of
 *     our metadata. Whichever lands second fills in what the first could not,
 *     joined on the customer code we stored before checkout ever opened.
 *   - **Renewals carry no metadata at all.** A renewal is recognised by having
 *     no `kind` of ours, and the sub-account is found by customer code.
 */
export async function handlePaystackEvent(event: PaystackEvent): Promise<void> {
  switch (event.event) {
    case "charge.success":
      await handleChargeSuccess(event.data);
      return;
    case "subscription.create":
      await handleSubscriptionCreate(event.data);
      return;
    case "invoice.payment_failed":
      await handleRenewalFailed(event.data);
      return;
    case "subscription.disable":
      await handleSubscriptionEnded(event.data);
      return;
    case "subscription.not_renew":
      // Auto-renew was turned OFF. The subscription is "active, non-renewing":
      // the cycle the client already paid for runs to its end date, and only
      // the NEXT charge is cancelled. Paystack fires `subscription.disable`
      // when the period actually expires — that is the terminating event.
      //
      // Cancelling here would paywall someone for the weeks they have paid
      // for, and Stripe's equivalent (`cancel_at_period_end`) correctly
      // reports nothing until the period ends.
      console.log(
        "[paystack] subscription.not_renew — access runs to the period end",
      );
      return;
    default:
      // Paystack sends far more than Client Billing cares about (transfers,
      // refunds, DVA events). Logging the type keeps a new one discoverable
      // without acting on something we have not mapped.
      console.log(`[paystack] unhandled event ${event.event}`);
  }
}

/**
 * A payment succeeded. Three cases, told apart by the metadata WE stamped at
 * checkout: a plan's first payment, a one-time charge, or a renewal (which
 * carries none of ours).
 */
async function handleChargeSuccess(data: PaystackEventData): Promise<void> {
  const metadata = readMetadata(data);
  const customerId = data.customer?.customer_code ?? null;

  if (metadata.kind === SUB_ACCOUNT_PLAN_KIND) {
    if (!metadata.subAccountId || !metadata.planId) {
      console.error(
        "[paystack] plan charge succeeded without subAccountId/planId metadata",
      );
      return;
    }
    await activateSubAccountPlan({
      subAccountId: metadata.subAccountId,
      planId: metadata.planId,
      customerId,
      // Paystack creates the subscription asynchronously; `subscription.create`
      // fills this in. Null here must not clear an id already stored.
      subscriptionId: null,
    });
    return;
  }

  if (metadata.kind === SUB_ACCOUNT_CHARGE_KIND) {
    if (!metadata.chargeId) {
      console.error("[paystack] charge succeeded without chargeId metadata");
      return;
    }
    await markSubAccountChargePaid({
      chargeId: metadata.chargeId,
      checkoutSessionId: data.reference ?? null,
      // Paystack's transaction id is the payment; there is no separate intent.
      paymentId: data.id != null ? String(data.id) : null,
    });
    return;
  }

  // No metadata of ours. This MIGHT be a subscription renewal — but
  // `charge.success` fires for every successful charge on the agency's
  // Paystack account, including ones that have nothing to do with Client
  // Billing. Two pieces of evidence are required before it can unlock a
  // workspace:
  //
  //   1. a plan code, which an ordinary one-off payment does not carry, and
  //   2. that plan being the one this workspace is actually subscribed to.
  //
  // Without both, a lapsed client paying the agency for something else — or a
  // test charge from the Paystack dashboard under the same customer — would
  // clear their dunning window and unlock a plan they have not paid.
  const planCode = data.plan?.plan_code;
  if (!customerId || !planCode) return;

  // The event names a PLAN, never a subscription. The subscription id is left
  // unknown rather than filled with the plan's: they are different objects,
  // and storing one as the other would repoint the workspace at something that
  // cannot be cancelled.
  await applySubAccountSubscriptionStatus({
    subscriptionId: null,
    status: "active",
    deleted: false,
    customerIdHint: customerId,
    matchPriceId: planCode,
    providerStatus: "charge.success",
  });
}

/**
 * The subscription now exists. This is the only event carrying its code, so it
 * is where the code gets stored — and it may arrive before OR after the
 * payment that created it.
 */
async function handleSubscriptionCreate(
  data: PaystackEventData,
): Promise<void> {
  const subscriptionCode = data.subscription_code;
  const customerId = data.customer?.customer_code ?? null;
  if (!subscriptionCode || !customerId) {
    console.error(
      "[paystack] subscription.create without a subscription code or customer",
    );
    return;
  }
  await applySubAccountSubscriptionStatus({
    subscriptionId: subscriptionCode,
    status: "active",
    deleted: false,
    customerIdHint: customerId,
    providerStatus: "subscription.create",
  });
}

/** A renewal charge failed — start (or continue) the dunning window. */
async function handleRenewalFailed(data: PaystackEventData): Promise<void> {
  const subscriptionCode = data.subscription?.subscription_code ?? null;
  const customerId = data.customer?.customer_code ?? null;
  if (!subscriptionCode && !customerId) return;
  await applySubAccountSubscriptionStatus({
    subscriptionId: subscriptionCode,
    status: "past_due",
    deleted: false,
    customerIdHint: customerId,
    providerStatus: "invoice.payment_failed",
  });
}

/** The subscription is over, by cancellation or by exhausting its retries. */
async function handleSubscriptionEnded(
  data: PaystackEventData,
): Promise<void> {
  const subscriptionCode = data.subscription_code ?? null;
  const customerId = data.customer?.customer_code ?? null;
  if (!subscriptionCode && !customerId) return;
  await applySubAccountSubscriptionStatus({
    subscriptionId: subscriptionCode,
    status: "canceled",
    // `deleted` clears the stored id. Kept false so the code stays on the doc:
    // a cancelled Paystack subscription is still the one to look up when the
    // agency asks what happened.
    deleted: false,
    customerIdHint: customerId,
    providerStatus: "subscription.disable",
  });
}

/**
 * Paystack echoes back whatever metadata we sent, but as JSON it re-parsed —
 * so it can come back as an object, as a string, or not at all. Only strings
 * are read out of it; nothing here trusts its shape.
 */
function readMetadata(data: PaystackEventData): {
  kind?: string;
  subAccountId?: string;
  planId?: string;
  chargeId?: string;
} {
  const raw = data.metadata;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Paystack sometimes returns the empty string for "no metadata". That is
      // a renewal, not an error, so it falls through to an empty object.
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== "object") return {};
  const obj = parsed as Record<string, unknown>;
  const str = (key: string) =>
    typeof obj[key] === "string" ? (obj[key] as string) : undefined;
  return {
    kind: str("kind"),
    subAccountId: str("subAccountId"),
    planId: str("planId"),
    chargeId: str("chargeId"),
  };
}

export interface PaystackEvent {
  event: string;
  data: PaystackEventData;
}

export interface PaystackEventData {
  id?: number | string;
  reference?: string;
  status?: string;
  metadata?: unknown;
  customer?: { customer_code?: string } | null;
  plan?: { plan_code?: string } | null;
  subscription_code?: string;
  subscription?: { subscription_code?: string } | null;
}
